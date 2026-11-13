// Mirrors lib/int-schema.cds so extensions in these tests can attempt to read the real connect-state
// table. In production this entity is contributed by the sidecar's int-schema.
namespace cds.xt.synonyms;

entity Registry {
  key provider_service_manager : String(300);
  provider_tenant              : String(300);
}
