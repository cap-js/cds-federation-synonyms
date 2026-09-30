using from './int-schema';  // ensure that int-schema.cds is included in the model

// this service is part of the application's model

@rest
@requires: 'any'
@path: '/synonymapi'
service ConfigService {
  action echo     (msg: String)                          returns String;
  action getConfig()                                     returns String;
  // provider_service_manager / provider_tenant: identify the provider container
  //   provider_tenant is optional
  //   provider_service_manager = null -> explicitly unconnect (overrides static config)
  action setDynamicConfig   (srv: String, provider_service_manager: String,
                                          provider_tenant: String,
                                          triggerUpgrade: Boolean) returns String;
  action deleteDynamicConfig(srv: String, triggerUpgrade: Boolean) returns String;
  action check    (srv: String)                          returns String;

  @readonly @cds.persistence.skip
  entity Status {
    key SCHEMA_NAME  : String(256);
    key SYNONYM_NAME : String(256);
    OBJECT_SCHEMA    : String(256);
    OBJECT_NAME      : String(256);
    STATUS           : String(256);
    IS_VALID         : String(5);
    CREATE_TIME      : Timestamp;
  }
}
