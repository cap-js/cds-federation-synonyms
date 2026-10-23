const config = {
  testTimeout: 60000,
  testMatch: ["**/*.test.js"],
  testPathIgnorePatterns: ["<rootDir>/test/e2e/"],
  forceExit: true,
  detectOpenHandles: true,
}

module.exports = config
