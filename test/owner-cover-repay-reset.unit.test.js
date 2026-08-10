/**
 * #13 owner-cover repay & reset — local Hardhat unit test.
 * Run: npx hardhat test test/owner-cover-repay-reset.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");

describe("Owner cover repay & reset (#13)", function () {
  async function deployBtcFixture() {
    const [owner, bot, feeReceiver] = await ethers.getSigners();

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

    const kashToken = await ethers.getContractAt("KashTokenBtc", await kashYield.kashTokenBtc());
    const vault = await kashYield.getAddress();

    return { owner, bot, feeReceiver, usdc, kashYield, kashToken, vault };
  }

  async function fundAndCover({ owner, bot, usdc, kashYield }, coverAmount) {
    await usdc.connect(owner).approve(await kashYield.getAddress(), coverAmount);
    await kashYield.connect(owner).markOwnerUsdcDeposit(coverAmount);
    await kashYield.connect(bot).coverUsdcShortfall(coverAmount);
  }

  async function mintKashFromVault(ctx, amount) {
    const { vault, kashToken, owner } = ctx;
    await hre.network.provider.send("hardhat_setBalance", [
      vault,
      "0x" + (10n ** 18n).toString(16),
    ]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [vault] });
    const vaultSigner = await ethers.getSigner(vault);
    await kashToken.connect(vaultSigner).mint(owner.address, amount);
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [vault] });
  }

  it("repayOwnerCoverUsdc returns USDC and decrements counter", async function () {
    const ctx = await deployBtcFixture();
    const cover = 1_000_000n; // 1 USDC
    await fundAndCover(ctx, cover);

    expect(await ctx.kashYield.totalOwnerCoverUsdc()).to.equal(cover);
    expect(await ctx.kashYield.ownerUsdcReserve()).to.equal(0n);

    const ownerBefore = await ctx.usdc.balanceOf(ctx.owner.address);
    await ctx.kashYield.connect(ctx.owner).repayOwnerCoverUsdc(cover);
    const ownerAfter = await ctx.usdc.balanceOf(ctx.owner.address);

    expect(ownerAfter - ownerBefore).to.equal(cover);
    expect(await ctx.kashYield.totalOwnerCoverUsdc()).to.equal(0n);
  });

  it("repayOwnerCoverUsdc reverts when amount exceeds receivable", async function () {
    const ctx = await deployBtcFixture();
    await fundAndCover(ctx, 500_000n);

    await expect(
      ctx.kashYield.connect(ctx.owner).repayOwnerCoverUsdc(600_000n),
    ).to.be.revertedWithCustomError(ctx.kashYield, "InsufficientOwnerCoverReceivable");
  });

  it("repayOwnerCoverUsdc reverts when vault USDC insufficient", async function () {
    const ctx = await deployBtcFixture();
    await fundAndCover(ctx, 1_000_000n);

    const bal = await ctx.usdc.balanceOf(ctx.vault);
    await hre.network.provider.send("hardhat_setBalance", [
      ctx.vault,
      "0x" + (10n ** 18n).toString(16),
    ]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [ctx.vault] });
    const vaultSigner = await ethers.getSigner(ctx.vault);
    await ctx.usdc.connect(vaultSigner).transfer(ctx.bot.address, bal);
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [ctx.vault] });

    await expect(
      ctx.kashYield.connect(ctx.owner).repayOwnerCoverUsdc(1_000_000n),
    ).to.be.revertedWithCustomError(ctx.kashYield, "InsufficientVaultUsdc");
  });

  it("resetOwnerCoverUsdc works at dust supply", async function () {
    const ctx = await deployBtcFixture();
    await fundAndCover(ctx, 2_000_000n);

    await mintKashFromVault(ctx, 10n ** 14n); // 0.0001 KASH < dust

    expect(await ctx.kashToken.totalSupply()).to.be.lt(10n ** 15n);
    await ctx.kashYield.connect(ctx.owner).resetOwnerCoverUsdc();
    expect(await ctx.kashYield.totalOwnerCoverUsdc()).to.equal(0n);
  });

  it("resetOwnerCoverUsdc reverts when supply is not dust", async function () {
    const ctx = await deployBtcFixture();
    await fundAndCover(ctx, 1_000_000n);

    await mintKashFromVault(ctx, ethers.parseEther("1"));

    await expect(
      ctx.kashYield.connect(ctx.owner).resetOwnerCoverUsdc(),
    ).to.be.revertedWithCustomError(ctx.kashYield, "SupplyNotDust");
  });
});
