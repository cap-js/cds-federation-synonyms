'use strict'

// Full handler test for the MTX ConfigService connect/unconnect actions.
// Boots the service via cds.serve, stubs the DeploymentService, and drives the
// actions with srv.send. Static config is provided through cds.env.requires
// (config-helper falls back to cds.env when no ModelProviderService root is set).

const cds = require('@sap/cds')
const { expect } = cds.test.chai

cds.test().in(__dirname + '/..')

const MODEL = __dirname + '/../lib/mtx-service.cds'
const IMPL  = __dirname + '/../lib/mtx-service.js'
const REG   = 'cds.dataproducts.synonyms.Registry'

let srv, ds
const auditEvents = []   // captured audit-log emissions (reset per test)

function addSrvConfig(srv, sm) {
  cds.env.requires[srv] = { synonyms: { 'service-manager': sm } }
}
function addSmConfig(sm, { connect_mode, allowApiProviderTenant } = {}) {
  const synonyms = {}
  if (connect_mode !== undefined) synonyms.connect_mode = connect_mode
  if (allowApiProviderTenant !== undefined) synonyms['allow-api-provider-tenant'] = allowApiProviderTenant
  cds.env.requires[sm] = { credentials: { clientid: 'id' }, synonyms }
}
function cleanupRequires() {
  for (const k of Object.keys(cds.env.requires)) {
    if (k.startsWith('svc-') || k.startsWith('sm-')) delete cds.env.requires[k]
  }
}

// invoke an action as a privileged internal user
function call(action, data) {
  return cds.tx({ user: cds.User.privileged }, () => srv.send(action, data))
}
async function expectReject(action, data, msgIncludes) {
  let err
  try { await call(action, data) } catch (e) { err = e }
  expect(err, 'expected the action to be rejected').to.exist
  if (msgIncludes) expect(err.message).to.include(msgIncludes)
  return err
}
function rows() {
  return SELECT.from(REG)
}
// query the resolved config via the API (getConfig returns a JSON string)
async function getConfig(tenant = 't1') {
  const body = await cds.tx({ user: cds.User.privileged }, () => srv.send('getConfig', { tenant }))
  return JSON.parse(body)
}


beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  // audit-log: console target, no persistent outbox (so the test needs no outbox
  // table and emits are synchronous and captureable)
  cds.env.requires['audit-log'] = { kind: 'audit-log-to-console', outbox: false }
  const model = cds.linked(await cds.load(MODEL))  // linked so cds.model.definitions[...] are real entities
  cds.model = model
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(model)) await db.run(stmt)
  srv = await cds.serve('ConfigService', { from: MODEL, impl: IMPL })
  cds.model = model  // ensure the linked Registry definition is reachable for the handlers
  // capture every audit event the handlers emit
  const auditSrv = await cds.connect.to('audit-log')
  auditSrv.before('*', req => auditEvents.push({ event: req.event, data: structuredClone(req.data) }))
})

afterAll(() => cds.disconnect())

beforeEach(async () => {
  await DELETE.from(REG)
  cleanupRequires()
  auditEvents.length = 0
  // stub DeploymentService: t1 is a known tenant; upgrade records its calls
  const upgradeCalls = []
  ds = { getTenants: async () => ['t1'], upgrade: async t => { upgradeCalls.push(t) }, upgradeCalls }
  cds.services['cds.xt.DeploymentService'] = ds
})


describe('ConfigService.connect', () => {

  it('rejects when the tenant parameter is missing', async () => {
    addSmConfig('sm-a', { connect_mode: 'dynamic' }); addSrvConfig('svc-a', 'sm-a')
    await expectReject('connect', { providerServiceManager: 'sm-a' }, 'tenant parameter missing')
  })

  it('rejects an unknown tenant', async () => {
    addSmConfig('sm-a', { connect_mode: 'dynamic' }); addSrvConfig('svc-a', 'sm-a')
    await expectReject('connect', { tenant: 't-unknown', providerServiceManager: 'sm-a' }, 'tenant not found')
  })

  it('rejects an SM that is not statically declared (allowlist)', async () => {
    await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-unknown' }, 'unknown service manager')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('rejects a statically connected SM', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'static' })
    await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-a' }, 'statically controlled')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('rejects a provider_tenant when allow-api-provider-tenant is not set', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1' }, 'providerTenant not allowed')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('connects a dynamically connected SM: writes a row, no provider_tenant, no upgrade by default', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_service_manager).to.equal('sm-a')
    expect(result[0].provider_tenant).to.be.null
    expect(ds.upgradeCalls).to.have.lengthOf(0)
  })

  it('stores the provider_tenant when allowed and triggers an upgrade on request', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1', triggerUpgrade: true })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_tenant).to.equal('pt1')
    expect(ds.upgradeCalls).to.deep.equal(['t1'])
  })

  it('connect is idempotent (upsert) for the same SM', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt2' })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_tenant).to.equal('pt2')
  })

})


describe('ConfigService.unconnect', () => {

  it('rejects when the providerServiceManager parameter is missing', async () => {
    await expectReject('unconnect', { tenant: 't1' }, 'providerServiceManager parameter missing')
  })

  it('clears a stale row for an SM that is no longer statically declared (cleanup)', async () => {
    // no static config for sm-stale -> connect would reject it, but unconnect must still clean it up
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-stale', provider_tenant: null })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-stale' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('clears a stale row for a statically connected SM (cleanup)', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'static' })
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-a', provider_tenant: null })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('deletes the row for a dynamically connected SM', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-a', provider_tenant: null })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('is idempotent when no row exists, and triggers upgrade on request', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a', triggerUpgrade: true })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
    expect(ds.upgradeCalls).to.deep.equal(['t1'])
  })

})


