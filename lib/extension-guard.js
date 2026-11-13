'use strict'

// Guards synonym federation against CDS extensions via ExtensibilityService and ModelProviderService:
//
//  - Federation annotations: an extension must not add, remove or change @data.product:'via-synonym'
//    or @cds.external on any service. Only the operator's base model may decide whether/how a service
//    participates in synonym federation. Checked via model diff at validate time.
//
//  - Connect-state reads: an extension must not read cds.xt.synonyms.Registry. cds-mtxs's
//    protected-namespace check misses top-level UNION views and nested sub-queries (scalar subqueries
//    in columns, EXISTS/IN in WHERE, etc.). This guard's walker covers those cases.
//
//  - Connect-state writes via CSV: an extension must not upload a CSV targeting the Registry.
//    cds-mtxs does not inspect CSV data when no extension-allowlist is configured. Checked both at
//    upload time (before UPSERT/UPDATE on Extensions, covering draft extensions that skip validate)
//    and on ModelProviderService.getExtCsvs, covering stored drafts during validation and deployment.
//
// Hooked via the per-service 'serving' event, so single-tenant apps (no ExtensibilityService) are a
// no-op and there is no @sap/cds-mtxs dependency at import time.

const cds = require('@sap/cds')
const { REGISTRY } = require('./config-helper')
const LOG = cds.log('cds-federation-synonyms')

// 4.2.0 added the protected-namespace read/projection block and the internals this guard relies
// on (getExtCsvs, getCsn option shape, validate hook).
const MIN_MTXS = '4.2.0'
const REGISTRY_CSV_ERROR = 'SYNONYM_REGISTRY_CSV'

// True if the given @sap/cds-mtxs version string is >= MIN_MTXS (4.2.0).
function mtxsVersionSufficient(version) {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 4 || (major === 4 && minor >= 2)
}

function installedMtxsSufficient() {
  try { return mtxsVersionSufficient(require('@sap/cds-mtxs/package.json').version) }
  catch { return false }
}

// `via`/`ext` pair per service; absent or null annotations collapse to false.
function federationState(csn) {
  const state = {}
  for (const [name, d] of Object.entries(csn?.definitions ?? {})) {
    if (d && d.kind === 'service') {
      state[name] = { via: d['@data.product'] === 'via-synonym', ext: !!d['@cds.external'] }
    }
  }
  return state
}

// Services whose federation state (via-synonym / @cds.external) changes between baseline and
// merged model: the extension adds/removes/changes via-synonym, or flips @cds.external on a
// via-synonym service.
function offendingServices(baselineCsn, mergedCsn) {
  const base = federationState(baselineCsn)
  const merged = federationState(mergedCsn)
  const out = []
  for (const name of new Set([...Object.keys(base), ...Object.keys(merged)])) {
    const b = base[name] ?? { via: false, ext: false }
    const m = merged[name] ?? { via: false, ext: false }
    if (b.via !== m.via) out.push(name)
    // @cds.external only matters once a service is via-synonym; we deliberately do not police it on
    // non-federation services (it is a general CAP annotation the plugin does not own).
    else if (b.via && b.ext !== m.ext) out.push(name)
  }
  return out
}

// CSV filenames that map to the Registry entity (dashes → dots, drop .csv suffix).
function registryCsvFiles(csvFileNames) {
  return (csvFileNames ?? []).filter(f => f.replace(/\.csv$/i, '').replace(/-/g, '.') === REGISTRY)
}

// True if a definition's query reads the Registry anywhere in its tree: FROM, top-level SET,
// joins, and nested sub-queries in columns/WHERE/HAVING/ON. cds-mtxs's check only covers
// SELECT.from / def.projection, missing top-level SET and all nested positions.
function readsRegistry(def) {
  const registrySource = (from) => {
    if (!from || typeof from !== 'object') return false
    const head = from.ref?.[0]
    if ((typeof head === 'string' ? head : head?.id) === REGISTRY) return true
    return Array.isArray(from.args) && from.args.some(registrySource) // join operands
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return false
    if (registrySource(node.from)) return true
    // Walk every expression container, including function args, lists and ref path filters.
    // Only FROM refs identify sources; ordinary column refs must not be mistaken for entities.
    return Object.values(node).some(visit)
  }
  return visit(def?.query) || visit(def?.projection)
}

// Definitions new in merged (vs baseline) that read the Registry.
function offendingRegistryReaders(baselineCsn, mergedCsn) {
  const base = baselineCsn?.definitions ?? {}
  const merged = mergedCsn?.definitions ?? {}
  const out = []
  for (const [name, def] of Object.entries(merged)) {
    if (!readsRegistry(def)) continue
    if (base[name] && readsRegistry(base[name])) continue   // already read it in the base model
    out.push(name)
  }
  return out
}

// Idempotency guard: prevents double-registration when both 'serving' and 'served' events fire.
const INSTALLED = Symbol.for('cds-federation-synonyms:extension-guard')

