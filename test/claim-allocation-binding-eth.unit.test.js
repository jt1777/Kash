/**
 * FIX-1 (ETH) — claim amounts must match on-chain Phase-2 allocations.
 * Mirrors claim-allocation-binding.unit.test.js for the ETH vault.
 * Redeem claims pay native ETH; mint claims pay KASH-ETH.
 * Run: npx hardhat test test/claim-allocation-binding-eth.unit.test.js
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

describe("Claim allocation binding — ETH (FIX-1)", function () {
  async function deployEthFixture() {
    const [owner, bot, user, attacker, feeReceiver] = await ethers.getSigners();

    const weth = await (await ethers.getContractFactory("MockERC20")).deploy("WETH", "WETH", 18);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC", 6);
    const oracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(
      3000n * 10n ** 8n,
      8,
    );
    const kashYield = await (await ethers.getContractFactory("KashYieldETH")).deploy(
      bot.address,
      await weth.getAddress(),
      await usdc.getAddress(),
      feeReceiver.address,
    );
    await kashYield.setEthOracle(await oracle.getAddress());
    await kashYield.setProcessingWindowStart(0);
    await kashYield.setUserWindowEnd(86400);

    const kashToken = await ethers.getContractAt("KashTokenEth", await kashYield.kashTokenEth());

    const kashYieldAddr = await kashYield.getAddress();
    await hre.network.provider.send("hardhat_setBalance", [
      kashYieldAddr,
      "0x" + (10n ** 20n).toString(16),
    ]);
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [kashYieldAddr] });
    const kashYieldSigner = await ethers.getSigner(kashYieldAddr);
    await kashToken.connect(kashYieldSigner).mint(user.address, ethers.parseEther("100"));
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [kashYieldAddr] });

    return { owner, bot, user, attacker, kashYield, kashToken };
  }

  async function settleRedeemBatch(kashYield, bot, user, kashToken) {
    const batchCycle = await kashYield.getCurrentBatchCycle();
    await kashToken.connect(user).approve(await kashYield.getAddress(), ethers.parseEther("10"));
    await kashYield.connect(user).requestRedeem(ethers.parseEther("10"));
    await kashYield.connect(bot).performUpkeep("0x");
    const grossG = ethers.parseEther("0.001"); // 0.001 ETH gross unwind
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
    return { batchCycle, entries, proofs };
  }

  async function settleMintBatch(kashYield, bot, user) {
    const batchCycle = await kashYield.getCurrentBatchCycle();
    await kashYield.connect(user).requestMint(0, { value: ethers.parseEther("0.01") });
    await kashYield.connect(bot).performUpkeep("0x");
    await kashYield.connect(bot).markBatchOpsDone(batchCycle, 0n);

    const nav = ethers.parseEther("1");
    const totalMintUSD = BigInt((await kashYield.batchTotalMintValueUSD(batchCycle)).toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    const amountAfterFeeTotal = (totalMintUSD * (10000n - feeBps)) / 10000n;
    const totalMintKash = (amountAfterFeeTotal * nav) / (10n ** 18n);
    const userAddr = await user.getAddress();
    const req = await kashYield.getPendingMintRequest(userAddr, batchCycle);
    const totalMintEth = BigInt((await kashYield.batchTotalMintEth(batchCycle)).toString());
    const entries = allocMintKashAmounts(
      [userAddr],
      [BigInt(req.amountIn.toString())],
      totalMintEth,
      totalMintKash,
    );
    const { root, proofs } = buildMintMerkleTree(batchCycle, entries);
    await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, ethers.ZeroHash, root);
    return { batchCycle, entries, proofs };
  }

  it("valid redeem claim succeeds when proof amount matches allocation", async function () {
    const { bot, user, kashYield, kashToken } = await deployEthFixture();
    const { batchCycle, entries, proofs } = await settleRedeemBatch(kashYield, bot, user, kashToken);
    const userAddr = await user.getAddress();
    const leaf = entries[0];
    const allocation = await kashYield.batchRedeemNetAsset(batchCycle, userAddr);
    expect(allocation).to.equal(leaf.amount);

    const proof = proofs.get(userAddr.toLowerCase());
    await expect(
      kashYield.connect(user).claimRedeem(batchCycle, leaf.amount, proof),
    ).to.changeEtherBalance(user, leaf.amount);
  });

  it("redeem claim reverts when proof amount differs from allocation", async function () {
    const { bot, user, kashYield, kashToken } = await deployEthFixture();
    const { batchCycle, entries } = await settleRedeemBatch(kashYield, bot, user, kashToken);
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
    const { bot, user, attacker, kashYield, kashToken } = await deployEthFixture();
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
    const { bot, user, kashYield, kashToken } = await deployEthFixture();
    const { batchCycle, entries, proofs } = await settleMintBatch(kashYield, bot, user);
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
    const { bot, user, kashYield } = await deployEthFixture();
    const { batchCycle, entries } = await settleMintBatch(kashYield, bot, user);
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
});
