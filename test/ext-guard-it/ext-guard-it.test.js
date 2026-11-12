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
})
