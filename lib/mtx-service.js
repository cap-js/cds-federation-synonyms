'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService } = require('./config-helper')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

// running in the context of MTX sidecar's model

// exposed at endpoint /-/cds/synonymapi
class ConfigService extends cds.ApplicationService {

  init() {
      const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    async function getTenant(req) {
      // tenant is mandatory parameter to the calls,
      //   for entity w/ param find it in req.params
      //   for actions it is in req.data
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

    async function _validateService(srv, tenant) {
      if (typeof srv !== 'string' || !srv.trim()) {
        throw new Error('srv parameter missing')
      }
      const { 'cds.xt.ModelProviderService': mps } = cds.services
      const csn = await mps.getCsn({ tenant: tenant })
      const def = csn?.definitions?.[srv]
      if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
        throw new Error('service is not an imported data service: ' + srv)
      }
    }


    const { Status } = this.entities
    this.on('READ', Status, async (req) => {
      LOG.info('===== READ readconf/Status (mtx)')
      LOG.debug('===== READ readconf/Status (mtx) - req: ' + JSON.stringify(req))

      try {
        const { tenant } = await getTenant(req)
        LOG.info('===== getConfig (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const sql = await buildStatusSql(tenant)
        LOG.debug('===== READ readconf/Status (mtx) - sql: ' + sql)
        const results = await cds.db.run(sql);
        LOG.debug('===== READ readconf/Status (mtx) - results: ' + JSON.stringify(results))
        return results;

      } catch (err) {
        LOG.error('===== READ readconf/Status (mtx) -', err.message)
        req.reject(422, 'error: ' + err.message)
        return 'error: ' + err.message
      }
    });




    this.on('echo', async req => {
      LOG.info('===== echo (mtx) - req:', JSON.stringify(req))

      const result = 'echo (mtx) - received: "' + req.data.msg + '"'

      LOG.info('===== echo (mtx) - result:', result)
      return result
    })


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

        await _validateService(req.data.srv, tenant)

        // static-config and dynamic-config from merged config, actual synonym status from DB
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

        await _validateService(req.data.srv, tenant)

        const provider_service_manager = req.data.provider_service_manager ?? null
        const provider_tenant          = req.data.provider_tenant          ?? null

        if (provider_service_manager === null && provider_tenant !== null) {
          throw new Error('provider_tenant must be null when provider_service_manager is null')
        }

        await UPSERT.into(synTab).entries({ srv: req.data.srv, provider_service_manager, provider_tenant })

        LOG.info(`===== setDynamicConfig (mtx) - dynamic config set: ${req.data.srv} -> ${provider_service_manager} / ${provider_tenant}`)
        let result = `dynamic config set (mtx): ${req.data.srv} -> ${provider_service_manager} / ${provider_tenant}`

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

    // needs to be at the end, otherwise the generic handlers are registered first
    super.init();
  }
}

module.exports = { ConfigService }
