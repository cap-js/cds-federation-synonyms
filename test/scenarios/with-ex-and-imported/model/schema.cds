// exported service
@data.product: 'via-synonym'
service sap.capire.exported {
  entity SomeEntity {
    key ID : Integer;
    name : String; 
  }
}

// imported service
@data.product: 'via-synonym' @cds.external
service sap.capire.imported {
  entity Flights {
    key ID : Integer;
    carrier : String; 
  }
}
