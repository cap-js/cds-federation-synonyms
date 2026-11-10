'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { offendingServices } = require('../lib/extension-guard')

// Pure test of the detection predicate. No MTX, no services, no deployment.
// offendingServices(baselineCsn, mergedCsn) returns services that have the federation combo
// (@data.product:'via-synonym' + @cds.external) in the merged model but not in the baseline -
// i.e. the pending extension introduced the combo.

const svc = (extra = {}) => ({ kind: 'service', ...extra })
const COMBO = { '@data.product': 'via-synonym', '@cds.external': true }
const model = (definitions = {}) => ({ definitions })

describe('extension-guard: offendingServices', () => {

  it('flags a service that gains the full combo (new service from the extension)', () => {
    expect(offendingServices(model(), model({ 'ext.Evil': svc(COMBO) }))).to.deep.equal(['ext.Evil'])
  })

  it('flags the split case: baseline has @cds.external only, extension adds @data.product', () => {
    const baseline = model({ 'base.Data': svc({ '@cds.external': true }) })
    const merged = model({ 'base.Data': svc(COMBO) })
    expect(offendingServices(baseline, merged)).to.deep.equal(['base.Data'])
  })

  it('flags the split case: baseline has @data.product only, extension adds @cds.external', () => {
    const baseline = model({ 'base.Export': svc({ '@data.product': 'via-synonym' }) })
    const merged = model({ 'base.Export': svc(COMBO) })
    expect(offendingServices(baseline, merged)).to.deep.equal(['base.Export'])
  })

  it('does NOT flag a service that already had the combo in the baseline', () => {
    const baseline = model({ 'base.Fed': svc(COMBO) })
    const merged = model({ 'base.Fed': svc(COMBO) })
    expect(offendingServices(baseline, merged)).to.deep.equal([])
  })

  it('does NOT flag when only @data.product is present in merged (no @cds.external)', () => {
    expect(offendingServices(model(), model({ 'ext.Export': svc({ '@data.product': 'via-synonym' }) }))).to.deep.equal([])
  })

  it('does NOT flag @data.product with a different value', () => {
    const merged = model({ 'ext.Other': svc({ '@data.product': 'something-else', '@cds.external': true }) })
    expect(offendingServices(model(), merged)).to.deep.equal([])
  })

  it('does NOT flag a non-service definition carrying the combo', () => {
    expect(offendingServices(model(), model({ 'ext.Entity': { kind: 'entity', ...COMBO } }))).to.deep.equal([])
  })

  it('reports each newly-federated service once', () => {
    const merged = model({ 'ext.A': svc(COMBO), 'base.B': svc(COMBO) })
    expect(offendingServices(model(), merged).sort()).to.deep.equal(['base.B', 'ext.A'])
  })

  it('returns [] and does not throw on empty / missing input', () => {
    expect(offendingServices(model(), model())).to.deep.equal([])
    expect(offendingServices(undefined, undefined)).to.deep.equal([])
    expect(offendingServices(null, null)).to.deep.equal([])
  })
})
