'use strict'

// Reject CDS extensions that enable synonym-based data federation.
//
// Only the operator's base model may mark a service @data.product:'via-synonym' + @cds.external.
// At extension validate time we diff the model with vs without the pending extension and reject any
// service that gains that combination (caught even when the base already carries one annotation).
// Hooked via the per-service 'serving' event, so single-tenant apps (no ExtensibilityService) are a
// no-op and there's no @sap/cds-mtxs dependency.

const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

function servicesWithFederationCombo(csn) {
  return Object.entries(csn?.definitions ?? {})
    .filter(([, d]) => d && d.kind === 'service' && d['@data.product'] === 'via-synonym' && d['@cds.external'])
    .map(([name]) => name)
}

// Services that gain the federation combination due to the extension (in merged, not baseline).
// Pure function over two CSNs for easy testing.
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
