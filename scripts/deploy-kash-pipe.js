/**
 * Deploy a KashPipe (USDC or USDT) against an already-deployed Aster vault.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-kash-pipe.js --network arbitrumOne
 *
 * Required env:
 *   VAULT_ADDRESS          KashVaultEth or KashVaultBtc
 *   ASSET_TOKEN            WETH or wBTC (must equal vault.asset())
 *   SPOT_DEX_ADDRESS       ISpotDex (same adapter the vault uses)
 * Optional:
 *   PIPE_STABLE            USDC (default) or USDT
 *   PIPE_MAX_SLIPPAGE_BPS  ceiling vs quoteExactIn (default 50 USDC / 100 USDT; max 500)
 */
require("dotenv").config();

const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  const vaultAddress = process.env.VAULT_ADDRESS;
  const assetToken = process.env.ASSET_TOKEN || process.env.WETH_ADDRESS || process.env.WBTC_ADDRESS;
  const spotDex = process.env.SPOT_DEX_ADDRESS;
  const stableName = (process.env.PIPE_STABLE || "USDC").toUpperCase();
  if (stableName !== "USDC" && stableName !== "USDT") {
    throw new Error("PIPE_STABLE must be USDC or USDT");
  }

  const defaultSlip = stableName === "USDT" ? "100" : "50";
  const maxSlippageBps = BigInt(process.env.PIPE_MAX_SLIPPAGE_BPS || defaultSlip);

  for (const [label, addr] of [
    ["VAULT_ADDRESS", vaultAddress],
    ["ASSET_TOKEN", assetToken],
    ["SPOT_DEX_ADDRESS", spotDex],
  ]) {
    if (!addr || !hre.ethers.isAddress(addr)) throw new Error(`Set ${label} in .env`);
  }

  const factoryName = stableName === "USDT" ? "KashPipeUsdt" : "KashPipeUsdc";
  const Factory = await hre.ethers.getContractFactory(factoryName);
  const pipe = await Factory.deploy(vaultAddress, assetToken, spotDex, maxSlippageBps);
  await pipe.waitForDeployment();
  const pipeAddr = await pipe.getAddress();

  const isEth = (assetToken || "").toLowerCase() === "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
  const product = isEth ? "ETH" : "BTC";
  const envKey = `NEXT_PUBLIC_KASH_PIPE_${stableName}_${product}`;

  console.log("\n====================================");
  console.log(`KASH PIPE ${stableName} → ${product}`);
  console.log("  Pipe:     ", pipeAddr);
  console.log("  Vault:    ", vaultAddress);
  console.log("  Asset:    ", assetToken);
  console.log("  Spot DEX: ", spotDex);
  console.log("  Slippage: ", maxSlippageBps.toString(), "bps");
  console.log("====================================\n");
  console.log(`  ${envKey}=${pipeAddr}`);
  console.log(`  KASH_PIPE_${stableName}_${product}=${pipeAddr}`);

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const filepath = path.join(
    deploymentsDir,
    `kash-pipe-${stableName.toLowerCase()}-${product.toLowerCase()}-${network}-${Date.now()}.json`,
  );
  fs.writeFileSync(
    filepath,
    JSON.stringify(
      {
        network,
        timestamp: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
          pipe: pipeAddr,
          factory: factoryName,
          vault: vaultAddress,
          assetToken,
          spotDex,
          maxSlippageBps: maxSlippageBps.toString(),
          stable: stableName,
        },
      },
      null,
      2,
    ),
  );
  console.log("Saved:", filepath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
