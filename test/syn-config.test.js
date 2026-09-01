'use strict'

// E2E test for the mtx synonymapi endpoints.
// Requires a running deployed app and tokens fetched via get-tokens.sh.
//
// Create test/.env with (see .env-template):
//   domain, tenant_id, mtx_host, mtx_token

const SRV            = 'sap.capire.flights.FlightsService_syn'
const TARGET         = 'xflights-db'
const TRIGGER_UPGRADE  = true
const UPGRADE_TIMEOUT  = 300_000  // 5 minutes; only used when TRIGGER_UPGRADE is true

const path = require('path')
const fs   = require('fs')

const ENV_FILE = path.join(__dirname, '.env')

function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) return null
  return Object.fromEntries(
    fs.readFileSync(ENV_FILE, 'utf-8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => l.split('=').map(s => s.trim()))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, v.join('=')])  // handle values that contain '='
  )
}

const env = loadEnv()

if (!env) {
  test.skip('syn-config E2E tests skipped: test/.env not found', () => {})
} else {

  const { domain, tenant_id, mtx_host, mtx_token } = env
  const missingVars = ['domain', 'tenant_id', 'mtx_host', 'mtx_token'].filter(k => !env[k])
  if (missingVars.length) {
    test.skip(`syn-config E2E tests skipped: missing .env vars: ${missingVars.join(', ')}`, () => {})
  } else {

    const mtx_url  = `https://${mtx_host}.${domain}`
    const mtx_base = `${mtx_url}/-/cds/synonymapi`

    let staticEntry  // static config entry for SRV from initial getConfig, null if none

    async function post(action, body = {}) {
      const res = await fetch(`${mtx_base}/${action}`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${mtx_token}`,
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      return { status: res.status, body: text }
    }

    async function getConfig() {
      const { status, body } = await post('getConfig', { tenant: tenant_id })
      expect(status).toBe(200)
      return JSON.parse(body)
    }

    async function check() {
      const { status, body } = await post('check', { tenant: tenant_id, srv: SRV })
      expect(status).toBe(200)
      return JSON.parse(body)
    }

    async function setDynamicConfig() {
      const { status, body } = await post('setDynamicConfig', { tenant: tenant_id, srv: SRV, target: TARGET, triggerUpgrade: TRIGGER_UPGRADE })
      expect(status).toBe(200)
      return body
    }

    async function deleteDynamicConfig() {
      const { status, body } = await post('deleteDynamicConfig', { tenant: tenant_id, srv: SRV, triggerUpgrade: TRIGGER_UPGRADE })
      expect(status).toBe(200)
      return body
    }

    function parseSynonyms(synonyms) {
      const m = (synonyms ?? '').match(/(\d+)\s+connected,\s*(\d+)\s+unconnected/)
      return { nConnected: m ? parseInt(m[1]) : 0, nUnconnected: m ? parseInt(m[2]) : 0 }
    }


    beforeAll(async () => {
      // // fetch CSRF token (not needed for direct mtx calls — CSRF is enforced by approuter, not srv)
      // const res = await fetch(`${tenant_url}/odata/v4/Travel`, {
      //   headers: { 'x-approuter-authorization': `Bearer ${token}`, 'x-csrf-token': 'fetch' }
      // })
      // csrf_token = res.headers.get('x-csrf-token')
      // expect(csrf_token).toBeTruthy()

      // read initial config to discover static entries — drives assertions throughout the test
      const { status, body } = await post('getConfig', { tenant: tenant_id })
      expect(status).toBe(200)
      const initialConfig = JSON.parse(body)
      staticEntry = initialConfig.find(e => e.srv === SRV && e.source.startsWith('static')) ?? null
      console.log('beforeAll - static entry for', SRV, ':', staticEntry)
    })


    describe('mtx synonymapi - setDynamicConfig/deleteDynamicConfig sequence', () => {

      it('getConfig (1) - initial state', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        console.log('getConfig (1):', JSON.stringify(config, null, 2))
      })

      it('check (1) - initial state', async () => {
        const result = await check()
        console.log('check (1):', result)
      })

      it('setDynamicConfig (2)', async () => {
        const result = await setDynamicConfig()
        console.log('setDynamicConfig (2):', result)
        expect(result).toMatch(SRV)
        expect(result).toMatch(TARGET)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (2) - after setDynamicConfig', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(entry).toBeDefined()
        expect(entry.target).toBe(TARGET)
        console.log('getConfig (2):', JSON.stringify(config, null, 2))
      })

      it('check (2) - after setDynamicConfig', async () => {
        const result = await check()
        console.log('check (2):', result)
        expect(result['dynamic-config']).toBe(staticEntry ? TARGET + ' (overrides static)' : TARGET)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBeGreaterThan(0)
          expect(nUnconnected).toBe(0)
        }
      })

      it('setDynamicConfig (3) - idempotent', async () => {
        const result = await setDynamicConfig()
        console.log('setDynamicConfig (3):', result)
        expect(result).toMatch(SRV)
        expect(result).toMatch(TARGET)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (3) - after setDynamicConfig (idempotent)', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entries = config.filter(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(entries).toHaveLength(1)
        console.log('getConfig (3):', JSON.stringify(config, null, 2))
      })

      it('check (3) - after setDynamicConfig (idempotent)', async () => {
        const result = await check()
        console.log('check (3):', result)
        expect(result['dynamic-config']).toBe(staticEntry ? TARGET + ' (overrides static)' : TARGET)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBeGreaterThan(0)
          expect(nUnconnected).toBe(0)
        }
      })

      it('deleteDynamicConfig (4)', async () => {
        const result = await deleteDynamicConfig()
        console.log('deleteDynamicConfig (4):', result)
        expect(result).toMatch(SRV)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (4) - after deleteDynamicConfig', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const dynamicEntry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(dynamicEntry).toBeUndefined()
        console.log('getConfig (4):', JSON.stringify(config, null, 2))
      })

      it('check (4) - after deleteDynamicConfig', async () => {
        const result = await check()
        console.log('check (4):', result)
        expect(result['dynamic-config']).toBe('not set')
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          if (staticEntry?.target) {
            expect(nConnected).toBeGreaterThan(0)
            expect(nUnconnected).toBe(0)
          } else {
            expect(nConnected).toBe(0)
            expect(nUnconnected).toBeGreaterThan(0)
          }
        }
      })

      it('deleteDynamicConfig (5) - idempotent', async () => {
        const result = await deleteDynamicConfig()
        console.log('deleteDynamicConfig (5):', result)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (5) - after deleteDynamicConfig (idempotent)', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const dynamicEntry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(dynamicEntry).toBeUndefined()
        console.log('getConfig (5):', JSON.stringify(config, null, 2))
      })

      it('check (5) - after deleteDynamicConfig (idempotent)', async () => {
        const result = await check()
        console.log('check (5):', result)
        expect(result['dynamic-config']).toBe('not set')
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          if (staticEntry?.target) {
            expect(nConnected).toBeGreaterThan(0)
            expect(nUnconnected).toBe(0)
          } else {
            expect(nConnected).toBe(0)
            expect(nUnconnected).toBeGreaterThan(0)
          }
        }
      })

      // --- null-target sequence ---

      it('setDynamicConfig (6) - set to real target', async () => {
        const result = await setDynamicConfig()
        console.log('setDynamicConfig (6):', result)
        expect(result).toMatch(SRV)
        expect(result).toMatch(TARGET)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (6) - after setDynamicConfig to real target', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(entry).toBeDefined()
        expect(entry.target).toBe(TARGET)
        console.log('getConfig (6):', JSON.stringify(config, null, 2))
      })

      it('check (6) - after setDynamicConfig to real target', async () => {
        const result = await check()
        console.log('check (6):', result)
        expect(result['dynamic-config']).toBe(staticEntry ? TARGET + ' (overrides static)' : TARGET)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBeGreaterThan(0)
          expect(nUnconnected).toBe(0)
        }
      })

      it('setDynamicConfig (7) - set to null (explicit unconnect)', async () => {
        const { status, body } = await post('setDynamicConfig', { tenant: tenant_id, srv: SRV, target: null, triggerUpgrade: TRIGGER_UPGRADE })
        expect(status).toBe(200)
        console.log('setDynamicConfig (7):', body)
        expect(body).toMatch(SRV)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (7) - after setDynamicConfig to null', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(entry).toBeDefined()
        expect(entry.target).toBeNull()
        console.log('getConfig (7):', JSON.stringify(config, null, 2))
      })

      it('check (7) - after setDynamicConfig to null', async () => {
        const result = await check()
        console.log('check (7):', result)
        expect(result['dynamic-config']).toBe(staticEntry ? 'null (overrides static)' : 'null')
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBe(0)
          expect(nUnconnected).toBeGreaterThan(0)
        }
      })

      it('deleteDynamicConfig (8)', async () => {
        const result = await deleteDynamicConfig()
        console.log('deleteDynamicConfig (8):', result)
        expect(result).toMatch(SRV)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (8) - after deleteDynamicConfig', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const dynamicEntry = config.find(e => e.srv === SRV && e.source.startsWith('dynamic'))
        expect(dynamicEntry).toBeUndefined()
        console.log('getConfig (8):', JSON.stringify(config, null, 2))
      })

      it('check (8) - after deleteDynamicConfig', async () => {
        const result = await check()
        console.log('check (8):', result)
        expect(result['dynamic-config']).toBe('not set')
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          if (staticEntry?.target) {
            expect(nConnected).toBeGreaterThan(0)
            expect(nUnconnected).toBe(0)
          } else {
            expect(nConnected).toBe(0)
            expect(nUnconnected).toBeGreaterThan(0)
          }
        }
      })

    })

  }
}
