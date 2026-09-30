namespace cds.dataproducts.synonyms;

// this entity is part of MTX's model and the application's model

entity Registry {
  key srv                  : String(300);  // name of imported CDS API service
  provider_service_manager : String(300);  // service manager of the provider system
  provider_tenant          : String(300);  // tenant in the provider system
}
