'use strict'

// Reject CDS extensions that change a service's synonym-federation behavior, or that write the
// synonym connect-state table via uploaded CSV data.
//
// Only the operator's base model may decide whether/how a service participates in synonym
// federation, expressed by @data.product:'via-synonym' (import when @cds.external is set, export
// when it is not). An extension must not add, remove or change that: at validate time we compare the
// model with vs without the pending extension and reject any service whose federation state differs.
// Separately, an extension must not upload a CSV targeting the connect-state table (cds.xt.synonyms.
// Registry) - cds-mtxs does not block that data vector when no extension-allowlist is configured.
// Hooked via the per-service 'serving' event, so single-tenant apps (no ExtensibilityService) are a
// no-op and there's no @sap/cds-mtxs dependency.

const cds = require('@sap/cds')
const { REGISTRY } = require('./config-helper')
const LOG = cds.log('cds-federation-synonyms')

// Per-service federation state: `via` = is it a synonym data product, `ext` = is @cds.external set
// (which selects import vs export). Absent or null annotations collapse to false.
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
//  - add / remove / change the 'via-synonym' status of a service (covers import and export), or
//  - flip @cds.external on a service that is 'via-synonym' in the base (import <-> export).
// Pure function over two CSNs for easy testing.
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
// Returns the file names that would write the connect-state table. Pure, for easy testing.
function registryCsvFiles(csvFileNames) {
  return (csvFileNames ?? []).filter(f => f.replace(/\.csv$/i, '').replace(/-/g, '.') === REGISTRY)
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

  srv.after('validate', async (result, req) => {
    const mps = cds.services['cds.xt.ModelProviderService']
    if (!Array.isArray(result?.errors)) {
      LOG.error('extension-guard: unexpected validation result shape')
      throw new Error('extension-guard: cannot validate extension')
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
module.exports.registryCsvFiles = registryCsvFiles
