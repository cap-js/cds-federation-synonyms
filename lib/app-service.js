'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService } = require('./config-helper')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

// running in the context of the application's model

// exposed at endpoint '/synonymapi'
class ConfigService extends cds.ApplicationService {

  init() {

    const { Status } = this.entities

    this.on('READ', Status, async (req) => {
      LOG.info('synonymapi/Status (app)')
      try {
        const [sql, params] = await buildStatusSql()
        LOG.debug('synonymapi/Status (app) - sql: ' + sql)
        const results = await cds.db.run(sql, params)
        LOG.debug('synonymapi/Status (app) - results: ' + JSON.stringify(results))
        return results
      } catch (err) {
        LOG.error('synonymapi/Status (app) -', err.message)
        req.reject(422, 'error: ' + err.message)
      }
    })

    const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    function _validateService(srv) {
      if (typeof srv !== 'string' || !srv.trim()) {
        throw new Error('srv parameter missing')
      }
      const def = cds.model?.definitions?.[srv]
      if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
        throw new Error('service is not an imported data service: ' + srv)
      }
    }

    this.on('echo', async req => {
      LOG.info('synonymapi/echo (srv) - req:', JSON.stringify(req))

      const result = 'echo (srv) received: "' + req.data.msg + '"'

      LOG.info('synonymapi/echo (srv) - result:', result)
      return result
    })


    this.on('getConfig', async req => {
      const merged = await getResolvedConfig(true)
      const result = JSON.stringify(merged)
      LOG.info('synonymapi/getConfig (srv) - result:', result)
      return result
    })


    this.on('check', async req => {
      LOG.info('synonymapi/check (srv) - req.data:', JSON.stringify(req.data))
      _validateService(req.data.srv)

      const result = await checkService(req.data.srv)

      LOG.info('synonymapi/check (srv) - result:', JSON.stringify(result))
      return result
    })


    this.on('setDynamicConfig', async req => {
      LOG.info('synonymapi/setDynamicConfig (srv) - req.data:', JSON.stringify(req.data))
      _validateService(req.data.srv)

      const provider_service_manager = req.data.provider_service_manager ?? null
      const provider_tenant          = req.data.provider_tenant          ?? null
      if (provider_service_manager === null && provider_tenant !== null) {
        throw new Error('provider_tenant must be null when provider_service_manager is null')
      }

      await UPSERT.into(synTab).entries({ srv: req.data.srv, provider_service_manager, provider_tenant })

      let result = 'dynamic config set (srv): ' + req.data.srv + ' -> ' + provider_service_manager + ' / ' + provider_tenant
      LOG.info('synonymapi/setDynamicConfig (srv) - result:', result)
      return result
    })


    this.on('deleteDynamicConfig', async req => {
      LOG.info('synonymapi/deleteDynamicConfig (srv) - req.data:', JSON.stringify(req.data))

      await DELETE.from(synTab).where({srv: req.data.srv})

      let result = 'dynamic config deleted (srv): ' + req.data.srv
      LOG.info('synonymapi/deleteDynamicConfig (srv) - result:', result)
      return result
    })

    // needs to be at the end, otherwise the generic handlers are registered first
    super.init()
  }
}

module.exports = { ConfigService }
