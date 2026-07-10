# Misc

## mta.yaml for single tenant consumer

Instead of using hard-coded service names in the "requires" section of the HDI deployer,
it is more flexible to introduce some place-holders:

* Add property to the resource entry for xtravels-db:
    ```yaml
      - name: xtravels-db
        type: com.sap.xs.hdi-container
        parameters:
          service: hana
          service-plan: hdi-shared
        properties:                       # <---
          cons-db-hdi: ${service-name}    # <---
    ```
* Add a new resource entry for the xflights-db:
    ```yaml
      - name: xflights-db
        type: org.cloudfoundry.existing-service
        parameters:
          service-name: xflights-db
        properties:
          prov-db-hdi: ${service-name}
    ```
* Add a dependency and the service replacement the section for the HDI deployer:
    ```yaml
      - name: xtravels-db-deployer
        type: hdb
        path: gen/db
        parameters:
          buildpack: nodejs_buildpack
        requires:
          - name: xtravels-db
            properties:                           # <---
              TARGET_CONTAINER: ~{cons-db-hdi}    # <---
          - name: xflights-db                     # <---
            group: SERVICE_REPLACEMENTS           # <---
            properties:                           # <---
              key: sap.capire.flights.data_syn    # <---
              service: ~{prov-db-hdi}             # <---
    ```
