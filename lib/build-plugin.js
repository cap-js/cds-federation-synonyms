'use strict'

// This plugin enhances "cds.compile.to.hana" for CAP Data Integration via synonyms

// For entities of an exported data service <service-name>:
// - create role that grants "SELECT WITH GRANT OPTION" for all the entities in the service
// - create role that grants "SELECT" for all the entities in the service
// For entities of an imported data service <service-name>:
// - create a mock table
// - create a synonym with the original table name pointing to the mock table
// - create a synonymconfig that points to the remote schema (via logical service)
// - create a .hdbgrants file that grants the roles created for exported service


// Use the global cds injected by cds-dk's plugin loader instead of require('@sap/cds'),
// to ensure we patch the same instance that runs cds.compile.to.hana.
// Require @sap/cds from the project root so we patch the same instance the build task uses.
// Use global.cds.root to avoid TDZ - the local const binding can't reference itself during init.
const cds = require(require.resolve('@sap/cds', { paths: [global.cds.root] }));
const compile = require ('@sap/cds-compiler')
const LOG = cds.log('cds-federation-synonyms')





const roleSkeleton = (srv) => ({
  role_1: {
    role: {
      name: srv + '#',
      object_privileges:[]
    }
  },
  role_2: {
    role: {
      name: srv,
      object_privileges:[]
    }
  }
});


function getExportedServices(csn) {
  // get services for exported data APIs
  let di_services = Object.entries(csn.definitions)
    .filter( ([name, def]) => def.kind === 'service' && def['@data.product'] === 'via-synonym' && !def['@cds.external'])
    .map(([n,]) => ({name: n}) );
  LOG.info(`Exported data services: ${di_services.map( n => n.name).join(', ')}`)
  LOG.info('------------------------------');
  return di_services;
}

function getImportedServices(csn) {
  // get services for imported data APIs
  let di_services = Object.entries(csn.definitions)
    .filter( ([name, def]) => def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])
    .map(([n, def]) => ({name: n, synonyms: {}, synonymconfigs: {}, quotedNames: def['@cds.persistence.namingMode'] === 'quoted', qgrants: [] }) );
  LOG.info(`Imported data services: ${di_services.map( n => n.name).join(', ')}`);
  LOG.info('------------------------------');
  return di_services;
}







