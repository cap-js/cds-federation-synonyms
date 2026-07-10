# Technical details

While the [walkthrough](./walktrough.md) provides only instructions to follow along,
this document adds some background information.

In general, the plugin has two jobs:
* It modifies the _cds build for HANA_.
* For multi-tenant applications, it provides an API to connect or disconnect the synonyms at runtime.


## Generated HDI files

The plugin modifies the _cds build for HANA_.

### Provider

For a service that defines an API, in addition to the regular HDI files
two _.hdbrole_ files are generated, which grant `select` privileges
to all the objects in the service.

To see the effect of the synonyms plugin on the build output for xflights, run
```sh
cds build --for hana
```
and have a look at the generated HDI files in folder _gen/db/src/gen_.

There are two role definition files,
_sap.capire.flights.data_syn#.hdbrole_ and _sap.capire.flights.data_syn.hdbrole_,
that provide `SELECT` access to the HANA views that correspond to the entities
in the API service.

File _sap.capire.flights.data\_syn#.hdbrole_:

```jsonc
{
  "role": {
    "name": "sap.capire.flights.data_syn#",
    "object_privileges": [
      {
        "name": "SAP_CAPIRE_FLIGHTS_DATA_SYN_FLIGHTS",
        "type": "VIEW",
        "privileges_with_grant_option": [ "SELECT" ]
      },
      {
        "name": "SAP_CAPIRE_FLIGHTS_DATA_SYN_AIRLINES",
        "type": "VIEW",
        "privileges_with_grant_option": [ "SELECT" ]
      },
      // ...
    ]
  }
}
```

> If you want to know why there are two _.hdbrole_ files and why there is a `#` in
the names, check out HANA docu on [Granting Roles and Privileges for Use with Synonyms](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-developer-guide-for-cloud-foundry-multitarget-applications-sap-business-app-studio/granting-roles-and-privileges-for-use-with-synonyms?locale=en-US&q=hdbrole#role-names
).


### Consumer

To see the effect of the synonyms plugin on the build output for xtravels, run
```sh
cds build --for hana
```
and have a look at the generated HDI files in folder _gen/db_:
```
gen/db
├── src/gen
|   ├── sap.capire.flights.data_syn.Airlines_#proxy.hdbtable
|   ├── sap.capire.flights.data_syn.Airports_#proxy.hdbtable
|   ├── sap.capire.flights.data_syn.Flights_#proxy.hdbtable
|   ├── sap.capire.flights.data_syn.Supplements_#proxy.hdbtable
|   ├── sap.capire.flights.data_syn.SupplementTypes_#proxy.hdbtable
|   ├── sap.capire.flights.data_syn.hdbsynonym
|   ├── sap.capire.flights.data_syn.hdbgrants
|   └── ...
└── cfg/gen
    └── sap.capire.flights.data_syn.hdbsynonymconfig
```

For each entity in the imported service there is a local mock table
with name suffix `_#mock`and a synonym definition that points to the mock table.
All synonyms for an imported service are defined in one _.hdbsynonym_ file.

File _sap.capire.flights.data\_syn.hdbsynonym_:
```jsonc
{
  "SAP_CAPIRE_FLIGHTS_DATA_SYN_FLIGHTS": {
    "target": {
      "object": "SAP_CAPIRE_FLIGHTS_DATA_SYN_FLIGHTS#MOCK"
    }
  },
  "SAP_CAPIRE_FLIGHTS_DATA_SYN_AIRLINES": {
    "target": {
      "object": "SAP_CAPIRE_FLIGHTS_DATA_SYN_AIRLINES#MOCK"
    }
  },
  // ...
}
```

If a _csv_ file with test data is provided for an imported entity (as part of the API package
or in the consuming app), the data is always inserted into the mock table.

