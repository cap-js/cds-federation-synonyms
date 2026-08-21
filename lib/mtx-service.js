'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService } = require('./config-helper')
const LOG = cds.log('cds-federation-synonyms')

// running in the context of MTX sidecar's model

// exposed at endpoint /-/cds/readconf
class Exposure extends cds.ApplicationService {

  init() {

    const { Registry, Synonyms, Status } = this.entities

    async function getTenant(req) {
      // tenant is mandatory parameter to the call, for OData entity w/ param find it in req.params
      const applicationTenant = req?.params?.[0]?.tenant || req?.data?.tenant;
      if (!applicationTenant) throw new Error('tenant parameter missing')

      const { 'cds.xt.DeploymentService': ds } = cds.services
      if (!ds) throw new Error('DeploymentService not found')

      const tenantsInT0 = await ds.getTenants()
      if (!tenantsInT0.includes(applicationTenant)) throw new Error('tenant not found: ' + applicationTenant)

      return {
        tenant: applicationTenant,
        ds: ds
      }
    }


    this.on('READ', Registry, async (req) => {
      LOG.info('===== READ readconf/Registry (mtx)')

      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== READ readconf/Registry (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const query = SELECT.from('cds.dataproducts.synonyms.Registry');
        const results = await query;
        return results;

      } catch (err) {
        LOG.error('===== READ readconf/Registry (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    });

    this.on('READ', Synonyms, async (req) => {
      LOG.info('===== READ readconf/Synonyms (mtx)')

      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== READ readconf/Synonyms - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const query = SELECT.from('cds.dataproducts.synonyms.Synonyms').where`SCHEMA_NAME = current_schema()`
        const results = await query;
        return results;

      } catch (err) {
        LOG.error('===== READ readconf/Synonyms (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    });

    this.on('READ', Status, async (req) => {
      LOG.info('===== READ readconf/Status (mtx)')

      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== READ readconf/Status - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const query = SELECT.from('cds.dataproducts.synonyms.Status');
        const results = await query;
        return results;

      } catch (err) {
        LOG.error('===== READ readconf/Status (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    });

    // needs to be at the end, otherwise the generic handlers are registered first
    super.init();
  }
}


// exposed at endpoint /-/cds/synonymapi
class ConfigService extends cds.ApplicationService {

  init() {
    super.init()

    const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    this.on('echo', async req => {
      LOG.info('===== echo (mtx) req:', JSON.stringify(req))

      const result = 'echo (mtx) received: "' + req.data.msg + '"'

      LOG.info('===== echo (mtx) result:', result)
      return result
    })


    async function getTenant(req) {
      // tenant is parameter to the call, for rest it is in req.data
      const applicationTenant = req?.data?.tenant;
      if (!applicationTenant) throw new Error('tenant parameter missing')

      const { 'cds.xt.DeploymentService': ds } = cds.services
      if (!ds) throw new Error('DeploymentService not found')

      const tenantsInT0 = await ds.getTenants()
      if (!tenantsInT0.includes(applicationTenant)) throw new Error('tenant not found: ' + applicationTenant)

      return {
        tenant: applicationTenant,
        ds: ds
      }
    }


    this.on('getConfig', async req => {
      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== getConfig (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const merged = await getResolvedConfig()

        const result = JSON.stringify(merged)
        LOG.info('===== getConfig (mtx) - result:', result)
        return result

      } catch (err) {
        LOG.error('===== getConfig (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })


    this.on('check', async req => {
      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== check (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const { 'cds.xt.ModelProviderService': mps } = cds.services
        const csn = await mps.getCsn({ tenant: tenant })
        const def = csn?.definitions?.[req.data.srv]
        if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
          throw new Error('service is not an imported data service: ' + req.data.srv)
        }

        // static-config and dynamic-config from merged config, actual synonym status from Status view
        const result = await checkService(req.data.srv)

        LOG.info('===== check (mtx) - result:', JSON.stringify(result))
        return result

      } catch (err) {
        LOG.error('===== check (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })


    this.on('connect', async req => {
      try {
        const { tenant, ds } = await getTenant(req)
        LOG.info('===== connect (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const { 'cds.xt.ModelProviderService': mps } = cds.services
        const csn = await mps.getCsn({ tenant: tenant })
        const def = csn?.definitions?.[req.data.srv]
        if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
          throw new Error('service is not an imported data service: ' + req.data.srv)
        }

        // check if the service is already conected
        const existingRecord = await cds.ql.SELECT.one.from(synTab).where({ srv: req.data.srv })
        const syn_entry = {
          srv: req.data.srv,
          target: req.data.target
        }
        if (existingRecord && existingRecord.target === req.data.target) {
          LOG.info('===== connect (mtx) - Record already exists with same target, nothing to do (upgrade skipped)')
          return 'already connected ' + req.data.srv + ' to ' + req.data.target + ' (upgrade skipped)'
        } else if (existingRecord) {
          LOG.info('===== connect (mtx) - Record already exists with different target, reconnecting ...')
          await UPDATE(synTab).set(syn_entry).where({ srv: req.data.srv })
        } else {
          LOG.info('===== connect (mtx) - No record found, connecting ...')
          await INSERT.into(synTab).entries(syn_entry)
        }

        let result = `connected (mtx): ${req.data.srv} to ${req.data.target}`

        if (req.data.triggerUpgrade) {
          LOG.info('===== connect (mtx) - calling upgrade')
          const t0_upgrade = Date.now()
          await ds.upgrade(tenant)
          LOG.info(`===== connect (mtx) - upgrade took ${Date.now() - t0_upgrade} ms`)
          result += ` with upgrade (took ${Date.now() - t0_upgrade} ms)`
        }
        else {
          LOG.info('===== connect (mtx) - upgrade skipped')
          result += ' (upgrade skipped)'
        }

        LOG.info('===== connect (mtx) - result:', result)
        return result

      } catch (err) {
        LOG.error('===== connect (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })


    this.on('unconnect', async req => {
      try {
        const { tenant, ds } = await getTenant(req)
        LOG.info('===== unconnect (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        // check if the service is already conected
        const existingRecord = await cds.ql.SELECT.one.from(synTab).where({ srv: req.data.srv })

        if (existingRecord) {
          LOG.info('===== unconnect (mtx) - Record exists:', existingRecord, 'diconnecting ...')
          await DELETE.from(synTab).where({ srv: req.data.srv })
        } else {
          LOG.info('===== unconnect (mtx) - No existing record found, nothing to do (upgrade skipped)')
          return 'was not connected (upgrade skipped)'
        }

        let result = `disconnected (mtx): ${req.data.srv}`

        if (req.data.triggerUpgrade) {
          LOG.info('===== unconnect (mtx) - calling upgrade')
          const t0_upgrade = Date.now()
          await ds.upgrade(tenant)
          LOG.info(`===== unconnect (mtx) - upgrade took ${Date.now() - t0_upgrade} ms`)
          result += ` with upgrade (took ${Date.now() - t0_upgrade} ms)`
        }
        else {
          LOG.info('===== unconnect (mtx) - upgrade skipped')
          result += ' (upgrade skipped)'
        }

        LOG.info('===== unconnect (mtx) - result:', result)
        return result

      } catch (err) {
        LOG.error('===== unconnect (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })

  }
}

module.exports = { Exposure, ConfigService }
