'use strict'

// Loaded in-process by cds.test and, crucially, inside the native activation worker via
// job-worker.js's _local_cli_js(). The worker bootstraps with cds.serve() (no HTTP app) and never
// emits the per-service 'serving' event, so the guard relies on its 'served' hook there.
require('../../lib/extension-guard')()
