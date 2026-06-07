/**
 * Set HyperliquidAdapter directDepositMode + hlAccount (owner key).
 *
 * Bootstrap path when HL contract-master approveAgent is unavailable:
 *   directDepositMode=true, hlAccount=<on-chain bot EOA>
 * HL master = bot EOA (same as KashYield botAddress). No approveAgent — bot signs HL API directly.
 * Set bot/.env PRIVATE_KEY and HYPERLIQUID_API_PRIVATE_KEY to the same bot key.
 *
 * Usage (BTC):
 *   HL_ADAPTER_ADDRESS_BTC=0x... HL_ACCOUNT_ADDRESS=<BOT_ADDRESS> \
 *   npx hardhat run scripts/set-direct-deposit-mode.js --network arbitrumOne
 *
 * Disable bootstrap (production custody):
 *   ENABLED=false HL_ADAPTER_ADDRESS_BTC=0x... \
 *   npx hardhat run scripts/set-direct-deposit-mode.js --network arbitrumOne
 */
require("dotenv").config();

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const adapterAddress =
    process.env.HL_ADAPTER_ADDRESS ||
    process.env.HL_ADAPTER_ADDRESS_BTC ||
    process.env.HL_ADAPTER_ADDRESS_ETH;
  if (!adapterAddress || !ethers.isAddress(adapterAddress)) {
    throw new Error("Set HL_ADAPTER_ADDRESS or HL_ADAPTER_ADDRESS_BTC / _ETH.");
  }

  const enabled = (process.env.ENABLED || "true").toLowerCase() !== "false";
  const hlAccount =
    process.env.HL_ACCOUNT_ADDRESS ||
    process.env.BOT_ADDRESS ||
    process.env.HL_ADAPTER_OPERATOR_ADDRESS ||
    ethers.ZeroAddress;

  if (enabled && (!hlAccount || !ethers.isAddress(hlAccount))) {
    throw new Error("ENABLED=true requires HL_ACCOUNT_ADDRESS or BOT_ADDRESS (on-chain bot EOA).");
  }

  const [signer] = await ethers.getSigners();
  const adapter = await ethers.getContractAt(
    [
      "function setDirectDepositMode(bool enabled, address _hlAccount) external",
      "function directDepositMode() view returns (bool)",
      "function hlAccount() view returns (address)",
      "function owner() view returns (address)",
    ],
    adapterAddress,
    signer,
  );

  const onChainOwner = await adapter.owner();
  if (onChainOwner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not adapter owner (${onChainOwner}).`);
  }

  const targetAccount = enabled ? hlAccount : ethers.ZeroAddress;
  console.log(`\nsetDirectDepositMode on ${adapterAddress}`);
  console.log(`  enabled:   ${enabled}`);
  console.log(`  hlAccount: ${targetAccount}`);

  const tx = await adapter.setDirectDepositMode(enabled, targetAccount);
  const receipt = await tx.wait();
  if (receipt.status !== 1 && receipt.status !== 1n) {
    throw new Error(`setDirectDepositMode reverted (status=${receipt.status})`);
  }

  console.log(`  tx: ${receipt.hash}`);
  console.log(`  directDepositMode = ${await adapter.directDepositMode()}`);
  console.log(`  hlAccount = ${await adapter.hlAccount()}`);
  console.log(
    enabled
      ? "\n✅ Bootstrap mode on. Next: bot/.env — same key for PRIVATE_KEY + HYPERLIQUID_API_PRIVATE_KEY (hlAccount). No approveHlAgent."
      : "\n✅ Custody mode off (adapter is HL account). Wire HL agent via approveHlAgent.js (SIGNER=adapter).",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
