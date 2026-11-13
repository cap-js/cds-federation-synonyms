'use strict'

// Integration tests for the extension guard in the MAIN process, against real @sap/cds-mtxs.
// The ExtensibilityService is served lazily and caught via the guard's per-service 'serving' hook.
// Runs on in-memory sqlite so it shares no on-disk tenant db with the native-worker suite (which
// needs file-based sqlite); that keeps the two suites safe to run in parallel in the same folder.

process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:'
process.env.NODE_ENV = 'production'

const cds = require('@sap/cds/lib')
const { fs, path, tar } = cds.utils

const TENANT = 't1'
const USER = 'dev_t1'

describe('extension-guard integration', () => {
  const { POST } = cds.test(__dirname)

  afterAll(async () => {
    await fs.promises.rm(path.join(__dirname, 'extension-evil.tgz'), { force: true })
    await fs.promises.rm(path.join(__dirname, 'extension-evil-feature.tgz'), { force: true })
    await fs.promises.rm(path.join(__dirname, 'extension-evil-csv.tgz'), { force: true })
    await fs.promises.rm(path.join(__dirname, 'extension-evil-union.tgz'), { force: true })
    await fs.promises.rm(path.join(__dirname, 'extension-evil-scalar-subquery.tgz'), { force: true })
    await fs.promises.rm(path.join(__dirname, 'extension-evil-exists-subquery.tgz'), { force: true })
  })

  test('rejects an extension that adds @data.product:via-synonym + @cds.external to a service', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil.tgz'), path.join(__dirname, 'extension-evil'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('via-synonym')
      })
    )
  })

  // An extension may carry an appid other than this application's; ModelProviderService's default
  // per-app filter then excludes it from the guard's comparison, yet deployment still applies it.
  // The guard must evaluate across all appids. Here we store the offending extension under a
  // different appid and assert it is still rejected (regression test for the appid bypass).
  test('rejects an offending extension carrying a different application ID', async () => {
    const TENANT2 = 't2'
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT2)

    const es = await cds.connect.to('cds.xt.ExtensibilityService')
    const extCsn = await fs.promises.readFile(
      path.join(__dirname, 'extension-evil', 'extension.csn'), 'utf8')

    await cds.tx({ tenant: TENANT2, user: new cds.User.Privileged() }, async () => {
      await expect(
        es.send({
          event: 'UPSERT',
          entity: 'Extensions',
          data: { ID: 'evil-alt-appid', appid: 'different-app', csn: [extCsn], status: 2 }
        })
      ).rejects.toThrow(/via-synonym/)
    })
  })

  // Feature-toggled services (fts/<feature>/) are absent from a model requested without toggles, yet
  // MTX's validator and deployment include them via toggles:['*']. The guard must pass toggles:['*']
  // too, or an extension could add federation annotations to a feature service undetected.
  test('rejects an offending extension targeting a feature-toggled service', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-feature.tgz'),
      path.join(__dirname, 'extension-evil-feature'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-feature.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('via-synonym')
      })
    )
  })

  // CSV / data vector: a data-only extension can ship a CSV targeting the connect-state table
  // (cds.xt.synonyms.Registry). cds-mtxs does not block that with no extension-allowlist configured
  // (the protected-namespace guard inspects only the model, not CSV data). The extension-guard must
  // reject it. The fixture carries NO federation annotations, so only the CSV check can trip here.
  test('rejects a data-only extension that uploads a CSV to the connect-state table', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-csv.tgz'),
      path.join(__dirname, 'extension-evil-csv'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-csv.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('connect-state table')
      })
    )
  })

  // Draft CSV bypass: a draft extension (status=1) skips the validate hook entirely, so the
  // after('validate') CSV check never fires. An attacker can store a malicious draft with a Registry
  // CSV, then activate a separate harmless extension - MTX's getExtCsvs reads ALL rows (incl.
  // drafts) on deployment and would import the CSV. The guard must reject the upload itself.
  test.each(['UPSERT', 'UPDATE'])('rejects an extension %s that stores a Registry CSV as a draft', async event => {
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const es = await cds.connect.to('cds.xt.ExtensibilityService')

    await cds.tx({ tenant: TENANT, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, async () => {
      await expect(
        es.send({
          event,
          entity: 'Extensions',
          data: {
            ID: 'evil-draft-csv',
            csn: ['{"definitions":{}}'],
            csvs: [{ name: 'cds.xt.synonyms-Registry.csv', content: 'provider_tenant\nevil_tenant' }],
            status: 1  // DRAFT - no validate will be called
          }
        })
      ).rejects.toThrow(/connect-state table/)
    })
  })

  test('blocks a stored Registry CSV draft when a different tag activates or the tenant upgrades', async () => {
    const tenant = 'stored-draft'
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(tenant)
    const es = await cds.connect.to('cds.xt.ExtensibilityService')
    const sources = await tar.cz(path.join(__dirname, 'extension-evil-csv'))

    // Model a draft stored before the upload guard was installed. It must never reach deployment.
    await cds.tx({ tenant }, async tx => {
      await tx.run(cds.ql.INSERT.into('cds.xt.Extensions').entries({
        ID: cds.utils.uuid(), tag: 'old-evil-draft', activated: 'draft',
        csn: '{"definitions":{}}', sources, timestamp: new Date().toISOString()
      }))
      expect(await tx.run(cds.ql.SELECT.from('cds.xt.synonyms.Registry'))).toEqual([])
    })

    await expect(cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions',
        data: { ID: 'innocent', csn: ['{"definitions":{}}'], status: 2 } })
    )).rejects.toThrow(/connect-state table/)

    // Upgrade does not call ExtensibilityService.validate; guard the CSVs returned to deployment too.
    await expect(ds.upgrade(tenant)).rejects.toThrow(/connect-state table/)
    await cds.tx({ tenant }, async tx => {
      expect(await tx.run(cds.ql.SELECT.from('cds.xt.synonyms.Registry'))).toEqual([])
      const rows = await tx.run(cds.ql.SELECT.from('cds.xt.Extensions').where({ activated: 'database' }))
      expect(rows).toEqual([])
    })

    // Removing the offending draft restores normal activation and upgrades.
    await cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.discard('old-evil-draft'))
    await cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions',
        data: { ID: 'innocent', csn: ['{"definitions":{}}'], status: 2 } }))
    await ds.upgrade(tenant)
  })

  test('allows ordinary CSV data from a draft during activation of another tag', async () => {
    const tenant = 'ordinary-csv'
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(tenant)
    const es = await cds.connect.to('cds.xt.ExtensibilityService')
    const id = cds.utils.uuid()
    await cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions', data: {
        ID: 'ordinary-draft', csn: ['{"definitions":{}}'], status: 1,
        csvs: [{ name: 'ext.guard-Things.csv', content: `ID;name\n${id};ordinary` }]
      } }))
    await cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions',
        data: { ID: 'innocent', csn: ['{"definitions":{}}'], status: 2 } }))
    await cds.tx({ tenant }, async tx => {
      expect(await tx.run(cds.ql.SELECT.from('ext.guard.Things'))).toEqual([{ ID: id, name: 'ordinary' }])
      expect(await tx.run(cds.ql.SELECT.from('cds.xt.synonyms.Registry'))).toEqual([])
    })
  })

  test('rejects a Registry scalar subquery nested in a function argument during activation', async () => {
    const tenant = 'nested-function'
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(tenant)
    const es = await cds.connect.to('cds.xt.ExtensibilityService')
    const extension = `using { ext.guard.Things } from './things';
    using { cds.xt.synonyms.Registry } from './registry';
    entity x_Leak as select from Things {
      key ID,
      coalesce((select from Registry { provider_tenant } limit 1), '') as secret : String
    };`

    await expect(cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions',
        data: { ID: 'nested-function', csn: [extension], status: 2 } })
    )).rejects.toThrow(/read the synonym connect-state table/)
  })

  // Read vector - nested subqueries: cds-mtxs's walker only checks top-level FROM, so a scalar
  // subquery in a SELECT column or an EXISTS subquery in WHERE can expose the Registry without
  // triggering the base check. The extension-guard's walker recurses into columns/WHERE/HAVING.
  test('rejects an extension that reads the connect-state table via a scalar subquery in columns', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-scalar-subquery.tgz'),
      path.join(__dirname, 'extension-evil-scalar-subquery'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-scalar-subquery.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('read the synonym connect-state table')
      })
    )
  })

  test('rejects an extension that reads the connect-state table via an EXISTS subquery in WHERE', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-exists-subquery.tgz'),
      path.join(__dirname, 'extension-evil-exists-subquery'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-exists-subquery.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('read the synonym connect-state table')
      })
    )
  })

  // Read vector: an extension exposes the connect-state table (cds.xt.synonyms.Registry) through a
  // top-level UNION view. cds-mtxs's protected-namespace check only inspects SELECT/projection, so
  // it misses the union; the extension-guard must reject it. The fixture carries no federation
  // annotations and no CSV, so only the read check can trip here.
  test('rejects an extension that reads the connect-state table via a UNION view', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-union.tgz'),
      path.join(__dirname, 'extension-evil-union'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-union.tgz'))

    await expect(
      POST('/-/cds/extensibility/push',
        { extension: tgz.toString('base64') },
        { auth: { username: USER } })
    ).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ status: 422 }),
        message: expect.stringContaining('read the synonym connect-state table')
      })
    )
  })
})