function buildPlugin() {
  LOG.debug('===== build-plugin.js is running');

  const toHana_old = cds.compile.to.hana;

  cds.compile.to.hana = function (csn, options, ...etc) {
    // don't modify the build result if MTX builds its own model
    if (csn.definitions['cds.xt.Tenants']) {
      LOG.info('===== hana build plugin: detected MTX model, skip plugin execution');
      return toHana_old(csn, options, ...etc);
    }
    LOG.info('######### hana build plugin start #########');

    let di_services_exp = getExportedServices(csn);
    let di_services_imp = getImportedServices(csn);
    let toBeSynonymized = {};
    let csn_small = { definitions: {} }

    for (const n in csn.definitions) {
      let entity = csn.definitions[n];
      if (entity.kind != 'entity') continue;

      // TODO: check for @cds.persistence.skip ...

      let srv_x = di_services_exp.find( x => n.startsWith(x.name + '.'))
      if (srv_x) {
        let table_name       = n.replace(/\./g, '_');
        let kind = (entity.query || entity.projection)? 'view' : 'table';
        LOG.info(`exported entity: ${n}`);
        LOG.info(`${kind}:  ${table_name}`);

        srv_x.roles ??= roleSkeleton(srv_x.name);
        srv_x.roles.role_1.role.object_privileges.push({
          name: table_name.toUpperCase(),
          type: kind.toUpperCase(),
          privileges_with_grant_option:[ "SELECT" ]
        })
        srv_x.roles.role_2.role.object_privileges.push({
          name: table_name.toUpperCase(),
          type: kind.toUpperCase(),
          privileges:[ "SELECT" ]
        })
      }


      // for imported entity:
      // - add synonym and synonymconfig
      // - if quoted, remember column mapping (upper-cased name -> original name)
      let srv_i = di_services_imp.find( x => n.startsWith(x.name + '.'))
      if (srv_i) {
        let syn_name        = '';
        let mock_table_name = '';
        let target_name     = '';
        let file_name = n + '.hdbtable';
        if (!srv_i.quotedNames) {
          let table_name   = n.replace(/\./g, '_');
          syn_name         = table_name.toUpperCase()
          mock_table_name  = table_name.toUpperCase() + '#MOCK'
          target_name      = table_name.toUpperCase()
        }
        else {
          syn_name         = n + '#syn';
          mock_table_name  = n + '#mock';
          target_name      = n.substring(srv_i.name.length + 1); // remove service prefix
 
          csn_small.definitions[n] = csn.definitions[n];

          srv_i.qgrants.push({
            "name": target_name,
            "privileges_with_grant_option": [ "SELECT" ]
          })

        }




        LOG.info(`imported entity: ${n}`);
        //LOG.debug('   table:      ', table_name);
        //LOG.debug('   file:       ', file_name);
        //LOG.debug('   mock table: ', mock_table_name);
        //LOG.debug('   mock file:  ', mock_file_name);
        //LOG.debug('   synonym:    ', syn_name);
        //LOG.debug('   target:     ', target_name);
        //LOG.debug('   quoted:     ', srv_i.quotedNames ? 'yes' : 'no');
        //LOG.debug('------------------------------');

        // use normalized file name as key
        toBeSynonymized[file_name.replace(/\./g, '_')] = {
          entity_name: n,
          quotedNames: srv_i.quotedNames
          // TODO why not add column mapping here?
        };

        srv_i.synonyms[syn_name] = {
          "target": {
            "object": mock_table_name
          }
        }
        srv_i.synonymconfigs[syn_name] = {
          "target": {
            "schema.configure" : `${srv_i.name}/schema`,
            "object": target_name
          }
        }
      }
    }



    let hdbtable_quoted;
    if (Object.keys(csn_small.definitions).length > 0) {
      const opt2 = { ...options, sqlMapping: 'quoted' };
      hdbtable_quoted = compile.to.hdi.migration(csn_small, opt2, null).definitions
    }


    const results = [];

    const hdiResult = toHana_old(csn, options, ...etc);  // generator function
    // hdiResult: array of [content, {file: filename}]

    // turn tables to mock tables
    //   there unfortunately is no direct link to entity name
    //   for "regular" entities:             file name is <entity_name>.hdbtable
    //   for texts entities:                 file name is <entity_name>_texts.hdbtable
    //   for managed composition of aspects: file name is <entity_name>_<assoc>.hdbtable
    for(let result of hdiResult) {
      const content = result[0];
      const file = result[1];



      //
      // for imported entity, change hdbtable file to mock table 
      //
      // find entity that has the same file name after converting all "." to "_"
      let o = toBeSynonymized[file.file.replace(/\./g, '_')]
      if (o) {
        //LOG.debug('adapt hdbtable for entity', o.entity_name);
        //LOG.debug('   change file name:',  file.file, ' --> ', o.mock_file_name);
        //LOG.debug('   change table name:', o.table_name, ' --> ', o.mock_table_name);

        o.orig_file_name = file.file;

        let new_content = '';
        if (!o.quotedNames) {
          // in content, replace table name with mock table name
          let table_name      = o.entity_name.replace(/\./g, '_')
          let mock_table_name = table_name + '#mock';
          new_content = content.replace(new RegExp(`COLUMN TABLE ${table_name}`),
                                                   `COLUMN TABLE ${mock_table_name}`);
        }
        else {
          // get content from newly generated sql for quoted names
          let q = hdbtable_quoted.find( x => x.name === o.entity_name);
          if (q) {
            let table_name      = o.entity_name
            let mock_table_name = table_name + '#mock';
            new_content = q.sql.replace(new RegExp(`COLUMN TABLE "${table_name}"`),
                                                   `COLUMN TABLE "${mock_table_name}"`);
          }
        }

        let mock_file_name  = file.file.replace('.hdbtable', '#mock.hdbtable');
        result = [new_content, {file: mock_file_name}];
      }
      results.push(result);
    }

    // mapping views
    for (let f in toBeSynonymized) {
      let o = toBeSynonymized[f];
      if (!o.quotedNames) continue;
      let view_name = o.entity_name.replace(/\./g, '_');
      let file_name = o.orig_file_name.replace('.hdbtable', '.hdbview');

      let view_content = `VIEW ${view_name} AS SELECT\n` 

      let v = csn_small.definitions[o.entity_name]
      const selectColumns = [];
      for (let e in v.elements) {
        let el = v.elements[e];
        if (el.virtual || el.type == 'cds.Association' || el.type == 'cds.Composition') continue;
        selectColumns.push(`  "${e}" as "${e.replace(/\./g, '_').toUpperCase()}"`);
      }
      view_content += selectColumns.join(',\n') + '\n';
      view_content += `FROM "${o.entity_name}#syn"`;

      results.push([view_content, {file: file_name}]);
    }




    // add .hdbrole files for exported services
    for (let s of di_services_exp) {
      if (s?.roles.role_1.role.object_privileges.length > 0)
      {
        //LOG.debug('generate hdbroles files for service:', s.name);
        results.push([JSON.stringify(s.roles.role_1, null, 2), {file: `${s.name}#.hdbrole`}]);
        results.push([JSON.stringify(s.roles.role_2, null, 2), {file: `${s.name}.hdbrole`}]);
      }
    }
    // add .hdbsynonym and .hdbgrants files for imported services
    for (let s of di_services_imp) {
      if (s.synonyms) {
        //LOG.debug('generate .hdbsynonym, .hdbsynonymconfig, and .hdbgrants files for service:', s.name);
        results.push([JSON.stringify(s.synonyms, null, 2),     {file: `${s.name}.hdbsynonym`}]);




        let grant_content
        if (!s.quotedNames) {
          grant_content = {
            [s.name]: {
              "object_owner": { 
                "schema_roles" : [
                  {
                    "roles" : [ `${s.name}#` ]
                  }
                ]
              },
              "application_user": { 
                "schema_roles" : [
                  {
                    "roles" : [ `${s.name}` ]
                  }
                ]
              }
            }
          }
        }
        else {
          grant_content = {
            [s.name]: {
              "object_owner": { 
                "object_privileges" : s.qgrants
              },
              "application_user": { 
                "object_privileges" : s.qgrants
              }
            }
          }
        }


        // hdbsynonymconfig and hdbgrants is generated next to all other HDI files in src/gen
        // build will later move them to cfg/gen, where they are expected by HDI template mechanism
        if (cds?.env?.data_integration != 'mock') {
          results.push([JSON.stringify(s.synonymconfigs, null, 2), {file: `${s.name}.hdbsynonymconfig`}]);
          results.push([JSON.stringify(grant_content, null, 2),  {file: `${s.name}.hdbgrants`}]);
        }
      }
    }

    const synsyn = {
      "CDS_DATAPRODUCTS_SYNONYMS_SYNONYMS": {
        "target": {
          "schema" : "SYS",
          "object" : "SYNONYMS"
        }
      }
    }
    results.push([JSON.stringify(synsyn, null, 2), {file: `cds.dataproducts.synonyms.Synonyms.hdbsynonym`}]);

    const cond = di_services_imp.map( s => `SYNONYM_NAME like '${s.name.replace(/\./g, '_').toUpperCase()}_%'`).join(' or ')
    let synview = `view CDS_DATAPRODUCTS_SYNONYMS_STATUS as select
      SCHEMA_NAME,
      SYNONYM_NAME,
      OBJECT_SCHEMA,
      OBJECT_NAME,
      case when OBJECT_SCHEMA = SCHEMA_NAME and OBJECT_NAME = SYNONYM_NAME || '#MOCK' then 'mock'
           when OBJECT_NAME = SYNONYM_NAME                                            then 'connected'
                                                                                      else '?'
      end as STATUS,
      IS_VALID,
      CREATE_TIME
      from CDS_DATAPRODUCTS_SYNONYMS_SYNONYMS where SCHEMA_NAME = current_schema`;
    if (cond) synview += ` and (${cond})`
    results.push([synview,  {file: `cds.dataproducts.synonyms.Status.hdbview`}]);

    LOG.info('######### build plugin end #########');
    return results;
  }


  //
  // redirect .hdbtabledata to write csv data into the mock tables
  //
  const old_hdbtabledata = cds.compile.to.hdbtabledata

  cds.compile.to.hdbtabledata = async (csn, options = {}) => {
    LOG.info("######### hdbtabledata build plugin start #########")


    let di_services_imp = getImportedServices(csn);
    let toBeSynonymized = {};
    for (const n in csn.definitions) {
      let entity = csn.definitions[n];
      if (entity.kind != 'entity') continue;

      let srv_i = di_services_imp.find( x => n.startsWith(x.name + '.'))
      if (srv_i) {
        let table_name      = n.replace(/\./g, '_').toUpperCase();
        let mock_table_name = (!srv_i.quotedNames) ? table_name + '#MOCK'  : n + '#mock';

        LOG.info(`imported entity: ${n}`);
        //LOG.info('   table:     ', table_name);
        //LOG.info('   mock table:', mock_table_name);

        // use table name as key
        toBeSynonymized[table_name] = {
          mock_table_name: mock_table_name,
          quotedNames: srv_i.quotedNames
        };

      }
    }


    let res = await old_hdbtabledata(csn, options)
    let newres = []
    for (const val of res) {  // val is the json content of hdbtabledata
      let table_name = val[0].imports[0].target_table
      let o = toBeSynonymized[table_name]
      if (o) {
        LOG.info('redirect', val[1].file, 'to', o.mock_table_name)
        const imp = val[0].imports[0]
        imp.target_table = o.mock_table_name

        if (o.quotedNames && imp.column_mappings) {
          const remapped = {}
          for (const v of Object.values(imp.column_mappings)) {
            remapped[v] = v
          }
          imp.column_mappings = remapped
          imp.import_settings.import_columns = Object.keys(remapped)
        }

      }


      newres.push(val)
    }

    LOG.info("######### hdbtabledata build plugin end #########")
    return _toOutput(newres)  // caller expects a generator object
  }


  function* _toOutput(datas) {
    for (let i = 0; i < datas.length; i++) {
      if (datas[i]) yield datas[i]
    }
  }

}

module.exports = buildPlugin;
