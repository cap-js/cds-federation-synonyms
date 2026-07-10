const cds = require('@sap/cds')

const LOG = cds.log('cds-federation-synonyms')

LOG.debug('===== cds-plugin.js is running');

require('./lib/server.js')()  // run the code that registers the mtx deploy hooks

if (cds?.env?.data_integration === false) {
  LOG.info('===== build-plugin.js deactivated');
}
else {
  require('./lib/build-plugin.js')()  // run the code that registers the build hooks
}
