'use strict'

// Reject CDS extensions that change a service's synonym-federation behavior, that read the synonym
// connect-state table, or that write it via uploaded CSV data.
//
// Only the operator's base model may decide whether/how a service participates in synonym
// federation, expressed by @data.product:'via-synonym' (import when @cds.external is set, export
// when it is not). An extension must not add, remove or change that: at validate time we compare the
// model with vs without the pending extension and reject any service whose federation state differs.
// Separately, an extension must not read the connect-state table (a top-level UNION slips past
// cds-mtxs's protected-namespace check) nor upload a CSV targeting it (cds-mtxs does not cover the
// data vector when no extension-allowlist is configured) - both target cds.xt.synonyms.Registry.
// Hooked via the per-service 'serving' event, so single-tenant apps (no ExtensibilityService) are a
// no-op and there's no @sap/cds-mtxs dependency.

const cds = require('@sap/cds')
const { REGISTRY } = require('./config-helper')
const LOG = cds.log('cds-federation-synonyms')

// Minimum @sap/cds-mtxs this guard relies on: 4.2.0 introduced the protected-namespace
// projection/read block and carries the extension-activation internals (readDataCsv, the per-tenant
// Extensions sources, the getCsn option shape, the validate hook) this guard and the Registry
// namespace move depend on. On anything older, synonym-federation safety cannot be guaranteed.
const MIN_MTXS = '4.2.0'

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

// Per-service federation state: `via` = synonym data product, `ext` = @cds.external set
// Absent or null annotations collapse to false.
function federationState(csn) {
  const state = {}
  for (const [name, d] of Object.entries(csn?.definitions ?? {})) {
    if (d && d.kind === 'service') {
      state[name] = { via: d['@data.product'] === 'via-synonym', ext: !!d['@cds.external'] }
    }
  }
  return state
}

// Services whose federation state is changed by the pending extension (baseline = without it,
// merged = with it). An extension must not:
//  - add / remove / change the 'via-synonym' status of a service, or
//  - flip @cds.external on a service that is 'via-synonym' in the base.
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

// A data-CSV file name maps to a fully-qualified entity name: drop the '.csv' suffix, then dashes
// become dots (the cds-core / cds-mtxs data-file convention, mirrored from lib/utils entityNameFromCsvFile).
// Returns the file names that would write the connect-state table.
function registryCsvFiles(csvFileNames) {
  return (csvFileNames ?? []).filter(f => f.replace(/\.csv$/i, '').replace(/-/g, '.') === REGISTRY)
}

// True if a definition's query reads from the connect-state table (REGISTRY) anywhere in its
// from-tree: projection, SELECT, joins, sub-queries, and - crucially - a top-level set operation
// (UNION/INTERSECT/EXCEPT). cds-mtxs's own protected-namespace check only inspects def.query.SELECT
// / def.projection, so it misses a top-level def.query.SET; an extension can expose the Registry
// through a union view. This walker closes that hole.
function readsRegistry(def) {
  let found = false
  const visitFrom = (from) => {
    if (found || !from || typeof from !== 'object') return
    if (Array.isArray(from.ref) && from.ref.length) {
      const seg = from.ref[0]
      if ((typeof seg === 'string' ? seg : seg?.id) === REGISTRY) { found = true; return }
    }
    if (Array.isArray(from.args)) from.args.forEach(visitFrom)   // joins
    if (from.SELECT) visitQuery(from.SELECT)                     // sub-query in FROM
    if (from.SET) visitQuery(from)                               // set sub-query in FROM
  }
  const visitQuery = (q) => {
    if (found || !q || typeof q !== 'object') return
    if (q.SELECT) visitFrom(q.SELECT.from)
    if (q.SET && Array.isArray(q.SET.args)) q.SET.args.forEach(visitQuery)
    if (q.from) visitFrom(q.from)   // projection shape: def.projection has .from directly
  }
  visitQuery(def?.query ?? def?.projection ?? {})
  return found
}

// Definitions in the merged model that read the connect-state table but did not in the baseline -
// i.e. reads introduced by the pending extension. An extension has no legitimate reason to read the
// Registry, so reject any that do. Pure, for easy testing.
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

// Lists the data-CSV file names carried by the pending (inactive) extension. cds-mtxs stores the
// extension payload as a TAR in cds.xt.Extensions.sources; readDataCsv unpacks it and reads data/*.csv.
// Mirrors cds-mtxs's own private _readExtensionCsvNames. Lazy-require so single-tenant apps (which
// never reach this hook) keep no @sap/cds-mtxs dependency.
async function extensionCsvNames(tag) {
  const { readDataCsv } = require('@sap/cds-mtxs/lib/utils')
  const { fs, path, rimraf } = cds.utils
  const entry = await cds.ql.SELECT.one('sources').from('cds.xt.Extensions')
    .where({ tag: tag ?? null, activated: { '!=': 'database' } }).orderBy('timestamp desc')
  if (!entry?.sources) return []
  const root = await fs.promises.mkdtemp(path.join(fs.realpathSync(require('os').tmpdir()), 'extguard-'))
  try {
    const { csvs } = await readDataCsv(entry.sources, root)
    return Object.keys(csvs ?? {})
  } finally {
    await rimraf(root)
  }
}

