using { cds.dataproducts.synonyms as internal } from './int-schema';

// these services are part of MTX sidecar's model

@requires: 'any'
@path: '/-/cds/readconf'
service Exposure {
  @cds.persistence.skip
  entity Registry (tenant: String) as projection on internal.Registry;
  @readonly @cds.persistence.skip
  entity Synonyms (tenant: String) as projection on internal.Synonyms;
  @readonly @cds.persistence.skip
  entity Status   (tenant: String) as projection on internal.Status;
}


@rest
@requires: 'any'
@path: '/-/cds/synonymapi'
service ConfigService {
  action echo     (msg: String)                                                         returns String;
  action getConfig(tenant:String)                                                       returns String;
  action check    (tenant:String, srv: String)                                          returns String;
  // target: service manager name for the target container, null = explicitly unconnect (overrides static config)
  action setDynamicConfig   (tenant:String, srv: String, target: String, triggerUpgrade: Boolean) returns String;
  action deleteDynamicConfig(tenant:String, srv: String,                 triggerUpgrade: Boolean) returns String;
}
