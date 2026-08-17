/**
 * Aster round-2 bundle (#3/#8/#9 + fee cap): local Hardhat unit tests (ownerless Aster).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  WAD,
  PROCESSING_WINDOW_START,
  deployKashYieldAsterFixture,
  mintKashToUser,
  jumpToCycleOffset,
} = require("./helpers/deployKashYieldAsterFixture");

describe("Aster round-2 bundle", function () {
  it("rejects feeBps > 30 at deploy", async function () {
    const [bot, feeReceiver] = await ethers.getSigners();
    const dummy = ethers.Wallet.createRandom().address;
    const MockOracle = await ethers.getContractFactory("MockChainlinkOracle");
    const oracle = await MockOracle.deploy(3000n * 10n ** 8n, 8);
    const KashYieldETH = await ethers.getContractFactory("KashYieldETH");

    await expect(
      KashYieldETH.deploy(
        bot.address,
        dummy,
        dummy,
        dummy,
        dummy,
        await oracle.getAddress(),
        ethers.ZeroAddress,
        feeReceiver.address,
        3600n,
        3000n,
        3000n,
        100n,
        31n,
        10_000n,
        10_000n,
        50n,
      ),
    ).to.be.revertedWithCustomError(KashYieldETH, "FeeTooHigh");
  });

  it("exposes immutable redeemPayoutBufferBps and no ownerWithdraw/rescue", async function () {
    const { vault } = await deployKashYieldAsterFixture();
    expect(await vault.redeemPayoutBufferBps()).to.equal(50n);
    expect(vault.interface.hasFunction("ownerWithdrawEth")).to.equal(false);
    expect(vault.interface.hasFunction("rescueERC20")).to.equal(false);
  });

  it("sweep keeps lockedClaim; release pays user capped (#9)", async function () {
    const { bot, user, feeReceiver, vault, kashToken } = await deployKashYieldAsterFixture();
    const nav = WAD;
    const redeemKash = 10n * WAD;
    const grossG = ethers.parseEther("0.001");

    const vaultAddr = await vault.getAddress();
    await ethers.provider.send("hardhat_setBalance", [
      vaultAddr,
      "0x" + ethers.parseEther("1").toString(16),
    ]);

    await mintKashToUser(vault, kashToken, user, redeemKash);
    await kashToken.connect(user).approve(vaultAddr, redeemKash);
    await vault.connect(user).requestRedeem(redeemKash);

    const cycle = await vault.getCurrentBatchCycle();
    await vault.connect(bot).updateNAV(nav, 0, 0, 0);
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(cycle, grossG);

    const redeemRoot = ethers.keccak256(ethers.toUtf8Bytes("aster-redeem-root"));
    await vault.connect(bot).processBatchPhase2ForCycle(cycle, redeemRoot, ethers.ZeroHash);

    const lockedBefore = await vault.lockedClaimEth();
    const allocation = await vault.batchRedeemNetAsset(cycle, user.address);
    expect(allocation).to.be.gt(0n);

    const feeBefore = await ethers.provider.getBalance(feeReceiver.address);
    await time.increase(30 * 24 * 3600 + 1);
    await vault.connect(bot).sweepExpiredClaims(cycle);

    expect(await vault.lockedClaimEth()).to.equal(lockedBefore);
    const info = await vault.batchClaimInfo(cycle);
    expect(info.redeemClaimsExpired).to.equal(true);
    expect(await ethers.provider.getBalance(feeReceiver.address)).to.equal(feeBefore);

    const balBefore = await ethers.provider.getBalance(user.address);
    await vault.connect(bot).releaseExpiredRedeem(cycle, user.address, allocation);
    expect(await ethers.provider.getBalance(user.address)).to.be.gt(balBefore);
    expect(await vault.lockedClaimEth()).to.equal(lockedBefore - allocation);

    await expect(
      vault.connect(bot).releaseExpiredRedeem(cycle, user.address, 1n),
    ).to.be.revertedWithCustomError(vault, "ExceedsAllocation");
  });
});
