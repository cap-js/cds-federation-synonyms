'use strict'
const cds = require('@sap/cds')
const LOG = cds.log('cds-federation-synonyms')

// running in the context of the application's model

// path: '/synonymapi'
class ConfigService extends cds.ApplicationService {

  init() {
    //console.log("########## Initializing the synonym service ##########")

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
      // LOG.info('/getConfig (srv) req:', JSON.stringify(req))
      // LOG.info('/getConfig (srv) cds.context:', JSON.stringify(cds.context))

      // read config table
      const configRecords = await cds.ql.SELECT.from(synTab)
      LOG.info('/getConfig (srv) - config records:', JSON.stringify(configRecords))

      const result = JSON.stringify(configRecords)

      LOG.info('/getConfig (srv) - result:', result)
      return result
    })


    this.on('check', async req => {
      LOG.info('/check (srv) req.data:', JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      //let cds_service = req.data.srv
      //LOG.info('/check (srv) - A: ' + JSON.stringify(cds_service))

      // check connection status of service
      const existingRecord = await cds.ql.SELECT.one.from(synTab).where({srv: req.data.srv})

      let result = 'check (srv): ' + req.data.srv

      if (existingRecord) {
        LOG.info('/check (srv) - Record found:', existingRecord)
        result += ' is connected to ' + existingRecord.target
      } else {
        LOG.info('/check (srv) - No record found, connecting ...')
        result += ' is not connected'
      }

      LOG.info('/check (srv) - result:', result)
      return result
    })


    this.on('connect', async req => {
      //LOG.info('/connect (srv) req:',         JSON.stringify(req))
      //LOG.info('/connect (srv) cds.context:', JSON.stringify(cds.context))
      LOG.info('/connect (srv) req.data:',    JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      // check if the service is already conected
      const existingRecord = await cds.ql.SELECT.one.from(synTab).where({srv: req.data.srv})
      const syn_entry = {
        srv: req.data.srv,
        target: req.data.target
      }
      if (existingRecord && existingRecord.target === req.data.target) {
        LOG.info('/connect (srv) - Record already exists with same target, nothing to do')
        return 'already connected ' + req.data.srv + ' to ' + req.data.target
      } else if (existingRecord) {
        LOG.info('/connect (srv) - Record already exists with different target, reconnecting ...')
        await UPDATE(synTab).set(syn_entry).where({srv: req.data.srv})
      } else {
        LOG.info('/connect (srv) - No record found, connecting ...')
        await INSERT.into(synTab).entries(syn_entry)
      }

      let result = 'connected (srv) - ' + req.data.srv + ' to ' + req.data.target

      LOG.info('/connect (srv) result:', result)
      return result
    })


    this.on('unconnect', async req => {
      //LOG.info('/unconnect (srv) req:',         JSON.stringify(req))
      //LOG.info('/unconnect (srv) cds.context:', JSON.stringify(cds.context))
      LOG.info('/unconnect (srv) req.data:',    JSON.stringify(req.data))

      _validateImportedService(req.data.srv)

      // check if the service is already conected
      const existingRecord = await cds.ql.SELECT.one.from(synTab).where({srv: req.data.srv})

      if (existingRecord) {
        LOG.info('/unconnect (srv) - Record exists:', existingRecord, 'disconnecting ...')
        await DELETE.from(synTab).where({srv: req.data.srv})
      } else {
        LOG.info('/unconnect (srv) - No existing record found, nothing to do')
        return 'was not connected'
      }

      let result = 'disconnected (srv) - ' + req.data.srv

      LOG.info('/unconnect (srv) result:', result)
      return result
    })


  }
}

module.exports = ConfigService
