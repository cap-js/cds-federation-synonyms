'use strict'
const cds = require('@sap/cds')
const path = require('path')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

/**
 * Returns the effective synonym configuration, resolved per CDS service, for the deploy hook.
 *
 * Config model (two homes, read separately):
 *  - mapping cds-service -> service-manager (SM) is STATIC ONLY and lives in the MAIN APP's
 *    `cds.requires` (model intent): an imported CDS service carries
 *    `synonyms: { 'service-manager': <sm> }`. Read via getMainAppRequires().
 *    If no such entry is present, the service is never connected.
 *  - Per-SM policy lives under `synonyms` on the SM's binding entry in the SIDECAR's own
 *    `cds.requires` (next to the credential binding). Read via getSidecarRequires():
 *      deferred                   : false/absent -> static-controlled (connected on every deploy)
 *                                   true         -> API-controlled (connected iff a table row exists)
 *      allow-api-provider-tenant  : false/absent -> provider_tenant from the API is ignored (own (deploying) tenant used)
 *                                   true         -> provider_tenant stored via the API is honored
 *  - The connect state of an API-controlled SM is stored in the Registry table, keyed by SM:
 *    row present = connected, no row = disconnected.
 *
 * The output shape is kept per-service and stable for the deploy hook (lib/server.js):
 *   { srv, provider_service_manager, provider_tenant, config_origin }
 * where provider_service_manager is the SM when the service is to be connected, otherwise null
 * (so the hook leaves it unconnected / mocked). config_origin is informational (logging/check).
 */
async function getResolvedConfig() {
  const requires = getMainAppRequires()
  const policyEnv = getSidecarRequires()

  // static cds-service -> SM mappings (from the main app)
  const mappings = Object.entries(requires)
    .filter(([, conf]) => conf?.synonyms?.['service-manager'])
    .map(([srv, conf]) => ({ srv, sm: conf.synonyms['service-manager'] }))

  // per-SM connect state from the table (keyed by SM; presence = connected)
  const rowBySm = await readConnectState()

  const result = mappings.map(({ srv, sm }) => {
    const policy         = policyEnv[sm]?.synonyms ?? {}
    const deferred       = policy.deferred === true
    const allowApiTenant = policy['allow-api-provider-tenant'] === true
    // the table (connect state + provider_tenant) is only consulted for deferred SMs;
    // for static-controlled SMs any leftover row is ignored
    const row            = deferred ? rowBySm.get(sm) : undefined
    const connected      = deferred ? Boolean(row) : true
    const provider_tenant = allowApiTenant && row ? (row.provider_tenant ?? null) : null
    return {
      srv,
      provider_service_manager: connected ? sm : null,
      provider_tenant,
      config_origin: deferred ? 'api' : 'static'
    }
  })

  LOG.debug('===== getResolvedConfig - effective config:', JSON.stringify(result))
  return result
}

/**
 * Returns the check result for a single service: its static mapping/policy, the effective
 * connect state, and the actual synonym status from the DB.
 */
async function checkService(srv) {
  const requires = getMainAppRequires()
  const sm             = requires[srv]?.synonyms?.['service-manager'] ?? null
  const policy         = sm ? (getSidecarRequires()[sm]?.synonyms ?? {}) : {}
  const deferred       = policy.deferred === true
  const allowApiTenant = policy['allow-api-provider-tenant'] === true

  let row = null
  if (sm && deferred) {  // table is only relevant for deferred (API-controlled) SMs
    const rowBySm = await readConnectState()
    row = rowBySm.get(sm) ?? null
  }
  const connected = sm ? (deferred ? Boolean(row) : true) : false

  // actual synonym status from the DB
  const srvPrefix  = srv.replace(/\./g, '_').toUpperCase() + '_'
  const [sql, params] = await buildStatusSql()
  const fullSql = sql + ` AND SYNONYM_NAME LIKE ?`
  const fullParams = [...params, `${srvPrefix}%`]
  const statusRows = await cds.db.run(fullSql, fullParams)
  const nConnected   = statusRows.filter(r => r.STATUS === 'connected').length
  const nUnconnected = statusRows.filter(r => r.STATUS === 'mock').length

  const providerTenant = !connected ? 'n/a'
    : (allowApiTenant && row?.provider_tenant) ? row.provider_tenant
    : 'own tenant'

  return {
    'service-manager': sm ?? 'not mapped',
    'connect-mode':    sm ? (deferred ? 'dynamic' : 'static') : 'n/a',
    'connected':       connected,
    'provider-tenant': providerTenant,
    'synonyms':        `${nConnected} connected, ${nUnconnected} unconnected`
  }
}

/**
 * Returns the statically declared service managers (SMs) and their policy, keyed by SM name.
 * An SM is "declared" iff at least one CDS service maps to it via static config (in the main app)
 * - this set is the allowlist the connect API validates against (an SM not in here cannot be
 * connected). The per-SM policy is read from the sidecar's own env.
 *
 *   { <sm>: { deferred: Boolean, allowApiProviderTenant: Boolean }, ... }
 */
