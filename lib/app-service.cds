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
  action echo     (msg: String)                                          returns String;
  action getConfig()                                                     returns String;
  action check    (srv: String)                                          returns String;
  action connect  (srv: String, target: String, triggerUpgrade: Boolean) returns String;
  action unconnect(srv: String,                 triggerUpgrade: Boolean) returns String;
}
