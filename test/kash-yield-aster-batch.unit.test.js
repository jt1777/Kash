const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  WAD,
  CYCLE_DURATION,
  PROCESSING_WINDOW_START,
  deployKashYieldAsterFixture,
  mintKashToUser,
  jumpToCycleOffset,
} = require("./helpers/deployKashYieldAsterFixture");

describe("ownerless KashYield batch guards", function () {
  it("defers redeem USD until Phase 1 using indicative NAV", async function () {
    const { bot, user, vault, kashToken } = await deployKashYieldAsterFixture();
    const nav = (11n * WAD) / 10n; // +10% — within FIX-2 ±15% bound from genesis 1e18
    const redeemKash = 50n * WAD;

    await mintKashToUser(vault, kashToken, user, redeemKash);
    await kashToken.connect(user).approve(await vault.getAddress(), redeemKash);
    await vault.connect(user).requestRedeem(redeemKash);

    const cycle = await vault.getCurrentBatchCycle();
    let info = await vault.getBatchInfo(cycle);
    expect(info.totalRedeemKash).to.equal(redeemKash);
    expect(info.totalRedeemUSD).to.equal(0n);

    await vault.connect(bot).updateNAV(nav, 0, 0, 0);
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");

    info = await vault.getBatchInfo(cycle);
    expect(info.totalRedeemUSD).to.equal((redeemKash * nav) / WAD);
    expect(await vault.batchIndicativeNAV(cycle)).to.equal(nav);
    expect(await vault.batchPhase(cycle)).to.equal(1);
  });

  it("reverts Phase 1 when the previous batch is still in Phase 1", async function () {
    const { bot, vault } = await deployKashYieldAsterFixture();
    const nav = WAD;

    await vault.connect(bot).updateNAV(nav, 0, 0, 0);

    const cycle0 = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(cycle0, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    expect(await vault.batchPhase(cycle0)).to.equal(1);

    const cycle1 = cycle0 + 1n;
    await jumpToCycleOffset(cycle1, PROCESSING_WINDOW_START + 1n);
    await expect(vault.connect(bot).performUpkeep("0x")).to.be.revertedWithCustomError(
      vault,
      "PreviousBatchNotComplete",
    );
  });

  it("allows Phase 1 on the next cycle after the previous batch reaches Phase 2", async function () {
    const { bot, vault } = await deployKashYieldAsterFixture();
    const nav = WAD;

    await vault.connect(bot).updateNAV(nav, 0, 0, 0);

    const cycle0 = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(cycle0, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(cycle0, 0);

    const cycle1 = cycle0 + 1n;
    await jumpToCycleOffset(cycle1, PROCESSING_WINDOW_START + 1n);
    await expect(vault.connect(bot).performUpkeep("0x")).to.not.be.reverted;
    expect(await vault.batchPhase(cycle1)).to.equal(1);
  });
});
