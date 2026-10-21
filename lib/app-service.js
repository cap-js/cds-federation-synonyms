'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService } = require('./config-helper')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

class ClientError extends Error {}

// running in the context of the application's model

// exposed at endpoint '/synonymapi'
class ConfigService extends cds.ApplicationService {

  init() {
    const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    function _validateService(srv) {
      if (typeof srv !== 'string' || !srv.trim()) {
        throw new ClientError('srv parameter missing')
      }
      const def = cds.model?.definitions?.[srv]
      if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
        throw new ClientError('service is not an imported data service: ' + srv)
      }
    }


    const { Status } = this.entities
    this.on('READ', Status, async (req) => {
      LOG.debug('synonymapi/Status (app)')

      try {
        const [sql, params] = await buildStatusSql()
        LOG.debug('synonymapi/Status (app) - sql: ' + sql)
        const results = await cds.db.run(sql, params)
        LOG.debug('synonymapi/Status (app) - results: ' + JSON.stringify(results))
        return results

      } catch (err) {
        LOG.error('synonymapi/Status (app) -', err)
        req.reject(500, 'synonym configuration error — see application log for details')
      }
    })


    this.on('getConfig', async req => {
      try {
        const merged = await getResolvedConfig(true)
        const result = JSON.stringify(merged)
        LOG.debug('synonymapi/getConfig (srv) - result:', result)
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/getConfig (srv) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/getConfig (srv) -', err)
          req.reject(500, 'synonym configuration error — see application log for details')
        }
      }
    })


    this.on('check', async req => {
      try {
        _validateService(req.data.srv)

        const result = await checkService(req.data.srv)

        LOG.debug('synonymapi/check (srv) - result:', JSON.stringify(result))
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/check (srv) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/check (srv) -', err)
          req.reject(500, 'synonym configuration error — see application log for details')
        }
      }
    })


    this.on('setDynamicConfig', async req => {
      try {
        LOG.debug('synonymapi/setDynamicConfig (srv) - req.data:', JSON.stringify(req.data))
        _validateService(req.data.srv)

        const provider_service_manager = req.data.provider_service_manager ?? null
        const provider_tenant          = req.data.provider_tenant          ?? null
        if (provider_service_manager === null && provider_tenant !== null) {
          throw new ClientError('provider_tenant must be null when provider_service_manager is null')
        }

        await UPSERT.into(synTab).entries({ srv: req.data.srv, provider_service_manager, provider_tenant })

        LOG.info(`synonymapi/setDynamicConfig (srv) dynamic config set: ${req.data.srv} -> ${provider_service_manager} / ${provider_tenant}`)
        let result = `dynamic config set (srv): ${req.data.srv} -> ${provider_service_manager} / ${provider_tenant}`

        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/setDynamicConfig (srv) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/setDynamicConfig (srv) -', err)
          req.reject(500, 'synonym configuration error — see application log for details')
        }
      }
    })


    this.on('deleteDynamicConfig', async req => {
      try {
        LOG.debug('synonymapi/deleteDynamicConfig (srv) - req.data:', JSON.stringify(req.data))

        await DELETE.from(synTab).where({srv: req.data.srv})

        LOG.info(`synonymapi/deleteDynamicConfig (srv) - dynamic config deleted: ${req.data.srv}`)
        let result = `dynamic config deleted (srv): ${req.data.srv}`
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/deleteDynamicConfig (srv) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/deleteDynamicConfig (srv) -', err)
          req.reject(500, 'synonym configuration error — see application log for details')
        }
      }
    })

    // needs to be at the end, otherwise the generic handlers are registered first
    super.init()
  }
}

module.exports = { ConfigService }
