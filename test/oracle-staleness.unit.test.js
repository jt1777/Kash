/**
 * FIX-3 — getEthPrice/getBtcPrice revert StalePrice on a stale (>25h) or incomplete oracle round.
 * Run: npx hardhat test test/oracle-staleness.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Oracle staleness (FIX-3)", function () {
  async function deployFixture() {
    const [owner, bot, user, feeReceiver] = await ethers.getSigners();
    const wbtc = await (await ethers.getContractFactory("MockERC20")).deploy("wBTC", "wBTC", 8);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC", 6);
    const oracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(
      100_000n * 10n ** 8n,
      8,
    );
    const kashYield = await (await ethers.getContractFactory("KashYieldBtc")).deploy(
      bot.address,
      await wbtc.getAddress(),
      await usdc.getAddress(),
      feeReceiver.address,
    );
    await kashYield.setBtcOracle(await oracle.getAddress());
    return { kashYield, oracle };
  }

  it("returns a normalised price for a fresh oracle round", async function () {
    const { kashYield } = await deployFixture();
    expect(await kashYield.getBtcPrice()).to.equal(100_000n * 10n ** 18n);
  });

  it("reverts StalePrice when the oracle timestamp is stale (>25h)", async function () {
    const { kashYield, oracle } = await deployFixture();
    await oracle.setStale(true);
    await expect(kashYield.getBtcPrice()).to.be.revertedWithCustomError(kashYield, "StalePrice");
  });

  it("reverts StalePrice when answeredInRound < roundId (incomplete round)", async function () {
    const { kashYield, oracle } = await deployFixture();
    await oracle.setIncompleteRound(true);
    await expect(kashYield.getBtcPrice()).to.be.revertedWithCustomError(kashYield, "StalePrice");
  });
});
