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

const { getResolvedConfig, checkService, getSmConfig, validateConfig, REGISTRY } = require('../lib/config-helper')

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
function addSmConfig(sm, { connect_mode, allowApiProviderTenant } = {}) {
  const synonyms = {}
  if (connect_mode !== undefined) synonyms.connect_mode = connect_mode
  if (allowApiProviderTenant !== undefined) synonyms['allow-api-provider-tenant'] = allowApiProviderTenant
  cds.env.requires[sm] = { credentials: { kind: 'hana' }, synonyms }
}
// write per-SM connect state
function writeConfigTable(sm, provider_tenant = null) {
  return INSERT.into(REGISTRY).entries({ provider_service_manager: sm, provider_tenant })
}


describe('getResolvedConfig()', () => {

  beforeEach(async () => {
    await DELETE.from(REGISTRY)
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


  describe('statically connected SM (connect_mode absent/static)', () => {

    it('maps a service to its SM', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a')  // no connect_mode
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'static' }
      ])
    })

    it('treats a missing SM policy entry as static-controlled', async () => {
      addSrvConfig('svc-a', 'sm-a')
      // no cds.env.requires['sm-a']
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'static' }
      ])
    })

    it('ignores any table row for a statically connected SM', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'static' })
      await writeConfigTable('sm-a', 'prov-t1')  // allow-api-provider-tenant is off -> tenant ignored anyway
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'static' }
      ])
    })

    it('ignores a stray table provider_tenant for a statically connected SM even if api tenant is allowed', async () => {
      // e.g. SM was dynamic, got a row, then was switched to static
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'static', allowApiProviderTenant: true })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'static' }
      ])
    })

    it('connects all services of an SM together', async () => {
      addSrvConfig('svc-a', 'sm-shared')
      addSrvConfig('svc-b', 'sm-shared')
      addSmConfig('sm-shared')
      const result = (await getResolvedConfig()).sort((a, b) => a.service.localeCompare(b.service))
      expect(result[0]).to.deep.equal(
        { service: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'static' })
      expect(result[1]).to.deep.equal(
        { service: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'static' })
    })

  })


  describe('dynamically connected SM (connect_mode: dynamic)', () => {

    it('is disconnected when no table row exists', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'dynamic' })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' }
      ])
    })

    it('is connected when a table row exists', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'dynamic' })
      await writeConfigTable('sm-a')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'dynamic' }
      ])
    })

    it('connects/disconnects all services of the SM together', async () => {
      addSrvConfig('svc-a', 'sm-shared')
      addSrvConfig('svc-b', 'sm-shared')
      addSmConfig('sm-shared', { connect_mode: 'dynamic' })

      // no table row yet -> all services of the SM are disconnected
      const before = (await getResolvedConfig()).sort((a, b) => a.service.localeCompare(b.service))
      expect(before[0]).to.deep.equal(
        { service: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' })
      expect(before[1]).to.deep.equal(
        { service: 'svc-b', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' })

      // adding the row connects all services of the SM together
      await writeConfigTable('sm-shared')
      const after = (await getResolvedConfig()).sort((a, b) => a.service.localeCompare(b.service))
      expect(after[0]).to.deep.equal(
        { service: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
      expect(after[1]).to.deep.equal(
        { service: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
    })

  })


  describe('provider_tenant handling', () => {

    it('honors the table provider_tenant when allow-api-provider-tenant is true', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result[0]).to.deep.equal(
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'prov-t1', connect_mode: 'dynamic' }
      )
    })

    it('ignores the table provider_tenant when allow-api-provider-tenant is not set', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'dynamic' })
      await writeConfigTable('sm-a', 'prov-t1')
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'dynamic' }
      ])
    })

    it('yields null provider_tenant when allowed but the table row has no tenant', async () => {
      addSrvConfig('svc-a', 'sm-a')
      addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
      await writeConfigTable('sm-a')  // row present, but no provider_tenant
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([
        { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'dynamic' }
      ])
    })

  })

})


