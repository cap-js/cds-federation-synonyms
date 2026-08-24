# Walkthrough

This document walks you through the setup of data federation via synonyms
based on the CAP sample apps [xflights](https://github.com/capire/xflights) as provider
and [xtravels](https://github.com/capire/xtravels) as consumer.

You should be familiar with the content in the
[CAP-level Data Federation](https://pages.github.tools.sap/cap/docs/guides/integration/data-federation)
guide, as we build upon that foundation here.

This example uses SAP BTP with Cloud Foundry.
Precondition for all deployments: You have access to a BTP subaccount with a SAP HANA Cloud instance. Logon with `cf login`.

The walkthrough focuses on _what_ needs to be done, without any deeper explanation.
If you are interested in the technical details, see [details](./details.md)

## Prepare your workspace

If you haven't done so already, clone the required repositories to follow along:

```sh :line-numbers
mkdir -p cap/samples
cd cap/samples
mkdir apis
git clone https://github.com/capire/xflights
git clone https://github.com/capire/xtravels
```

<!-- Workspace setup:

# echo '{"workspaces":["xflights","xtravels","apis"]}' > package.json     ### Variant with workspaces
# npm install                                                             ### Variant with workspaces

Note: with workspace, mta setup becomes a bit more complicated:
* mta build doesn't work if cds-federation-synonyms is only a link -> that one must be really installed
  (only relevant for developing the plugin, users will always install from github or npm)
* need to copy the package-lock.json from the root folder to xflights/xtravels
* need to have an extra copy step in the build section
-->


## Modelling

### xflights as data provider

Define a new [API service](https://cap.cloud.sap/docs/guides/integration/calesi#defining-service-apis)
in a separate file for the purpose of exposing the flights data on HANA level via synonyms.

For our xflights example, we don't have to start from scratch:
xflights already defines an API service for service-level data federation. As the modelling is the
same for all kinds of data federation, we can just copy this service and adapt it to our needs.
Copy file _srv/data-service.cds_ to _srv/data-service-syn.cds_ and make the following adjustments:
* Rename the service to `FlightsService_syn`.
* Remove annotations `@hcql @rest @odata @graphql ...` that have been added for service level data federation.
* Add annotation `@data.product: 'via-synonym'` to enable data federation via synonyms:

```cds
namespace sap.capire.flights;

@data.product: 'via-synonym'
service FlightsService_syn {
  // ...
}
```

> Note: A service annotated with `@data.product` is not served via OData.

We recommend to not use a `select *` in the entities of an API service, as that may
unintentionally expose futher fields if the base entity is extended in later versions
of the application.

Use `cds export` to [generate an API package](https://cap.cloud.sap/docs/guides/integration/calesi#exporting-apis)
for the service definition:
```sh
cds export srv/data-service-syn.cds --texts --data --plugin --to ../apis/data-service-syn
```

Adapt the generated API package in folder _apis/data-service-syn_:
* In _package.json_, change the name to `@capire/xflights-data-syn`.
* In _index.cds_, add these annotations:
    ```cds
    // Workaround for @cds.autoexpose kicking in too eagerly ...
    annotate sap.common.Currencies with @cds.autoexpose:false;
    annotate sap.common.Countries with @cds.autoexpose:false;
    annotate sap.common.Languages with @cds.autoexpose:false;
    ```
* Slightly modify the data in the _data/...csv_ files. Later, this will allow
  you to see whether you view data coming from local mock tables fed by these _csv_ files,
  or data coming from the xflights tables via synonym. For example, prepend the names of airlines with
  "(test)", like so:
    ```csv
    ID,modifiedAt,name,icon,currency_code
    GA,2026-04-20T14:39:39.329Z,(test) Green Albatros,https://..,CAD
    FA,2026-04-20T14:39:39.329Z,(test) Fly Africa,https://..,ZAR
    ...
    ```

In your projects, you are of course free to choose a service name and a package name.
These names are later used in consumer apps to reference the API, so they should be
unique and meaningful in the sense that they represent the producer app. That is why in
this example the service has a namespace prefix.

Finally, [publish the package](https://cap.cloud.sap/docs/guides/integration/calesi#publishing-apis)
to make it available for the consumer app, e.g.
* via github
* by creating a tarball with `npm pack`
* ...

For the walkthrough, we run `npm pack` to create a tarball:
```sh
npm pack ../apis/data-service-syn --pack-destination ../apis/
```

<!-- Worksapce setup:
no pack/export necessary
-->

### xtravels as data consumer

In xtravels, import the API package. The exact statement depends on how it was published, in our example it is
```sh
npm install ../apis/capire-xflights-data-syn-0.1.3.tgz
```

<!-- Worksapce setup:
```sh
npm add ../apis/data-service-syn
```
-->

Usually you would now define [consumption views](https://cap.cloud.sap/docs/guides/integration/calesi#consumption-views)
on top of the imported entities and then use these consumption views as access point to the imported entities
in your application model.

Luckily, in xtravels this has already been done for the example of service-level data federation.
We change this to the synonym approach by simply changing the existing consumption views and redirecting
them to the API we just have imported. The rest of the application can stay as is.

The consumption views are defined in file _xtravels/apis/capire/xflights.cds_. The imported
entities are referenced via the `using` directive at the top of the file.
Replace the names there with the name of the API service and the package name defined above:
Change
```cds
using { sap.capire.flights.FlightsService as external } from '@capire/xflights-data';
```
to
```cds
using { sap.capire.flights.FlightsService_syn as external } from '@capire/xflights-data-syn';
```

In _srv/travel-service/service.js_, there is a function `service_integration()` that is
written for the use case Data Federation via Service-level replication and
doesn't work for our example. Remove the function and its invocation in `init()`.

You can now run the xtravels app with `cds watch`. The imported service is mocked,
and we see the flights data provided via the _csv_  files in the API package.



## Prepare for HANA deployment

### xflights as producer

Add HANA capabilities to your project:
```sh
cds add hana
```

Install the synonyms plugin with
```sh
npm install -D git+https://github.com/cap-js/cds-federation-synonyms.git
```

Create new file _db/undeploy.json_ with this content (if the file already exists, add the entry for `*.hdbrole`):
```
[
  "src/gen/**/*.hdbrole"
]
```


### xtravels as  consumer

Add HANA capabilities to your project:
```sh
cds add hana
```

Install the synonyms plugin with
```sh
npm install -D git+https://github.com/cap-js/cds-federation-synonyms.git
```

Create new file _db/undeploy.json_ with this content (if the file already exists, add the respective entries):
```
[
  "src/gen/**/*.hdbsynonym",
  "cfg/gen/**/*.hdbsynonymconfig"
]
```



## Deploy to HANA for hybrid testing

### xflights as producer

Deploy to HANA:
```sh
cds deploy --to hana
```
As result, an HDI container with name `xflights-db` is created.


### xtravels

During the build an _.hdbsynonymconfig_ file is generated.
By deploying with or without this file, we can switch the synonyms
and control whether they point to the local mock tables or to the views in xflights.
We first need to deploy once without this file to create the xtravels HDI container
and get its credentials. 
Then we can deploy with the _.hdbsynonymconfig_ file and thus connect the synonyms.

* Add a file _db/.hdiignore_ with the following content:
    ```txt
    **/sap.capire.flights.FlightsService_syn.hdbgrants
    **/sap.capire.flights.FlightsService_syn.hdbsynonymconfig
    ```
* Deploy with
    ```sh
    cds deploy --to hana
    ```
* Remove _db/.hdiignore_
* Provide a _.env_ file with the following content:
    ```sh
    TARGET_CONTAINER=db
    SERVICE_REPLACEMENTS='[{"key":"sap.capire.flights.FlightsService_syn","service":"xflights-db"}]'
    ```
    In the `SERVICE_REPLACEMENTS`, `key` is the name of the API service,
    `service` is the name of the producer's HDI container.
* Bind to the HDI container service for xflights:
    ```sh
    cds bind xflights-db -2 xflights-db
    ```
* Deploy again, using the binding:
    ```sh
    cds deploy --to hana --resolve-bindings --profile hybrid
    ```

Now you can run xtravels locally, based on the HDI container with the synonyms connected to xflights:
```sh
cds watch --profile hybrid
```


## Deploy via MTA

For xflights and xtravels:
```sh
cds add xsuaa
cds add mta
cds add approuter
npm install
```

<!-- Workspace setup:
Additionally:
copy ..\package-lock.json package-lock.json    ## variant with workspaces
-->


In _mta.yaml_ of xtravels:
* Add new resource entry for the xflights-db:
    ```yaml
      - name: xflights-db
        type: org.cloudfoundry.existing-service
    ```
* Add a dependency and the service replacement to the section for the HDI deployer:
    ```yaml
      - name: xtravels-db-deployer
        ...
        requires:
          - name: xtravels-db
            properties:                                   # <---
              TARGET_CONTAINER: xtravels-db               # <---
          - name: xflights-db                             # <---
            group: SERVICE_REPLACEMENTS                   # <---
            properties:                                   # <---
              key: sap.capire.flights.FlightsService_syn  # <---
              service: xflights-db                        # <---
    ```

<!-- Workspace setup:
Additionally:
* Add a copy command to the "before-all" build-parameters:
    ```yml
    commands:
      - npm ci
      - npx cds build --production --ws-pack
      - npx shx cp -r ..\\apis gen\\apis     # <----    ## variant with workspaces
    ```
-->


First build and deploy xflights, then xtravels:
```
mbt build
cf deploy ...
```



## Multi-tenant applications

In a multi-tenant setup, the synonym plugin provides an API that allows
to dynamically switch the synonyms between pointing to local mock tables and
pointing to the xflights views.


### Workaround

If you work on a windows machine, run
```sh
npm add -D tar
```
both in the xtravels and in the xflights project.
This avoids problems that, depending on your setup, may arise during packaging you apps.


### Deploy flights

There is no difference to any other multi-tenant CAP app.

Prepare for deployment, build, and deploy:
```sh
cds add xsuaa
cds add mta
cds add approuter
cds add multitenancy
npm install
cd mtx/sidecar && npm i --package-lock-only && cd ../..
mbt build
cf deploy ...
```

<!-- Workspace setup:
After "npm install", do
# copy ..\package-lock.json package-lock.json    ## variant with workspaces
-->

### Deploy xtravels

Prepare for deployment:
```sh
cds add xsuaa
cds add mta
cds add approuter
cds add multitenancy
npm install
```

<!-- Workspace setup:
After "npm install", do
# copy ..\package-lock.json package-lock.json    ## variant with workspaces
-->

Install the synonyms plugin also in _mtx/sidecar_ (here a dev dependency is not sufficient):
```sh
cd mtx/sidecar
npm install git+https://github.com/cap-js/cds-federation-synonyms.git
cd ../..
```

In _mtx/sidecar/package.json_, add this section
to bind to the HANA service manager of xflights and to ensure that we deploy to xtravels-db:
```jsonc
  "cds": {
    "profile": "mtx-sidecar",
    "requires": {
      "db": {  // <- deploy target is identified by name "db"
        "kind": "hana",
        "vcap": {
          "name": "xtravels-db"
        }
      },
      "xflights-db": {
        "kind": "hana",
        "vcap": {
          "name": "xflights-db"
        }
      }
    }
  }
```

Note: The entry for the HDI container where we want to deploy to _must_ have the name `db`.

xtravels-mtx needs to be bound to xflights-db. This can be done either statically via _mta.yaml_,
or dynamically after the deployment. Dynamic binding is necessary when you can't control the
deployment order of your apps. Then it can happen that xtravels is deployed before xflights,
which fails, if xflights-db is required in the _mta.yaml_ of xtravels.

* Static binding: In _mta.yaml_, ...
  * Add a resource entry for xflights-db:
      ```yaml
        - name: xflights-db
          type: org.cloudfoundry.existing-service
      ```
  * Bind xtravels-mtx to xflights-db by adding an entry to the `requires` section:
    ```yaml
      - name: xtravels-mtx
        type: nodejs
        path: gen/mtx/sidecar
        requires:
          - name: xtravels-auth
          - name: xtravels-db
          - name: xflights-db        # <----
          - name: xtravels-registry
          - name: app-api
          ...
    ```
* Dynamic binding: Don't mention xflights-db in _mta.yaml_

You can provide the connection info for the synonym as a static config in
the xtravel _package.json_ (works only with static binding):
```jsonc
  "cds": {
    "requires": {
      "sap.capire.flights.FlightsService_syn": {
        "kind": "hana-synonyms",
        "service-manager": "xflights-db"
      },
      // ...
    }
  }
```


Build and deploy:
```sh
mbt build
cf deploy ...
```

For dynamic binding: after both apps have been deployed, execute
```sh
cf bind-service xtravels-mtx xflights-db
cf restage xtravels-mtx
```

If you don't want to or cannot use a static config for the connection info, you
can connect/unconnect the synonyms via an API. This dynamic configuration
overrules the static config.

### Connecting synonyms

After creating subscriptions for xflights and xtravels,
the synonyms in xtravels initially point to the local mock tables.

Query the Flights exposed in the travel service:
```
https://<host_name>.<domain_name>/odata/v4/Travel/Flights
https://sf4-cdsruntime-sflight-dev-xtravels.cfapps.sap.hana.ondemand.com/odata/v4/Travel/Flights
```
You should see the data fed into the local mock tables via the _csv_ files of the imported API.


To switch the synonyms, i.e. connect/disconnect the imported service `sap.capire.flights.FlightsService_syn` to/from
the `xflights-db` HDI container, use the [ConfigService API](./config-service-api.md) in xtravels-mtx.

Set dynamic config (connect the synonyms):
```http
POST {{host_name}}.{{domain_name}}/-/cds/synonymapi/setDynamicConfig

{
  "tenant": "{{tenant_id}}",
  "srv": "sap.capire.flights.FlightsService_syn",
  "target": "xflights-db",
  "triggerUpgrade": true
}
```

Query Flights again, you should now see the data coming directly from the xflights app.

Delete dynamic config (disconnect the synonyms):
```http
POST {{host_name}}.{{domain_name}}/-/cds/synonymapi/deleteDynamicConfig

{
  "tenant": "{{tenant_id}}",
  "srv": "sap.capire.flights.FlightsService_syn",
  "triggerUpgrade": true
}
```


### Checking synonym status

Check the connection status for service `sap.capire.flights.FlightsService_syn`:
```http
POST {{host_name}}.{{domain_name}}/-/cds/synonymapi/check

{
  "tenant": "{{tenant_id}}",
  "srv": "sap.capire.flights.FlightsService_syn"
}
```

Read the complete config table:
```http
POST {{host_name}}.{{domain_name}}/-/cds/synonymapi/getConfig

{
  "tenant": "{{tenant_id}}"
}
```

Read the complete config table:
```http
GET {{host_name}}.{{domain_name}}/readconf/Registry
```

Query a monitoring view to get status information on synonym level:
```http
GET {{host_name}}.{{domain_name}}/readconf/Status
```
