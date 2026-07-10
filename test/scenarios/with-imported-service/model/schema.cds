
@data.product: 'via-synonym' @cds.external
service sap.capire.flights {
  entity Flights {
    key ID : Integer;
    carrier : String;
    virtual notOnDB : String;
  }
}
