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

function addSrvConfig(srv, sm) {
  cds.env.requires[srv] = { synonyms: { 'service-manager': sm } }
}
function addSmConfig(sm, { deferred, allowApiProviderTenant } = {}) {
  const synonyms = {}
  if (deferred !== undefined) synonyms.deferred = deferred
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
  const model = cds.linked(await cds.load(MODEL))  // linked so cds.model.definitions[...] are real entities
  cds.model = model
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(model)) await db.run(stmt)
  srv = await cds.serve('ConfigService', { from: MODEL, impl: IMPL })
  cds.model = model  // ensure the linked Registry definition is reachable for the handlers
})

afterAll(() => cds.disconnect())

beforeEach(async () => {
  await DELETE.from(REG)
  cleanupRequires()
  // stub DeploymentService: t1 is a known tenant; upgrade records its calls
  const upgradeCalls = []
  ds = { getTenants: async () => ['t1'], upgrade: async t => { upgradeCalls.push(t) }, upgradeCalls }
  cds.services['cds.xt.DeploymentService'] = ds
})


describe('ConfigService.connect', () => {

  it('rejects when the tenant parameter is missing', async () => {
    addSmConfig('sm-a', { deferred: true }); addSrvConfig('svc-a', 'sm-a')
    await expectReject('connect', { sm: 'sm-a' }, 'tenant parameter missing')
  })

  it('rejects an unknown tenant', async () => {
    addSmConfig('sm-a', { deferred: true }); addSrvConfig('svc-a', 'sm-a')
    await expectReject('connect', { tenant: 't-unknown', sm: 'sm-a' }, 'tenant not found')
  })

  it('rejects an SM that is not statically declared (allowlist)', async () => {
    await expectReject('connect', { tenant: 't1', sm: 'sm-unknown' }, 'unknown service manager')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('rejects a statically-controlled SM (not deferred)', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: false })
    await expectReject('connect', { tenant: 't1', sm: 'sm-a' }, 'statically controlled')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('rejects a provider_tenant when allow-api-provider-tenant is not set', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await expectReject('connect', { tenant: 't1', sm: 'sm-a', provider_tenant: 'pt1' }, 'provider_tenant not allowed')
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('connects a deferred SM: writes a row, no provider_tenant, no upgrade by default', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await call('connect', { tenant: 't1', sm: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_service_manager).to.equal('sm-a')
    expect(result[0].provider_tenant).to.be.null
    expect(ds.upgradeCalls).to.have.lengthOf(0)
  })

  it('stores the provider_tenant when allowed and triggers an upgrade on request', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', sm: 'sm-a', provider_tenant: 'pt1', triggerUpgrade: true })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_tenant).to.equal('pt1')
    expect(ds.upgradeCalls).to.deep.equal(['t1'])
  })

  it('connect is idempotent (upsert) for the same SM', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', sm: 'sm-a' })
    await call('connect', { tenant: 't1', sm: 'sm-a', provider_tenant: 'pt2' })
    const result = await rows()
    expect(result).to.have.lengthOf(1)
    expect(result[0].provider_tenant).to.equal('pt2')
  })

})


describe('ConfigService.unconnect', () => {

  it('rejects when the sm parameter is missing', async () => {
    await expectReject('unconnect', { tenant: 't1' }, 'sm parameter missing')
  })

  it('clears a stale row for an SM that is no longer statically declared (cleanup)', async () => {
    // no static config for sm-stale -> connect would reject it, but unconnect must still clean it up
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-stale', provider_tenant: null })
    await call('unconnect', { tenant: 't1', sm: 'sm-stale' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('clears a stale row for a statically-controlled (non-deferred) SM (cleanup)', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: false })
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-a', provider_tenant: null })
    await call('unconnect', { tenant: 't1', sm: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('deletes the row for a deferred SM', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await INSERT.into(REG).entries({ provider_service_manager: 'sm-a', provider_tenant: null })
    await call('unconnect', { tenant: 't1', sm: 'sm-a' })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
  })

  it('is idempotent when no row exists, and triggers upgrade on request', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await call('unconnect', { tenant: 't1', sm: 'sm-a', triggerUpgrade: true })
    const result = await rows()
    expect(result).to.have.lengthOf(0)
    expect(ds.upgradeCalls).to.deep.equal(['t1'])
  })

})


describe('ConfigService config round-trip (set via API, read back via getConfig)', () => {

  it('getConfig shows a deferred SM as disconnected until connected', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { srv: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects a connect', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await call('connect', { tenant: 't1', sm: 'sm-a' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects the provider_tenant when allowed', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true, allowApiProviderTenant: true })
    await call('connect', { tenant: 't1', sm: 'sm-a', provider_tenant: 'pt1' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { srv: 'svc-a', provider_service_manager: 'sm-a', provider_tenant: 'pt1', connect_mode: 'dynamic' }
    ])
  })

  it('getConfig reflects an unconnect (back to disconnected)', async () => {
    addSrvConfig('svc-a', 'sm-a'); addSmConfig('sm-a', { deferred: true })
    await call('connect', { tenant: 't1', sm: 'sm-a' })
    await call('unconnect', { tenant: 't1', sm: 'sm-a' })
    const config = await getConfig()
    expect(config).to.deep.equal([
      { srv: 'svc-a', provider_service_manager: null, provider_tenant: null, connect_mode: 'dynamic' }
    ])
  })

  it('getConfig connects all services of the SM together', async () => {
    addSrvConfig('svc-a', 'sm-shared'); addSrvConfig('svc-b', 'sm-shared')
    addSmConfig('sm-shared', { deferred: true })
    await call('connect', { tenant: 't1', sm: 'sm-shared' })
    const config = (await getConfig()).sort((a, b) => a.srv.localeCompare(b.srv))
    expect(config[0]).to.deep.equal(
      { srv: 'svc-a', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
    expect(config[1]).to.deep.equal(
      { srv: 'svc-b', provider_service_manager: 'sm-shared', provider_tenant: null, connect_mode: 'dynamic' })
  })

})
