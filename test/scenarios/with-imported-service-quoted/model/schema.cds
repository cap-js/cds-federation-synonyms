@data.product: 'via-synonym' @cds.external
@cds.persistence.namingMode: 'quoted'
service com.sap.GroundArrangements {
  entity Hotels {
    key Id          : Integer;
    Name            : String(100);
    Address_Country : String(100);
    Address_City    : String(100);
    Address_Street  : String(100);
    Rating          : Integer;
    PricePerNight   : Decimal(9, 2);
    car : Association to RentalCars on car.![Id-1] = Id;
  }

  entity RentalCars {
    key ![Id-1]  : Integer;
    key ![Id-2]  : String(2);
    Make         : String(50);
    Model        : String(50);
    LicensePlate : String(20);
    hotel : Association to Hotels on hotel.Id = ![Id-1];
  }
}
