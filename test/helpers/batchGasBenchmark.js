const { ethers } = require("hardhat");

const WBTC_ADDRESS = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const UNISWAP_ROUTER_V2 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
];

/** Arbitrum One L2 block gas limit (approx.) — Phase 2 must fit in one tx. */
const ARBITRUM_BLOCK_GAS_LIMIT = 32_000_000n;

const CYCLE_SECS = 3600n;
const NAV_1 = 10n ** 18n;

async function createFundedWallets(count, funder, ethPerWallet = ethers.parseEther("0.002")) {
  const wallets = [];
  for (let i = 0; i < count; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await (await funder.sendTransaction({ to: wallet.address, value: ethPerWallet })).wait();
    wallets.push(wallet);
  }
  return wallets;
}

async function deployKashYieldBtcBenchmark(owner, bot) {
  const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
  const uniAdapter = await UniswapV3Adapter.deploy(UNISWAP_ROUTER_V2, WETH_ADDRESS);
  await uniAdapter.waitForDeployment();

  const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc = await KashYieldBtc.deploy(bot.address, WBTC_ADDRESS, USDC_ADDRESS);
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

async function submitMintRequests({ kashYieldBtc, wbtc, wallets, mintAmountEach, chunkSize = 10 }) {
  const vault = await kashYieldBtc.getAddress();
  for (let i = 0; i < wallets.length; i += chunkSize) {
    const chunk = wallets.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (wallet) => {
        const wbtcUser = wbtc.connect(wallet);
        await (await wbtcUser.approve(vault, mintAmountEach)).wait();
        await (await kashYieldBtc.connect(wallet).requestMint(mintAmountEach)).wait();
      }),
    );
  }
}

async function currentBatchCycle() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp) / CYCLE_SECS;
}

function formatGasReport({ mintCount, phase1Gas, phase2Gas, phase2Estimate, phase2Failed }) {
  const lines = [
    "",
    "══════════════════════════════════════════════════════════════",
    `  KashYieldBtc batch gas benchmark (${mintCount} minters, mint-only)`,
    "══════════════════════════════════════════════════════════════",
    `  Phase 1 (performUpkeep — NAV / USD totals) : ${phase1Gas?.toLocaleString() ?? "n/a"} gas`,
    `  Phase 2 (mint KASH push payouts)           : ${phase2Gas?.toLocaleString() ?? "n/a"} gas`,
  ];
  if (phase2Estimate != null) {
    lines.push(`  Phase 2 eth_estimateGas                  : ${phase2Estimate.toLocaleString()} gas`);
  }
  lines.push(`  Arbitrum block gas limit (reference)       : ${ARBITRUM_BLOCK_GAS_LIMIT.toLocaleString()} gas`);
  if (phase2Gas != null) {
    const pct = Number((phase2Gas * 10000n) / ARBITRUM_BLOCK_GAS_LIMIT) / 100;
    lines.push(`  Phase 2 vs block limit                   : ${pct.toFixed(1)}%`);
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
  submitMintRequests,
  currentBatchCycle,
  formatGasReport,
};
