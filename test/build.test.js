const cds = require('@sap/cds/')
const { execSync } = require('node:child_process')

const { expect } = cds.test.chai
const { fs, path } = cds.utils

describe('when building', () => {
  const setupTempOutputDir = (prefix = 'temp-') => {
    const TEMP_DIR = fs.mkdtempSync(path.join(__dirname, prefix))
    const DEST_DIR = path.join(TEMP_DIR, 'out'); fs.mkdirSync(DEST_DIR)
    const OUT_SRC_DIR = path.join(DEST_DIR, 'src', 'gen')
    const OUT_CFG_DIR = path.join(DEST_DIR, 'cfg', 'gen')
    return { OUT_SRC_DIR, OUT_CFG_DIR, DEST_DIR, TEMP_DIR }
  }

  const cleanupTempOutputDir = TEMP_DIR => {
    if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true })
  }

  // prettier-ignore
  const buildForSynonyms = (scenario_folder, destDir) => {
    let output = ''; try {
      output = execSync(
        `cds build --for hana --src ${scenario_folder} --dest ${destDir} `,
        { cwd: path.join(__dirname, 'scenarios'), stdio: 'pipe' }
      ).toString('utf-8')
    } catch (error) {
      if (error.stdout) output += `${error.stdout}\n`
      if (error.stderr) output += `${error.stderr}\n`
    }

    // This is required for compatibility with 'cds test' runner
    // > The mocha (?) test runner will add ANSI codes to the output
    // eslint-disable-next-line no-control-regex -- Match ANSI escape codes emitted by test runners
    output = output.replaceAll(/\x1b\[[0-9;]*[a-zA-Z]/g, '')

    return output.split('\n').filter(line => line.trim())
  }

  function getRefFilePath(scenario_folder, fileName) {
    return path.join(__dirname, 'scenarios', scenario_folder, 'ref', fileName)
  }


  describe('a model without data services', () => {
    let OUT_SRC_DIR, DEST_DIR, TEMP_DIR, BUILD_LOGS
    const scenario_folder = 'without-data-service'

    beforeAll(() => {
      ({ OUT_SRC_DIR, DEST_DIR, TEMP_DIR } = setupTempOutputDir())
      BUILD_LOGS = buildForSynonyms(path.join(scenario_folder, 'model'), DEST_DIR)
      expect(BUILD_LOGS).to.be.an('array').that.is.not.empty
    })
    afterAll(() => cleanupTempOutputDir(TEMP_DIR))


    it('should report that plugin is running', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/cds-plugin.js is running/i))).to.be.true
    })

    it('should report that plugin code is running in cds build', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/######### hana build plugin start #########/i))).to.be.true
    })

    it('should report that no imported data services were found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Imported data services:\s*$/i))).to.be.true
    })

    it('should report that no exported data services were found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Exported data services:\s*$/i))).to.be.true
    })

    it('it should generate an hdbtable file', () => {
      const filePath = path.join(OUT_SRC_DIR, 'com.sap.Books.hdbtable')
      expect(fs.existsSync(filePath)).to.be.true
      const content = fs.readFileSync(filePath, 'utf-8').replaceAll('\r\n', '\n')

      const refPath = getRefFilePath(scenario_folder, 'com.sap.Books.hdbtable')
      const refContent = fs.readFileSync(refPath, 'utf-8').replaceAll('\r\n', '\n')
      expect(content).to.equal(refContent)
    })

    it('should not generate any hdbrole files', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbrole'))
      expect(files).to.be.an('array').that.is.empty
    })

    it('should generate one hdbsynonym file for sys.synonyms', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbsynonym'))
      expect(files).to.be.an('array').with.lengthOf(1)

      const filePath = path.join(OUT_SRC_DIR, `cds.dataproducts.synonyms.Synonyms.hdbsynonym`)
      expect(fs.existsSync(filePath)).to.be.true
    })
  })



  describe('a model with an exported data service', () => {
    let OUT_SRC_DIR, DEST_DIR, TEMP_DIR, BUILD_LOGS
    const scenario_folder = 'with-exported-service'
    const serviceName = 'sap.capire.flights'

    beforeAll(() => {
      ({ OUT_SRC_DIR, DEST_DIR, TEMP_DIR } = setupTempOutputDir())
      BUILD_LOGS = buildForSynonyms(path.join(scenario_folder, 'model'), DEST_DIR)
      expect(BUILD_LOGS).to.be.an('array').that.is.not.empty
    })
    afterAll(() => cleanupTempOutputDir(TEMP_DIR))


    it('should report that plugin is running', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/cds-plugin.js is running/i))).to.be.true
    })

    it('should report that no imported data services were found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Imported data services:\s*$/i))).to.be.true
    })

    it('should report that exported data service was found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Exported data services: sap.capire.flights\s*$/i))).to.be.true
    })

    it('should generate a regular hdbtable file', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName}.Flights.hdbtable`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = fs.readFileSync(filePath, 'utf-8').replaceAll('\r\n', '\n')

      const refPath = getRefFilePath(scenario_folder, `${serviceName}.Flights.hdbtable`)
      const refContent = fs.readFileSync(refPath, 'utf-8').replaceAll('\r\n', '\n')
      expect(content).to.equal(refContent)
    })

    it('should generate two hdbrole files', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbrole'))
      expect(files).to.be.an('array').with.lengthOf(2)
      // --------------------------------------------------
      const filePath1 = path.join(OUT_SRC_DIR, `${serviceName}#.hdbrole`)
      expect(fs.existsSync(filePath1)).to.be.true
      const content1 = JSON.parse(fs.readFileSync(filePath1, 'utf-8'))

      const refPath1 = getRefFilePath(scenario_folder, `${serviceName}#.hdbrole`)
      const refContent1 = JSON.parse(fs.readFileSync(refPath1, 'utf-8'))
      expect(content1).to.deep.equal(refContent1)
      // --------------------------------------------------
      const filePath2 = path.join(OUT_SRC_DIR, `${serviceName}.hdbrole`)
      expect(fs.existsSync(filePath2)).to.be.true
      const content2 = JSON.parse(fs.readFileSync(filePath2, 'utf-8'))

      const refPath2 = getRefFilePath(scenario_folder, `${serviceName}.hdbrole`)
      const refContent2 = JSON.parse(fs.readFileSync(refPath2, 'utf-8'))
      expect(content2).to.deep.equal(refContent2)
    })

    it('should generate one hdbsynonym file for sys.synonyms', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbsynonym'))
      expect(files).to.be.an('array').with.lengthOf(1)

      const filePath = path.join(OUT_SRC_DIR, `cds.dataproducts.synonyms.Synonyms.hdbsynonym`)
      expect(fs.existsSync(filePath)).to.be.true
    })
  })



  describe('a model with an imported data service', () => {
    let OUT_SRC_DIR, OUT_CFG_DIR, DEST_DIR, TEMP_DIR, BUILD_LOGS
    const scenario_folder = 'with-imported-service'
    const serviceName = 'sap.capire.flights'

    beforeAll(() => {
      ({ OUT_SRC_DIR, OUT_CFG_DIR, DEST_DIR, TEMP_DIR } = setupTempOutputDir())
      BUILD_LOGS = buildForSynonyms(path.join(scenario_folder, 'model'), DEST_DIR)
      expect(BUILD_LOGS).to.be.an('array').that.is.not.empty
    })
    afterAll(() => cleanupTempOutputDir(TEMP_DIR))

    it('should report that plugin is running', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/cds-plugin.js is running/i))).to.be.true
    })

    it('should report that no exported data service was found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Exported data services:\s*$/i))).to.be.true
    })

    it('should report that imported data services were found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Imported data services: sap.capire.flights\s*$/i))).to.be.true
    })

    it('should generate mock hdbtable file', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName}.Flights#mock.hdbtable`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = fs.readFileSync(filePath, 'utf-8').replaceAll('\r\n', '\n')

      const refPath = getRefFilePath(scenario_folder, `${serviceName}.Flights#mock.hdbtable`)
      const refContent = fs.readFileSync(refPath, 'utf-8').replaceAll('\r\n', '\n')
      expect(content).to.equal(refContent)
    })

    it('should generate hdbtabledata file', () => {
      const DATA_DIR = path.join(OUT_SRC_DIR, 'data')

      const filePath = path.join(DATA_DIR, `${serviceName}-Flights.hdbtabledata`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName}-Flights.hdbtabledata`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate a hdbsynonym file', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName}.hdbsynonym`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName}.hdbsynonym`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate a hdbsynonymconfig file', () => {
      const filePath = path.join(OUT_CFG_DIR, `${serviceName}.hdbsynonymconfig`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName}.hdbsynonymconfig`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate a hdbgrants file', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName}.hdbgrants`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName}.hdbgrants`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should not generate any hdbrole files', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbrole'))
      expect(files).to.be.an('array').that.is.empty
    })
  })


  describe('a model with an exported and an imported data service', () => {
    let OUT_SRC_DIR, OUT_CFG_DIR, DEST_DIR, TEMP_DIR, BUILD_LOGS
    const scenario_folder = 'with-ex-and-imported'
    const serviceName_ex = 'sap.capire.exported'
    const serviceName_im = 'sap.capire.imported'

    beforeAll(() => {
      ({ OUT_SRC_DIR, OUT_CFG_DIR, DEST_DIR, TEMP_DIR } = setupTempOutputDir())
      BUILD_LOGS = buildForSynonyms(path.join(scenario_folder, 'model'), DEST_DIR)
      expect(BUILD_LOGS).to.be.an('array').that.is.not.empty
    })
    afterAll(() => cleanupTempOutputDir(TEMP_DIR))


    it('should report that plugin is running', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/cds-plugin.js is running/i))).to.be.true
    })

    it('should report that imported data services were found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Imported data services: sap.capire.imported\s*$/i))).to.be.true
    })

    it('should report that exported data service was found', () => {
      const pluginLogs = BUILD_LOGS.filter(line => line.startsWith('[cds-federation-synonyms]'))
      expect(pluginLogs.some(line => line.match(/Exported data services: sap.capire.exported\s*$/i))).to.be.true
    })

    // exported

    it('should generate a regular hdbtable file for exported service', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName_ex}.SomeEntity.hdbtable`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = fs.readFileSync(filePath, 'utf-8').replaceAll('\r\n', '\n')

      const refPath = getRefFilePath(scenario_folder, `${serviceName_ex}.SomeEntity.hdbtable`)
      const refContent = fs.readFileSync(refPath, 'utf-8').replaceAll('\r\n', '\n')
      expect(content).to.equal(refContent)
    })

    it('should generate two hdbrole files for exported service', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbrole'))
      expect(files).to.be.an('array').with.lengthOf(2)
      // --------------------------------------------------
      const filePath1 = path.join(OUT_SRC_DIR, `${serviceName_ex}#.hdbrole`)
      expect(fs.existsSync(filePath1)).to.be.true
      const content1 = JSON.parse(fs.readFileSync(filePath1, 'utf-8'))

      const refPath1 = getRefFilePath(scenario_folder, `${serviceName_ex}#.hdbrole`)
      const refContent1 = JSON.parse(fs.readFileSync(refPath1, 'utf-8'))
      expect(content1).to.deep.equal(refContent1)
      // --------------------------------------------------
      const filePath2 = path.join(OUT_SRC_DIR, `${serviceName_ex}.hdbrole`)
      expect(fs.existsSync(filePath2)).to.be.true
      const content2 = JSON.parse(fs.readFileSync(filePath2, 'utf-8'))

      const refPath2 = getRefFilePath(scenario_folder, `${serviceName_ex}.hdbrole`)
      const refContent2 = JSON.parse(fs.readFileSync(refPath2, 'utf-8'))
      expect(content2).to.deep.equal(refContent2)
    })

    // imported

    it('should generate mock hdbtable file for imported service', () => {
      const filePath = path.join(OUT_SRC_DIR, `${serviceName_im}.Flights#mock.hdbtable`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = fs.readFileSync(filePath, 'utf-8').replaceAll('\r\n', '\n')

      const refPath = getRefFilePath(scenario_folder, `${serviceName_im}.Flights#mock.hdbtable`)
      const refContent = fs.readFileSync(refPath, 'utf-8').replaceAll('\r\n', '\n')
      expect(content).to.equal(refContent)
    })

    it('should generate one hdbtabledata file - for imported service', () => {
      const DATA_DIR = path.join(OUT_SRC_DIR, 'data')

      const files = fs.readdirSync(DATA_DIR, ).filter(file => file.endsWith('.hdbtabledata'))
      expect(files).to.be.an('array').with.lengthOf(1)

      const filePath = path.join(DATA_DIR, `${serviceName_im}-Flights.hdbtabledata`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName_im}-Flights.hdbtabledata`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate two hdbsynonym files - for imported service and for sys.synonyms', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbsynonym'))
      expect(files).to.be.an('array').with.lengthOf(2)
      // --------------------------------------------------
      const filePath1 = path.join(OUT_SRC_DIR, `cds.dataproducts.synonyms.Synonyms.hdbsynonym`)
      expect(fs.existsSync(filePath1)).to.be.true
      // --------------------------------------------------
      const filePath2 = path.join(OUT_SRC_DIR, `${serviceName_im}.hdbsynonym`)
      expect(fs.existsSync(filePath2)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath2, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName_im}.hdbsynonym`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate one hdbsynonymconfig file - for imported service', () => {
      const files = fs.readdirSync(OUT_CFG_DIR, ).filter(file => file.endsWith('.hdbsynonymconfig'))
      expect(files).to.be.an('array').with.lengthOf(1)

      const filePath = path.join(OUT_CFG_DIR, `${serviceName_im}.hdbsynonymconfig`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName_im}.hdbsynonymconfig`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })

    it('should generate one hdbgrants file - for imported service', () => {
      const files = fs.readdirSync(OUT_SRC_DIR, ).filter(file => file.endsWith('.hdbgrants'))
      expect(files).to.be.an('array').with.lengthOf(1)

      const filePath = path.join(OUT_SRC_DIR, `${serviceName_im}.hdbgrants`)
      expect(fs.existsSync(filePath)).to.be.true
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

      const refPath = getRefFilePath(scenario_folder, `${serviceName_im}.hdbgrants`)
      const refContent = JSON.parse(fs.readFileSync(refPath, 'utf-8'))
      expect(content).to.deep.equal(refContent)
    })
  })



})