describe('ConfigService config round-trip (set via API, read back via getConfig)', () => {

  it('getConfig shows a dynamically connected SM as disconnected until connected', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { service: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects a connect', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects the provider_tenant when allowed', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { service: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'pt1', connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects an unconnect (back to disconnected)', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a' })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { service: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig connects all services of the SM together', async () => {
    addSrvConfig('svc-a', 'sm-shared'); addSrvConfig('svc-b', 'sm-shared')
    addSmConfig('sm-shared', { connect_mode: 'dynamic' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-shared' })
    const config = (await getConfig()).sort((a, b) => a.service.localeCompare(b.service))
    expect(config[0]).to.deep.equal(
      { service: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
    expect(config[1]).to.deep.equal(
      { service: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
  })

})


const configEvents = () => auditEvents.filter(e => e.event === 'ConfigurationModified')
const securityEvents = () => auditEvents.filter(e => e.event === 'SecurityEvent')

describe('ConfigService audit logging', () => {

  it('connect emits ConfigurationModified with before/after attributes', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const ev = configEvents()
    expect(ev).to.have.lengthOf(1)
    expect(ev[0].data.tenant).to.equal('$PROVIDER')   // written to the provider account
    expect(ev[0].data.object).to.deep.equal({
      type: 'cds.dataproducts.synonyms.Registry',
      id: { tenant: 't1', provider_service_manager: 'sm-a' }   // app tenant preserved here
    })
    expect(ev[0].data.attributes).to.deep.include({ name: 'provider_service_manager', old: null, new: 'sm-a' })
    // provider_tenant was null before and after -> unchanged -> not listed
    expect(ev[0].data.attributes.map(a => a.name)).to.not.include('provider_tenant')
  })

  it('connect records the provider_tenant transition when allowed', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1' })
    expect(configEvents()[0].data.attributes).to.deep.include({ name: 'provider_tenant', old: null, new: 'pt1' })
  })

  it('re-connect records the previous values as old', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic', allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1' })
    auditEvents.length = 0
    await call('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt2' })
    const attrs = configEvents()[0].data.attributes
    // provider_service_manager is unchanged (sm-a -> sm-a) so it is not listed
    expect(attrs.map(a => a.name)).to.not.include('provider_service_manager')
    expect(attrs).to.deep.include({ name: 'provider_tenant', old: 'pt1', new: 'pt2' })
  })

  it('unconnect of an existing row emits ConfigurationModified with new=null', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-a', provider_tenant: 'pt1' })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a' })
    const ev = configEvents()
    expect(ev).to.have.lengthOf(1)
    expect(ev[0].data.attributes).to.deep.include({ name: 'provider_service_manager', old: 'sm-a', new: null })
    expect(ev[0].data.attributes).to.deep.include({ name: 'provider_tenant', old: 'pt1', new: null })
  })

  it('unconnect of a non-existent row emits nothing', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await call('unconnect', { tenant: 't1', providerServiceManager: 'sm-a' })
    expect(auditEvents).to.have.lengthOf(0)
  })

  it('a denied connect (unknown sm) emits a SecurityEvent and no ConfigurationModified', async () => {
    await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-unknown' }, 'unknown service manager')
    const sec = securityEvents()
    expect(sec).to.have.lengthOf(1)
    expect(sec[0].data.tenant).to.equal('$PROVIDER')          // written to the provider account
    expect(sec[0].data.data.action).to.equal('connect')
    expect(sec[0].data.data.tenant).to.equal('t1')            // app tenant preserved in the event data
    expect(sec[0].data.data.service_manager).to.equal('sm-unknown')
    expect(sec[0].data.data.reason).to.include('unknown service manager')
    expect(configEvents()).to.have.lengthOf(0)
  })

  it('a denied connect (providerTenant not allowed) records the attempted provider_tenant', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-a', providerTenant: 'pt1' }, 'providerTenant not allowed')
    const sec = securityEvents()[0]
    expect(sec.data.data.provider_tenant).to.equal('pt1')
    expect(sec.data.data.reason).to.include('providerTenant not allowed')
  })

  it('a missing or unknown tenant is NOT audited', async () => {
    await expectReject('connect', { providerServiceManager: 'sm-a' }, 'tenant parameter missing')
    await expectReject('connect', { tenant: 't-unknown', providerServiceManager: 'sm-a' }, 'tenant not found')
    expect(auditEvents).to.have.lengthOf(0)
  })

  it('rejects connect with 503 and writes nothing when the audit log is unavailable', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { connect_mode: 'dynamic' })
    const real = cds.connect.to.bind(cds.connect)
    const spy = jest.spyOn(cds.connect, 'to').mockImplementation(name =>
      name === 'audit-log' ? Promise.reject(new Error('no audit binding')) : real(name))
    try {
      await expectReject('connect', { tenant: 't1', providerServiceManager: 'sm-a' }, 'audit log unavailable')
      expect(await rows()).to.have.lengthOf(0)
    } finally {
      spy.mockRestore()
    }
  })

})
