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

        const merged = await getResolvedConfig(true)

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


    this.on('setDynamicConfig', async req => {
      try {
        const { tenant, ds } = await getTenant(req)
        LOG.info('===== setDynamicConfig (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const { 'cds.xt.ModelProviderService': mps } = cds.services
        const csn = await mps.getCsn({ tenant: tenant })
        const def = csn?.definitions?.[req.data.srv]
        if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
          throw new Error('service is not an imported data service: ' + req.data.srv)
        }

        const target = req.data.target === 'null' ? null : req.data.target
        await UPSERT.into(synTab).entries({ srv: req.data.srv, target })

        LOG.info(`===== setDynamicConfig (mtx) - dynamic config set: ${req.data.srv} -> ${target}`)
        let result = `dynamic config set (mtx): ${req.data.srv} -> ${target}`

        if (req.data.triggerUpgrade) {
          LOG.info('===== setDynamicConfig (mtx) - calling upgrade')
          const t0_upgrade = Date.now()
          await ds.upgrade(tenant)
          LOG.info(`===== setDynamicConfig (mtx) - upgrade took ${Date.now() - t0_upgrade} ms`)
          result += `, with upgrade (took ${Date.now() - t0_upgrade} ms)`
        }
        else {
          LOG.info('===== setDynamicConfig (mtx) - upgrade skipped')
          result += ', upgrade skipped'
        }

        return result

      } catch (err) {
        LOG.error('===== setDynamicConfig (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })


    this.on('deleteDynamicConfig', async req => {
      try {
        const { tenant, ds } = await getTenant(req)
        LOG.info('===== deleteDynamicConfig (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        await DELETE.from(synTab).where({ srv: req.data.srv })

        LOG.info(`===== deleteDynamicConfig (mtx) - dynamic config deleted: ${req.data.srv}`)
        let result = `dynamic config deleted (mtx): ${req.data.srv}`

        if (req.data.triggerUpgrade) {
          LOG.info('===== deleteDynamicConfig (mtx) - calling upgrade')
          const t0_upgrade = Date.now()
          await ds.upgrade(tenant)
          LOG.info(`===== deleteDynamicConfig (mtx) - upgrade took ${Date.now() - t0_upgrade} ms`)
          result += `, with upgrade (took ${Date.now() - t0_upgrade} ms)`
        }
        else {
          LOG.info('===== deleteDynamicConfig (mtx) - upgrade skipped')
          result += ', upgrade skipped'
        }

        return result

      } catch (err) {
        LOG.error('===== deleteDynamicConfig (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    })

  }
}

module.exports = { Exposure, ConfigService }
