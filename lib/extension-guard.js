'use strict'

// Reject CDS extensions that change a service's synonym-federation behavior.
//
// Only the operator's base model may decide whether/how a service participates in synonym
// federation, expressed by @data.product:'via-synonym' (import when @cds.external is set, export
// when it is not). An extension must not add, remove or change that: at validate time we compare the
// model with vs without the pending extension and reject any service whose federation state differs.
// Hooked via the per-service 'serving' event, so single-tenant apps (no ExtensibilityService) are a
// no-op and there's no @sap/cds-mtxs dependency.

const cds = require('@sap/cds')
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
    else if (b.via && b.ext !== m.ext) out.push(name)
  }
  return out
}

function installExtensionGuard() {
  cds.on('serving', (srv) => {
    if (srv.name !== 'cds.xt.ExtensibilityService') return

    srv.after('validate', async (result, req) => {
      const mps = cds.services['cds.xt.ModelProviderService']
      // single-tenant no-op is the 'serving' filter above; below is fail-closed anomaly handling
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
        // baseline = activated model; merged = baseline + the pending (inactive) extension
        baselineCsn = await mps.getCsn({ tenant })
        mergedCsn = await mps.getCsn({ tenant, activated: false, options: { inactive: [req.data.ID] } })
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
    })

    LOG.info('extension-guard: installed after(validate) hook on ExtensibilityService')
  })
}

module.exports = installExtensionGuard
module.exports.offendingServices = offendingServices
