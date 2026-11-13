'use strict'

// Integration test for the extension guard in a NATIVE ACTIVATION WORKER
// (cds.requires.multitenancy.jobs.nativeWorkers: true). MTX activates the extension in a worker
// thread that calls cds.serve() without an HTTP app, so the generic 'serving' event is never
// emitted there. The guard must therefore also install via the 'served' event, which the worker
// does emit. Here we push an offending extension and assert the worker rejects it with 422.
//
// The worker loads the guard through the app's server.js (job-worker.js _local_cli_js); a real
// deployment loads it via cds.plugins instead, but the serve/served sequence under test is the same.
// nativeWorkers is enabled via CDS_CONFIG so this suite can share the app folder with the main-process
// suite (which runs on in-memory sqlite); the worker needs file-based sqlite, so they do not collide.

process.env.CDS_CONFIG = JSON.stringify({
  requires: { multitenancy: { jobs: { nativeWorkers: true, workerSize: 1 } } }
})
process.env.NODE_ENV = 'production'

const cds = require('@sap/cds/lib')
const { fs, path, tar } = cds.utils

const TENANT = 't1'
const USER = 'dev_t1'

describe('extension-guard native-worker integration', () => {
  // This suite uses file-based sqlite, so each run leaves per-tenant db-t*.sqlite (+ WAL/SHM) on
  // disk; stale ones from an earlier (possibly crashed) run pollute the next run. Clear them before
  // the server boots and again after the suite, to keep runs reproducible and the tree clean.
  const cleanTenantDbs = () => {
    for (const f of fs.readdirSync(__dirname))
      if (/\.sqlite(-wal|-shm)?$/.test(f)) fs.rmSync(path.join(__dirname, f), { force: true })
  }

  beforeAll(cleanTenantDbs)        // registered before cds.test() so it runs before the server boots
  const { POST } = cds.test(__dirname)

  afterAll(async () => {
    await fs.promises.rm(path.join(__dirname, 'extension-evil-worker.tgz'), { force: true })
    cleanTenantDbs()
  })

  test('rejects an offending extension activated through a native worker', async () => {
    await tar.czf(path.join(__dirname, 'extension-evil-worker.tgz'), path.join(__dirname, 'extension-evil'))

    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(TENANT)

    const tgz = await fs.promises.readFile(path.resolve(__dirname, 'extension-evil-worker.tgz'))

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

  test('rejects a stored Registry CSV draft when a native worker activates a different tag', async () => {
    const tenant = 'stored-draft-worker'
    const ds = await cds.connect.to('cds.xt.DeploymentService')
    await ds.subscribe(tenant)
    const es = await cds.connect.to('cds.xt.ExtensibilityService')
    const sources = await tar.cz(path.join(__dirname, 'extension-evil-csv'))
    await cds.tx({ tenant }, tx => tx.run(cds.ql.INSERT.into('cds.xt.Extensions').entries({
      ID: cds.utils.uuid(), tag: 'old-evil-draft', activated: 'draft',
      csn: '{"definitions":{}}', sources, timestamp: new Date().toISOString()
    })))

    await expect(cds.tx({ tenant, user: new cds.User({ id: 'dev', roles: ['cds.ExtensionDeveloper'] }) }, () =>
      es.send({ event: 'UPSERT', entity: 'Extensions',
        data: { ID: 'innocent', csn: ['{"definitions":{}}'], status: 2 } })
    )).rejects.toThrow(/connect-state table/)
    await cds.tx({ tenant }, async tx => {
      expect(await tx.run(cds.ql.SELECT.from('cds.xt.synonyms.Registry'))).toEqual([])
    })
  })
})
