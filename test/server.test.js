'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const os = require('os')
const fs = require('fs')
const path = require('path')
const PlugIntoMtx = require('../lib/server')

cds.test().in(__dirname + '/..')

// Minimal fake DeploymentService that captures the 'before deploy' handler
function makeDeploymentService() {
  let deployHandler = null
  return {
    prepend(fn) { fn() },
    before(event, handler) {
      if (event === 'deploy') deployHandler = handler
    },
    fire(data) { return deployHandler({ data }) }
  }
}

// Build a minimal CSN with one external service annotated for synonyms
function makeCsn(serviceNames) {
  const definitions = {}
  for (const name of serviceNames) {
    definitions[name] = { kind: 'service', '@data.product': 'via-synonym', '@cds.external': true }
  }
  return { definitions }
}

// Create a temp out-dir with dummy .hdbsynonymconfig and .hdbgrants files for given services
async function makeTempOutDir(serviceNames) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-syn-test-'))
  for (const srv of serviceNames) {
    fs.mkdirSync(path.join(outDir, 'cfg', 'gen'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'src', 'gen'), { recursive: true })
    fs.writeFileSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`), '{}')
    fs.writeFileSync(path.join(outDir, `src/gen/${srv}.hdbgrants`), '{}')
  }
  return outDir
}

function cleanupDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true })
}


beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  const m = await cds.load('lib/int-schema.cds')
  cds.model = m
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(m)) await db.run(stmt)
})

afterAll(() => cds.disconnect())


describe('PlugIntoMtx - before deploy handler', () => {

  let ds

  beforeAll(() => {
    // Register PlugIntoMtx once — it wires up cds.on('served', ...)
    // Each test swaps cds.services.['cds.xt.DeploymentService'] before firing
    ds = makeDeploymentService()
    cds.services['cds.xt.DeploymentService'] = ds
    PlugIntoMtx()
    cds.emit('served')
  })

  afterEach(() => {
    // Remove any hana-synonyms / sm entries added by the test
    for (const [k, v] of Object.entries(cds.env.requires)) {
      if (v?.kind === 'hana-synonyms' || (typeof v === 'object' && v?.credentials)) delete cds.env.requires[k]
    }
    cds.xt = undefined
  })


  it('service with static config and credentials → service replacement added to data.options', async () => {
    const srv            = 'sap.capire.flights'
    const smName         = 'sm-provider'
    const providerTenant = 'prov-tenant-1'
    const fakeCredentials = { schema: 'TENANT_SCHEMA', url: 'jdbc:sap://host' }

    cds.env.requires[srv]    = { kind: 'hana-synonyms', 'service-manager': smName, 'provider-tenant': providerTenant }
    cds.env.requires[smName] = { credentials: { clientid: 'id', clientsecret: 'secret' } }

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv])
    }

    let capturedProviderTenant
    cds.xt = {
      containerManager: {
        newInstance: () => ({
          get: async (tenant) => {
            capturedProviderTenant = tenant
            return { credentials: fakeCredentials }
          }
        })
      }
    }

    const outDir = await makeTempOutDir([srv])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // containerManager.get must be called with provider_tenant, not the deploying tenant
      expect(capturedProviderTenant).to.equal(providerTenant)

      // The .hdbsynonymconfig and .hdbgrants files should still exist (service is connected)
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.true
      expect(fs.existsSync(path.join(outDir, `src/gen/${srv}.hdbgrants`))).to.be.true

      // A service replacement should have been added
      const replacements = JSON.parse(data.options._.hdi.deployEnv.SERVICE_REPLACEMENTS)
      expect(replacements).to.deep.include({ key: srv, service: `${smName}-${providerTenant}-vcap` })

      // VCAP entry should have been added with the right name
      const vcap = data.options._.hdi.deployEnv.VCAP_SERVICES
      expect(vcap.hana).to.have.lengthOf(1)
      expect(vcap.hana[0].name).to.equal(`${smName}-${providerTenant}-vcap`)
      expect(vcap.hana[0].credentials).to.deep.equal(fakeCredentials)
    } finally {
      cleanupDir(outDir)
    }
  })


  it('service with static config but no SM credentials → files removed, no service replacement', async () => {
    const srv = 'sap.capire.flights'

    cds.env.requires[srv] = { kind: 'hana-synonyms', 'service-manager': 'sm-provider', 'provider-tenant': 'prov-t1' }
    // no cds.env.requires['sm-provider'] entry → no credentials

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv])
    }
    cds.xt = { containerManager: { newInstance: () => ({ get: async () => ({ credentials: {} }) }) } }

    const outDir = await makeTempOutDir([srv])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // Files should have been removed
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(outDir, `src/gen/${srv}.hdbgrants`))).to.be.false

      // No service replacement added
      expect(data.options._).to.be.undefined
    } finally {
      cleanupDir(outDir)
    }
  })


  it('service with no config at all → files removed, no service replacement', async () => {
    const srv = 'sap.capire.flights'
    // no cds.env.requires entry for srv, no DB entry

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv])
    }
    cds.xt = { containerManager: { newInstance: () => ({ get: async () => ({ credentials: {} }) }) } }

    const outDir = await makeTempOutDir([srv])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // Files should have been removed
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(outDir, `src/gen/${srv}.hdbgrants`))).to.be.false

      // No service replacement added
      expect(data.options._).to.be.undefined
    } finally {
      cleanupDir(outDir)
    }
  })


  it('three services: one connected, one SM missing credentials, one no config → only connected keeps files and gets replacement', async () => {
    const srvConnected    = 'sap.capire.flights'
    const srvNoCreds      = 'sap.capire.hotels'
    const srvNoConfig     = 'sap.capire.cars'
    const smConnected     = 'sm-connected'
    const smNoCreds       = 'sm-no-creds'
    const providerTenant  = 'prov-t1'
    const fakeCredentials = { schema: 'TENANT_SCHEMA', url: 'jdbc:sap://host' }

    cds.env.requires[srvConnected] = { kind: 'hana-synonyms', 'service-manager': smConnected, 'provider-tenant': providerTenant }
    cds.env.requires[srvNoCreds]   = { kind: 'hana-synonyms', 'service-manager': smNoCreds,   'provider-tenant': 'prov-t2' }
    // no entry for srvNoConfig
    cds.env.requires[smConnected]  = { credentials: { clientid: 'id', clientsecret: 'secret' } }
    // no entry for smNoCreds

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srvConnected, srvNoCreds, srvNoConfig])
    }
    cds.xt = {
      containerManager: {
        newInstance: () => ({
          get: async () => ({ credentials: fakeCredentials })
        })
      }
    }

    const outDir = await makeTempOutDir([srvConnected, srvNoCreds, srvNoConfig])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // Connected service: files kept, service replacement added
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srvConnected}.hdbsynonymconfig`))).to.be.true
      expect(fs.existsSync(path.join(outDir, `src/gen/${srvConnected}.hdbgrants`))).to.be.true

      // No-creds service: files removed
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srvNoCreds}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(outDir, `src/gen/${srvNoCreds}.hdbgrants`))).to.be.false

      // No-config service: files removed
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srvNoConfig}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(outDir, `src/gen/${srvNoConfig}.hdbgrants`))).to.be.false

      // Exactly one service replacement for the connected service
      const replacements = JSON.parse(data.options._.hdi.deployEnv.SERVICE_REPLACEMENTS)
      expect(replacements).to.have.lengthOf(1)
      expect(replacements[0]).to.deep.equal({ key: srvConnected, service: `${smConnected}-${providerTenant}-vcap` })

      // Exactly one VCAP entry
      expect(data.options._.hdi.deployEnv.VCAP_SERVICES.hana).to.have.lengthOf(1)
      expect(data.options._.hdi.deployEnv.VCAP_SERVICES.hana[0].name).to.equal(`${smConnected}-${providerTenant}-vcap`)
    } finally {
      cleanupDir(outDir)
    }
  })


  it('two services using same SM but different provider tenants → two separate VCAP entries', async () => {
    const srv1 = 'sap.capire.flights'
    const srv2 = 'sap.capire.hotels'
    const sm   = 'sm-shared'
    const fakeCredentials = { schema: 'SOME_SCHEMA', url: 'jdbc:sap://host' }

    cds.env.requires[srv1] = { kind: 'hana-synonyms', 'service-manager': sm, 'provider-tenant': 'prov-t1' }
    cds.env.requires[srv2] = { kind: 'hana-synonyms', 'service-manager': sm, 'provider-tenant': 'prov-t2' }
    cds.env.requires[sm]   = { credentials: { clientid: 'id', clientsecret: 'secret' } }

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv1, srv2])
    }
    cds.xt = {
      containerManager: {
        newInstance: () => ({
          get: async () => ({ credentials: fakeCredentials })
        })
      }
    }

    const outDir = await makeTempOutDir([srv1, srv2])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // Both services connected
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv1}.hdbsynonymconfig`))).to.be.true
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv2}.hdbsynonymconfig`))).to.be.true

      // Two separate service replacements and two VCAP entries
      const replacements = JSON.parse(data.options._.hdi.deployEnv.SERVICE_REPLACEMENTS)
      expect(replacements).to.have.lengthOf(2)
      expect(replacements.find(r => r.key === srv1).service).to.equal(`${sm}-prov-t1-vcap`)
      expect(replacements.find(r => r.key === srv2).service).to.equal(`${sm}-prov-t2-vcap`)

      const vcapHana = data.options._.hdi.deployEnv.VCAP_SERVICES.hana
      expect(vcapHana).to.have.lengthOf(2)
      expect(vcapHana.map(e => e.name).sort()).to.deep.equal([`${sm}-prov-t1-vcap`, `${sm}-prov-t2-vcap`].sort())
    } finally {
      cleanupDir(outDir)
    }
  })


  it('inconsistent config (null SM, non-null provider_tenant) → service treated as unconnected', async () => {
    const srv = 'sap.capire.flights'
    await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv, provider_service_manager: null, provider_tenant: 'prov-t1' })

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv])
    }
    cds.xt = { containerManager: { newInstance: () => ({ get: async () => ({ credentials: {} }) }) } }

    const outDir = await makeTempOutDir([srv])
    try {
      const data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // Files should have been removed (treated as unconnected)
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(outDir, `src/gen/${srv}.hdbgrants`))).to.be.false

      expect(data.options._).to.be.undefined
    } finally {
      cleanupDir(outDir)
      await DELETE.from('cds.dataproducts.synonyms.Registry')
    }
  })


  it('shared gen/base out-dir is copied to a private temp dir before file removal', async () => {
    const srv = 'sap.capire.flights'
    // no config → srv will be in unconnected_services, triggering the copy

    cds.services['cds.xt.ModelProviderService'] = {
      getCsn: async () => makeCsn([srv])
    }
    cds.xt = { containerManager: { newInstance: () => ({ get: async () => null }) } }

    // Create the shared base dir with path ending in gen/base
    const sharedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-syn-base-'))
    const outDir = path.join(sharedBase, 'gen', 'base')
    fs.mkdirSync(path.join(outDir, 'cfg', 'gen'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'src', 'gen'), { recursive: true })
    fs.writeFileSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`), '{}')
    fs.writeFileSync(path.join(outDir, `src/gen/${srv}.hdbgrants`), '{}')

    let data
    try {
      data = {
        tenant: 'tenant-1',
        options: { out: outDir, container: { credentials: { schema: 'CONTAINER_SCHEMA' } } }
      }

      await ds.fire(data)

      // data.options.out must have been redirected to a new temp dir (not the original gen/base)
      expect(data.options.out).to.not.equal(outDir)
      expect(data.options.out).to.not.include('gen/base')

      // Original shared dir is untouched
      expect(fs.existsSync(path.join(outDir, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.true
      expect(fs.existsSync(path.join(outDir, `src/gen/${srv}.hdbgrants`))).to.be.true

      // Private copy has the files removed
      expect(fs.existsSync(path.join(data.options.out, `cfg/gen/${srv}.hdbsynonymconfig`))).to.be.false
      expect(fs.existsSync(path.join(data.options.out, `src/gen/${srv}.hdbgrants`))).to.be.false
    } finally {
      cleanupDir(sharedBase)
      if (data?.options.out && data.options.out !== outDir) cleanupDir(data.options.out)
    }
  })

})
