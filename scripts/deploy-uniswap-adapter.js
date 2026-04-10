// scripts/deploy-uniswap-adapter.js
// Deploys UniswapV3Adapter and optionally registers it as the spot DEX on KashYieldETH/BTC.
//
// The adapter implements ISpotDex and wraps Uniswap V3 SwapRouter02 for
// ETH ↔ USDC and wBTC ↔ USDC swaps used by KashYield's swapForUsdc / swapFromUsdc.
//
// Network defaults (can be overridden via env vars):
//   Arbitrum One:    SwapRouter02 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
//                    WETH         0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
//   Arbitrum Sepolia: SwapRouter02 0x101F443B4d1b059569D643917553c771E1b9663E
//                    WETH         0x980B62Da83eFf3D4576C647993b0c1D7faf17c73
//
// Usage (mainnet — uses defaults automatically):
//   npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
//
// Usage (testnet — uses defaults automatically):
//   npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumSepolia
//
// Optional env var overrides:
//   UNISWAP_ROUTER_ADDRESS   — override SwapRouter02 address
//   WETH_ADDRESS             — override WETH address
//   KASH_YIELD_ETH_ADDRESS   — if set, auto-registers adapter as spot DEX on KashYieldETH
//   KASH_YIELD_BTC_ADDRESS   — if set, auto-registers adapter as spot DEX on KashYieldBtc
//   DEFAULT_FEE_TIER         — override default fee tier (500, 3000, 10000 — default: 500)
//
// Fee tier overrides (set after deploy via setFeeTierOverride on the adapter):
//   For most WETH/USDC and wBTC/USDC pools on Arbitrum the 0.05% (500) tier has the most liquidity.
//   If a pool has better depth at 0.3% (3000), call setFeeTierOverride() on the deployed adapter.

