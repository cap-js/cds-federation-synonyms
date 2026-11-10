'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { offendingServices } = require('../lib/extension-guard')

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
