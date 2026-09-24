using from './int-schema';  // ensure that int-schema.cds is included in the model

// this service is part of MTX sidecar's model

@rest
@requires: 'any'
@path: '/-/cds/synonymapi'
service ConfigService {
  action echo     (msg: String)                          returns String;
  action getConfig(tenant:String)                        returns String;
  // provider_service_manager / provider_tenant: identify the provider container
  //   provider_tenant is optional
  //   provider_service_manager = null -> explicitly unconnect (overrides static config)
  action setDynamicConfig   (tenant:String, srv: String, provider_service_manager: String,
                                                         provider_tenant: String,
                                                         triggerUpgrade: Boolean) returns String;
  action deleteDynamicConfig(tenant:String, srv: String, triggerUpgrade: Boolean) returns String;
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
