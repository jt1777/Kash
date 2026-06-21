// test/batch-gas-benchmark.fork.test.js
//
// Measures on-chain gas for KashYieldBtc batch Phase 1 and Phase 2 (O(1) — gas does
// not scale with minter count). Default 50 wallets is enough for regression; larger
// MINT_USER_COUNT only stress-tests enrollment setup time on the fork.
//
// Setup uses BenchmarkKashYieldBtc.benchmarkEnrollMints (batched state registration)
// plus one wBTC transfer to the vault — not N×requestMint.
//
// Requires a forked Arbitrum One RPC (same as other fork e2e tests).
//
// Run (full 500-wallet benchmark):
//   ARBITRUM_MAINNET_RPC_URL=https://arb1.aralchemy.com/v2/KEY \
//   npx hardhat test test/batch-gas-benchmark.fork.test.js
//
// Quick smoke (50 wallets):
//   MINT_USER_COUNT=50 npx hardhat test test/batch-gas-benchmark.fork.test.js
//
// npm script:
//   npm run test:gas-batch

const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const {
  buildMintMerkleRoot,
} = require("./helpers/forkBatchOps");
const {
  WBTC_ADDRESS,
  ARBITRUM_BLOCK_GAS_LIMIT,
  NAV_1,
  ERC20_ABI,
  createFundedWallets,
  deployKashYieldBtcBenchmark,
  swapEthForWbtc,
  benchmarkEnrollMints,
  currentBatchCycle,
  benchmarkTimeoutMs,
  formatGasReport,
} = require("./helpers/batchGasBenchmark");

const FORK_BLOCK = process.env.FORK_BLOCK_NUMBER
  ? parseInt(process.env.FORK_BLOCK_NUMBER, 10)
  : 440_000_000;

const MINT_COUNT = parseInt(process.env.MINT_USER_COUNT || "50", 10);
/** ~$15+ of wBTC at typical prices — above the ~10 USDC minimum. */
const MINT_WBTC_EACH = 25_000n; // 0.00025 BTC (8 decimals)

describe(`Batch gas benchmark — ${MINT_COUNT} mint wallets`, function () {
  const RPC_URL = process.env.ARBITRUM_MAINNET_RPC_URL || process.env.ARBITRUM_ONE_RPC_URL;

  before(function () {
    if (!RPC_URL) {
      console.log("    ⏭  ARBITRUM_MAINNET_RPC_URL not set — skipping gas benchmark.");
      this.skip();
    }
    if (MINT_COUNT < 1 || MINT_COUNT > 10000) {
      throw new Error("MINT_USER_COUNT must be between 1 and 10000");
    }
  });

  this.timeout(benchmarkTimeoutMs(MINT_COUNT));

  it("reports Phase 1 and Phase 2 gas for mint-only batch", async function () {
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC_URL, blockNumber: FORK_BLOCK } }],
    });

    const [owner, bot] = await ethers.getSigners();
    const { kashYieldBtc } = await deployKashYieldBtcBenchmark(owner, bot);
    const wbtc = new ethers.Contract(WBTC_ADDRESS, ERC20_ABI, owner);

    console.log(`\n    Setting up ${MINT_COUNT} wallets with wBTC mint requests…`);

    const wallets = await createFundedWallets(MINT_COUNT);

    const totalWbtcNeeded = MINT_WBTC_EACH * BigInt(MINT_COUNT);
    const ethForSwap = ethers.parseEther(
      String(Math.max(40, Math.ceil(Number(MINT_COUNT) * 0.08))),
    );
    await swapEthForWbtc(owner, ethForSwap);
    const ownerWbtc = await wbtc.balanceOf(owner.address);
    expect(ownerWbtc).to.be.gte(totalWbtcNeeded);

    const vaultAddr = await kashYieldBtc.getAddress();
    await (await wbtc.transfer(vaultAddr, totalWbtcNeeded)).wait();
    await benchmarkEnrollMints({
      kashYieldBtc,
      owner,
      wallets,
      mintAmountEach: MINT_WBTC_EACH,
    });

    const batchCycle = await currentBatchCycle();
    const activeMintUsers = await kashYieldBtc.activeMintUsers(batchCycle);
    expect(Number(activeMintUsers)).to.equal(MINT_COUNT);

    console.log(`    ✅ ${MINT_COUNT} mint requests queued for batch ${batchCycle}`);

    // ── Phase 1 ────────────────────────────────────────────────────────────
    const phase1Tx = await kashYieldBtc.connect(bot).performUpkeep("0x");
    const phase1Receipt = await phase1Tx.wait();
    const phase1Gas = phase1Receipt.gasUsed;
    expect(await kashYieldBtc.batchPhase(batchCycle)).to.equal(1);

    // Mint-only settlement: skip Aave/HL bot ops; wBTC already sits in vault.
    await kashYieldBtc.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
    await kashYieldBtc.connect(bot).markBatchOpsDone(batchCycle, 0);

    const mintRoot = await buildMintMerkleRoot(kashYieldBtc, batchCycle, NAV_1);
    const phase2Calldata = kashYieldBtc.interface.encodeFunctionData(
      "processBatchPhase2ForCycle",
      [batchCycle, `0x${"0".repeat(64)}`, mintRoot],
    );
    let phase2Estimate;
    try {
      phase2Estimate = await ethers.provider.estimateGas({
        from: bot.address,
        to: await kashYieldBtc.getAddress(),
        data: phase2Calldata,
      });
    } catch (err) {
      phase2Estimate = null;
      console.log(`    ⚠  Phase 2 estimateGas failed: ${err.shortMessage || err.message}`);
    }

    let phase2Gas;
    let phase2Failed;
    try {
      const phase2Tx = await kashYieldBtc.connect(bot).processBatchPhase2ForCycle(
        batchCycle,
        `0x${"0".repeat(64)}`,
        mintRoot,
      );
      const phase2Receipt = await phase2Tx.wait();
      phase2Gas = phase2Receipt.gasUsed;
      expect(await kashYieldBtc.batchProcessed(batchCycle)).to.equal(true);
    } catch (err) {
      phase2Failed = err.shortMessage || err.message;
    }

    console.log(
      formatGasReport({
        mintCount: MINT_COUNT,
        phase1Gas,
        phase2Gas,
        phase2Estimate,
        phase2Failed,
      }),
    );

    if (phase2Gas != null) {
      expect(phase2Gas).to.be.gt(0n);
      expect(phase2Gas).to.be.lt(3_000_000n);
      if (phase1Gas != null) {
        expect(phase1Gas).to.be.lt(600_000n);
      }
    } else {
      throw new Error(`Phase 2 reverted: ${phase2Failed}`);
    }
  });
});
