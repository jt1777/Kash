/**
 * FIX-4a — emergencyWithdrawRedeem requires batchPhase == 0 (WrongPhase otherwise).
 * Run: npx hardhat test test/emergency-withdraw-phase.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");

describe("emergencyWithdrawRedeem wrong-phase (FIX-4a)", function () {
  async function deployFixture() {
    const [owner, bot, user, feeReceiver] = await ethers.getSigners();
    const wbtc = await (await ethers.getContractFactory("MockERC20")).deploy("wBTC", "wBTC", 8);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC", 6);
    const oracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(100_000n * 10n ** 8n, 8);
    const kashYield = await (await ethers.getContractFactory("KashYieldBtc")).deploy(
      bot.address,
      await wbtc.getAddress(),
      await usdc.getAddress(),
      feeReceiver.address,
    );
    await kashYield.setBtcOracle(await oracle.getAddress());
    await kashYield.setProcessingWindowStart(0);
    await kashYield.setUserWindowEnd(86400);
    const kashToken = await ethers.getContractAt("KashTokenBtc", await kashYield.kashTokenBtc());

    const vaultAddr = await kashYield.getAddress();
    await hre.network.provider.send("hardhat_setBalance", [vaultAddr, "0x" + (10n ** 20n).toString(16)]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddr] });
    const vaultSigner = await ethers.getSigner(vaultAddr);
    await kashToken.connect(vaultSigner).mint(user.address, ethers.parseEther("100"));
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [vaultAddr] });

    return { owner, bot, user, kashYield, kashToken };
  }

  it("paused + phase 0 → emergencyWithdrawRedeem returns the KASH", async function () {
    const { owner, user, kashYield, kashToken } = await deployFixture();
    const cycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(owner).pause();

    const balBefore = await kashToken.balanceOf(user.address);
    await kashYield.connect(user).emergencyWithdrawRedeem(cycle);
    expect(await kashToken.balanceOf(user.address)).to.equal(balBefore + ethers.parseEther("10"));
  });

  it("paused + phase != 0 → emergencyWithdrawRedeem reverts WrongPhase", async function () {
    const { owner, bot, user, kashYield, kashToken } = await deployFixture();
    const cycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x"); // → phase 1
    await kashYield.connect(owner).pause();

    await expect(
      kashYield.connect(user).emergencyWithdrawRedeem(cycle),
    ).to.be.revertedWithCustomError(kashYield, "WrongPhase");
  });

  it("not paused → emergencyWithdrawRedeem reverts NotPaused", async function () {
    const { user, kashYield, kashToken } = await deployFixture();
    const cycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    // not paused
    await expect(
      kashYield.connect(user).emergencyWithdrawRedeem(cycle),
    ).to.be.revertedWithCustomError(kashYield, "NotPaused");
  });
});
