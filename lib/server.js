const cds = require('@sap/cds')
//const im = require('@sap/instance-manager') // API that can be used to get container credentials for now
const fs = require('fs')
const path = require('path')
const LOG = cds.log('cds-federation-synonyms')


function PlugIntoMtx() {
  LOG.debug('===== PlugIntoMtx() is running')

  cds.on('served', () => {
    LOG.info('===== cds.on served - BEGIN')

    const { 'cds.xt.DeploymentService': ds } = cds.services
    if (!ds) {
      LOG.info('===== DeploymentService not found, skipping subscription to its events')
      return
    }

    //ds.before('subscribe',   ({ data }) => { LOG.info('===== before subscribe =====') })
    //ds.before('upgrade',     ({ data }) => { LOG.info('===== before upgrade =====') })
    //ds.before('unsubscribe', ({ data }) => { LOG.info('===== before unsubscribe =====') })

    ds.prepend(() => {
      ds.before('deploy', async ({ data }) => {
        LOG.info('===== before deploy - BEGIN')

        //LOG.info('===== before deploy - data: ' + JSON.stringify(data))
        //LOG.info('===== before deploy - data.options: ' + JSON.stringify(data.options))
        LOG.info('===== before deploy - data.tenant: ' + JSON.stringify(data.tenant))
        LOG.info('===== before deploy - data.options.container.credentials.schema: ' + data.options.container.credentials.schema)


        // TODO: if data.option or data.options.out is null, do nothing
        //   could happen if "deploy" is called w/o options
        //   probably not a real use case, but we shouldn't crash


        const { tenant } = data
        const customVcap = { 'hana': [] }

        const t0 = cds.env.requires.multitenancy?.t0 ?? 't0'
        if (tenant === t0) {
          LOG.info('===== before deploy - tenant t0, leave')
          return
        }

        // step 1: get list of CDS services that may have to be connected from the model
        // the service names are used as "logical schema names" in .hdbsynonymconfig and .hdbgrants files

        // get model (cds.model is mtx's own model -> not what we need) and extract services for imported data APIs
        const { 'cds.xt.ModelProviderService': mps } = cds.services
        const csn = await mps.getCsn({ tenant: tenant })
        let ext_services = Object.entries(csn.definitions)
          .filter( ([, def]) => def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])
          .map(([n,]) => ([n, null]) );

        // don't waste any time if there are no services to be connected
        if (!ext_services || ext_services.length === 0) {
          LOG.info('===== before deploy - no external services, leave')
          return
        }

        let cds_services = Object.fromEntries(ext_services);
        // cds_services: { 'sap.capire.bookshop.data' : null, ... }
        LOG.info('===== before deploy - external services: ' + JSON.stringify(cds_services))

        // step 2: read config table: which service to be connected to which target container

        try {
          // // we ensured via package.json that the synonym registry table is in the model of the mtx app
          // const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']
          // LOG.info('===== before deploy - synTab:', JSON.stringify(synTab))
          // const configEntries = await cds.ql.SELECT.from(synTab)

          // BUT: when the "before deploy" funtion is called after redeploying the app (there seems to be an auto-redeploy?)
          // the synTab is not in the model yet ??!! -> TODO can we fix this?
          // If cds.dataproducts.synonyms.Registry is in the model, the result uses column names "srv" and "target,
          // If not, it uses "SRV" and "TARGET" - we have to cover both cases
          const configEntries = await cds.ql.SELECT.from('cds.dataproducts.synonyms.Registry')
          LOG.info('===== before deploy - config table content: ' + JSON.stringify(configEntries))
          for (let srv in cds_services) {
            let config  = configEntries.find(e => e.SRV === srv || e.srv === srv)
            if (config) {
              cds_services[srv] = config.TARGET || config.target
            }
          }
          //cds_services: { 'sap.capire.bookshop.data' : 'syn-prov-1-mt-db', ... }
        } catch (error) {
          // note: this error is expected for the first deployment, where the table is not yet created
          LOG.info('===== before deploy - could not read config table:', error)
        }
        
        // compile list of all used target db service managers
        let target_containers = {};
        for (let srv in cds_services) {
          if (cds_services[srv])
            target_containers[cds_services[srv]] = null;
        }  
        //target_containers: { 'syn-prov-1-mt-db': null, ... }
        LOG.info('===== before deploy - before getting credentials - cds_services: ' + JSON.stringify(cds_services)
                                                          + ', target_containers: ' + JSON.stringify(target_containers))

        // step 3: get credentials for each target_db_service_manager from env
        //         - it may be possible that it can't be found (e.g. provider is not yet deployed)
        //         - -> then don't connect related services
        //         get credentials for the target container from the target_db_service_manager
        //         - it is possible that credentials can't be found (if there is no subscription for the tenant yet)
        //         - -> then don't connect related services
        // for those that are to be conntected, add the credentials to an array (later to be used for VCAP)

        for (let target_db_sm in target_containers) {
          const { credentials } = cds.env.requires[target_db_sm] || {}
          if (!credentials) {
            LOG.info('===== before deploy - NO service manager credentials for ' + target_db_sm)
          }
          else {
            LOG.info('===== before deploy - Service Manager Credentials for ' + target_db_sm + ':' + JSON.stringify(credentials))
            let targetContainerCredentials = await getTargetContainerCredentials(credentials, tenant)
            if (!targetContainerCredentials) {
              LOG.info('===== before deploy - NO target container credentials for ' + target_db_sm)
            }
            else {
              LOG.info('===== before deploy - for target ' + target_db_sm + ' - schema name: ' + JSON.stringify(targetContainerCredentials?.credentials?.schema)
                                                                            + ', credentials:' + JSON.stringify(targetContainerCredentials))
              const vcap_service_name = target_db_sm + '-vcap-service-name';
              target_containers[target_db_sm] = vcap_service_name
              targetContainerCredentials.name = vcap_service_name
              customVcap['hana'].push(targetContainerCredentials)
            }
          }
        }
        LOG.info('===== before deploy - after getting credentials - cds_services: ' + JSON.stringify(cds_services)
                                                          + ', target_containers: ' + JSON.stringify(target_containers))

        // step 4: go over list of services
        // - for those which shall not or cannot be connected, remove the .hdbsynonymconfig and .hdbgrants files
        // - for those which are to be connected, add service replacement to an array

        async function getAllFiles(dir_full, dir_short = '') {
          let results = [];
          const list = await fs.promises.readdir(dir_full, { withFileTypes: true });
          for (const file of list) {
            const filePath_short = path.join(dir_short, file.name);
            if (file.isDirectory()) {
              const filePath_full  = path.join(dir_full, file.name);
              results = results.concat(await getAllFiles(filePath_full, filePath_short));
            } else {
              results.push(filePath_short);
            }
          }
          return results;
        }
        const filesBefore = await getAllFiles(data.options.out);
        LOG.info('===== before deploy - files to be deployed BEFORE: ' + JSON.stringify(filesBefore))

        const service_replacements = [];
        //const exclude_filter = [];

        for (let srv in cds_services) {
          let target_db_sm = cds_services[srv];
          let vcap_service_name = target_db_sm ? target_containers[target_db_sm] : null;

          if (!vcap_service_name) {
            LOG.info('===== before deploy - Remove synonymconfig for service ' + srv)
            // TODO try HDI_DEPLOY_OPTIONS  "exclude-filter" and ** pattern instead deleting the files
            // HDI_DEPLOY_OPTIONS is an environment variable, that holds deployment options in JSON format:
            //   example: { "verbose" : true, "exit" : true, "include_filter" : [ "src/", "cfg/" ] }
            // exclude_filter.push(`cfg/${srv}.hdbsynonymconfig`, `cfg/gen/${srv}.hdbsynonymconfig`,
            //                     `src/${srv}.hdbgrants`,        `src/gen/${srv}.hdbgrants`)

            // remove files to force undeploy
            await fs.promises.rm(path.join(data.options.out, `cfg/${srv}.hdbsynonymconfig`),     { force: true })
            await fs.promises.rm(path.join(data.options.out, `cfg/gen/${srv}.hdbsynonymconfig`), { force: true })
            await fs.promises.rm(path.join(data.options.out, `src/${srv}.hdbgrants`),            { force: true })
            await fs.promises.rm(path.join(data.options.out, `src/gen/${srv}.hdbgrants`),        { force: true })
          }
          else {
            service_replacements.push({ "key": srv, "service": vcap_service_name });
          }
        }

        const filesAfter = await getAllFiles(data.options.out);
        LOG.info('===== before deploy - files to be deployed AFTER: ' + JSON.stringify(filesAfter))

        // step 5: update custom deploy environment with service replacements and vcap services

        LOG.info('===== before deploy - service replacements: ' + JSON.stringify(service_replacements)
                                            + ', customVcap: ' + JSON.stringify(customVcap)) 
//        LOG.info('===== before deploy - exclude_filter: ' + JSON.stringify(exclude_filter)) 
//        if (service_replacements.length > 0 || exclude_filter.length > 0) {
        if (service_replacements.length > 0) {
          data.options = {
            ...data.options,
            _: {
              ...data.options._,
              hdi: {
                ...data.options._?.hdi,
                deployEnv: {
                  //...(service_replacements.length > 0 && { SERVICE_REPLACEMENTS: JSON.stringify(service_replacements), VCAP_SERVICES: customVcap }),
                  //...(exclude_filter.length > 0 && { HDI_DEPLOY_OPTIONS: JSON.stringify({ "exclude-filter": exclude_filter }) })
                  SERVICE_REPLACEMENTS: JSON.stringify(service_replacements),
                  VCAP_SERVICES: customVcap
                }
              }
            }
          }
        }

        //LOG.info('===== before deploy - data.options: ' + JSON.stringify(data.options))
        LOG.info('===== before deploy - FINISHED')
      })
    })
  })


  // get credentials via containerManager - ready for TMS v2
  async function getTargetContainerCredentials(serviceManagerCredentials, tenant) {
    try {
      const containerManager = cds.xt.containerManager.newInstance(serviceManagerCredentials)
      return await containerManager.get(tenant)
    } catch (e) {
      LOG.error('===== error fetching target container credentials: ', e)
      return
    }
  }


  // async function getTargetContainerCredentials(serviceManagerCredentials, tenant) {
  //   try {
  //     return new Promise((resolve, reject) => {
  //       // create instance-manager from multidb-mt-bs-common-db binding
  //       im.create(serviceManagerCredentials, (error, sm) => {
  //         if (error) {
  //           cds.error('===== (getTargetContainerCredentials) ERR creating instance-manager:', error)
  //         }
  //         // sm is now the service-manager for the target container
  //         sm.get(tenant, (error, instance) => {
  //           if (error) {
  //             cds.error('===== (getTargetContainerCredentials) ERR fetching credentials:', error)
  //           }
  //           // credentials is now the credentials for the target container
  //           resolve(instance)
  //         })
  //       })
  //     })
  //   } catch (e) {
  //     LOG.info('===== (getTargetContainerCredentials) ERR fetching target container credentials: ', e)
  //     return
  //   }
  // }
}


module.exports = PlugIntoMtx;