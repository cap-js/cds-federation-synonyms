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
})
