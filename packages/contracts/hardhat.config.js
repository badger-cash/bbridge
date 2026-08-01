require('@nomicfoundation/hardhat-toolbox')

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      viaIR: true
    }
  },

  /*
   * Gas measurement, off unless asked for (SPEC.md Appendix A).
   *
   * Off by default because the table is noise on an ordinary run and the numbers are
   * only worth reading when someone is looking at them. `REPORT_GAS=true npm test`
   * measures the whole suite, which already exercises release() end to end.
   *
   * Measured on the local EVM, and that is not a compromise: gas is deterministic
   * given the bytecode and the calldata, so a testnet would report the same numbers.
   * What a testnet would add is a gas PRICE, which is a market question rather than a
   * property of this contract.
   *
   * Reporting is not enforcement. This prints; it does not fail. A ceiling that
   * actually holds has to be asserted in a test -- see test/gas.test.js.
   */
  gasReporter: {
    enabled: process.env.REPORT_GAS === 'true',
    currency: 'USD',
    // No API key, so no fiat column. Deliberate: a dollar figure here would be a
    // snapshot of one day's ether price wearing the costume of a measurement.
    showTimeSpent: true
  }
}
