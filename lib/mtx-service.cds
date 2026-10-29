using from './int-schema';  // ensure that int-schema.cds is included in the model

// this service is part of MTX sidecar's model

@rest
@requires: ['internal-user']
@path: '/-/cds/synonymapi'
service ConfigService {
  action getConfig(tenant:String)                        returns String;
  // connect / unconnect set the desired connect state of a whole service manager (SM): all CDS
  // services statically mapped to the SM are connected/disconnected together. This only records the
  // intent; it takes effect on the next tenant deploy (best-effort: a service stays unconnected if no
  // SM credentials / provider container are found). Pass triggerUpgrade to apply it immediately.
  //   connect:
  //     - sm must be statically declared (referenced by a service mapping) and configured as
  //       'deferred' (API-controlled); otherwise the call is rejected
  //     - provider_tenant is accepted only if the SM's static config sets
  //       'allow-api-provider-tenant'; otherwise the deploying tenant is used
  //   unconnect:
  //     - only deletes the SM's connect-state row (the safe direction); NOT gated by the allowlist /
  //       'deferred' flag, so it can also clean up stale rows left by a static-config change
  action connect  (tenant:String, sm: String, provider_tenant: String, triggerUpgrade: Boolean) returns String;
  action unconnect(tenant:String, sm: String,                          triggerUpgrade: Boolean) returns String;
  action check    (tenant:String, srv: String)           returns String;

  @readonly @cds.persistence.skip
  entity Status (tenant: String) {
    key SCHEMA_NAME  : String(256);
    key SYNONYM_NAME : String(256);
    OBJECT_SCHEMA    : String(256);
    OBJECT_NAME      : String(256);
    STATUS           : String(256);
    IS_VALID         : String(5);
    CREATE_TIME      : Timestamp;
  }
}
