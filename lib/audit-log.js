'use strict'
const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

const CONFIG_OBJECT_TYPE = 'cds.dataproducts.synonyms.Registry'

// Audit entries are written to the operator's subaccount ($PROVIDER), not the subscriber
// (application) tenant; the application tenant is still carried inside the entry
// (object.id.tenant and SecurityEvent data.tenant). Cross-tenant (x-zid) writes to the
// subscriber account failed authentication in the test landscape, whereas operator
// subaccount logging always authenticates.
const AUDIT_ACCOUNT = '$PROVIDER'

// Returns the audit-log service, or null if unavailable (plugin absent or no binding).
// A warning is logged so the operator notices at startup / first call without the operation
// being blocked.
async function connectAudit() {
  try {
    return await cds.connect.to('audit-log')
  } catch (err) {
    LOG.warn('audit log unavailable - connect/unconnect will proceed without audit trail:', err.message)
    return null
  }
}

function _attr(name, oldVal, newVal) {
  return { name, old: oldVal ?? null, new: newVal ?? null }
}

// Call inside the handler's committing tx so the outboxed entry is atomic with
// the Registry write. `tenant` is set explicitly to attribute the entry to the
// application tenant being configured (not the technical MTX context).
// Best-effort: if the audit log is unavailable or the write fails, a warning is
// logged and the operation is not rolled back.
async function auditConfigChange({ tenant, sm, oldRow, newRow }) {
  const audit = await connectAudit()
  if (!audit) return
  // only list attributes that actually changed - the audit service renders every
  // listed attribute as "changed" regardless of old/new, so an unchanged one (e.g.
  // provider_tenant null->null on a plain connect) would show as a spurious change
  const attributes = [
    _attr('provider_service_manager', oldRow?.provider_service_manager, newRow?.provider_service_manager),
    _attr('provider_tenant', oldRow?.provider_tenant, newRow?.provider_tenant)
  ].filter(a => a.old !== a.new)
  if (!attributes.length) return   // nothing actually changed -> no audit entry
  try {
    await audit.log('ConfigurationModified', {
      tenant: AUDIT_ACCOUNT,
      object: { type: CONFIG_OBJECT_TYPE, id: { tenant, provider_service_manager: sm } },
      attributes
    })
  } catch (err) {
    LOG.warn('audit log write failed:', err.message)
  }
}

// SecurityEvent for a denied connect. req.reject rolls back the request's tx,
// which would discard an outboxed entry enlisted in it, so emit in its own
// committing tx. Best-effort: never let an audit failure mask the denial.
async function auditDenial({ tenant, sm, provider_tenant, action, reason }) {
  try {
    await cds.tx(async () => {
      const audit = await cds.connect.to('audit-log')
      await audit.log('SecurityEvent', {
        tenant: AUDIT_ACCOUNT,
        data: {
          object_type: CONFIG_OBJECT_TYPE,
          action,
          reason,
          tenant,
          service_manager: sm ?? null,
          provider_tenant: provider_tenant ?? null
        }
      })
    })
  } catch (err) {
    LOG.warn('audit-log - failed to record denied attempt:', err.message)
  }
}

module.exports = { connectAudit, auditConfigChange, auditDenial }
