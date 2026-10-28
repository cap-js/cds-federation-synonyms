# Tests

This folder contains
* automated unit/integration tests
* an automated end-to-end test (multi-tenant case)
* prepared API calls for manual end-to-end tests (multi-tenant case)

## Prerequisites for end-2-end tests

The end-to-end tests are based on sample apps `xflights` and `xtravels` in the _e2e_ folder.

**Setup sequence:**
1. Deploy both apps to CF (see [e2e](#e2e) section below)
2. Create tenant subscriptions for both apps via BTP cockpit
3. Map a CF route to the xtravels AppRouter (`cf map-route ...` or via BTP cockpit)
   - only needed for OData queries to the app, not for the automated test
4. Populate _.env_ (copy _.env-template_, fill in values - see [Variables and Tokens](#variables-and-tokens) below)
5. Run `npm test` (the e2e test auto-skips if _.env_ is absent or incomplete) to execute automated tests

Required _.env_ variables:
* `domain`: CF domain suffix (e.g. `cfapps.sap.hana.ondemand.com`)
  * used by: _syn-config.test.js_, _syn-config.http_
* `mtx_host`: hostname of the xtravels MTX sidecar, without the domain
  * used by: _syn-config.test.js_, _syn-config.http_
* `tenant_host`: AppRouter hostname for a subscribed tenant, without the domain
  * used by: _syn-config.http_
* `tenant_id`: Tenant ID / Subaccount ID (UUID) of the subscriber tenant subaccount
  * used by: _syn-config.test.js_, _syn-config.http_
* `mtx_token`: service token for the operator subaccount (the subaccount that runs the SaaS app; client credentials grant against the operator XSUAA)
  * used by: _syn-config.test.js_, _syn-config.http_
* `token`: user token for the subscribed tenant (password grant against the tenant-specific XSUAA)
  * used by: _syn-config.http_


## Files and folders

### build.test.js

Unit/integration test for _lib/build-plugin.js_.
Runs `cds build --for hana` for the models in folder _scenarios/<name>/model_ and asserts the generated HDI artifacts
match the respective reference files in _scenarios/<name>/ref_.

Runs entirely locally, no deployment or credentials needed.

### config-helper.test.js

Unit test for _lib/config-helper.js_.
Boots CDS with an in-memory SQLite DB and mocks _lib/status-sql.js_ (this file calls `ModelProviderService.getCsn()` when
running inside the MTX sidecar and queries `SYS.SYNONYMS`, neither of which is available in the local test environment).
Covers static config, dynamic config only, and the precedence rules between them (dynamic overrides static).

Runs entirely locally, no deployment or credentials needed.

### server.test.js

Unit test for the `before('deploy')` handler in _lib/server.js_.
Wires up a fake `DeploymentService`, supplies mock CSN / container manager / SM credentials, and asserts that
HDI artifact files (`.hdbsynonymconfig`, `.hdbgrants`) are kept or removed per service and that `SERVICE_REPLACEMENTS`
and `VCAP_SERVICES` are built correctly. Also covers the `gen/base` shared-dir copy behaviour.

Runs entirely locally, no deployment or credentials needed.

### syn-config.test.js

Automated end-to-end test for the MTX `synonymapi` endpoints (`getConfig`, `check`, `setDynamicConfig`, `deleteDynamicConfig`).
Calls the live MTX sidecar directly (bypassing the AppRouter).

**Prerequisites:** See [Prerequisites for end-2-end tests](#prerequisites-for-end-2-end-tests) above.

Skips automatically if _.env_ is absent or any of the variables is missing.
The `TRIGGER_UPGRADE` flag at the top of the file controls whether each config change also triggers
a full tenant upgrade (default: `true`; upgrade timeout: 5 min).

### syn-config.http

VS Code REST Client file for manually invoking the `synonymapi` endpoints
directly via the MTX sidecar (uses `mtx_token` with `Authorization`).

Also includes a basic `GET .../Travel/Flights` smoke request through the
AppRouter (uses `token` with `x-approuter-authorization`).

**Prerequisites:** See [Prerequisites for end-2-end tests](#prerequisites-for-end-2-end-tests) above.

### scenarios

Test CDS models and corresponding HDI reference files for _build.test.js_.

### .env-template

Template for the _.env_ file required by the end-to-end tests.
Copy to _.env_ and fill in the values. The _.env_ file is gitignored.
See [Variables and Tokens](#variables-and-tokens) for details on each variable.

### e2e

Contains adapted versions of the CAP sample apps [xflights](https://github.com/capire/xflights)
and [xtravels](https://github.com/capire/xtravels) for the end-2-end test _syn-config.test.js_
and for the queries in _syn-config.http_.

The apps are reduced to the bare minimum needed for testing the synonyms (no UI, no actions, no custom code).
They represent the final state of the [walkthrough](../../doc/walkthrough.md), i.e. xflights exports
a data service for synonyms, and xtravels already consumes it. The apps are ready to be deployed as
multi-tenant apps to CF. For both apps, run
```sh
bash x_build-and-deploy.sh
```

The apps can also be adapted for single-tenant deployments.


## Variables and Tokens

The `cf` commands below require an active CF login (`cf login` or `cf login --sso`).

### `domain`

The Cloud Foundry domain suffix used to construct app hostnames.

```bash
cf domains
```

Use the shared domain, e.g. `cfapps.eu10.hana.ondemand.com`.

### `mtx_host`

The hostname of the MTX sidecar app, without the domain suffix.

```bash
cf apps   # run in the operator space
```

Take the route of the MTX sidecar app and strip the domain.

### `tenant_host`

The AppRouter hostname for a subscribed tenant, without the domain suffix.
Follows the pattern `<tenant-subdomain>-<approuter-app-name>`.

Alternatively, find the AppRouter URL in the BTP cockpit:
subscriber subaccount → Instances and Subscriptions → \<app\> → _Go to Application_.
Strip the domain suffix.

### `tenant_id`

The Tenant ID / Subaccount ID (UUID) of the subscriber tenant subaccount - not the subdomain string.

BTP cockpit: subscriber subaccount → Overview → Subaccount details → **Subaccount ID** (also shown as Tenant ID in some views).

### `token` - user token

A JWT that represents a specific **user** in the context of the subscriber tenant.
Issued by the subscriber tenant's XSUAA via OAuth2 **password grant**.
Carries the subscriber tenant context (`zid`) so the app server connects to the right
tenant DB, plus whatever app-specific scopes are assigned to the user in the
**subscriber subaccount**.

Used for requests through the AppRouter (`x-approuter-authorization` header).

How to obtain - POST to the subscriber XSUAA:

```bash
curl -s -X POST "https://<tenant-subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  --data-urlencode "grant_type=password" \
  --data-urlencode "client_id=<clientid>" \
  --data-urlencode "client_secret=<clientsecret>" \
  --data-urlencode "username=<your BTP user>" \
  --data-urlencode "password=<your BTP password>" \
  | jq -r .access_token
```

The `clientid` and `clientsecret` are in the XSUAA service binding of the deployed app:

```bash
cf env xtravels-srv | grep -A20 '"xsuaa"' | grep clientid      # → clientid
cf env xtravels-srv | grep -A20 '"xsuaa"' | grep clientsecret  # → clientsecret
```

### `mtx_token` - service/operator token

A JWT that represents the **operator** (the SaaS app itself), with no user identity.
Issued by the operator XSUAA via OAuth2 **client credentials grant**.
CAP treats this token as `internal-user`, granting access to privileged MTX sidecar
endpoints (synonymapi, tenant upgrade, etc.).
Does **not** carry `cds.Developer` or any subscriber tenant context.

Used for direct calls to the MTX sidecar (`Authorization: Bearer` header).

How to obtain - POST to the operator XSUAA:

```bash
curl -s -X POST "https://<operator-subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=<clientid>" \
  --data-urlencode "client_secret=<clientsecret>" \
  | jq -r .access_token
```

The `clientid` and `clientsecret` are in the XSUAA service binding of the MTX sidecar app:

```bash
cf env xtravels-mtx | grep clientid      # → clientid
cf env xtravels-mtx | grep clientsecret  # → clientsecret
```

The operator subdomain is in the BTP cockpit:
operator subaccount → Overview → Subaccount details → **Subdomain**.

### Inspecting a token

To see what scopes and tenant context a token carries:

```bash
echo "<token>" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{scope, zid, client_id}'
```

> **Tip:** If you prefer not to run these steps manually, you can ask an AI assistant to generate
> a shell script based on the information in this section.