In addition, there is a _.hdbsynonymconfig_ file that overrides the basic synonym definitions
and redirects the synonyms to the "exported" views in xflights.
The target schema is not hard coded, but the synonym config leverages
[Templates for HDI Configuration Files](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-developer-guide-for-cloud-foundry-multitarget-applications-sap-business-app-studio/templates-for-hdi-configuration-files):
it uses the name of the imported CDS service as a logical service name. Upon deployment,
this name needs to be mapped to a physical service which then provides the actual
name of the producer's HDI container database schema.

File _sap.capire.flights.data\_syn.hdbsynonymconfig_:
```jsonc
{
  "SAP_CAPIRE_FLIGHTS_DATA_SYN_FLIGHTS": {
    "target": {
      "schema.configure": "sap.capire.flights.data_syn/schema",
      "object": "SAP_CAPIRE_FLIGHTS_DATA_SYN_FLIGHTS"
    }
  },
  "SAP_CAPIRE_FLIGHTS_DATA_SYN_AIRLINES": {
    "target": {
      "schema.configure": "sap.capire.flights.data_syn/schema",
      "object": "SAP_CAPIRE_FLIGHTS_DATA_SYN_AIRLINES"
    }
  },
  // ...
}
```


By deploying with or without the _.hdbsynonymconfig_ file, we can switch
the synonyms and control whether they point to the local mock tables ("unconnected")
or to the views in xflights ("connected"), respectively.


Finally, for each imported service, a _.hdbgrants_ file is generated.
Upon deployment, it grants the roles generated in xflights to the HDI users of xtravels.
It again uses the name of the imported service as logical service name that upon deployment
is mapped to a physical service with the required credentials.

File _sap.capire.flights.data\_syn.hdbgrants_:
```jsonc
{
  "sap.capire.flights.data_syn": {
    "object_owner": {
      "schema_roles": [
        {
          "roles": [ "sap.capire.flights.data_syn#" ]
        }
      ]
    },
    "application_user": {
      "schema_roles": [
        {
          "roles": [ "sap.capire.flights.data_syn"]
        }
      ]
    }
  }
}
```


## Deploy to HANA

### Provider

For the provider (xflights), deployment to HANA is not different from any other CAP application.


### Single-tenant consumer

To deploy in "unconnected" state (i.e. synonyms point to local mock tables), deploy
without the synonym config. This can for example be achieved by adding a file _db/.hdiignore_.
The _.hdiignore_ file should also contain the _.hdbgrants_ file, as deploying this
file only works if the service mapping is in place.
When the HANA deployment is controlled via an _mta.yaml_, you can alternatively specify an
"exclude-filter" via the "HDI_DEPLOY_OPTION" instead of providing a real _.hdiignore_ file.

To deploy in "connected" state (i.e. synonyms point to tables/views in xflights), the logical
service name `sap.capire.flights.data_syn` appearing in the generated _.hdbsynonymconfig_ and
_.hdbgrants_ files needs to be resolved to a physical service.
This physical service then provides the actual name of the target schema for the synonyms
as well as the credentials for granting access to that schema.
As physical service we use the "SAP HANA Schemas & HDI Containers" service `xflights-db` that resulted
from the xflights deployment.
The xtravels app is bound to that service, and a `SERVICE_REPLACEMENTS` is defined (in  _.env_ or in _mta.yaml_)
that maps the logical service name to the physical service.

As the xtravels app is now effectively bound to two HDI containers (xflights-db and xtravels-db),
we need to explicitly specify the `TARGET_CONTAINER` (in _.env_ or in _mta.yaml_) for the HDI deployment.



### Multi-tenant consumer

For multi tenant apps, the plugin provides an API to switch during runtime.



For the deployment, the consumer app needs to be bound to the provider's service manager.
Deployment and tenant subscription are not different from any other CAP application.
The synonyms for an imported service are initially deployed in "unconnected" state.

Once tenant subscription has happened for a provider and consumer, the synonyms can
be connected via an API in the consumer app that is provided via the plugin.
Connect the imported service with the provider's service manager via
```http
POST {{server}}/setconf/connect

{
  "srv": "datasrv", "target": "provider-db"
}
```
After calling the API, a tenant update must be explicitly triggered.


