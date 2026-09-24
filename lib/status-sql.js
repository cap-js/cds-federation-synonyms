'use strict'
const cds = require('@sap/cds')

// Assembles a SELECT against SYS.SYNONYMS that replicates the Status HANA view,
// including the WHERE extension the build plugin adds (filter to imported data-product services).
// Works in both MTX (uses ModelProviderService) and app context (uses cds.model directly).
async function buildStatusSql(tenant) {
  const { 'cds.xt.ModelProviderService': mps } = cds.services
  const csn = mps ? await mps.getCsn({ tenant }) : cds.model

  const importedServices = Object.entries(csn.definitions)
    .filter(([, def]) => def.kind === 'service' && def['@data.product'] === 'via-synonym' && def['@cds.external'])
    .map(([name]) => name)

  const cond = importedServices
    .map(name => `SYNONYM_NAME like '${name.replace(/\./g, '_').toUpperCase()}_%'`)
    .join(' OR ')
  const whereExt = cond ? ` AND (${cond})` : ''

  return `SELECT SCHEMA_NAME, SYNONYM_NAME, OBJECT_SCHEMA, OBJECT_NAME,
    CASE WHEN OBJECT_SCHEMA = SCHEMA_NAME AND OBJECT_NAME = SYNONYM_NAME || '#MOCK' THEN 'mock'
         WHEN OBJECT_NAME = SYNONYM_NAME                                            THEN 'connected'
         ELSE '?'
    END AS STATUS,
    IS_VALID, CREATE_TIME
    FROM SYS.SYNONYMS WHERE SCHEMA_NAME = CURRENT_SCHEMA${whereExt}`


  }

module.exports = { buildStatusSql }
