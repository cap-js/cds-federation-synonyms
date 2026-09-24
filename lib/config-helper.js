'use strict'
const cds = require('@sap/cds')
const path = require('path')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

/**
 * Returns the merged synonym configuration from static config (cds.env.requires of the main app)
 * and the dynamic config table (cds.dataproducts.synonyms.Registry).
 *
 * Static config entries are cds.env.requires entries with kind === 'hana-synonyms'; the service manager
 * is taken from the 'service-manager' property and the provider tenant from 'provider-tenant'.
 * Dynamic entries take precedence over static ones.
 *
 * Returns an array with entries like { srv, provider_service_manager, provider_tenant, config_origin },
 * where config_origin is one of: 'static', 'dynamic', 'dynamic (overrides static)'
 *
 * @param {boolean} [all=false] - if false (default), static entries overridden by a dynamic entry are omitted,
 *                                so there is at most one entry per service. If true, all entries are returned.
 */
async function getResolvedConfig(all = false) {
  // read static config from main app env (not sidecar env)
  // static entries are cds.env.requires entries with kind === 'hana-synonyms',
  // where 'service-manager' names the provider service manager (null = explicitly unconnected)
  const mpsConf = cds.requires['cds.xt.ModelProviderService'] || cds.requires.kinds['cds.xt.ModelProviderService']
  const mainEnv = mpsConf?.root ? cds.env.for('cds', path.resolve(cds.root, mpsConf.root)) : cds.env
  const requires = mainEnv.requires ?? {}
  const staticEntries = Object.entries(requires)
    .filter(([, conf]) => conf?.kind === 'hana-synonyms')
    .map(([srv, conf]) => ({
      srv,
      provider_service_manager: conf['service-manager'] ?? null,
      provider_tenant:          conf['provider-tenant'] ?? null,
      config_origin: 'static'
    }))

  // read dynamic config from table (may fail on first deployment before table exists)
  // if cds.dataproducts.synonyms.Registry is in the model, columns are "srv"/"target",
  // otherwise "SRV"/"TARGET" - cover both cases
  //
  // we ensured via package.json that the synonym registry table is in the model of the mtx app
  // const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']
  // const configEntries = await cds.ql.SELECT.from(synTab)
  // BUT: when the "before deploy" funtion is called after redeploying the app (there seems to be an auto-redeploy?)
  // the synTab is not in the model yet ??!! -> TODO can we fix this?
  let tableRecords = []
  try {
    tableRecords = await cds.ql.SELECT.from('cds.dataproducts.synonyms.Registry')
  } catch (e) {
    // this error is expected for the first deployment, where the table is not yet created
    LOG.info('===== getResolvedConfig - could not read config table:', e.message)
  }
  const dynamicEntries = tableRecords.map(r => ({
    srv:                     r.srv ?? r.SRV,
    provider_service_manager: r.provider_service_manager ?? r.PROVIDER_SERVICE_MANAGER ?? null,
    provider_tenant:          r.provider_tenant          ?? r.PROVIDER_TENANT          ?? null,
    config_origin: staticEntries.some(e => e.srv === (r.srv ?? r.SRV)) ? 'dynamic (overrides static)' : 'dynamic'
  }))

  const merged = [...dynamicEntries, ...staticEntries]
  const result = all ? merged : merged.filter(e => !(e.config_origin === 'static' && dynamicEntries.some(d => d.srv === e.srv)))
  LOG.info(`===== getResolvedConfig - ${all ? 'merged' : 'effective'} config:`, JSON.stringify(result))
  return result
}

/**
 * Returns the check result for a single service: static-config, dynamic-config, and actual synonym status.
 */
async function checkService(srv) {
  const allConfig  = await getResolvedConfig(true)
  const staticCfg  = allConfig.find(e => e.srv === srv && e.config_origin.startsWith('static'))
  const dynamicCfg = allConfig.find(e => e.srv === srv && e.config_origin.startsWith('dynamic'))

  const configLabel = e => {
    if (!e) return 'not set'
    const label = e.provider_service_manager
      ? `${e.provider_service_manager} / ${e.provider_tenant ?? 'null'}`
      : 'null'
    return e.config_origin === 'dynamic (overrides static)' ? label + ' (overrides static)' : label
  }

  const srvPrefix  = srv.replace(/\./g, '_').toUpperCase() + '_'

  // srvPrefix is safe to interpolate: derived from a service name already validated
  // against cds.model.definitions (letters, digits, underscores only after replace)
  const sql = (await buildStatusSql()) + ` AND SYNONYM_NAME like '${srvPrefix}%'`
  const statusRows = await cds.db.run(sql)

  const nConnected   = statusRows.filter(r => r.STATUS === 'connected').length
  const nUnconnected = statusRows.filter(r => r.STATUS === 'mock').length

  const effectiveCfg = dynamicCfg ?? staticCfg
  const warnings = []
  if (effectiveCfg && effectiveCfg.provider_service_manager === null && effectiveCfg.provider_tenant !== null) {
    warnings.push('provider_service_manager is null but provider_tenant is set — will be treated as unconnected')
  }

  return {
    'static-config':  configLabel(staticCfg),
    'dynamic-config': configLabel(dynamicCfg),
    'synonyms': `${nConnected} connected, ${nUnconnected} unconnected`,
    ...(warnings.length > 0 ? { warnings } : {})
  }
}

module.exports = { getResolvedConfig, checkService }