// Marks a service instance as already guarded, so registering on both 'serving' and 'served'
// (see installExtensionGuard) can never attach the after('validate') handler twice.
const INSTALLED = Symbol.for('cds-federation-synonyms:extension-guard')

function installOn(srv) {
  if (!srv || srv.name !== 'cds.xt.ExtensibilityService' || srv[INSTALLED]) return
  srv[INSTALLED] = true

  // Checked once at install: an older cds-mtxs lacks the protections this guard builds on, so we
  // fail closed and reject every extension activation (below) rather than under-protect silently.
  const mtxsOk = installedMtxsSufficient()
  if (!mtxsOk) LOG.error(`extension-guard: @sap/cds-mtxs ${MIN_MTXS} or newer is required; extension activation will be blocked until it is upgraded`)

  // Draft/stored CSV bypass: an extension uploaded as a draft (status=1) never goes through the
  // validate hook, so the CSV check below would never run. An attacker can pre-load a Registry CSV
  // in a draft, then activate an unrelated harmless extension; MTX's getExtCsvs reads ALL rows
  // (draft or active) on deployment and would import the malicious CSV. Reject at upload instead,
  // before the row is written to the database. The compat before-handler (registered sync in
  // srv.init) fires first and normalises req.data.csvs to {filename: content}; our hook sees that.
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
      // baseline = activated model; merged = baseline + the pending (inactive) extension.
      // toggles:['*'] and appid:'*' make the guard see exactly what MTX's validator and deployment
      // see. Without toggles, feature services (fts/<feature>/) are missing; without appid:'*', an
      // extension carrying a different appid is filtered out. Either gap lets an extension change
      // federation annotations undetected.
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

    // Read vector: an extension must not read the connect-state table. cds-mtxs blocks a direct
    // projection of a protected-namespace artifact, but misses a top-level UNION, so a union view
    // could still expose the Registry. Reuse the merged/baseline models already fetched above.
    for (const name of offendingRegistryReaders(baselineCsn, mergedCsn)) {
      LOG.warn(`extension-guard: rejecting extension - it reads the connect-state table in definition: ${name}`)
      result.errors.push({
        severity: 'Error',
        message: `an extension must not read the synonym connect-state table (${REGISTRY}) - definition: ${name}`
      })
    }

    // Data/CSV vector: cds-mtxs's protected-namespace guard inspects only the model, not uploaded
    // CSV data, so with no extension-allowlist configured an extension can ship a CSV that writes
    // the connect-state table (cds.xt.synonyms.Registry) directly - bypassing the audited connect
    // API. The model diff above cannot see this (CSV data is not in the CSN), so inspect the data
    // files here. Fail closed, consistent with the model evaluation above.
    let csvFiles
    try {
      csvFiles = await extensionCsvNames(req.data.ID)
    } catch (e) {
      LOG.error('extension-guard: could not inspect extension data files for validation', e)
      result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
      return
    }
    for (const f of registryCsvFiles(csvFiles)) {
      LOG.warn(`extension-guard: rejecting extension - it uploads data to the connect-state table via '${f}'`)
      result.errors.push({
        severity: 'Error',
        message: `an extension must not upload data to the synonym connect-state table (${REGISTRY})`
      })
    }
  })

  LOG.info('extension-guard: installed after(validate) hook on ExtensibilityService')
}

function installExtensionGuard() {
  // Main HTTP process: MTX services are served lazily, so they are absent from cds.services at
  // 'served' and must be caught per-service via 'serving'. Single-tenant apps never serve the
  // ExtensibilityService, so this is a no-op there.
  cds.on('serving', installOn)
  // Native activation workers (cds.requires.multitenancy.jobs.nativeWorkers): the worker bootstraps
  // with cds.serve(), which emits no per-service 'serving', but does emit 'served' with the
  // ExtensibilityService already present.
  cds.on('served', (services) => installOn(services?.['cds.xt.ExtensibilityService']))
  // Listeners cannot observe events that fired before this module loaded. If the
  // ExtensibilityService is already served (e.g. this plugin initialized after cds.serve()), install
  // on it now. installOn is idempotent, so this never double-registers with the listeners above.
  installOn(cds.services['cds.xt.ExtensibilityService'])
}

module.exports = installExtensionGuard
module.exports.offendingServices = offendingServices
module.exports.offendingRegistryReaders = offendingRegistryReaders
module.exports.registryCsvFiles = registryCsvFiles
module.exports.mtxsVersionSufficient = mtxsVersionSufficient
