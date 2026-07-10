namespace cds.dataproducts.synonyms;

// these entities are part of MTX's model and the application's model

entity Registry {
  key srv : String(300);  // name of imported CDS API service
  target : String(300);   // target container service for the synonyms
}

// the corresponding HANA object (synonym) is generated in the build plugin
@cds.persistence.exists
entity Synonyms {
  key SCHEMA_NAME        : String(256);
  key SYNONYM_NAME       : String(256);
  SYNONYM_OID            : Integer64;
  OBJECT_DATABASE_SCHEMA : String(256);
  OBJECT_DATABASE        : String(256);
  OBJECT_SCHEMA          : String(256);
  OBJECT_NAME            : String(256);
  OBJECT_TYPE            : String(32);
  IS_COLUMN_OBJECT       : String(5);
  IS_VALID               : String(5);
  CREATE_TIME            : Timestamp;
}

// the corresponding HANA object (view) is generated in the build plugin
@cds.persistence.exists
entity Status {
  key SCHEMA_NAME  : String(256);
  key SYNONYM_NAME : String(256);
  OBJECT_SCHEMA    : String(256);
  OBJECT_NAME      : String(256);
  STATUS           : String(256);
  IS_VALID         : String(5);
  CREATE_TIME      : Timestamp;
}
