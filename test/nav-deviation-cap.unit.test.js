/**
 * FIX-2 — updateNAV rejects a write >15% (NAV_MAX_DEVIATION_BPS=1500) from the current NAV.
 * Run: npx hardhat test test/nav-deviation-cap.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("NAV deviation cap (FIX-2)", function () {
  async function deployBtcFixture() {
    const [owner, bot, user, feeReceiver] = await ethers.getSigners();
    const wbtc = await (await ethers.getContractFactory("MockERC20")).deploy("wBTC", "wBTC", 8);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC", 6);
    const kashYield = await (await ethers.getContractFactory("KashYieldBtc")).deploy(
      bot.address,
      await wbtc.getAddress(),
      await usdc.getAddress(),
      feeReceiver.address,
    );
    return { owner, bot, user, kashYield };
  }

  it("rejects a NAV write >15% above the current NAV", async function () {
    const { bot, kashYield } = await deployBtcFixture();
    // currentNAV initialised to 1e18 ($1.00); +20% is outside the 15% bound
    await expect(
      kashYield.connect(bot).updateNAV(ethers.parseEther("1.20"), 0, 0, 0),
    ).to.be.revertedWithCustomError(kashYield, "NAVDeviationTooLarge");
    // NAV unchanged
    expect(await kashYield.currentNAV()).to.equal(ethers.parseEther("1"));
  });

  it("rejects a NAV write >15% below the current NAV", async function () {
    const { bot, kashYield } = await deployBtcFixture();
    await expect(
      kashYield.connect(bot).updateNAV(ethers.parseEther("0.80"), 0, 0, 0),
    ).to.be.revertedWithCustomError(kashYield, "NAVDeviationTooLarge");
  });

  it("accepts writes within the 15% bound (no false trip)", async function () {
    const { bot, kashYield } = await deployBtcFixture();
    await kashYield.connect(bot).updateNAV(ethers.parseEther("1.10"), 0, 0, 0); // +10%
    expect(await kashYield.currentNAV()).to.equal(ethers.parseEther("1.10"));
    await kashYield.connect(bot).updateNAV(ethers.parseEther("1.05"), 0, 0, 0); // -4.5% of 1.10
    expect(await kashYield.currentNAV()).to.equal(ethers.parseEther("1.05"));
    await kashYield.connect(bot).updateNAV(ethers.parseEther("1.14"), 0, 0, 0); // +8.6% of 1.05, still in bound
    expect(await kashYield.currentNAV()).to.equal(ethers.parseEther("1.14"));
  });

  it("rejects a zero NAV", async function () {
    const { bot, kashYield } = await deployBtcFixture();
    await expect(
      kashYield.connect(bot).updateNAV(0, 0, 0, 0),
    ).to.be.revertedWithCustomError(kashYield, "InvalidNAV");
  });

  it("non-bot/non-keeper caller is rejected", async function () {
    const { owner, kashYield } = await deployBtcFixture();
    await expect(
      kashYield.connect(owner).updateNAV(ethers.parseEther("1.01"), 0, 0, 0),
    ).to.be.revertedWithCustomError(kashYield, "OnlyBotOrKeeper");
  });
});
