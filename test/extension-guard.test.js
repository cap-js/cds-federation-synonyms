'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { offendingServices, offendingRegistryReaders, registryCsvFiles, mtxsVersionSufficient } = require('../lib/extension-guard')
const { REGISTRY } = require('../lib/config-helper')

// Pure test of the detection predicate. No MTX, no services, no deployment.
// offendingServices(baselineCsn, mergedCsn) returns services whose synonym-federation state
// (@data.product:'via-synonym' and, for via-synonym services, @cds.external) is changed by the
// pending extension - i.e. the extension adds, removes or changes that behavior.

const svc = (extra = {}) => ({ kind: 'service', ...extra })
const IMPORT = { '@data.product': 'via-synonym', '@cds.external': true }   // import (consumer)
const EXPORT = { '@data.product': 'via-synonym' }                          // export (producer)
const model = (definitions = {}) => ({ definitions })

describe('extension-guard: offendingServices', () => {

  // --- adding federation ---

  it('flags adding the import combo (new service from the extension)', () => {
    expect(offendingServices(model(), model({ 'ext.Evil': svc(IMPORT) }))).to.deep.equal(['ext.Evil'])
  })

  it('flags adding export (via-synonym without @cds.external) - producer exposure', () => {
    expect(offendingServices(model(), model({ 'ext.Exp': svc(EXPORT) }))).to.deep.equal(['ext.Exp'])
  })

  it('flags a truthy non-boolean @cds.external (matches the deploy-path predicate)', () => {
    const merged = model({ 'ext.Evil': svc({ '@data.product': 'via-synonym', '@cds.external': 1 }) })
    expect(offendingServices(model(), merged)).to.deep.equal(['ext.Evil'])
  })

  it('flags split case: baseline has @cds.external only, extension adds @data.product', () => {
    expect(offendingServices(model({ 'base.D': svc({ '@cds.external': true }) }), model({ 'base.D': svc(IMPORT) }))).to.deep.equal(['base.D'])
  })

  // --- removing / disabling federation ---

  it('flags removing via-synonym from a base import service (disable)', () => {
    expect(offendingServices(model({ 'base.D': svc(IMPORT) }), model({ 'base.D': svc({ '@cds.external': true }) }))).to.deep.equal(['base.D'])
  })

  it('flags removing via-synonym from a base export service (disable)', () => {
    expect(offendingServices(model({ 'base.E': svc(EXPORT) }), model({ 'base.E': svc() }))).to.deep.equal(['base.E'])
  })

  it('flags changing @data.product away from via-synonym', () => {
    const merged = model({ 'base.D': svc({ '@data.product': 'something-else', '@cds.external': true }) })
    expect(offendingServices(model({ 'base.D': svc(IMPORT) }), merged)).to.deep.equal(['base.D'])
  })

  // --- flipping import <-> export on a via-synonym service ---

  it('flags adding @cds.external to a base export service (export -> import)', () => {
    expect(offendingServices(model({ 'base.X': svc(EXPORT) }), model({ 'base.X': svc(IMPORT) }))).to.deep.equal(['base.X'])
  })

  it('flags removing @cds.external from a base import service (import -> export)', () => {
    expect(offendingServices(model({ 'base.X': svc(IMPORT) }), model({ 'base.X': svc(EXPORT) }))).to.deep.equal(['base.X'])
  })

  // --- no change / no false positives ---

  it('does NOT flag a base import service left unchanged', () => {
    expect(offendingServices(model({ 'base.D': svc(IMPORT) }), model({ 'base.D': svc(IMPORT) }))).to.deep.equal([])
  })

  it('does NOT flag a base export service left unchanged', () => {
    expect(offendingServices(model({ 'base.E': svc(EXPORT) }), model({ 'base.E': svc(EXPORT) }))).to.deep.equal([])
  })

  it('does NOT flag @cds.external changes on a non-via-synonym service', () => {
    // deliberate: @cds.external is a general annotation; we only guard it on federated services
    expect(offendingServices(model({ 'base.P': svc() }), model({ 'base.P': svc({ '@cds.external': true }) }))).to.deep.equal([])
  })

  it('does NOT flag @data.product changes between two non-via-synonym values', () => {
    const baseline = model({ 'base.P': svc({ '@data.product': 'a' }) })
    const merged = model({ 'base.P': svc({ '@data.product': 'b' }) })
    expect(offendingServices(baseline, merged)).to.deep.equal([])
  })

  it('does NOT flag a non-service definition carrying the annotations', () => {
    expect(offendingServices(model(), model({ 'ext.Entity': { kind: 'entity', ...IMPORT } }))).to.deep.equal([])
  })

  // --- misc ---

  it('reports each changed service once', () => {
    const merged = model({ 'ext.A': svc(IMPORT), 'base.B': svc(EXPORT) })
    expect(offendingServices(model(), merged).sort()).to.deep.equal(['base.B', 'ext.A'])
  })

  it('returns [] and does not throw on empty / missing input', () => {
    expect(offendingServices(model(), model())).to.deep.equal([])
    expect(offendingServices(undefined, undefined)).to.deep.equal([])
    expect(offendingServices(null, null)).to.deep.equal([])
  })
})

