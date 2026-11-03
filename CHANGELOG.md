# Change Log

- All notable changes to this project are documented in this file.
- The format is based on [Keep a Changelog](https://keepachangelog.com/).
- This project adheres to [Semantic Versioning](https://semver.org/).

## Version 1.0.0 - TBD

### Added

- Audit logging of the `connect` / `unconnect` config-change actions via `@cap-js/audit-logging`
  (successful changes as `ConfigurationModified`, rejected attempts as `SecurityEvent`). The
  actions are rejected (HTTP 503) if no audit log is configured ("no audit, no action"). See
  [Audit logging](doc/details.md#audit-logging).
- Static config validation: at MTX sidecar startup the plugin warns about misconfigured `synonyms`
  entries (unrecognized keys, `allow-api-provider-tenant` on a statically connected SM, orphaned blocks).

### Changed

- Synonym configuration model. The service → service-manager (SM) mapping is static and lives in
  the main app's `cds.requires` as `synonyms: { "service-manager": <sm> }`. The per-SM policy
  (`connect_mode`, `allow-api-provider-tenant`) lives on the SM's binding entry in the sidecar's
  `mtx/sidecar/package.json`, next to its credentials binding.
- Connect/disconnect is now per service manager (all CDS services mapped to an SM together), via
  the `connect` / `unconnect` actions of the MTX sidecar `ConfigService` (`/-/cds/synonymapi`).
- The `Registry` table is keyed by `provider_service_manager` (row present = connected, no row =
  disconnected).

### Fixed

### Removed

- The `setDynamicConfig` / `deleteDynamicConfig` actions (replaced by `connect` / `unconnect`).

### Migration notes

- Pre-1.0 and experimental: no compatibility is guaranteed. Upgrading an existing deployment across
  the `Registry` schema change is **not supported in place**: the old service-keyed rows cannot be
  converted to the new SM-keyed primary key, so a clean redeploy is required. Only the stored
  connect-state is lost (re-establish it via the `connect` API); no business data is affected.
