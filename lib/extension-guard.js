'use strict'

// Reject CDS extensions that try to contribute the synonym federation annotations
// (@data.product:'via-synonym' + @cds.external) onto a service.
//
// Those annotations mark a service for synonym-based data federation, which only the application
// operator (base model) may declare; an extension developer must never be able to introduce them.
// We enforce this at extension validation time so an offending extension is rejected at
// push/activate, not silently ignored at deploy.
//
// This runs only inside an MTX sidecar that has the ExtensibilityService: we hook it via the
// per-service 'serving' event (no require('@sap/cds-mtxs')), so single-tenant apps that never
// serve that service are an automatic no-op.

const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

// Scan the extension CSN returned by ModelProviderService.getExtensions
// ({ definitions, extensions }) for services the extension contributes the federation
// annotations to. Returns the list of offending service/target names.
//
// Covers both ways an extension can add them:
//  - a NEW service definition carrying the annotations -> extCsn.definitions[name]
//  - an annotate/extend that adds them to an existing service -> extCsn.extensions[] entries
function findOffendingServices(extCsn) {
  const contributed = {} // target name -> { dataProduct, external }
  const note = (name, src) => {
    const c = (contributed[name] ??= {})
    if ('@data.product' in src) c.dataProduct = src['@data.product']
    if ('@cds.external' in src) c.external = src['@cds.external']
  }

  for (const [name, def] of Object.entries(extCsn?.definitions ?? {})) {
    if (def && def.kind === 'service') note(name, def)
  }
  for (const ext of extCsn?.extensions ?? []) {
    const target = ext?.annotate ?? ext?.extend
    if (target) note(target, ext)
  }

  return Object.entries(contributed)
    .filter(([, c]) => c.dataProduct === 'via-synonym' && c.external === true)
    .map(([name]) => name)
}

function installExtensionGuard() {
  // Attach via the per-service 'serving' event rather than 'served': in an MTX sidecar the
  // ExtensibilityService may be served lazily (cds-mtxs serves it via its own cds.serve().in(app)),
  // so it is not yet in cds.services at the global 'served' event. 'serving' fires for the service
  // whenever/however it is served; single-tenant apps never serve it, so this stays a no-op.
  cds.on('serving', (srv) => {
    if (srv.name !== 'cds.xt.ExtensibilityService') return

    srv.after('validate', async (result, req) => {
      const mps = cds.services['cds.xt.ModelProviderService']
      if (!mps || !Array.isArray(result?.errors)) return
      const tenant = req.data?.tenant ?? req.tenant ?? cds.context?.tenant
      let extCsn
      try {
        extCsn = await mps.getExtensions(tenant, { inactive: [req.data.ID] })
      } catch (e) {
        // Fail closed: the validate handler itself just fetched the same extension, so a failure
        // here is unexpected. Block rather than let a potentially offending extension through.
        LOG.error('extension-guard: could not fetch extension for validation', e)
        result.errors.push({ severity: 'Error', message: 'extension could not be validated for synonym-federation safety' })
        return
      }
      for (const name of findOffendingServices(extCsn)) {
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
module.exports.findOffendingServices = findOffendingServices
