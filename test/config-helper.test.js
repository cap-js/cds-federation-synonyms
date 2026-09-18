'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { getResolvedConfig, checkService } = require('../lib/config-helper')

// Boot in the project root so @cap-js/sqlite (nested under cds-dk) can be resolved
cds.test().in(__dirname + '/..')

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  const m = await cds.load('lib/int-schema.cds')
  cds.model = m
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(m)) await db.run(stmt)
  // Status is @cds.persistence.exists (a HANA view), so CDS doesn't generate DDL for it — create manually
  await db.run(`CREATE TABLE IF NOT EXISTS cds_dataproducts_synonyms_Status (
    SCHEMA_NAME   TEXT, SYNONYM_NAME TEXT, OBJECT_SCHEMA TEXT,
    OBJECT_NAME   TEXT, STATUS       TEXT, IS_VALID      TEXT, CREATE_TIME TEXT,
    PRIMARY KEY (SCHEMA_NAME, SYNONYM_NAME)
  )`)
})

afterAll(() => cds.disconnect())


describe('getResolvedConfig()', () => {

  beforeEach(async () => {
    await DELETE.from('cds.dataproducts.synonyms.Registry')
    // remove any hana-synonyms entries added by previous test
    for (const [k, v] of Object.entries(cds.env.requires)) {
      if (v?.kind === 'hana-synonyms') delete cds.env.requires[k]
    }
  })


  describe('static config only (no DB entries)', () => {

    it('returns empty array when no static config and no DB entries', async () => {
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([])
    })

    it('returns static entry with SM and provider tenant', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a', 'provider-tenant': 'prov-t1' }
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1', config_origin: 'static' }])
    })

    it('returns static entry without provider-tenant as null', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a' }
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, config_origin: 'static' }])
    })

    it('maps null service-manager to null provider_service_manager and null provider_tenant', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': null }
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', provider_service_manager: null, provider_tenant: null, config_origin: 'static' }])
    })

    it('returns multiple static entries', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a', 'provider-tenant': 'prov-t1' }
      cds.env.requires['svc-b'] = { kind: 'hana-synonyms', 'service-manager': 'sm-b', 'provider-tenant': 'prov-t2' }
      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.map(e => e.srv).sort()).to.deep.equal(['svc-a', 'svc-b'])
    })

  })


  describe('dynamic config only (DB entries, no static config)', () => {

    it('returns dynamic entry from DB', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1' })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1', config_origin: 'dynamic' }])
    })

    it('returns null provider_service_manager from DB', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: null, provider_tenant: null })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', provider_service_manager: null, provider_tenant: null, config_origin: 'dynamic' }])
    })

    it('passes through inconsistent config (null SM with non-null tenant) without coercion', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: null, provider_tenant: 'prov-t1' })
      const result = await getResolvedConfig()
      expect(result[0].provider_service_manager).to.be.null
      expect(result[0].provider_tenant).to.equal('prov-t1')
    })

    it('returns multiple dynamic entries', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries([
        { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1' },
        { srv: 'svc-b', provider_service_manager: 'sm-b', provider_tenant: 'prov-t2' }
      ])
      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.map(e => e.srv).sort()).to.deep.equal(['svc-a', 'svc-b'])
    })

  })


  describe('dynamic overrides static', () => {

    it('dynamic entry overrides static entry for same srv — static suppressed by default', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static', 'provider-tenant': 'prov-static' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: 'sm-dynamic', provider_tenant: 'prov-dynamic' })

      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.deep.equal({ srv: 'svc-a', provider_service_manager: 'sm-dynamic', provider_tenant: 'prov-dynamic', config_origin: 'dynamic (overrides static)' })
    })

    it('with all=true both entries are returned', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static', 'provider-tenant': 'prov-static' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: 'sm-dynamic', provider_tenant: 'prov-dynamic' })

      const result = await getResolvedConfig(true)
      expect(result).to.have.lengthOf(2)
      expect(result.find(e => e.config_origin === 'dynamic (overrides static)')).to.exist
      expect(result.find(e => e.config_origin === 'static')).to.exist
    })

    it('static entry without dynamic override is kept', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static-a', 'provider-tenant': 'prov-t1' }
      cds.env.requires['svc-b'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static-b', 'provider-tenant': 'prov-t2' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: 'sm-dynamic', provider_tenant: 'prov-dynamic' })

      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.find(e => e.srv === 'svc-a').config_origin).to.equal('dynamic (overrides static)')
      expect(result.find(e => e.srv === 'svc-b').config_origin).to.equal('static')
    })

  })

})


describe('checkService()', () => {

  beforeEach(async () => {
    await DELETE.from('cds.dataproducts.synonyms.Registry')
    for (const [k, v] of Object.entries(cds.env.requires)) {
      if (v?.kind === 'hana-synonyms') delete cds.env.requires[k]
    }
  })

  it('returns not-set labels when no config exists', async () => {
    const result = await checkService('svc-a')
    expect(result['static-config']).to.equal('not set')
    expect(result['dynamic-config']).to.equal('not set')
    expect(result.warnings).to.be.undefined
  })

  it('returns SM/tenant label for static config', async () => {
    cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a', 'provider-tenant': 'prov-t1' }
    const result = await checkService('svc-a')
    expect(result['static-config']).to.equal('sm-a / prov-t1')
    expect(result['dynamic-config']).to.equal('not set')
    expect(result.warnings).to.be.undefined
  })

  it('adds warnings when effective config has null SM but non-null provider_tenant', async () => {
    await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: null, provider_tenant: 'prov-t1' })
    const result = await checkService('svc-a')
    expect(result.warnings).to.be.an('array').with.lengthOf(1)
    expect(result.warnings[0]).to.include('provider_service_manager is null')
  })

  it('no warnings for consistent null config (SM and tenant both null)', async () => {
    await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', provider_service_manager: null, provider_tenant: null })
    const result = await checkService('svc-a')
    expect(result.warnings).to.be.undefined
  })

})
