using { sap.capire.travels as our, sap } from '../db/schema';
using { sap.capire.xflights as x } from '../apis/capire/xflights';

@fiori @path: 'Travel'  // explicit path so Node and Java serve at the same URL (/odata/v4/Travel)
service TravelService {

  @readonly entity Travels as projection on our.Travels;

  // Also expose related entities as read-only projections
  @readonly entity TravelAgencies as projection on our.TravelAgencies;
  @readonly entity Currencies as projection on sap.common.Currencies;
  @readonly entity Countries as projection on sap.common.Countries;
  @readonly entity Flights as projection on x.Flights;
  @readonly entity Supplements as projection on x.Supplements;
}

// Custom type for percentage values
type Percentage : Integer @assert.range: [1,100];