function getSmConfig() {
  const requires = getMainAppRequires()
  const policyEnv = getSidecarRequires()
  const declaredSms = new Set(
    Object.values(requires)
      .map(conf => conf?.synonyms?.['service-manager'])
      .filter(Boolean)
  )
  const result = {}
  for (const sm of declaredSms) {
    const policy = policyEnv[sm]?.synonyms ?? {}
    result[sm] = {
      deferred:               policy.deferred === true,
      allowApiProviderTenant: policy['allow-api-provider-tenant'] === true
    }
  }
  return result
}

/**
 * Reads the main app's `cds.env.requires` (not the MTX sidecar's own env).
 * Source of the static cds-service -> SM mappings.
 */
function getMainAppRequires() {
  const mpsConf = cds.requires['cds.xt.ModelProviderService'] || cds.requires.kinds['cds.xt.ModelProviderService']
  const mainEnv = mpsConf?.root ? cds.env.for('cds', path.resolve(cds.root, mpsConf.root)) : cds.env
  return mainEnv.requires ?? {}
}

/**
 * Reads the sidecar's own `cds.env.requires`. Source of the per-SM policy, which lives on the
 * SM's credential-binding entry here (same place the deploy hook reads SM credentials from).
 */
function getSidecarRequires() {
  return cds.env.requires ?? {}
}

/**
 * Reads the per-SM connect state from the Registry table and returns a Map keyed by SM.
 * May fail on the very first deployment before the table exists -> treated as "no rows".
 */
async function readConnectState() {
  let rows = []
  try {
    rows = await cds.ql.SELECT.from('cds.dataproducts.synonyms.Registry')
  } catch (e) {
    // expected on first deployment, where the table is not yet created
    LOG.debug('===== readConnectState - could not read config table:', e)
  }
  const map = new Map()
  for (const r of rows) {
    const sm = r.provider_service_manager ?? r.PROVIDER_SERVICE_MANAGER
    if (sm != null) map.set(sm, { provider_tenant: r.provider_tenant ?? r.PROVIDER_TENANT ?? null })
  }
  return map
}

/**
 * Validates the static `synonyms` config and logs warnings for misconfigurations that would
 * otherwise fail silently. Mappings are checked in the main app's env, per-SM policy in the
 * sidecar's own env:
 *
 *  - Unrecognized key in a service mapping (main app, has `service-manager`): only
 *    `service-manager` is valid; any other key (e.g. a typo) is silently ignored.
 *
 *  - Unrecognized key in an SM policy entry (sidecar, for a declared SM): only `deferred` and
 *    `allow-api-provider-tenant` are valid; anything else is silently ignored.
 *
 *  - `allow-api-provider-tenant: true` on a non-deferred SM (sidecar): the flag only takes effect
 *    when `deferred` is also set, so on a static SM it is meaningless.
 *
 *  - Orphaned `synonyms` block (sidecar): an entry with a `synonyms` block that is neither a
 *    service mapping nor referenced as an SM by any mapping. It is entirely ignored at runtime.
 */
function validateConfig() {
  const mappingEnv = getMainAppRequires()
  const policyEnv  = getSidecarRequires()
  const MAPPING_KEYS = new Set(['service-manager'])
  const POLICY_KEYS  = new Set(['deferred', 'allow-api-provider-tenant'])

  const declaredSms = new Set(
    Object.values(mappingEnv)
      .map(conf => conf?.synonyms?.['service-manager'])
      .filter(Boolean)
  )

  // mapping-key validation (main app)
  for (const [key, conf] of Object.entries(mappingEnv)) {
    if (!conf?.synonyms?.['service-manager']) continue
    for (const k of Object.keys(conf.synonyms))
      if (!MAPPING_KEYS.has(k))
        LOG.warn(`synonyms config: unrecognized key '${k}' in service mapping for '${key}' (valid: service-manager)`)
  }

  // policy-key validation + orphan detection (sidecar)
  for (const [key, conf] of Object.entries(policyEnv)) {
    if (!conf?.synonyms) continue
    if ('service-manager' in conf.synonyms) continue  // a mapping, checked above
    if (declaredSms.has(key)) {
      for (const k of Object.keys(conf.synonyms))
        if (!POLICY_KEYS.has(k))
          LOG.warn(`synonyms config: unrecognized key '${k}' in SM policy for '${key}' (valid: deferred, allow-api-provider-tenant)`)
      if (conf.synonyms['allow-api-provider-tenant'] && !conf.synonyms.deferred)
        LOG.warn(`synonyms config: 'allow-api-provider-tenant' on SM '${key}' has no effect because 'deferred' is not set`)
    } else {
      LOG.warn(`synonyms config: entry '${key}' has a 'synonyms' block but is neither a service mapping nor a declared SM -- ignored`)
    }
  }
}

module.exports = { getResolvedConfig, checkService, getSmConfig, validateConfig }
