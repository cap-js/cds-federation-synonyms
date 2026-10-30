# Technical details

While the [walkthrough](./walkthrough.md) provides only instructions to follow along,
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
_sap.capire.flights.FlightsService_syn#.hdbrole_ and _sap.capire.flights.FlightsService_syn.hdbrole_,
that provide `SELECT` access to the HANA views that correspond to the entities
in the API service.

File _sap.capire.flights.FlightsService\_syn#.hdbrole_:

```jsonc
{
  "role": {
    "name": "sap.capire.flights.FlightsService_syn#",
    "object_privileges": [
      {
        "name": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_FLIGHTS",
        "type": "VIEW",
        "privileges_with_grant_option": [ "SELECT" ]
      },
      {
        "name": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_AIRLINES",
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
|   ├── sap.capire.flights.FlightsService_syn.Airlines_#proxy.hdbtable
|   ├── sap.capire.flights.FlightsService_syn.Airports_#proxy.hdbtable
|   ├── sap.capire.flights.FlightsService_syn.Flights_#proxy.hdbtable
|   ├── sap.capire.flights.FlightsService_syn.Supplements_#proxy.hdbtable
|   ├── sap.capire.flights.FlightsService_syn.SupplementTypes_#proxy.hdbtable
|   ├── sap.capire.flights.FlightsService_syn.hdbsynonym
|   ├── sap.capire.flights.FlightsService_syn.hdbgrants
|   └── ...
└── cfg/gen
    └── sap.capire.flights.FlightsService_syn.hdbsynonymconfig
```

For each entity in the imported service there is a local mock table
with name suffix `_#mock`and a synonym definition that points to the mock table.
All synonyms for an imported service are defined in one _.hdbsynonym_ file.

File _sap.capire.flights.data\_syn.hdbsynonym_:
```jsonc
{
  "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_FLIGHTS": {
    "target": {
      "object": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_FLIGHTS#MOCK"
    }
  },
  "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_AIRLINES": {
    "target": {
      "object": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_AIRLINES#MOCK"
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
  "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_FLIGHTS": {
    "target": {
      "schema.configure": "sap.capire.flights.FlightsService_syn/schema",
      "object": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_FLIGHTS"
    }
  },
  "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_AIRLINES": {
    "target": {
      "schema.configure": "sap.capire.flights.FlightsService_syn/schema",
      "object": "SAP_CAPIRE_FLIGHTS_FLIGHTSSERVICE_SYN_AIRLINES"
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
  "sap.capire.flights.FlightsService_syn": {
    "object_owner": {
      "schema_roles": [
        {
          "roles": [ "sap.capire.flights.FlightsService_syn#" ]
        }
      ]
    },
    "application_user": {
      "schema_roles": [
        {
          "roles": [ "sap.capire.flights.FlightsService_syn"]
        }
      ]
    }
  }
}
```


## Configuration

