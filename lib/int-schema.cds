// Namespace 'cds.xt' is protected by MTX Extensibility: extensions cannot read (project),
// extend, annotate or define here. This keeps the connect-state table out of reach of extension
// developers (see doc-private/registry-protected-namespace.md).
// Keep in sync with the REGISTRY constant in lib/config-helper.js.
namespace cds.xt.synonyms;

// this entity is part of MTX's model and the application's model

// Per-SM connect state, written by the ConfigService connect/unconnect actions.
// The unit of connect/disconnect is the service manager (SM): all CDS services
// mapped to an SM (via static config) connect/disconnect together.
//   row present  -> SM is connected
//   no row       -> SM is disconnected
// provider_tenant is only stored when the SM's static config sets
// 'allow-api-provider-tenant'; otherwise it stays null and the own (deploying)
// tenant is used.
entity Registry {
  key provider_service_manager : String(300);  // the service manager of the provider system
  provider_tenant              : String(300);  // tenant in the provider system (only if allowed by static config)
}