describe('checkService()', () => {

  beforeEach(async () => {
    await DELETE.from(REGISTRY)
    cleanupRequires()
  })

  it('reports an unmapped service', async () => {
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'providerServiceManager': 'not mapped',
      'connectMode':    'n/a',
      'connected':       false,
      'providerTenant': 'n/a',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports a static-controlled service as connected', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'providerServiceManager': 'sm-a',
      'connectMode':    'static',
      'connected':       true,
      'providerTenant': 'own tenant',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports a dynamically connected SM as disconnected without a table row', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic' })
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'providerServiceManager': 'sm-a',
      'connectMode':    'dynamic',
      'connected':       false,
      'providerTenant': 'n/a',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('reports the API provider tenant when connected and allowed', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await writeConfigTable('sm-a', 'prov-t1')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'providerServiceManager': 'sm-a',
      'connectMode':    'dynamic',
      'connected':       true,
      'providerTenant': 'prov-t1',
      'synonyms':        '0 connected, 0 unconnected'
    })
  })

  it('shows own tenant when connected but API tenant is not allowed', async () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await writeConfigTable('sm-a', 'prov-t1')
    const result = await checkService('svc-a')
    expect(result).to.deep.equal({
      'providerServiceManager': 'sm-a',
      'connectMode':    'dynamic',
      'connected':       true,
      'providerTenant': 'own tenant',
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

  it('reports default policy (static, api tenant not allowed) when SM entry is absent', () => {
    addSrvConfig('svc-a', 'sm-a')  // no sm-a policy entry
    expect(getSmConfig()['sm-a']).to.deep.equal({ dynamic: false, allowApiProviderTenant: false })
  })

  it('reflects the SM policy flags', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    expect(getSmConfig()['sm-a']).to.deep.equal({ dynamic: true, allowApiProviderTenant: true })
  })

  it('reflects allowApiProviderTenant independently of connect_mode', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'static', allowApiProviderTenant: true })
    expect(getSmConfig()['sm-a']).to.deep.equal({ dynamic: false, allowApiProviderTenant: true })
  })

  it('deduplicates an SM referenced by multiple services', () => {
    addSrvConfig('svc-a', 'sm-shared')
    addSrvConfig('svc-b', 'sm-shared')
    addSmConfig('sm-shared', { connect_mode: 'dynamic' })
    const result = getSmConfig()
    expect(Object.keys(result)).to.deep.equal(['sm-shared'])
    expect(result['sm-shared'].dynamic).to.be.true
  })

})


describe('validateConfig()', () => {

  let warnSpy

  beforeEach(() => {
    cleanupRequires()
    warnSpy = jest.spyOn(cds.log('cds-federation-synonyms'), 'warn').mockImplementation(() => {})
  })

  afterEach(() => warnSpy.mockRestore())

  // collected warning messages as a single string for easy substring matching
  function warnings() {
    return warnSpy.mock.calls.map(args => args.join(' ')).join('\n')
  }

  it('emits no warning for a valid config', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    validateConfig()
    expect(warnSpy.mock.calls.length).to.equal(0)
  })

  it('warns on an unrecognized key in a service mapping', () => {
    cds.env.requires['svc-a'] = { synonyms: { 'service-manager': 'sm-a', 'typo-key': true } }
    validateConfig()
    expect(warnings()).to.match(/unrecognized key 'typo-key' in service mapping for 'svc-a'/)
  })

  it('warns on an unrecognized key in an SM policy entry', () => {
    addSrvConfig('svc-a', 'sm-a')
    cds.env.requires['sm-a'] = { synonyms: { connect_mode: 'dynamic', 'bad-key': 1 } }
    validateConfig()
    expect(warnings()).to.match(/unrecognized key 'bad-key' in SM policy for 'sm-a'/)
  })

  it('warns when allow-api-provider-tenant is set on a statically connected SM', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { allowApiProviderTenant: true })  // no connect_mode: dynamic
    validateConfig()
    expect(warnings()).to.match(/'allow-api-provider-tenant' on SM 'sm-a' has no effect because 'connect_mode' is not 'dynamic'/)
  })

  it('does not warn when allow-api-provider-tenant is set on a dynamically connected SM', () => {
    addSrvConfig('svc-a', 'sm-a')
    addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    validateConfig()
    expect(warnings()).not.to.match(/allow-api-provider-tenant/)
  })

  it('warns on an orphaned synonyms block (neither mapping nor declared SM)', () => {
    cds.env.requires['sm-orphan'] = { synonyms: { connect_mode: 'dynamic' } }
    validateConfig()
    expect(warnings()).to.match(/entry 'sm-orphan' has a 'synonyms' block but is neither a service mapping nor a declared SM/)
  })

  it('ignores requires entries without a synonyms block', () => {
    cds.env.requires['svc-plain'] = { credentials: {} }
    validateConfig()
    expect(warnSpy.mock.calls.length).to.equal(0)
  })

})
