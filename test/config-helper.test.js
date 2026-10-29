'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai

// buildStatusSql targets SYS.SYNONYMS which doesn't exist in SQLite - mock it to
// return an empty result set so config-helper tests can focus on config logic
jest.mock('../lib/status-sql', () => ({
  buildStatusSql: jest.fn().mockResolvedValue([
    `SELECT NULL AS SCHEMA_NAME, NULL AS SYNONYM_NAME, NULL AS OBJECT_SCHEMA,
     NULL AS OBJECT_NAME, NULL AS STATUS, NULL AS IS_VALID, NULL AS CREATE_TIME WHERE 0`,
    []
  ])
}))

const { getResolvedConfig, checkService, getSmConfig } = require('../lib/config-helper')

// Boot in the project root so @cap-js/sqlite (nested under cds-dk) can be resolved
cds.test().in(__dirname + '/..')

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  const m = await cds.load('lib/int-schema.cds')
  cds.model = m
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(m)) await db.run(stmt)
})

afterAll(() => cds.disconnect())

// remove test-added requires entries (service mappings and SM entries use svc-/sm- prefixes)
function cleanupRequires() {
  for (const k of Object.keys(cds.env.requires)) {
    if (k.startsWith('svc-') || k.startsWith('sm-')) delete cds.env.requires[k]
  }
}

// static config helpers
function addSrvConfig(srv, sm) {
  cds.env.requires[srv] = { synonyms: { 'service-manager': sm } }
}
function addSmConfig(sm, { deferred, allowApiProviderTenant } = {}) {
  const synonyms = {}
  if (deferred !== undefined) synonyms.deferred = deferred
  if (allowApiProviderTenant !== undefined) synonyms['allow-api-provider-tenant'] = allowApiProviderTenant
  cds.env.requires[sm] = { credentials: { kind: 'hana' }, synonyms }
} 
// write per-SM connect state
function writeConfigTable(sm, provider_tenant = null) {
  return INSERT.into('cds.dataproducts.synonyms.Registry').entries({ provider_service_manager: sm, provider_tenant })
}


describe('getResolvedConfig()', () => {

  beforeEach(async () => {
    await DELETE.from('cds.dataproducts.synonyms.Registry')
    cleanupRequires()
  })


  it('returns empty array when nothing is configured', async () => {
    const result = await getResolvedConfig()
    expect(result).to.deep.equal([])
  })

  it('ignores requires entries that are not synonym mappings', async () => {
    cds.env.requires['svc-plain'] = { credentials: {} }
    const result = await getResolvedConfig()
    expect(result).to.deep.equal([])
  })

  it('ignores a table row for an SM that is not statically mapped (deploy-time defense for #38)', async () => {
    // a row for an SM that no service maps to must never produce a connection
    await writeConfigTable('sm-ghost', 'prov-t1')
    const result = await getResolvedConfig()
    expect(result).to.deep.equal([])
  })


  describe('static-controlled SM (deferred absent/false)', () => {

    it('maps a service to its SM', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a')  // no deferred
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'static' }
      ])
    })

    it('treats a missing SM policy entry as static-controlled', async () => {
      addSrvConfig('svc-a', 'sm-a')
      // no cds.env.requires['sm-a']
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'static' }
      ])
    })

    it('ignores any table row for a static-controlled SM', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: false })
      await writeConfigTable('sm-a', 'prov-t1')  // allow-api-provider-tenant is off -> tenant ignored anyway
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'static' }
      ])
    })

    it('ignores a stray table provider_tenant for a static-controlled SM even if api tenant is allowed', async () => {
      // e.g. SM was deferred, got a row, then was switched to static-controlled
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: false, allowApiProviderTenant: true })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'static' }
      ])
    })

    it('connects all services of an SM together', async () => {
      addSrvConfig('svc-a', 'sm-shared')
      addSrvConfig('svc-b', 'sm-shared')
      addSmConfig('sm-shared')
      const result = (await getResolvedConfig()).sort((a, b) => a.srv.localeCompare(b.srv))
      expect(result[0]).to.deep.equal(
        { srv: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, config_origin: 'static' })
      expect(result[1]).to.deep.equal(
        { srv: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, config_origin: 'static' })
    })

  })


  describe('API-controlled SM (deferred: true)', () => {

    it('is disconnected when no table row exists', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: true })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: null, provider_tenant: null, config_origin: 'api' }
      ])
    })

    it('is connected when a table row exists', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: true })
      await writeConfigTable('sm-a')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'api' }
      ])
    })

    it('connects/disconnects all services of the SM together', async () => {
      addSrvConfig('svc-a', 'sm-shared')
      addSrvConfig('svc-b', 'sm-shared')
      addSmConfig('sm-shared', { deferred: true })

      // no table row yet -> all services of the SM are disconnected
      const before = (await getResolvedConfig()).sort((a, b) => a.srv.localeCompare(b.srv))
      expect(before[0]).to.deep.equal(
        { srv: 'svc-a', provider_service_manager: null, provider_tenant: null, config_origin: 'api' })
      expect(before[1]).to.deep.equal(
        { srv: 'svc-b', provider_service_manager: null, provider_tenant: null, config_origin: 'api' })

      // adding the row connects all services of the SM together
      await writeConfigTable('sm-shared')
      const after = (await getResolvedConfig()).sort((a, b) => a.srv.localeCompare(b.srv))
      expect(after[0]).to.deep.equal(
        { srv: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, config_origin: 'api' })
      expect(after[1]).to.deep.equal(
        { srv: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, config_origin: 'api' })
    })

  })


  describe('provider_tenant handling', () => {

    it('honors the table provider_tenant when allow-api-provider-tenant is true', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result[0]).to.deep.equal(
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1', config_origin: 'api' }
      )
    })

    it('ignores the table provider_tenant when allow-api-provider-tenant is not set', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: true })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'api' }
      ])
    })

    it('yields null provider_tenant when allowed but the table row has no tenant', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
      await writeConfigTable('sm-a')  // row present, but no provider_tenant
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'api' }
      ])
    })

  })

})


