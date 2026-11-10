'use strict'

// Reject CDS extensions that enable synonym-based data federation for a service.
//
// A service annotated @data.product:'via-synonym' + @cds.external is a federation target, which
// only the application operator (base model) may declare; an extension developer must never be
// able to introduce that combination. We check at extension validation time by comparing the model
// WITH the pending extension against the model WITHOUT it: any service that gains the federation
// combination because of the extension is rejected, so push/activate fails instead of the
// extension silently taking effect at deploy.
//
// Because we evaluate the merged model (not the extension's contribution in isolation), this also
// catches the case where the extension supplies only one of the two annotations while the base
// model already carries the other.
//
// Runs only inside an MTX sidecar that has the ExtensibilityService: we hook it via the per-service
// 'serving' event (no require('@sap/cds-mtxs')), so single-tenant apps that never serve that
// service are an automatic no-op.

const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

function servicesWithFederationCombo(csn) {
  return Object.entries(csn?.definitions ?? {})
    .filter(([, d]) => d && d.kind === 'service' && d['@data.product'] === 'via-synonym' && d['@cds.external'] === true)
    .map(([name]) => name)
}

// Services that have the federation combination in the merged model (baseline + pending extension)
// but not in the baseline model (without it) - i.e. the extension introduced it. Pure function over
// two CSNs for easy testing.
function offendingServices(baselineCsn, mergedCsn) {
  const baseline = new Set(servicesWithFederationCombo(baselineCsn))
  return servicesWithFederationCombo(mergedCsn).filter(name => !baseline.has(name))
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
      const tenant = req.data?.tenant ?? req.tenant ?? cds.context?.tenant
      let baselineCsn, mergedCsn
      try {
        // baseline = current (activated) model without the pending extension;
        // merged = that plus the pending (inactive) extension being validated
        baselineCsn = await mps.getCsn({ tenant })
        mergedCsn = await mps.getCsn({ tenant, activated: false, options: { inactive: [req.data.ID] } })
      } catch (e) {
        // Fail closed: if we cannot evaluate the model, block rather than let a potentially
        // offending extension through.
        LOG.error('extension-guard: could not evaluate model for validation', e)
        result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
        return
      }
      for (const name of offendingServices(baselineCsn, mergedCsn)) {
        LOG.warn(`extension-guard: rejecting extension - federation annotations not allowed in extensions: ${name}`)
        result.errors.push({
          severity: 'Error',
          message: `@data.product:'via-synonym' with @cds.external is not allowed in extensions: ${name}`
        })
      }
    })

    LOG.info('extension-guard: installed after(validate) hook on ExtensibilityService')
  })
}

module.exports = installExtensionGuard
module.exports.offendingServices = offendingServices