// Pure test of the CSV-target predicate: a data-CSV file name whose entity resolves to the
// connect-state table (cds.xt.synonyms.Registry) must be flagged, so the guard can reject an
// extension that writes it directly. Dashes and dots are both the FQN separator in the file name.
describe('extension-guard: registryCsvFiles', () => {

  it('flags a dash-separated Registry CSV', () => {
    expect(registryCsvFiles(['cds.xt.synonyms-Registry.csv'])).to.deep.equal(['cds.xt.synonyms-Registry.csv'])
  })

  it('flags a dot-separated Registry CSV', () => {
    expect(registryCsvFiles(['cds.xt.synonyms.Registry.csv'])).to.deep.equal(['cds.xt.synonyms.Registry.csv'])
  })

  it('matches the REGISTRY constant (single source of truth)', () => {
    expect(REGISTRY).to.equal('cds.xt.synonyms.Registry')
  })

  it('ignores unrelated CSVs', () => {
    expect(registryCsvFiles(['ext.guard-Things.csv', 'foo.csv', 'cds.xt.synonyms-Other.csv'])).to.deep.equal([])
  })

  it('returns [] and does not throw on empty / missing input', () => {
    expect(registryCsvFiles([])).to.deep.equal([])
    expect(registryCsvFiles(undefined)).to.deep.equal([])
  })
})

// Pure test of the Registry-read predicate. An extension-introduced definition that reads the
// connect-state table (cds.xt.synonyms.Registry) must be flagged - including the top-level UNION
// form that cds-mtxs's own protected-namespace check misses.
describe('extension-guard: offendingRegistryReaders', () => {
  const REG = 'cds.xt.synonyms.Registry'
  const sel = (name) => ({ SELECT: { from: { ref: [name] }, columns: [{ ref: ['provider_tenant'] }] } })
  const union = (name) => ({ kind: 'entity', query: { SET: { op: 'union', all: true, args: [sel(name), sel(name)] } } })
  const proj = (name) => ({ kind: 'entity', query: sel(name) })
  const join = (a, b) => ({ kind: 'entity', query: { SELECT: { from: { join: 'inner', args: [{ ref: [a] }, { ref: [b] }] } } } })

  it('flags a new entity reading Registry via top-level UNION (the bypass)', () => {
    expect(offendingRegistryReaders(model(), model({ 'x.Leak': union(REG) }))).to.deep.equal(['x.Leak'])
  })

  it('flags a new entity reading Registry via a plain projection', () => {
    expect(offendingRegistryReaders(model(), model({ 'x.Leak': proj(REG) }))).to.deep.equal(['x.Leak'])
  })

  it('flags a read via a join', () => {
    expect(offendingRegistryReaders(model(), model({ 'x.Leak': join('ext.guard.Things', REG) }))).to.deep.equal(['x.Leak'])
  })

  it('does NOT flag a view over an unrelated entity', () => {
    expect(offendingRegistryReaders(model(), model({ 'x.Ok': union('ext.guard.Things') }))).to.deep.equal([])
  })

  it('does NOT flag a base definition that already read Registry (not introduced by the extension)', () => {
    const base = model({ 'base.View': proj(REG) })
    expect(offendingRegistryReaders(base, base)).to.deep.equal([])
  })

  it('returns [] and does not throw on empty / missing input', () => {
    expect(offendingRegistryReaders(model(), model())).to.deep.equal([])
    expect(offendingRegistryReaders(undefined, undefined)).to.deep.equal([])
  })
})

// The guard requires @sap/cds-mtxs >= 4.2.0 (the version that added the protections it builds on);
// on anything older it blocks extension activation. Pure test of the version predicate.
describe('extension-guard: mtxsVersionSufficient', () => {
  it('accepts 4.2.0 and newer', () => {
    for (const v of ['4.2.0', '4.2.1', '4.3.0', '4.10.0', '5.0.0', '10.1.2']) {
      expect(mtxsVersionSufficient(v), v).to.equal(true)
    }
  })
  it('rejects anything below 4.2.0', () => {
    for (const v of ['4.1.1', '4.0.2', '4.0.0', '3.9.9']) {
      expect(mtxsVersionSufficient(v), v).to.equal(false)
    }
  })
  it('rejects unparseable / missing input', () => {
    for (const v of ['', 'garbage', undefined, null]) {
      expect(mtxsVersionSufficient(v)).to.equal(false)
    }
  })
})

// The guard must also cover the case where the ExtensibilityService was already served before this
// plugin loaded (e.g. a native worker that finished cds.serve() first): serving/served listeners
// cannot observe past events, so installExtensionGuard() installs on the current instance eagerly.
describe('extension-guard: installExtensionGuard eager install', () => {
  const installExtensionGuard = require('../lib/extension-guard')

  const withFakeService = (srv, fn) => {
    const key = 'cds.xt.ExtensibilityService'
    const had = Object.prototype.hasOwnProperty.call(cds.services, key)
    const saved = cds.services[key]
    cds.services[key] = srv
    try { fn() } finally {
      if (had) cds.services[key] = saved
      else delete cds.services[key]
    }
  }

  it('installs after(validate) on an already-served ExtensibilityService', () => {
    const events = []
    const fakeSrv = { name: 'cds.xt.ExtensibilityService', after: (event) => events.push(event) }
    withFakeService(fakeSrv, () => installExtensionGuard())
    expect(events).to.include('validate')
  })
})