describe('checkService()', () => {

  beforeEach(async () => {
    await DELETE.from('cds.dataproducts.synonyms.Registry')
    cleanupRequires()
  })

  it('reports an unmapped service', async () => {
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'service-manager': 'not mapped',
      'connect-mode':    'n/a',
      'connected':       false,
      'provider-tenant': 'n/a',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports a static-controlled service as connected', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'service-manager': 'sm-a',
      'connect-mode':    'static',
      'connected':       true,
      'provider-tenant': 'own tenant',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports an API-controlled service as disconnected without a table row', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { deferred: true })
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'service-manager': 'sm-a',
      'connect-mode':    'dynamic',
      'connected':       false,
      'provider-tenant': 'n/a',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports the API provider tenant when connected and allowed', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
    await writeConfigTable('sm-a', 'prov-t1')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'service-manager': 'sm-a',
      'connect-mode':    'dynamic',
      'connected':       true,
      'provider-tenant': 'prov-t1',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('shows own tenant when connected but API tenant is not allowed', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { deferred: true })
    await writeConfigTable('sm-a', 'prov-t1')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'service-manager': 'sm-a',
      'connect-mode':    'dynamic',
      'connected':       true,
      'provider-tenant': 'own tenant',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

})


describe('getSmConfig()', () => {

  beforeEach(cleanupRequires)

  it('returns an empty object when no service is mapped', () => {
    expect(getSmConfig()).to.deep.equal({})
  })

  it('lists only SMs referenced by a service mapping (the allowlist)', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-b')  // declared but not referenced by any mapping
    const result = getSmConfig()
    expect(Object.keys(result)).to.deep.equal(['sm-a'])
  })

  it('reports default policy (not deferred, api tenant not allowed) when SM entry is absent', () => {
    addSrvConfig('svc-a', 'sm-a')  // no sm-a policy entry
    expect(getSmConfig()['sm-a']).to.deep.equal({ deferred: false, allowApiProviderTenant: false })
  })

  it('reflects the SM policy flags', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
    expect(getSmConfig()['sm-a']).to.deep.equal({ deferred: true, allowApiProviderTenant: true })
  })

  it('reflects allowApiProviderTenant independently of deferred', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { deferred: false, allowApiProviderTenant: true })
    expect(getSmConfig()['sm-a']).to.deep.equal({ deferred: false, allowApiProviderTenant: true })
  })

  it('deduplicates an SM referenced by multiple services', () => {
    addSrvConfig('svc-a', 'sm-shared')
    addSrvConfig('svc-b', 'sm-shared')
    addSmConfig('sm-shared', { deferred: true })
    const result = getSmConfig()
    expect(Object.keys(result)).to.deep.equal(['sm-shared'])
    expect(result['sm-shared'].deferred).to.be.true
  })

})
