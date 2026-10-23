using sap.capire.flights as x from '../db/schema';
namespace sap.capire.flights;

/**
 * Master data service providing flight-related data, e.g. Flights, Airlines,
 * Airports, and Supplements (e.g. extra luggage, meals, etc.).
 */
@data.product: 'via-synonym'
service FlightsService_syn {

  // Serve Flights data via denormalized view with flattened FlightConnections
  @readonly entity Flights as select from x.Flights left join x.FlightConnections on ID = flight.ID {
    key ID, key date, *
  } excluding { flight, createdAt, createdBy, modifiedBy } // as flight details are flattened

  // Serve Airlines with redirected association to Flights view
  @readonly entity Airlines as projection on x.Airlines { *,
    flights : redirected to Flights
  } excluding { createdAt, createdBy, modifiedBy };

  // Serve Airports with redirected associations to Flights view
  @readonly entity Airports as projection on x.Airports { *,
    departures : redirected to Flights,
    arrivals   : redirected to Flights
  } excluding { createdAt, createdBy, modifiedBy };

  // Serve Supplements data as is
  @readonly entity Supplements as projection on x.Supplements
  excluding { createdAt, createdBy, modifiedBy };
}

using { sap.common } from '@sap/cds/common';

//  Workaround for @cds.autoexpose kicking in too eagerly ...
//  - cds.autoexpose should only apply to UI/Fiori backend services, not API services
//  - cds.autoexpose should be supported on individual assocs, not only targets
//  - associations to stay in models for non-exposed targets -> currently skipped by 4odata

annotate common.Currencies with @cds.autoexpose:false;
annotate common.Countries with @cds.autoexpose:false;
annotate common.Languages with @cds.autoexpose:false;
