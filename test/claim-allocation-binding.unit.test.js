/**
 * FIX-1 — claim amounts must match on-chain Phase-2 allocations.
 * Run: npx hardhat test test/claim-allocation-binding.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const {
  allocRedeemNetAmounts,
  buildRedeemMerkleTree,
} = require("./helpers/redeemMerkle");
const {
  allocMintKashAmounts,
  buildMintMerkleTree,
} = require("./helpers/mintMerkle");

describe("Claim allocation binding (FIX-1)", function () {
  async function deployBtcFixture() {
    const [owner, bot, user, attacker, feeReceiver] = await ethers.getSigners();

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

    return { owner, bot, user, attacker, wbtc, kashYield, kashToken };
  }

  async function settleRedeemBatch(kashYield, bot, user, kashToken) {
    const batchCycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x");
    const grossG = ethers.parseUnits("0.001", 8);
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, grossG);

    const redeemKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    const userAddr = await user.getAddress();
    const req = await kashYield.getPendingRedeemRequest(userAddr, batchCycle);
    const entries = allocRedeemNetAmounts(
      [userAddr],
      [BigInt(req.kashAmount.toString())],
      redeemKash,
      grossG,
      feeBps,
    );
    const { root, proofs } = buildRedeemMerkleTree(batchCycle, entries);
    await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, root, ethers.ZeroHash);
    return { batchCycle, entries, proofs, grossG };
  }

  async function settleMintBatch(kashYield, bot, user, wbtc) {
    const batchCycle = await kashYield.getCurrentBatchCycle();
    await wbtc.transfer(user.address, ethers.parseUnits("0.01", 8));
    const wbtcAddr = await kashYield.wbtcAddress();
    await wbtc.connect(user).approve(await kashYield.getAddress(), ethers.parseUnits("0.01", 8));
    await kashYield.connect(user).requestMint(ethers.parseUnits("0.01", 8));
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, 0n);

    const nav = ethers.parseEther("1");
    const totalMintUSD = BigInt((await kashYield.batchTotalMintValueUSD(batchCycle)).toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    const amountAfterFeeTotal = (totalMintUSD * (10000n - feeBps)) / 10000n;
    const totalMintKash = (amountAfterFeeTotal * nav) / (10n ** 18n);
    const userAddr = await user.getAddress();
    const req = await kashYield.getPendingMintRequest(userAddr, batchCycle);
    const totalMintBtc = BigInt((await kashYield.batchTotalMintBtc(batchCycle)).toString());
    const entries = allocMintKashAmounts(
      [userAddr],
      [BigInt(req.amountIn.toString())],
      totalMintBtc,
      totalMintKash,
    );
    const { root, proofs } = buildMintMerkleTree(batchCycle, entries);
    await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, ethers.ZeroHash, root);
    return { batchCycle, entries, proofs };
  }

  it("valid redeem claim succeeds when proof amount matches allocation", async function () {
    const { bot, user, wbtc, kashYield, kashToken } = await deployBtcFixture();
    const { batchCycle, entries, proofs } = await settleRedeemBatch(kashYield, bot, user, kashToken);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const allocation = await kashYield.batchRedeemNetAsset(batchCycle, userAddr);
    expect(allocation).to.equal(leaf.amount);

    const balBefore = await wbtc.balanceOf(userAddr);
    const proof = proofs.get(userAddr.toLowerCase());
    await kashYield.connect(user).claimRedeem(batchCycle, leaf.amount, proof);
    expect(await wbtc.balanceOf(userAddr)).to.equal(balBefore + leaf.amount);
  });

  it("redeem claim reverts when proof amount differs from allocation", async function () {
    const { bot, user, kashYield, kashToken } = await deployBtcFixture();
    const { batchCycle, entries, proofs } = await settleRedeemBatch(kashYield, bot, user, kashToken);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const wrongAmount = leaf.amount + 1n;
    const evilEntries = [{ user: userAddr, amount: wrongAmount }];
    const { proofs: evilProofs } = buildRedeemMerkleTree(batchCycle, evilEntries);
    const evilProof = evilProofs.get(userAddr.toLowerCase());

    await expect(
      kashYield.connect(user).claimRedeem(batchCycle, wrongAmount, evilProof),
    ).to.be.revertedWithCustomError(kashYield, "InvalidProof");
  });

  it("redeem claim reverts for address with no request even with a valid-looking proof", async function () {
    const { bot, user, attacker, kashYield, kashToken } = await deployBtcFixture();
    const { batchCycle, entries, proofs } = await settleRedeemBatch(kashYield, bot, user, kashToken);
    const attackerAddr = await attacker.getAddress();
    const leaf = entries[0];
    const proof = proofs.get((await user.getAddress()).toLowerCase());

    await expect(
      kashYield.connect(attacker).claimRedeem(batchCycle, leaf.amount, proof),
    ).to.be.revertedWithCustomError(kashYield, "InvalidProof");
    expect(await kashYield.batchRedeemNetAsset(batchCycle, attackerAddr)).to.equal(0n);
  });

  it("valid mint claim succeeds when proof amount matches allocation", async function () {
    const { bot, user, wbtc, kashYield, kashToken } = await deployBtcFixture();
    const { batchCycle, entries, proofs } = await settleMintBatch(kashYield, bot, user, wbtc);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const allocation = await kashYield.batchMintKashAllocation(batchCycle, userAddr);
    expect(allocation).to.equal(leaf.amount);

    const balBefore = await kashToken.balanceOf(userAddr);
    const proof = proofs.get(userAddr.toLowerCase());
    await kashYield.connect(user).claimMint(batchCycle, leaf.amount, proof);
    expect(await kashToken.balanceOf(userAddr)).to.equal(balBefore + leaf.amount);
  });

  it("mint claim reverts when proof amount differs from allocation", async function () {
    const { bot, user, wbtc, kashYield } = await deployBtcFixture();
    const { batchCycle, entries } = await settleMintBatch(kashYield, bot, user, wbtc);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const wrongAmount = leaf.amount + 1n;
    const evilEntries = [{ user: userAddr, amount: wrongAmount }];
    const { proofs: evilProofs } = buildMintMerkleTree(batchCycle, evilEntries);
    const evilProof = evilProofs.get(userAddr.toLowerCase());

    await expect(
      kashYield.connect(user).claimMint(batchCycle, wrongAmount, evilProof),
    ).to.be.revertedWithCustomError(kashYield, "InvalidProof");
  });

  it("prices all minters at the Phase 1 oracle, not request-time", async function () {
    const { bot, user, attacker, wbtc, kashYield } = await deployBtcFixture();
    const oracle = await ethers.getContractAt("MockChainlinkOracle", await kashYield.btcOracle());
    const batchCycle = await kashYield.getCurrentBatchCycle();
    const amt = ethers.parseUnits("0.01", 8);
    await wbtc.transfer(user.address, amt);
    await wbtc.transfer(attacker.address, amt);
    await wbtc.connect(user).approve(await kashYield.getAddress(), amt);
    await wbtc.connect(attacker).approve(await kashYield.getAddress(), amt);

    await oracle.setAnswer(80_000n * 10n ** 8n);
    await kashYield.connect(user).requestMint(amt);
    await oracle.setAnswer(120_000n * 10n ** 8n);
    await kashYield.connect(attacker).requestMint(amt);

    await kashYield.connect(bot).performUpkeep("0x");
    const phase1Price = await kashYield.batchMintBtcPrice(batchCycle);
    expect(phase1Price).to.equal(ethers.parseEther("120000"));
    expect(await kashYield.batchTotalMintValueUSD(batchCycle)).to.equal(
      (amt * 2n * phase1Price) / (10n ** 8n),
    );

    await kashYield.connect(bot).markBatchOpsDone(batchCycle, 0n);
    const nav = ethers.parseEther("1");
    const totalMintUSD = BigInt((await kashYield.batchTotalMintValueUSD(batchCycle)).toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    const totalMintKash = ((totalMintUSD * (10000n - feeBps)) / 10000n * nav) / (10n ** 18n);
    const totalMintBtc = BigInt((await kashYield.batchTotalMintBtc(batchCycle)).toString());
    const userAddr = await user.getAddress();
    const attackerAddr = await attacker.getAddress();
    const entries = allocMintKashAmounts(
      [userAddr, attackerAddr],
      [amt, amt],
      totalMintBtc,
      totalMintKash,
    );
    const { root } = buildMintMerkleTree(batchCycle, entries);
    await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, ethers.ZeroHash, root);

    const allocUser = await kashYield.batchMintKashAllocation(batchCycle, userAddr);
    const allocAttacker = await kashYield.batchMintKashAllocation(batchCycle, attackerAddr);
    expect(allocUser).to.equal(allocAttacker);
    expect(allocUser + allocAttacker).to.equal(totalMintKash);
  });
});
