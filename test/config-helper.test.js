'use strict'

const cds = require('@sap/cds')
const { expect } = cds.test.chai
const { getResolvedConfig } = require('../lib/config-helper')

// Boot in the project root so @cap-js/sqlite (nested under cds-dk) can be resolved
cds.test().in(__dirname + '/..')

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } }
  const m = await cds.load('lib/int-schema.cds')
  cds.model = m
  const db = await cds.connect.to('db')
  for (const stmt of cds.compile.to.sql(m)) await db.run(stmt)
})

afterAll(() => cds.disconnect())


describe('getResolvedConfig()', () => {

  beforeEach(async () => {
    await DELETE.from('cds.dataproducts.synonyms.Registry')
    // remove any hana-synonyms entries added by previous test
    for (const [k, v] of Object.entries(cds.env.requires)) {
      if (v?.kind === 'hana-synonyms') delete cds.env.requires[k]
    }
  })


  describe('static config only (no DB entries)', () => {

    it('returns empty array when no static config and no DB entries', async () => {
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([])
    })

    it('returns static entry', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a' }
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', target: 'sm-a', source: 'static' }])
    })

    it('maps null service-manager to null target', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': null }
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', target: null, source: 'static' }])
    })

    it('returns multiple static entries', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-a' }
      cds.env.requires['svc-b'] = { kind: 'hana-synonyms', 'service-manager': 'sm-b' }
      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.map(e => e.srv).sort()).to.deep.equal(['svc-a', 'svc-b'])
    })

  })


  describe('dynamic config only (DB entries, no static config)', () => {

    it('returns dynamic entry from DB', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', target: 'sm-a' })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', target: 'sm-a', source: 'dynamic' }])
    })

    it('returns null target from DB', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', target: null })
      const result = await getResolvedConfig()
      expect(result).to.deep.equal([{ srv: 'svc-a', target: null, source: 'dynamic' }])
    })

    it('returns multiple dynamic entries', async () => {
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries([
        { srv: 'svc-a', target: 'sm-a' },
        { srv: 'svc-b', target: 'sm-b' }
      ])
      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.map(e => e.srv).sort()).to.deep.equal(['svc-a', 'svc-b'])
    })

  })


  describe('dynamic overrides static', () => {

    it('dynamic entry overrides static entry for same srv — static suppressed by default', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', target: 'sm-dynamic' })

      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(1)
      expect(result[0]).to.deep.equal({ srv: 'svc-a', target: 'sm-dynamic', source: 'dynamic (overrides static)' })
    })

    it('with all=true both entries are returned', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', target: 'sm-dynamic' })

      const result = await getResolvedConfig(true)
      expect(result).to.have.lengthOf(2)
      expect(result.find(e => e.source === 'dynamic (overrides static)')).to.exist
      expect(result.find(e => e.source === 'static')).to.exist
    })

    it('static entry without dynamic override is kept', async () => {
      cds.env.requires['svc-a'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static-a' }
      cds.env.requires['svc-b'] = { kind: 'hana-synonyms', 'service-manager': 'sm-static-b' }
      await INSERT.into('cds.dataproducts.synonyms.Registry').entries({ srv: 'svc-a', target: 'sm-dynamic' })

      const result = await getResolvedConfig()
      expect(result).to.have.lengthOf(2)
      expect(result.find(e => e.srv === 'svc-a').source).to.equal('dynamic (overrides static)')
      expect(result.find(e => e.srv === 'svc-b').source).to.equal('static')
    })

  })

})
