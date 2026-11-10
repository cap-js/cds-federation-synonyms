'use strict'

// Integration test for the extension guard, against real @sap/cds-mtxs on sqlite.
// No deployment: subscribe a tenant in-process, push an extension that adds the federation
// annotations to a service, and assert cds-mtxs rejects the push with 422 because our guard
// contributed an Error finding to validation. This exercises the real push -> validate ->
// enforcement chain, which is what guards against cds-mtxs internal-API drift.

const cds = require('@sap/cds/lib')
const { fs, path, tar } = cds.utils

// install the guard before the app is served (it registers a cds.on('served') hook)
require('../../lib/extension-guard')()

process.env.NODE_ENV = 'production'

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
})
