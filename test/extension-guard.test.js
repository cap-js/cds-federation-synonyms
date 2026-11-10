'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { findOffendingServices } = require('../lib/extension-guard')

// Pure test of the detection predicate. No MTX, no services, no deployment.
// Input shape matches ModelProviderService.getExtensions: { definitions, extensions }.
// The real enforcement chain (push -> validate -> 422) is covered by the integration test.

const svc = (extra = {}) => ({ kind: 'service', ...extra })

describe('extension-guard: findOffendingServices', () => {

  it('flags a new service definition carrying both federation annotations', () => {
    const extCsn = { definitions: { 'ext.Evil': svc({ '@data.product': 'via-synonym', '@cds.external': true }) } }
    expect(findOffendingServices(extCsn)).to.deep.equal(['ext.Evil'])
  })

  it('flags an annotate of an existing service that adds both annotations', () => {
    const extCsn = { extensions: [{ annotate: 'base.Data', '@data.product': 'via-synonym', '@cds.external': true }] }
    expect(findOffendingServices(extCsn)).to.deep.equal(['base.Data'])
  })

  it('flags when the two annotations are contributed across separate extend/annotate entries on the same target', () => {
    const extCsn = { extensions: [
      { extend: 'base.Data', '@cds.external': true },
      { annotate: 'base.Data', '@data.product': 'via-synonym' }
    ] }
    expect(findOffendingServices(extCsn)).to.deep.equal(['base.Data'])
  })

  it('does NOT flag a service with only @data.product and no @cds.external (initial both-rule)', () => {
    const extCsn = { definitions: { 'ext.Export': svc({ '@data.product': 'via-synonym' }) } }
    expect(findOffendingServices(extCsn)).to.deep.equal([])
  })

  it('does NOT flag @data.product with a different value', () => {
    const extCsn = { definitions: { 'ext.Other': svc({ '@data.product': 'something-else', '@cds.external': true }) } }
    expect(findOffendingServices(extCsn)).to.deep.equal([])
  })

  it('does NOT flag a non-service definition carrying the annotations', () => {
    const extCsn = { definitions: { 'ext.Entity': { kind: 'entity', '@data.product': 'via-synonym', '@cds.external': true } } }
    expect(findOffendingServices(extCsn)).to.deep.equal([])
  })

  it('reports each offender once when several are present', () => {
    const extCsn = {
      definitions: { 'ext.A': svc({ '@data.product': 'via-synonym', '@cds.external': true }) },
      extensions: [{ annotate: 'base.B', '@data.product': 'via-synonym', '@cds.external': true }]
    }
    expect(findOffendingServices(extCsn).sort()).to.deep.equal(['base.B', 'ext.A'])
  })

  it('returns [] and does not throw on empty / missing input', () => {
    expect(findOffendingServices({})).to.deep.equal([])
    expect(findOffendingServices({ definitions: {}, extensions: [] })).to.deep.equal([])
    expect(findOffendingServices(undefined)).to.deep.equal([])
    expect(findOffendingServices(null)).to.deep.equal([])
  })
})