function installOn(srv) {
  if (srv?.name === 'cds.xt.ModelProviderService') {
    if (srv[INSTALLED]) return
    srv[INSTALLED] = true
    // MTX collects sources from all tags/statuses, including drafts uploaded before this guard.
    // Check the actual result consumed by both SQLite and HANA, also during tenant upgrades.
    srv.after('getExtCsvs', (csvs, req) => {
      for (const f of registryCsvFiles(Object.keys(csvs ?? {}))) {
        LOG.warn(`extension-guard: rejecting extension data - CSV targets connect-state table: ${f}`)
        req.reject({ status: 422, code: REGISTRY_CSV_ERROR,
          message: `an extension must not upload data to the synonym connect-state table (${REGISTRY})` })
      }
    })
    return
  }
  if (!srv || srv.name !== 'cds.xt.ExtensibilityService' || srv[INSTALLED]) return
  srv[INSTALLED] = true

  // Fail closed on insufficient mtxs: block all activations rather than under-protect silently.
  const mtxsOk = installedMtxsSufficient()
  if (!mtxsOk) LOG.error(`extension-guard: @sap/cds-mtxs ${MIN_MTXS} or newer is required; extension activation will be blocked until it is upgraded`)

  // Draft extensions (status=1) skip validate entirely. MTX's getExtCsvs reads ALL rows
  // (including drafts) on deployment, so a malicious CSV stored in a draft is imported when any
  // extension activates. Reject at upload instead. The compat before-handler (sync, registered in
  // init) normalises req.data.csvs to {filename: content} before this fires.
  srv.before(['UPDATE', 'UPSERT'], 'Extensions', req => {
    const csvNames = Object.keys(req.data.csvs ?? {})
    for (const f of registryCsvFiles(csvNames)) {
      LOG.warn(`extension-guard: rejecting extension upload - CSV targets connect-state table: ${f}`)
      req.reject(422, `an extension must not upload data to the synonym connect-state table (${REGISTRY})`)
    }
  })

  srv.after('validate', async (result, req) => {
    const mps = cds.services['cds.xt.ModelProviderService']
    if (!Array.isArray(result?.errors)) {
      LOG.error('extension-guard: unexpected validation result shape')
      throw new Error('extension-guard: cannot validate extension')
    }
    if (!mtxsOk) {
      result.errors.push({ severity: 'Error', message: `extension activation blocked: @sap/cds-mtxs ${MIN_MTXS} or newer is required for synonym-federation safety` })
      return
    }
    if (!mps) {
      LOG.error('extension-guard: ModelProviderService unavailable')
      result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
      return
    }
    // authoritative tenant resolved (and permission-checked) by the validate handler; not the raw payload
    const tenant = cds.context?.tenant ?? req.tenant
    if (!tenant) {
      LOG.error('extension-guard: tenant unavailable during validation')
      result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
      return
    }
    let baselineCsn, mergedCsn
    try {
      // toggles:['*'] + appid:'*' match exactly what MTX's validator and deployment see;
      // without them, feature services and cross-appid extensions are invisible to the guard.
      baselineCsn = await mps.getCsn({ tenant, toggles: ['*'], options: { appid: '*' } })
      mergedCsn = await mps.getCsn({ tenant, toggles: ['*'], activated: false, options: { inactive: [req.data.ID], appid: '*' } })
    } catch (e) {
      // fail closed: can't evaluate the model -> block rather than let it through
      LOG.error('extension-guard: could not evaluate model for validation', e)
      result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
      return
    }
    for (const name of offendingServices(baselineCsn, mergedCsn)) {
      LOG.warn(`extension-guard: rejecting extension - it changes synonym-federation annotations of service: ${name}`)
      result.errors.push({
        severity: 'Error',
        message: `an extension must not change the synonym-federation annotations (@data.product:'via-synonym' / @cds.external) of service: ${name}`
      })
    }

    // Read vector: cds-mtxs catches direct projections but misses top-level UNIONs and nested
    // sub-queries; reuse the models already fetched.
    for (const name of offendingRegistryReaders(baselineCsn, mergedCsn)) {
      LOG.warn(`extension-guard: rejecting extension - it reads the connect-state table in definition: ${name}`)
      result.errors.push({
        severity: 'Error',
        message: `an extension must not read the synonym connect-state table (${REGISTRY}) - definition: ${name}`
      })
    }

    // Inspect exactly the CSV set deployment consumes, including other tags and stored drafts.
    // The getExtCsvs hook also enforces this at deployment time if validation is not called.
    try {
      await mps.getExtCsvs({ tenant })
    } catch (e) {
      LOG.error('extension-guard: could not inspect extension data files for validation', e)
      result.errors.push({
        severity: 'Error',
        message: e.code === REGISTRY_CSV_ERROR ? e.message : 'extension could not be validated for synonym-federation safety'
      })
    }
  })

  LOG.info('extension-guard: installed after(validate) hook on ExtensibilityService')
}

function installExtensionGuard() {
  // Main HTTP process: MTX services are served lazily; catch each one as it starts.
  cds.on('serving', installOn)
  // Native activation workers: cds.serve() emits 'served' (not per-service 'serving').
  const installServices = (services) => {
    installOn(services?.['cds.xt.ModelProviderService'])
    installOn(services?.['cds.xt.ExtensibilityService'])
  }
  cds.on('served', installServices)
  // Eager install in case services were already served before this module loaded.
  installServices(cds.services)
}

module.exports = installExtensionGuard
module.exports.offendingServices = offendingServices
module.exports.offendingRegistryReaders = offendingRegistryReaders
module.exports.registryCsvFiles = registryCsvFiles
module.exports.mtxsVersionSufficient = mtxsVersionSufficient
