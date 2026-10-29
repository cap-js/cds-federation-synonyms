'use strict'
const cds = require('@sap/cds')
const { getResolvedConfig, checkService, getSmConfig } = require('./config-helper')
const { buildStatusSql } = require('./status-sql')
const LOG = cds.log('cds-federation-synonyms')

class ClientError extends Error {}

// running in the context of MTX sidecar's model

// exposed at endpoint /-/cds/synonymapi
class ConfigService extends cds.ApplicationService {

  init() {
    const synTab = cds.model.definitions['cds.dataproducts.synonyms.Registry']

    async function getTenant(req) {
      // tenant is mandatory parameter to the calls - for entity w/ param find it in req.params
      //                                            - for actions it is in req.data
      const applicationTenant = req?.params?.[0]?.tenant || req?.data?.tenant;
      if (!applicationTenant) throw new ClientError('tenant parameter missing')
      const { 'cds.xt.DeploymentService': ds } = cds.services
      if (!ds) throw new Error('DeploymentService not found')
        const tenantsInT0 = await ds.getTenants()
      if (!tenantsInT0.includes(applicationTenant)) throw new ClientError('tenant not found: ' + applicationTenant)

      return {
        tenant: applicationTenant,
        ds: ds
      }
    }

    async function _validateService(srv, tenant) {
      if (typeof srv !== 'string' || !srv.trim()) {
        throw new ClientError('srv parameter missing')
      }
      const { 'cds.xt.ModelProviderService': mps } = cds.services
      const csn = await mps.getCsn({ tenant: tenant })
      const def = csn?.definitions?.[srv]
      if (!(def && def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])) {
        throw new ClientError('service is not an imported data service: ' + srv)
      }
    }

    // validate that `sm` may be connected/unconnected via the API and return its static policy
    function _validateSm(sm) {
      if (typeof sm !== 'string' || !sm.trim()) {
        throw new ClientError('sm parameter missing')
      }
      const smConfig = getSmConfig()
      const policy = smConfig[sm]
      if (!policy) {
        // sm is not statically declared -> not part of the allowlist
        throw new ClientError('unknown service manager (not statically declared): ' + sm)
      }
      if (!policy.deferred) {
        throw new ClientError('service manager is statically controlled; connect/unconnect not allowed: ' + sm)
      }
      return policy
    }

    // optionally trigger a tenant upgrade (deploy) and return a status suffix for the result string
    async function _maybeUpgrade(req, ds, tenant, op) {
      if (req.data.triggerUpgrade) {
        LOG.info(`synonymapi/${op} (mtx) - calling upgrade`)
        const t0_upgrade = Date.now()
        await ds.upgrade(tenant)
        const took = Date.now() - t0_upgrade
        LOG.info(`synonymapi/${op} (mtx) - upgrade took ${took} ms`)
        return `, with upgrade (took ${took} ms)`
      }
      LOG.info(`synonymapi/${op} (mtx) - upgrade skipped`)
      return ', upgrade skipped'
    }


    const { Status } = this.entities
    this.on('READ', Status, async (req) => {
      LOG.debug('synonymapi/Status (mtx)')

      try {
        const { tenant } = await getTenant(req)
        LOG.debug('synonymapi/Status (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const [sql, params] = await buildStatusSql(tenant)
        LOG.debug('synonymapi/Status (mtx) - sql: ' + sql)
        const results = await cds.db.run(sql, params);
        LOG.debug('synonymapi/Status (mtx) - results: ' + JSON.stringify(results))
        return results;

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/Status (mtx) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/Status (mtx) -', err)
          req.reject(500, 'synonym configuration error - see application log for details')
        }
      }
    });


    this.on('getConfig', async req => {
      try {
        const { tenant } = await getTenant(req)
        LOG.debug('synonymapi/getConfig (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const merged = await getResolvedConfig()
        const result = JSON.stringify(merged)
        LOG.debug('synonymapi/getConfig (mtx) - result:', result)
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/getConfig (mtx) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/getConfig (mtx) -', err)
          req.reject(500, 'synonym configuration error - see application log for details')
        }
      }
    })


    this.on('check', async req => {
      try {
        const { tenant } = await getTenant(req)
        LOG.debug('synonymapi/check (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        await _validateService(req.data.srv, tenant)

        // static-config and dynamic-config from merged config, actual synonym status from DB
        const result = await checkService(req.data.srv)

        LOG.debug('synonymapi/check (mtx) - result:', JSON.stringify(result))
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/check (mtx) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/check (mtx) -', err)
          req.reject(500, 'synonym configuration error - see application log for details')
        }
      }
    })


    this.on('connect', async req => {
      try {
        LOG.debug('synonymapi/connect (mtx) - req.data:', JSON.stringify(req.data))
        const { tenant, ds } = await getTenant(req)
        LOG.debug('synonymapi/connect (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const sm = req.data.sm
        const policy = _validateSm(sm)

        const provider_tenant = req.data.provider_tenant ?? null
        if (provider_tenant !== null && !policy.allowApiProviderTenant) {
          throw new ClientError('provider_tenant not allowed for this service manager (allow-api-provider-tenant is not set): ' + sm)
        }

        // presence of the row = connected; store the provider_tenant only when allowed
        await UPSERT.into(synTab).entries({ provider_service_manager: sm, provider_tenant })

        LOG.info(`synonymapi/connect (mtx) - connected: ${sm} / ${provider_tenant}`)
        let result = `connected (mtx): ${sm} / ${provider_tenant}`

        result += await _maybeUpgrade(req, ds, tenant, 'connect')
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/connect (mtx) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/connect (mtx) -', err)
          req.reject(500, 'synonym configuration error - see application log for details')
        }
      }
    })


    this.on('unconnect', async req => {
      try {
        LOG.debug('synonymapi/unconnect (mtx) - req.data:', JSON.stringify(req.data))
        const { tenant, ds } = await getTenant(req)
        LOG.debug('synonymapi/unconnect (mtx) - tenant verified successfully: ' + tenant)
        cds.context.tenant = tenant

        const sm = req.data.sm
        if (typeof sm !== 'string' || !sm.trim()) throw new ClientError('sm parameter missing')

        // Deliberately NOT validated against the static allowlist / deferred flag (unlike connect):
        // unconnect only ever DELETES a row, i.e. it is the safe direction (removes a connection,
        // never grants one), so the allowlist is not needed here. Always allowing the delete also
        // lets operators clean up stale/orphaned rows left behind when an SM's static config changed
        // (mapping removed, or switched deferred -> static) - otherwise such a row would be stuck and
        // could silently resurrect if the SM were ever switched back to deferred.
        await DELETE.from(synTab).where({ provider_service_manager: sm })

        LOG.info(`synonymapi/unconnect (mtx) - unconnected: ${sm}`)
        let result = `unconnected (mtx): ${sm}`

        result += await _maybeUpgrade(req, ds, tenant, 'unconnect')
        return result

      } catch (err) {
        if (err instanceof ClientError) {
          LOG.info('synonymapi/unconnect (mtx) -', err.message)
          req.reject(422, err.message)
        } else {
          LOG.error('synonymapi/unconnect (mtx) -', err)
          req.reject(500, 'synonym configuration error - see application log for details')
        }
      }
    })

    // needs to be at the end, otherwise the generic handlers are registered first
    super.init();
  }
}

module.exports = { ConfigService }
