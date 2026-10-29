'use strict'

// E2E test for the mtx synonymapi endpoints.
// Requires a running deployed app and tokens fetched via get-tokens.sh.
//
// Create test/.env with (see .env-template):
//   domain, tenant_id, mtx_host, mtx_token

const SRV                    = 'sap.capire.flights.FlightsService_syn'
const PROVIDER_SERVICE_MANAGER = 'xflights-db'
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

    async function connect() {
      const { status, body } = await post('connect', { tenant: tenant_id, sm: PROVIDER_SERVICE_MANAGER, triggerUpgrade: TRIGGER_UPGRADE })
      expect(status).toBe(200)
      return body
    }

    async function unconnect() {
      const { status, body } = await post('unconnect', { tenant: tenant_id, sm: PROVIDER_SERVICE_MANAGER, triggerUpgrade: TRIGGER_UPGRADE })
      expect(status).toBe(200)
      return body
    }

    function parseSynonyms(synonyms) {
      const m = (synonyms ?? '').match(/(\d+)\s+connected,\s*(\d+)\s+unconnected/)
      return { nConnected: m ? parseInt(m[1]) : 0, nUnconnected: m ? parseInt(m[2]) : 0 }
    }


    describe('mtx synonymapi - connect/unconnect sequence', () => {

      it('getConfig (1) - initial state', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        console.log('getConfig (1):', JSON.stringify(config, null, 2))
      })

      it('check (1) - initial state', async () => {
        const result = await check()
        console.log('check (1):', result)
      })

      it('connect (2)', async () => {
        const result = await connect()
        console.log('connect (2):', result)
        expect(result).toMatch(PROVIDER_SERVICE_MANAGER)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (2) - after connect', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV)
        expect(entry).toBeDefined()
        expect(entry.provider_service_manager).toBe(PROVIDER_SERVICE_MANAGER)
        expect(entry.provider_tenant).toBe(null)
        console.log('getConfig (2):', JSON.stringify(config, null, 2))
      })

      it('check (2) - after connect', async () => {
        const result = await check()
        console.log('check (2):', result)
        expect(result['service-manager']).toBe(PROVIDER_SERVICE_MANAGER)
        expect(result['connected']).toBe(true)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBeGreaterThan(0)
          expect(nUnconnected).toBe(0)
        }
      })

      it('connect (3) - idempotent', async () => {
        const result = await connect()
        console.log('connect (3):', result)
        expect(result).toMatch(PROVIDER_SERVICE_MANAGER)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (3) - after connect (idempotent)', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entries = config.filter(e => e.srv === SRV)
        expect(entries).toHaveLength(1)
        expect(entries[0].provider_service_manager).toBe(PROVIDER_SERVICE_MANAGER)
        console.log('getConfig (3):', JSON.stringify(config, null, 2))
      })

      it('check (3) - after connect (idempotent)', async () => {
        const result = await check()
        console.log('check (3):', result)
        expect(result['connected']).toBe(true)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBeGreaterThan(0)
          expect(nUnconnected).toBe(0)
        }
      })

      it('unconnect (4)', async () => {
        const result = await unconnect()
        console.log('unconnect (4):', result)
        expect(result).toMatch(PROVIDER_SERVICE_MANAGER)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (4) - after unconnect', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV)
        expect(entry).toBeDefined()
        expect(entry.provider_service_manager).toBeNull()
        console.log('getConfig (4):', JSON.stringify(config, null, 2))
      })

      it('check (4) - after unconnect', async () => {
        const result = await check()
        console.log('check (4):', result)
        expect(result['connected']).toBe(false)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBe(0)
          expect(nUnconnected).toBeGreaterThan(0)
        }
      })

      it('unconnect (5) - idempotent', async () => {
        const result = await unconnect()
        console.log('unconnect (5):', result)
      }, TRIGGER_UPGRADE ? UPGRADE_TIMEOUT : undefined)

      it('getConfig (5) - after unconnect (idempotent)', async () => {
        const config = await getConfig()
        expect(Array.isArray(config)).toBe(true)
        const entry = config.find(e => e.srv === SRV)
        expect(entry.provider_service_manager).toBeNull()
        console.log('getConfig (5):', JSON.stringify(config, null, 2))
      })

      it('check (5) - after unconnect (idempotent)', async () => {
        const result = await check()
        console.log('check (5):', result)
        expect(result['connected']).toBe(false)
        if (TRIGGER_UPGRADE) {
          const { nConnected, nUnconnected } = parseSynonyms(result.synonyms)
          expect(nConnected).toBe(0)
          expect(nUnconnected).toBeGreaterThan(0)
        }
      })

    })


    describe('mtx synonymapi - connect rejections (security)', () => {

      it('rejects an SM that is not statically declared', async () => {
        const { status, body } = await post('connect', { tenant: tenant_id, sm: 'does-not-exist' })
        console.log('connect unknown sm:', status, body)
        expect(status).toBe(422)
        expect(body).toMatch(/unknown service manager/)
      })

      it('rejects a provider_tenant when allow-api-provider-tenant is not set', async () => {
        const { status, body } = await post('connect', { tenant: tenant_id, sm: PROVIDER_SERVICE_MANAGER, provider_tenant: tenant_id })
        console.log('connect with provider_tenant:', status, body)
        expect(status).toBe(422)
        expect(body).toMatch(/provider_tenant not allowed/)
      })

    })
  }
}
