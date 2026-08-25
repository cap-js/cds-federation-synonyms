'use strict'
const cds = require('@sap/cds')
const path = require('path')
const LOG = cds.log('cds-federation-synonyms')

/**
 * Returns the merged synonym configuration from static config (cds.env.requires of the main app)
 * and the dynamic config table (cds.dataproducts.synonyms.Registry).
 *
 * Static config entries are cds.env.requires entries with kind === 'hana-synonyms'; the service manager
 * name is taken from the 'service-manager' property. Dynamic entries take precedence over static ones.
 *
 * Returns an array with entries like { srv, target, source },
 * where source is one of: 'static', 'dynamic', 'dynamic (overrides static)'
 */
async function getResolvedConfig() {
  // read static config from main app env (not sidecar env)
  // static entries are cds.env.requires entries with kind === 'hana-synonyms',
  // where 'service-manager' names the target service manager (null = explicitly unconnected)
  const mpsConf = cds.requires['cds.xt.ModelProviderService'] || cds.requires.kinds['cds.xt.ModelProviderService']
  const mainEnv = mpsConf?.root ? cds.env.for('cds', path.resolve(cds.root, mpsConf.root)) : cds.env
  const requires = mainEnv.requires ?? {}
  const staticEntries = Object.entries(requires)
    .filter(([, conf]) => conf?.kind === 'hana-synonyms')
    .map(([srv, conf]) => ({ srv, target: conf['service-manager'] == null ? null : conf['service-manager'], source: 'static' }))

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
    srv: r.srv ?? r.SRV,
    target: r.target ?? r.TARGET ?? null,
    source: staticEntries.some(e => e.srv === (r.srv ?? r.SRV)) ? 'dynamic (overrides static)' : 'dynamic'
  }))

  const merged = [...dynamicEntries, ...staticEntries]
  LOG.info('===== getResolvedConfig - merged config:', JSON.stringify(merged))
  return merged
}

/**
 * Returns the check result for a single service: static-config, dynamic-config, and actual synonym status.
 */
async function checkService(srv) {
  const allConfig  = await getResolvedConfig()
  const staticCfg  = allConfig.find(e => e.srv === srv && e.source.startsWith('static'))
  const dynamicCfg = allConfig.find(e => e.srv === srv && e.source.startsWith('dynamic'))
  const configLabel = e => !e ? 'not set' : e.source === 'dynamic (overrides static)' ? String(e.target) + ' (overrides static)' : String(e.target)

  const srvPrefix  = srv.replace(/\./g, '_').toUpperCase() + '_'
  const statusRows = await cds.ql.SELECT.from('cds.dataproducts.synonyms.Status')
    .where`SYNONYM_NAME like ${srvPrefix + '%'}`
  const nConnected   = statusRows.filter(r => r.STATUS === 'connected').length
  const nUnconnected = statusRows.filter(r => r.STATUS === 'mock').length

  return {
    'static-config':  configLabel(staticCfg),
    'dynamic-config': configLabel(dynamicCfg),
    'synonyms': `${nConnected} connected, ${nUnconnected} unconnected`
  }
}

module.exports = { getResolvedConfig, checkService }
