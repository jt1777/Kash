/**
 * FIX-1 — claim amounts must match on-chain Phase-2 allocations (Aster).
 * Run: ARBITRUM_MAINNET_RPC_URL= npx hardhat test test/claim-allocation-binding.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  WAD,
  PROCESSING_WINDOW_START,
  deployKashYieldAsterFixture,
  mintKashToUser,
  jumpToCycleOffset,
} = require("./helpers/deployKashYieldAsterFixture");
const {
  allocRedeemNetAmounts,
  buildRedeemMerkleTree,
} = require("./helpers/redeemMerkle");
const { buildMintMerkleTree } = require("./helpers/mintMerkle");

describe("Claim allocation binding (FIX-1, Aster)", function () {
  async function settleRedeemBatch(vault, bot, user, kashToken) {
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

    const redeemKashTotal = BigInt((await vault.batchTotalRedeemKash(cycle)).toString());
    const feeBps = BigInt((await vault.feeBps()).toString());
    const userAddr = await user.getAddress();
    const req = await vault.getPendingRedeemRequest(userAddr, cycle);
    const entries = allocRedeemNetAmounts(
      [userAddr],
      [BigInt(req.kashAmount.toString())],
      redeemKashTotal,
      grossG,
      feeBps,
    );
    const { root, proofs } = buildRedeemMerkleTree(cycle, entries);
    await vault.connect(bot).processBatchPhase2ForCycle(cycle, root, ethers.ZeroHash);
    return { cycle, entries, proofs };
  }

  async function settleMintBatch(vault, bot, user) {
    const nav = WAD;
    const mintEth = ethers.parseEther("0.01");

    await vault.connect(user).requestMint(0, { value: mintEth });

    const cycle = await vault.getCurrentBatchCycle();
    await vault.connect(bot).updateNAV(nav, 0, 0, 0);
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(cycle, 0n);

    const totalMintUSD = BigInt((await vault.batchTotalMintValueUSD(cycle)).toString());
    const feeBps = BigInt((await vault.feeBps()).toString());
    const totalMintKash = (totalMintUSD * (10000n - feeBps) * WAD) / (10000n * nav);
    const totalMintEth = BigInt((await vault.batchTotalMintEth(cycle)).toString());
    const userAddr = await user.getAddress();
    const req = await vault.getPendingMintRequest(userAddr, cycle);
    const amountIn = BigInt(req.amountIn.toString());
    const kash =
      totalMintEth === amountIn
        ? totalMintKash
        : (totalMintKash * amountIn) / totalMintEth;
    const entries = [{ user: userAddr, amount: kash }];
    const { root, proofs } = buildMintMerkleTree(cycle, entries);
    await vault.connect(bot).processBatchPhase2ForCycle(cycle, ethers.ZeroHash, root);
    return { cycle, entries, proofs };
  }

  it("valid redeem claim succeeds when proof amount matches allocation", async function () {
    const { bot, user, vault, kashToken } = await deployKashYieldAsterFixture();
    const { cycle, entries, proofs } = await settleRedeemBatch(vault, bot, user, kashToken);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const allocation = await vault.batchRedeemNetAsset(cycle, userAddr);
    expect(allocation).to.equal(leaf.amount);

    const balBefore = await ethers.provider.getBalance(userAddr);
    const proof = proofs.get(userAddr.toLowerCase());
    await vault.connect(user).claimRedeem(cycle, leaf.amount, proof);
    const balAfter = await ethers.provider.getBalance(userAddr);
    expect(balAfter).to.be.gt(balBefore);
  });

  it("redeem claim reverts when proof amount differs from allocation", async function () {
    const { bot, user, vault, kashToken } = await deployKashYieldAsterFixture();
    const { cycle, entries } = await settleRedeemBatch(vault, bot, user, kashToken);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const wrongAmount = leaf.amount + 1n;
    const { proofs: evilProofs } = buildRedeemMerkleTree(cycle, [{ user: userAddr, amount: wrongAmount }]);
    const evilProof = evilProofs.get(userAddr.toLowerCase());

    await expect(
      vault.connect(user).claimRedeem(cycle, wrongAmount, evilProof),
    ).to.be.revertedWithCustomError(vault, "InvalidProof");
  });

  it("redeem claim reverts for address with no allocation even with a valid-looking proof", async function () {
    const { bot, user, attacker, vault, kashToken } = await deployKashYieldAsterFixture();
    const { cycle, entries, proofs } = await settleRedeemBatch(vault, bot, user, kashToken);
    const attackerAddr = await attacker.getAddress();
    const leaf = entries[0];
    const proof = proofs.get((await user.getAddress()).toLowerCase());

    await expect(
      vault.connect(attacker).claimRedeem(cycle, leaf.amount, proof),
    ).to.be.revertedWithCustomError(vault, "InvalidProof");
    expect(await vault.batchRedeemNetAsset(cycle, attackerAddr)).to.equal(0n);
  });

  it("valid mint claim succeeds when proof amount matches allocation", async function () {
    const { bot, user, vault, kashToken } = await deployKashYieldAsterFixture();
    const { cycle, entries, proofs } = await settleMintBatch(vault, bot, user);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const allocation = await vault.batchMintKashAllocation(cycle, userAddr);
    expect(allocation).to.equal(leaf.amount);

    const balBefore = await kashToken.balanceOf(userAddr);
    const proof = proofs.get(userAddr.toLowerCase());
    await vault.connect(user).claimMint(cycle, leaf.amount, proof);
    expect(await kashToken.balanceOf(userAddr)).to.equal(balBefore + leaf.amount);
  });

  it("mint claim reverts when proof amount differs from allocation", async function () {
    const { bot, user, vault } = await deployKashYieldAsterFixture();
    const { cycle, entries } = await settleMintBatch(vault, bot, user);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const wrongAmount = leaf.amount + 1n;
    const { proofs: evilProofs } = buildMintMerkleTree(cycle, [{ user: userAddr, amount: wrongAmount }]);
    const evilProof = evilProofs.get(userAddr.toLowerCase());

    await expect(
      vault.connect(user).claimMint(cycle, wrongAmount, evilProof),
    ).to.be.revertedWithCustomError(vault, "InvalidProof");
  });
});
