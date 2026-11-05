'use strict'
const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

// TODO [revisit]: is the entity name the right audited-object type, or a more stable logical name?
const CONFIG_OBJECT_TYPE = 'cds.dataproducts.synonyms.Registry'

// Audit entries are written to the operator's subaccount ($PROVIDER), not the subscriber
// (application) tenant; the application tenant is still carried inside the entry
// (object.id.tenant and SecurityEvent data.tenant).
// TODO [revisit]: originally we logged to the subscriber (application) tenant, but
// cross-tenant (x-zid) writes failed authentication in the test landscape (free
// oauth2 audit-log plan) - and because delivery is async via the outbox, the connect
// still committed while the audit entry was silently dropped. Operator subaccount logging
// always authenticates. Reconsider per-subscriber trails where the landscape/plan supports
// cross-tenant audit writes.
const AUDIT_ACCOUNT = '$PROVIDER'

// Thrown when the audit log can't be reached (plugin absent, or no Audit Log
// Service bound in production). Carries the original `cause` for the server log
// (non-enumerable, so CAP won't leak it to the caller) and is shaped as the
// client response: 503 with a telling message. `$sanitize = false` keeps that
// message in production, where CAP otherwise replaces 5xx messages with a
// generic "Service Unavailable".
class AuditLogUnavailableError extends Error {
  constructor(cause) {
    super('audit log unavailable - connectivity change rejected; bind the SAP Audit Log Service to the MTX sidecar to enable connect/unconnect', { cause })
    this.code = '503'
    this.status = 503
    this.$sanitize = false
  }
}

// Lazy connect (not at startup) so a missing binding rejects the operation
// ("no audit, no action") instead of failing the boot.
// TODO [revisit]: no opt-out - without an audit-log target, connect/unconnect can't be used.
// The `audit-log-to-console` kind is the escape hatch (operations work, entries go to the app
// log, no service needed), so an explicit "audit off" opt-out is likely unnecessary.
async function connectAudit() {
  try {
    return await cds.connect.to('audit-log')
  } catch (err) {
    throw new AuditLogUnavailableError(err)
  }
}
function _attr(name, oldVal, newVal) {
  return { name, old: oldVal ?? null, new: newVal ?? null }
}

// Call inside the handler's committing tx so the outboxed entry is atomic with
// the Registry write. `tenant` is set explicitly to attribute the entry to the
// application tenant being configured (not the technical MTX context).
async function auditConfigChange(audit, { tenant, sm, oldRow, newRow }) {
  // only list attributes that actually changed - the audit service renders every
  // listed attribute as "changed" regardless of old/new, so an unchanged one (e.g.
  // provider_tenant null->null on a plain connect) would show as a spurious change
  const attributes = [
    _attr('provider_service_manager', oldRow?.provider_service_manager, newRow?.provider_service_manager),
    _attr('provider_tenant', oldRow?.provider_tenant, newRow?.provider_tenant)
  ].filter(a => a.old !== a.new)
  await audit.log('ConfigurationModified', {
    tenant: AUDIT_ACCOUNT,
    object: { type: CONFIG_OBJECT_TYPE, id: { tenant, provider_service_manager: sm } },
    attributes
  })
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

module.exports = { connectAudit, auditConfigChange, auditDenial, AuditLogUnavailableError }