The `synonyms` configuration described here applies to **multi-tenant** apps. For single-tenant
apps, the connection is a deployment decision made via `SERVICE_REPLACEMENTS` / `TARGET_CONTAINER`
(see [Single-tenant consumer](#single-tenant-consumer)); none of the `synonyms` entries below apply.

The synonym configuration is given statically as part of the app's `cds.requires`. It consists
of two kinds of entries, each living in its natural home:

- **Service mapping** - maps an imported CDS service to the provider's service manager (SM) via
  `synonyms: { "service-manager": <sm> }`. This is model intent, so it lives in the **main app's**
  `package.json`. Only services with such a mapping can ever be connected.
- **SM policy** - optional per-SM settings, placed under `synonyms` on the SM's credential-binding
  entry in the **sidecar's** `mtx/sidecar/package.json` (next to its `kind`/`vcap`):
  - `deferred` (default `false`): if `false`, the SM's synonyms are connected on every deployment
    (static control). If `true`, they start unconnected and are switched at runtime via the API.
  - `allow-api-provider-tenant` (default `false`): if `true`, a provider tenant supplied through
    the API is honored; otherwise the consumer's own (deploying) tenant is used. Only meaningful for `deferred` SMs.

```jsonc
// main app package.json - the service mapping (model intent)
{
  "cds": {
    "requires": {
      "sap.capire.flights.FlightsService_syn": {
        "synonyms": { "service-manager": "xflights-db" }
      }
    }
  }
}
```

```jsonc
// mtx/sidecar/package.json - the SM binding carries the policy
{
  "cds": {
    "requires": {
      "xflights-db": {
        "kind": "hana",
        "vcap": { "name": "xflights-db" },
        "synonyms": { "deferred": true }   // SM policy lives with the binding
      }
    }
  }
}
```

The mapping is read from the main app's `package.json`; the per-SM policy is read from the
sidecar's own `package.json`, alongside the credential binding. The app's own HDI container in the
sidecar must use the requires key `db`: MTX uses this key to identify its deploy target, and with
multiple HANA bindings present (the own container plus one or more provider SMs) the key must be
unambiguous.

Note the two roles the SM plays. The credential-bearing **binding** to the provider's Service
Manager is the sidecar's `kind`/`vcap` entry together with the actual deployment binding (e.g. in
_mta.yaml_ or via `cf bind-service`); this is what provides the credentials used to reach the
provider's HDI container. The `synonyms.service-manager` **mapping** only links an imported CDS
service to that SM by name - it carries no credentials itself.

### Putting it together

Wiring up one provider SM (call it `<sm>`) for a multi-tenant consumer touches **three** files, and
the **same `<sm>` name must be used in all of them**:

| File | What to add | Where `<sm>` appears |
| --- | --- | --- |
| main app `package.json` | service → SM mapping: `synonyms: { "service-manager": "<sm>" }` on the imported CDS service | the `service-manager` value |
| `mtx/sidecar/package.json` | SM binding + policy: `"<sm>": { "kind": "hana", "vcap": { "name": "<sm>" }, "synonyms": { "deferred": … } }` | the entry key **and** `vcap.name` |
| `mta.yaml` | an `existing-service` resource for the provider SM, plus a `requires` entry on the sidecar module so it is bound at deploy time | the resource name (and the `requires` entry) |

The `mta.yaml` binding is standard CF service-binding plumbing; without it the sidecar's `vcap.name`
resolves to nothing at runtime and no credentials are found. See the
[Walkthrough](walkthrough.md) for a complete `mta.yaml` example (static and dynamic binding).

### Connect state and resolution

The connect state of a `deferred` SM is stored per SM in a registry table: a row means connected,
no row means disconnected. On each deployment the plugin resolves, per imported service, whether
to connect:

- A statically-controlled SM (not `deferred`) is always connected.
- A `deferred` SM is connected if and only if a registry row exists for it.

The `connect`/`unconnect` API (exposed on the MTX sidecar for `deferred` SMs; the application
itself exposes no such API) sets this desired state. It operates per service manager -
`connect`/`unconnect` affect all imported services mapped to that SM together. The actual synonym
redirection then happens on the next tenant deployment, which must be triggered explicitly (or
requested inline via the `triggerUpgrade` parameter).

### The `provider_tenant` parameter

By default the synonyms of a connected SM point to the provider container of the **own (deploying)
tenant** - i.e. the consumer tenant's synonyms federate to the provider data of the same tenant.
This is the normal case and needs no configuration.

The `connect` action accepts an optional `provider_tenant` parameter that overrides this: the
synonyms are then pointed at the provider container of the *named* tenant instead of the deploying
one. This is only permitted when the SM's static policy sets `allow-api-provider-tenant: true`;
otherwise `connect` rejects any non-null `provider_tenant` (HTTP 422).

```jsonc
// connect, overriding the provider tenant (requires allow-api-provider-tenant: true on the SM)
{ "tenant": "<consumer-tenant>", "sm": "xflights-db", "provider_tenant": "<provider-tenant>" }
```

> **Security:** `provider_tenant` points one tenant's synonyms at *another* tenant's provider data,
> i.e. it effectively lets one tenant read another tenant's data. The value is **not** checked
> against any authorized-pairing allow-list - once `allow-api-provider-tenant` is on, any subscriber
> tenant of the provider can be named, so a caller holding (or compromising) the `internal-user`
> role could expose one tenant's data to another. Enable the flag and pass a `provider_tenant` only
> for tenant pairings that are legitimate and within the same trust boundary
> (see [Security considerations](../README.md#security-considerations)). Leave the flag unset
> (the default) whenever a tenant should only ever see its own provider data; in that state no
> caller-supplied tenant is accepted at all.


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
service name `sap.capire.flights.FlightsService_syn` appearing in the generated _.hdbsynonymconfig_ and
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

Deployment and tenant subscription are no different from any other multi-tenant CAP
application. The synonym-specific setup is:

1. Declare the static config and bind the provider's service manager to the sidecar -
   see [Putting it together](#putting-it-together) for the three files involved (and the
   [Walkthrough](walkthrough.md) for a complete `mta.yaml`).
2. Deploy and subscribe tenants as usual.
3. For a `deferred` SM, connect its synonyms at runtime via the MTX sidecar API
   (`/-/cds/synonymapi`, called with an `internal-user` token) - see
   [Connect state and resolution](#connect-state-and-resolution). A non-`deferred` SM is
   already connected on deployment and needs no API call.

> **Security:** the binding to the provider's Service Manager is not limited to the single provider container
> used for federation - it exposes credentials for *all* HDI containers under that Service
> Manager. Provider and consumer must therefore be deployed within the same trust boundary.
> See [Security considerations](../README.md#security-considerations).
