// scripts/deploy-arbitrum-sepolia.js
// Deploys KashYieldETH (constructor: botAddress, weth, usdc). Aave pool is immutable (Arbitrum One mainnet pool).
//
// Networks:
//   - Arbitrum One: use --network arbitrumOne; built-in mainnet WETH/USDC (or WETH_ADDRESS / USDC_ADDRESS).
//   - Arbitrum Sepolia: built-in testnet WETH/USDC defaults (or override via .env).
//
// Prerequisites:
//   - Root .env: PRIVATE_KEY; RPC via hardhat.config (ARBITRUM_ONE_RPC_URL / ARBITRUM_SEPOLIA_RPC_URL).
//   - Funded deployer on the target chain.
//
// Usage:
//   npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
//   npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const network = hre.network.name;
  const isArbitrumOne = network === "arbitrumOne";
  const isArbitrumSepolia = network === "arbitrumSepolia";
  if (!isArbitrumOne && !isArbitrumSepolia) {
    console.warn(`⚠️  Expected arbitrumOne or arbitrumSepolia. You are on: ${network}`);
  }

  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      "No deployer account. Set PRIVATE_KEY in the project root .env file (not in scripts/). " +
      "Run this from repo root: npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne"
    );
  }
  console.log("Deploying to", network);
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    throw new Error(
      isArbitrumOne
        ? "Deployer balance is 0. Fund the wallet with ETH on Arbitrum One."
        : "Deployer balance is 0. Get testnet ETH for Arbitrum Sepolia (e.g. faucet / bridge)."
    );
  }

  const botAddress = process.env.BOT_ADDRESS || deployer.address;

  const DEFAULTS = {
    arbitrumOne: {
      weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    },
    arbitrumSepolia: {
      weth: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
      usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    },
  };
  const networkDefaults = DEFAULTS[network] || DEFAULTS.arbitrumOne;

  const wethAddress = process.env.WETH_ADDRESS || networkDefaults.weth;
  const usdcAddress = process.env.USDC_ADDRESS || networkDefaults.usdc;

  console.log(`Deploying KashYieldETH (bot: ${botAddress}, weth: ${wethAddress}, usdc: ${usdcAddress})...`);
  const KashYieldETH = await hre.ethers.getContractFactory("KashYieldETH");
  const kashYieldEth = await KashYieldETH.deploy(botAddress, wethAddress, usdcAddress);
  await kashYieldEth.waitForDeployment();

  const kashYieldEthAddress = await kashYieldEth.getAddress();
  const kashTokenEthAddress = await kashYieldEth.kashTokenEth();
  console.log("✅ KashYieldETH:", kashYieldEthAddress);
  console.log("✅ KashTokenEth:", kashTokenEthAddress);
  console.log("   Aave pool:  ", await kashYieldEth.aavePoolAddress(), "(hardcoded mainnet)");

  // Optional: register HyperliquidAdapter (first-time bypass is immediate; later registrations timelock).
  const hyperliquidAddress = process.env.HL_ADAPTER_ADDRESS_ETH || "";
  if (hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)) {
    const tx = await kashYieldEth.setHyperliquid(hyperliquidAddress);
    await tx.wait();
    const readyAt = await kashYieldEth.adapterReadyAt("HL");
    const registered = await kashYieldEth.perpExchanges("HL");
    if (registered !== hre.ethers.ZeroAddress && BigInt(readyAt.toString()) === 0n) {
      console.log("✅ HyperliquidAdapter registered immediately (first-time bypass):", registered);
      console.log("   Run scripts/setActivePerpExchange.js (EXCHANGE_NAME=HL) to activate.");
    } else {
      console.log("✅ HyperliquidAdapter proposed. Timelock expires:", new Date(Number(readyAt) * 1000).toISOString());
      console.log("   Step 2: Run scripts/confirmPerpExchange.js (EXCHANGE_NAME=HL) after 48 hours.");
      console.log("   Step 3: Run scripts/setActivePerpExchange.js (EXCHANGE_NAME=HL) to activate.");
    }
  } else if (hyperliquidAddress) {
    console.warn("⚠️  HL_ADAPTER_ADDRESS_ETH env set but invalid; skipping.");
  }

  const fundAmount = process.env.FUND_KASHYIELD_ETH || "0";
  if (fundAmount !== "0") {
    const wei = hre.ethers.parseEther(fundAmount);
    const tx = await deployer.sendTransaction({ to: kashYieldEthAddress, value: wei });
    await tx.wait();
    console.log("✅ Funded KashYieldETH with", fundAmount, "ETH");
  }

  const deploymentTitle = isArbitrumOne ? "ARBITRUM ONE (MAINNET)" : network.toUpperCase();
  console.log("\n====================================");
  console.log("📋 KASHYIELD ETH —", deploymentTitle);
  console.log("====================================");
  console.log("  KashYieldETH:", kashYieldEthAddress);
  console.log("  KashTokenEth:", kashTokenEthAddress);
  console.log("  Aave pool:   ", await kashYieldEth.aavePoolAddress());
  console.log("  USDC:        ", await kashYieldEth.usdcAddress());
  console.log("  Initial NAV: ", hre.ethers.formatEther(await kashYieldEth.currentNAV()), "USD");
  console.log("  Fee (bps):   ", await kashYieldEth.feeBps());
  console.log("  Paused:      ", await kashYieldEth.paused());
  console.log("====================================\n");
  console.log("Add to .env, frontend/.env.local, and private kash-ops repo .env:");
  console.log(`  KASH_YIELD_ETH_ADDRESS=${kashYieldEthAddress}`);
  console.log(`  KASH_TOKEN_ETH=${kashTokenEthAddress}`);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const deploymentInfo = {
    network,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      kashYieldEth: kashYieldEthAddress,
      kashTokenEth: kashTokenEthAddress,
    },
    builtInAddresses: {
      aavePool: await kashYieldEth.aavePoolAddress(),
      weth: await kashYieldEth.wethAddress(),
      usdc: await kashYieldEth.usdcAddress(),
    },
    ...(hyperliquidAddress && hre.ethers.isAddress(hyperliquidAddress)
      ? { hyperliquidAddress }
      : {}),
  };

  const filename = `deployment-${network}-${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));
  console.log("💾 Saved:", filepath);

  console.log("\nVerify on Arbiscan (constructor: bot, weth, usdc):");
  console.log(
    `  npx hardhat verify --network ${network} ${kashYieldEthAddress} ${botAddress} ${wethAddress} ${usdcAddress}`
  );
  console.log("\n✅ Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
