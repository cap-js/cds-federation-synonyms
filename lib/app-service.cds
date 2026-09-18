using { cds.dataproducts.synonyms as internal } from './int-schema';

// these services are part of the application's model

@requires: 'any'
@path: '/readconf'
service Exposure {

  entity Registry as projection on internal.Registry;
  @readonly
  entity Synonyms as projection on internal.Synonyms where SCHEMA_NAME = current_schema();
  @readonly
  entity Status   as projection on internal.Status;
}


@rest
@requires: 'any'
@path: '/synonymapi'
service ConfigService {
  action echo     (msg: String)                          returns String;
  action getConfig()                                     returns String;
  action check    (srv: String)                          returns String;
  // provider_service_manager / provider_tenant: identify the provider container
  //   provider_tenant is optional
  //   provider_service_manager = null -> explicitly unconnect (overrides static config)
  action setDynamicConfig   (srv: String, provider_service_manager: String,
                                          provider_tenant: String,
                                          triggerUpgrade: Boolean) returns String;
  action deleteDynamicConfig(srv: String, triggerUpgrade: Boolean) returns String;
}
