/**
 * FIX-5 — sweepExpiredClaims / sweepExpiredMintClaims widened to onlyOwnerOrBotOrKeeper.
 * Proves the OWNER (not just bot) can sweep. Run: npx hardhat test test/owner-sweep.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Owner sweep expired claims (FIX-5)", function () {
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

    await wbtc.transfer(await kashYield.getAddress(), ethers.parseUnits("10", 8));

    const vaultAddr = await kashYield.getAddress();
    await hre.network.provider.send("hardhat_setBalance", [vaultAddr, "0x" + (10n ** 20n).toString(16)]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [vaultAddr] });
    const vaultSigner = await ethers.getSigner(vaultAddr);
    await kashToken.connect(vaultSigner).mint(user.address, ethers.parseEther("100"));
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [vaultAddr] });

    return { owner, bot, user, wbtc, kashYield, kashToken };
  }

  it("owner can sweepExpiredClaims after deadline", async function () {
    const { owner, bot, user, kashYield, kashToken } = await deployFixture();
    const cycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(cycle, ethers.parseUnits("0.001", 8));
    await kashYield.connect(bot).processBatchPhase2ForCycle(
      cycle,
      ethers.keccak256(ethers.toUtf8Bytes("redeem-root")),
      ethers.ZeroHash,
    );
    await time.increase(30 * 24 * 3600 + 1);

    await kashYield.connect(owner).sweepExpiredClaims(cycle);
    expect((await kashYield.batchClaimInfo(cycle)).redeemClaimsExpired).to.equal(true);
  });

  it("owner can sweepExpiredMintClaims after deadline", async function () {
    const { owner, bot, user, wbtc, kashYield } = await deployFixture();
    const cycle = await kashYield.getCurrentBatchCycle();
    await wbtc.transfer(user.address, ethers.parseUnits("0.01", 8));
    await wbtc.connect(user).approve(await kashYield.getAddress(), ethers.parseUnits("0.01", 8));
    await kashYield.connect(user).requestMint(ethers.parseUnits("0.01", 8));
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(cycle, 0n);
    await kashYield.connect(bot).processBatchPhase2ForCycle(
      cycle,
      ethers.ZeroHash,
      ethers.keccak256(ethers.toUtf8Bytes("mint-root")),
    );
    await time.increase(30 * 24 * 3600 + 1);

    await kashYield.connect(owner).sweepExpiredMintClaims(cycle);
    expect((await kashYield.batchClaimInfo(cycle)).mintClaimsExpired).to.equal(true);
  });
});