require("dotenv").config();
const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Network defaults ──────────────────────────────────────────────────────────
const NETWORK_DEFAULTS = {
  arbitrumOne: {
    swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02
    weth:       "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
  arbitrumSepolia: {
    swapRouter: "0x101F443B4d1b059569D643917553c771E1b9663E", // SwapRouter02
    weth:       "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
  },
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  console.log("Deploying UniswapV3Adapter to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance: ", hre.ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) throw new Error("Deployer balance is 0 — fund the wallet first.");

  const defaults   = NETWORK_DEFAULTS[network] || {};
  const routerAddr = process.env.UNISWAP_ROUTER_ADDRESS || defaults.swapRouter;
  const wethAddr   = process.env.WETH_ADDRESS           || defaults.weth;

  if (!routerAddr || !hre.ethers.isAddress(routerAddr)) {
    throw new Error(
      "No SwapRouter02 address. Set UNISWAP_ROUTER_ADDRESS in .env, or use --network arbitrumOne / arbitrumSepolia for auto-defaults."
    );
  }
  if (!wethAddr || !hre.ethers.isAddress(wethAddr)) {
    throw new Error(
      "No WETH address. Set WETH_ADDRESS in .env, or use --network arbitrumOne / arbitrumSepolia for auto-defaults."
    );
  }

  console.log("Parameters:");
  console.log("  SwapRouter02:", routerAddr);
  console.log("  WETH:        ", wethAddr);

  const defaultFeeTier = process.env.DEFAULT_FEE_TIER
    ? Number(process.env.DEFAULT_FEE_TIER)
    : 500;
  console.log("  Default fee: ", defaultFeeTier === 500 ? "500 (0.05%)" : defaultFeeTier === 3000 ? "3000 (0.3%)" : String(defaultFeeTier));
  console.log("");

  // ── Deploy ────────────────────────────────────────────────────────────────
  const UniswapV3Adapter = await hre.ethers.getContractFactory("UniswapV3Adapter");
  const adapter = await UniswapV3Adapter.deploy(routerAddr, wethAddr);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log("✅ UniswapV3Adapter:", adapterAddress);

  // Override default fee tier if non-standard value requested
  if (defaultFeeTier !== 500) {
    await (await adapter.setDefaultFeeTier(defaultFeeTier)).wait();
    console.log("✅ setDefaultFeeTier →", defaultFeeTier);
  }

  // ── Optional: register as spot DEX on KashYieldETH ───────────────────────
  const ethContractAddr = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS;
  if (ethContractAddr && hre.ethers.isAddress(ethContractAddr)) {
    const kashYieldEth = await hre.ethers.getContractAt("KashYieldETH", ethContractAddr);
    // 1. Whitelist the new adapter
    await (await kashYieldEth.setAllowedSpotDexRouter(adapterAddress, true)).wait();
    console.log("✅ setAllowedSpotDexRouter on KashYieldETH →", adapterAddress);
    // 2. Propose the new spot DEX (starts 48-hour timelock if one is already set)
    const currentSpotDex = await kashYieldEth.spotDexAddress();
    await (await kashYieldEth.setSpotDex(adapterAddress)).wait();
    if (currentSpotDex === hre.ethers.ZeroAddress) {
      console.log("✅ setSpotDex on KashYieldETH → immediate (first-ever):", adapterAddress);
    } else {
      const readyAt = await kashYieldEth.spotDexPending(adapterAddress);
      const readyDate = new Date(Number(readyAt) * 1000).toISOString();
      console.log("⏳ setSpotDex on KashYieldETH → 48h timelock started. Ready at:", readyDate);
      console.log("   Run after that time:");
      console.log(`     KASH_YIELD_ETH_ADDRESS=${ethContractAddr} SPOT_DEX_ADDRESS=${adapterAddress} npx hardhat run scripts/confirmSpotDex.js --network ${network}`);
    }
  }

  // ── Optional: register as spot DEX on KashYieldBtc ───────────────────────
  const btcContractAddr = process.env.KASH_YIELD_BTC_ADDRESS;
  if (btcContractAddr && hre.ethers.isAddress(btcContractAddr)) {
    const kashYieldBtc = await hre.ethers.getContractAt("KashYieldBtc", btcContractAddr);
    // 1. Whitelist the new adapter
    await (await kashYieldBtc.setAllowedSpotDexRouter(adapterAddress, true)).wait();
    console.log("✅ setAllowedSpotDexRouter on KashYieldBtc →", adapterAddress);
    // 2. Propose the new spot DEX
    const currentSpotDexBtc = await kashYieldBtc.spotDexAddress();
    await (await kashYieldBtc.setSpotDex(adapterAddress)).wait();
    if (currentSpotDexBtc === hre.ethers.ZeroAddress) {
      console.log("✅ setSpotDex on KashYieldBtc → immediate (first-ever):", adapterAddress);
    } else {
      const readyAtBtc = await kashYieldBtc.spotDexPending(adapterAddress);
      const readyDateBtc = new Date(Number(readyAtBtc) * 1000).toISOString();
      console.log("⏳ setSpotDex on KashYieldBtc → 48h timelock started. Ready at:", readyDateBtc);
      console.log("   Run after that time:");
      console.log(`     KASH_YIELD_BTC_ADDRESS=${btcContractAddr} SPOT_DEX_ADDRESS=${adapterAddress} npx hardhat run scripts/confirmSpotDex.js --network ${network}`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n====================================");
  console.log("📋 UNISWAP V3 ADAPTER");
  console.log("====================================");
  console.log("  UniswapV3Adapter:", adapterAddress);
  console.log("  SwapRouter02:    ", routerAddr);
  console.log("  WETH:            ", wethAddr);
  console.log("  Default fee tier:", defaultFeeTier);
  console.log("====================================");
  console.log("\nAdd to .env and bot/.env:");
  console.log(`  UNISWAP_ADAPTER_ADDRESS=${adapterAddress}`);
  console.log("\nIf not auto-registered above, set manually:");
  console.log(`  KASH_YIELD_ETH_ADDRESS=<addr> SPOT_DEX_ADDRESS=${adapterAddress} \\`);
  console.log(`    npx hardhat run scripts/setSpotDex.js --network ${network}`);
  console.log("\nTo override fee tier for a specific pair after deploy:");
  console.log("  Call adapter.setFeeTierOverride(tokenIn, tokenOut, 3000) for 0.3% pool");

  // ── Save deployment record ─────────────────────────────────────────────────
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const info = {
    network,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    timestamp:  new Date().toISOString(),
    deployer:   deployer.address,
    contracts: {
      uniswapV3Adapter: adapterAddress,
    },
    config: {
      swapRouter02: routerAddr,
      weth:         wethAddr,
      defaultFeeTier,
    },
  };
  const filepath = path.join(deploymentsDir, `uniswap-adapter-${network}-${Date.now()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log("\n💾 Saved:", filepath);
  console.log("\n✅ Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
