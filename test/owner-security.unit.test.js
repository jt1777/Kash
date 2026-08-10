/**
 * #12 owner security hardening — local Hardhat unit test.
 * Run: npx hardhat test test/owner-security.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");

describe("Owner security hardening (#12)", function () {
  async function deployBtcFixture() {
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
    await kashYield.setProcessingWindowStart(0);
    await kashYield.setUserWindowEnd(86400);
    await kashYield.connect(owner).setFeeBps(30);

    const kashToken = await ethers.getContractAt("KashTokenBtc", await kashYield.kashTokenBtc());
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

    return { owner, bot, user, feeReceiver, wbtc, kashYield, kashToken };
  }

  it("removes ownerWithdraw/rescue from ABI surface", async function () {
    const { kashYield } = await deployBtcFixture();
    expect(kashYield.interface.hasFunction("ownerWithdrawWbtc")).to.equal(false);
    expect(kashYield.interface.hasFunction("rescueERC20")).to.equal(false);
    expect(kashYield.interface.hasFunction("protocolFeeWbtcReserve")).to.equal(false);
  });

  it("caps fee at 30 bps and exposes immutable feeReceiver", async function () {
    const { owner, feeReceiver, kashYield } = await deployBtcFixture();
    expect(await kashYield.MAX_FEE_BPS()).to.equal(30n);
    expect(await kashYield.feeReceiver()).to.equal(feeReceiver.address);

    await expect(kashYield.connect(owner).setFeeBps(31n)).to.be.revertedWithCustomError(
      kashYield,
      "FeeTooHigh",
    );
    await kashYield.connect(owner).setFeeBps(30n);
    expect(await kashYield.feeBps()).to.equal(30n);
  });

  it("Phase 2 sends protocol fees to feeReceiver (not owner reserve)", async function () {
    const { bot, user, feeReceiver, wbtc, kashYield, kashToken } = await deployBtcFixture();
    const batchCycle = await kashYield.getCurrentBatchCycle();

    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, ethers.parseUnits("0.001", 8));

    const feeBefore = await wbtc.balanceOf(feeReceiver.address);
    const ownerReserveBefore = await kashYield.ownerWbtcReserve();

    const redeemMerkleRoot = ethers.keccak256(ethers.toUtf8Bytes("redeem-root-fee"));
    await kashYield
      .connect(bot)
      .processBatchPhase2ForCycle(batchCycle, redeemMerkleRoot, ethers.ZeroHash);

    const feeAfter = await wbtc.balanceOf(feeReceiver.address);
    expect(feeAfter).to.be.gt(feeBefore);
    expect(await kashYield.ownerWbtcReserve()).to.equal(ownerReserveBefore);
  });
});
