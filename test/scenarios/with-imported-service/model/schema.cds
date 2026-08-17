
@data.product: 'via-synonym' @cds.external
service sap.capire.flights {
  @assert.unique.id1: [carrier]
  entity Flights {
    key ID : Integer;
    carrier : String;
    virtual notOnDB : String;
  }
}
