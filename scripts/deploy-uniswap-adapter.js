// scripts/deploy-uniswap-adapter.js
// Deploys UniswapV3Adapter and optionally registers it as the spot DEX on KashYieldETH/BTC.
//
// The adapter implements ISpotDex and wraps Uniswap V3 SwapRouter02 for
// ETH ↔ USDC and wBTC ↔ USDC swaps used by KashYield's swapForUsdc / swapFromUsdc.
// Older adapter builds used the SwapRouter01 struct (with `deadline`) against Router02
// and reverted on swap — redeploy if your live adapter predates that ABI fix.
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
//                              Omit for ETH-only deploys (otherwise the script may fail if unset/wrong).
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
    await (await kashYieldEth.setSpotDex(adapterAddress)).wait();
    console.log("✅ setSpotDex on KashYieldETH →", adapterAddress);
  }

  // ── Optional: register as spot DEX on KashYieldBtc ───────────────────────
  const btcContractAddr = process.env.KASH_YIELD_BTC_ADDRESS;
  const btcAddrValid =
    btcContractAddr &&
    hre.ethers.isAddress(btcContractAddr) &&
    btcContractAddr !== hre.ethers.ZeroAddress;
  if (btcAddrValid) {
    const btcCode = await hre.ethers.provider.getCode(btcContractAddr);
    if (btcCode === "0x") {
      console.warn("⚠️  KASH_YIELD_BTC_ADDRESS has no contract code — skipping KashYieldBtc (ETH-only or wrong address).");
    } else {
      const kashYieldBtc = await hre.ethers.getContractAt("KashYieldBtc", btcContractAddr);
      let currentSpotDexBtc;
      try {
        currentSpotDexBtc = await kashYieldBtc.spotDexAddress();
      } catch (e) {
        console.warn(
          "⚠️  KashYieldBtc.spotDexAddress() failed (not a KashYieldBtc on this network, or stale address). Skipping BTC spot DEX registration.\n" +
            "   For ETH-only: remove KASH_YIELD_BTC_ADDRESS from .env.\n" +
            `   Detail: ${e.shortMessage || e.message}`
        );
        currentSpotDexBtc = null;
      }
      if (currentSpotDexBtc !== null) {
        await (await kashYieldBtc.setSpotDex(adapterAddress)).wait();
        console.log("✅ setSpotDex on KashYieldBtc →", adapterAddress);
      }
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
