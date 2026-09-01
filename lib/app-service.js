'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService } = require('./config-helper')
const LOG = cds.log('cds-federation-synonyms')

// running in the context of the application's model

// exposed at endpoint '/synonymapi'
class ConfigService extends cds.ApplicationService {

  init() {
    super.init()

    const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    function _validateImportedService(srv) {
      if (typeof srv !== 'string' || !srv.trim()) {
        throw new Error('srv parameter missing')
      }

      const def = cds.model?.definitions?.[srv]
      if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
        throw new Error('service is not an imported data service: ' + srv)
      }
    }

    this.on('echo', async req => {
      LOG.info('/echo (srv) req:',         JSON.stringify(req))
      LOG.info('/echo (srv) cds.context:', JSON.stringify(cds.context))
      LOG.info('/echo (srv) req.data:',    JSON.stringify(req.data))

      const result = 'echo (srv) received: "' + req.data.msg + '"'

      LOG.info('/echo (srv) result:', result)
      return result
    })


    this.on('getConfig', async req => {
      const merged = await getResolvedConfig(true)
      LOG.info('/getConfig (srv) - result:', JSON.stringify(merged))
      return JSON.stringify(merged)
    })


    this.on('check', async req => {
      LOG.info('/check (srv) req.data:', JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      const result = await checkService(req.data.srv)

      LOG.info('/check (srv) - result:', JSON.stringify(result))
      return result
    })


    this.on('setDynamicConfig', async req => {
      //LOG.info('/setDynamicConfig (srv) req:',         JSON.stringify(req))
      //LOG.info('/setDynamicConfig (srv) cds.context:', JSON.stringify(cds.context))
      LOG.info('/setDynamicConfig (srv) req.data:',    JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      const target = req.data.target === 'null' ? null : req.data.target
      await UPSERT.into(synTab).entries({ srv: req.data.srv, target })

      let result = 'dynamic config set (srv): ' + req.data.srv + ' -> ' + target

      LOG.info('/setDynamicConfig (srv) result:', result)
      return result
    })


    this.on('deleteDynamicConfig', async req => {
      //LOG.info('/deleteDynamicConfig (srv) req:',         JSON.stringify(req))
      //LOG.info('/deleteDynamicConfig (srv) cds.context:', JSON.stringify(cds.context))
      LOG.info('/deleteDynamicConfig (srv) req.data:',    JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      await DELETE.from(synTab).where({srv: req.data.srv})

      let result = 'dynamic config deleted (srv): ' + req.data.srv

      LOG.info('/deleteDynamicConfig (srv) result:', result)
      return result
    })

  }
}

module.exports = ConfigService
