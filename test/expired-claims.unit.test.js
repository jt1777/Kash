/**
 * #9 expired-claim user custody — local Hardhat unit test.
 * Run: npx hardhat test test/expired-claims.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Expired claim user custody (#9)", function () {
  async function deployFixture() {
    const [owner, bot, user] = await ethers.getSigners();

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
    );
    await kashYield.setBtcOracle(await oracle.getAddress());
    await kashYield.setProcessingWindowStart(0);
    await kashYield.setUserWindowEnd(86400);
    const kashToken = await ethers.getContractAt(
      "KashTokenBtc",
      await kashYield.kashTokenBtc(),
    );

    await wbtc.transfer(await kashYield.getAddress(), ethers.parseUnits("10", 8));

    const kashYieldAddr = await kashYield.getAddress();
    await hre.network.provider.send("hardhat_setBalance", [
      kashYieldAddr,
      "0x" + (10n ** 20n).toString(16),
    ]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [kashYieldAddr] });
    const kashYieldSigner = await ethers.getSigner(kashYieldAddr);
    await kashToken.connect(kashYieldSigner).mint(user.address, ethers.parseEther("100"));
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [kashYieldAddr] });

    return { owner, bot, user, wbtc, usdc, kashYield, kashToken };
  }

  it("sweep marks expired without moving lockedClaim; release pays user capped", async function () {
    const { bot, user, wbtc, kashYield, kashToken } = await deployFixture();
    const batchCycle = await kashYield.getCurrentBatchCycle();

    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, ethers.parseUnits("0.001", 8));

    const redeemMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes("redeem-root"));
    await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, redeemMerkleRoot, ethers.ZeroHash);

    const lockedBefore = await kashYield.lockedClaimWbtc();
    const allocation = await kashYield.batchRedeemNetAsset(batchCycle, user.address);
    expect(allocation).to.be.gt(0n);

    await time.increase(30 * 24 * 3600 + 1);
    await kashYield.connect(bot).sweepExpiredClaims(batchCycle);

    expect(await kashYield.lockedClaimWbtc()).to.equal(lockedBefore);
    const info = await kashYield.batchClaimInfo(batchCycle);
    expect(info.redeemClaimsExpired).to.equal(true);

    const balBefore = await wbtc.balanceOf(user.address);
    await kashYield.connect(bot).releaseExpiredRedeem(batchCycle, user.address, allocation);
    expect(await wbtc.balanceOf(user.address)).to.equal(balBefore + allocation);
    expect(await kashYield.lockedClaimWbtc()).to.equal(lockedBefore - allocation);

    await expect(
      kashYield.connect(bot).releaseExpiredRedeem(batchCycle, user.address, 1n),
    ).to.be.revertedWithCustomError(kashYield, "ExceedsAllocation");
  });

  it("sweep mint marks expired without burn; release pays KASH capped", async function () {
    const { bot, user, wbtc, kashYield, kashToken } = await deployFixture();
    const batchCycle = await kashYield.getCurrentBatchCycle();

    await wbtc.transfer(user.address, ethers.parseUnits("0.01", 8));
    await wbtc.connect(user).approve(await kashYield.getAddress(), ethers.parseUnits("0.01", 8));
    await kashYield.connect(user).requestMint(ethers.parseUnits("0.01", 8));

    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, 0n);

    await kashYield.connect(bot).processBatchPhase2ForCycle(
      batchCycle,
      ethers.ZeroHash,
      ethers.keccak256(ethers.toUtf8Bytes("mint-root")),
    );

    const lockedBefore = await kashYield.lockedClaimKash();
    const allocation = await kashYield.batchMintKashAllocation(batchCycle, user.address);
    expect(allocation).to.be.gt(0n);

    await time.increase(30 * 24 * 3600 + 1);
    await kashYield.connect(bot).sweepExpiredMintClaims(batchCycle);

    expect(await kashYield.lockedClaimKash()).to.equal(lockedBefore);
    const info = await kashYield.batchClaimInfo(batchCycle);
    expect(info.mintClaimsExpired).to.equal(true);

    const kashBefore = await kashToken.balanceOf(user.address);
    await kashYield.connect(bot).releaseExpiredMint(batchCycle, user.address, allocation);
    expect(await kashToken.balanceOf(user.address)).to.equal(kashBefore + allocation);

    await expect(
      kashYield.connect(bot).releaseExpiredMint(batchCycle, user.address, 1n),
    ).to.be.revertedWithCustomError(kashYield, "ExceedsAllocation");
  });
});
