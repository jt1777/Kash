const { ethers } = require("hardhat");
const hre = require("hardhat");

const WBTC_ADDRESS = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const UNISWAP_ROUTER_V2 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
];

/** Arbitrum One L2 block gas limit (approx.) — Phase 2 must fit in one tx. */
const ARBITRUM_BLOCK_GAS_LIMIT = 32_000_000n;

const CYCLE_SECS = 3600n;
const NAV_1 = 10n ** 18n;

/** Extra headroom for deploy, swap, Merkle build, and phase 1/2. */
const BENCHMARK_BASE_TIMEOUT_MS = 180_000;

async function createFundedWallets(count, ethPerWallet = ethers.parseEther("0.05")) {
  const wallets = Array.from({ length: count }, () =>
    ethers.Wallet.createRandom().connect(ethers.provider),
  );
  const ethHex = ethers.toBeHex(ethPerWallet);
  await Promise.all(
    wallets.map((wallet) =>
      hre.network.provider.send("hardhat_setBalance", [wallet.address, ethHex]),
    ),
  );
  return wallets;
}

async function deployKashYieldBtcBenchmark(owner, bot) {
  const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
  const uniAdapter = await UniswapV3Adapter.deploy(UNISWAP_ROUTER_V2, WETH_ADDRESS);
  await uniAdapter.waitForDeployment();

  const BenchmarkKashYieldBtc = await ethers.getContractFactory("BenchmarkKashYieldBtc");
  const kashYieldBtc = await BenchmarkKashYieldBtc.deploy(bot.address, WBTC_ADDRESS, USDC_ADDRESS);
  await kashYieldBtc.setSpotDex(await uniAdapter.getAddress());
  await kashYieldBtc.setCycleDurationSeconds(CYCLE_SECS);
  await kashYieldBtc.setUserWindowEnd(CYCLE_SECS);
  await kashYieldBtc.setProcessingWindowStart(0n);

  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    HL_BRIDGE,
    USDC_ADDRESS,
    WBTC_ADDRESS,
    false,
    await kashYieldBtc.getAddress(),
  );

  const { deployAndWireExchangeFacade } = require("./forkBatchOps");
  await deployAndWireExchangeFacade({
    kashYield: kashYieldBtc,
    owner,
    bot,
    usdcAddress: USDC_ADDRESS,
    primaryAsset: WBTC_ADDRESS,
    hlAdapter,
  });

  return { kashYieldBtc, uniAdapter, hlAdapter };
}

async function swapEthForWbtc(signer, ethAmount) {
  const router = new ethers.Contract(UNISWAP_ROUTER_V2, ROUTER_ABI, signer);
  await router.exactInputSingle(
    [WETH_ADDRESS, WBTC_ADDRESS, 500, await signer.getAddress(), ethAmount, 0, 0],
    { value: ethAmount },
  );
  const wbtc = new ethers.Contract(WBTC_ADDRESS, ERC20_ABI, signer);
  return wbtc.balanceOf(await signer.getAddress());
}

/**
 * Register minters via BenchmarkKashYieldBtc (test-only). Caller must send wBTC to the
 * vault separately — same totals as real requestMint, without N approve/mint txs.
 */
async function benchmarkEnrollMints({
  kashYieldBtc,
  owner,
  wallets,
  mintAmountEach,
  chunkSize = 50,
}) {
  let completed = 0;
  for (let i = 0; i < wallets.length; i += chunkSize) {
    const chunk = wallets.slice(i, i + chunkSize).map((w) => w.address);
    await (await kashYieldBtc.connect(owner).benchmarkEnrollMints(chunk, mintAmountEach)).wait();
    completed += chunk.length;
    if (completed % 50 === 0 || completed === wallets.length) {
      console.log(`       … enrolled ${completed}/${wallets.length} minters`);
    }
  }
}

async function currentBatchCycle() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp) / CYCLE_SECS;
}

function benchmarkTimeoutMs(mintCount) {
  const env = process.env.BENCHMARK_TIMEOUT_MS;
  if (env) return parseInt(env, 10);
  // ~2s per enrolled minter on a fork (50-user enroll txs) + Merkle RPC reads + overhead.
  return Math.max(BENCHMARK_BASE_TIMEOUT_MS, mintCount * 2_500 + BENCHMARK_BASE_TIMEOUT_MS);
}

function formatGasReport({ mintCount, phase1Gas, phase2Gas, phase2Estimate, phase2Failed }) {
  const lines = [
    "",
    "══════════════════════════════════════════════════════════════",
    `  KashYieldBtc batch gas benchmark (${mintCount} minters, mint-only)`,
    "══════════════════════════════════════════════════════════════",
    `  Phase 1 (performUpkeep — O(1) totals)     : ${phase1Gas?.toLocaleString() ?? "n/a"} gas`,
    `  Phase 2 (Merkle root commit + net mint)   : ${phase2Gas?.toLocaleString() ?? "n/a"} gas`,
  ];
  if (phase2Estimate != null) {
    lines.push(`  Phase 2 eth_estimateGas                  : ${phase2Estimate.toLocaleString()} gas`);
  }
  lines.push(`  Arbitrum block gas limit (reference)       : ${ARBITRUM_BLOCK_GAS_LIMIT.toLocaleString()} gas`);
  if (phase1Gas != null) {
    lines.push(
      phase1Gas <= 600_000n
        ? "  Phase 1 looks O(1) (under 600k)            : YES"
        : "  Phase 1 looks O(1) (under 600k)            : NO — investigate",
    );
  }
  if (phase2Gas != null) {
    const pct = Number((phase2Gas * 10000n) / ARBITRUM_BLOCK_GAS_LIMIT) / 100;
    lines.push(`  Phase 2 vs block limit                   : ${pct.toFixed(1)}%`);
    lines.push(
      phase2Gas <= 3_000_000n
        ? "  Phase 2 looks O(1) (under 3M)              : YES"
        : "  Phase 2 looks O(1) (under 3M)              : NO — investigate",
    );
    lines.push(
      phase2Gas <= ARBITRUM_BLOCK_GAS_LIMIT
        ? "  Phase 2 fits in one Arbitrum block         : YES"
        : "  Phase 2 fits in one Arbitrum block         : NO — would revert OOG on mainnet",
    );
  }
  if (phase2Failed) {
    lines.push(`  Phase 2 error                              : ${phase2Failed}`);
  }
  lines.push("══════════════════════════════════════════════════════════════");
  lines.push("");
  return lines.join("\n");
}

module.exports = {
  WBTC_ADDRESS,
  ARBITRUM_BLOCK_GAS_LIMIT,
  CYCLE_SECS,
  NAV_1,
  ERC20_ABI,
  createFundedWallets,
  deployKashYieldBtcBenchmark,
  swapEthForWbtc,
  benchmarkEnrollMints,
  currentBatchCycle,
  benchmarkTimeoutMs,
  formatGasReport,
};
