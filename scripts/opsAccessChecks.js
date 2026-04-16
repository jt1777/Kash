// scripts/opsAccessChecks.js
// Shared Hardhat-side checks for KashYield batch ops and HyperliquidAdapter sync.
// No dotenv — safe to require from root scripts and from bot/scripts/ops/_utils.js.

const { ethers } = require("hardhat");

async function assertKashYieldOpsSigner(kashYield, signerAddress) {
  const bot = await kashYield.botAddress();
  const keeper = await kashYield.keeperRegistry();
  const a = String(signerAddress).toLowerCase();
  if (a === String(bot).toLowerCase()) return;
  if (keeper && keeper !== ethers.ZeroAddress && a === String(keeper).toLowerCase()) return;
  throw new Error(
    `Signer ${signerAddress} cannot call KashYield batch ops (botAddress=${bot}, keeperRegistry=${keeper}). ` +
      `Use the bot wallet private key, or configure keeperRegistry to an ops address.`
  );
}

async function assertCanSyncHyperliquidAdapter(adapter, signerAddress) {
  const adapterOwner = await adapter.owner();
  let operator = ethers.ZeroAddress;
  try {
    operator = await adapter.operator();
  } catch {
    // Older bytecode without operator()
  }
  const a = String(signerAddress).toLowerCase();
  if (a === String(adapterOwner).toLowerCase()) return;
  if (operator && operator !== ethers.ZeroAddress && a === String(operator).toLowerCase()) return;
  throw new Error(
    `Signer ${signerAddress} cannot sync this HyperliquidAdapter (owner=${adapterOwner}, operator=${operator}). ` +
      `Use the owner key, or have the owner call setOperator(your bot address) on the adapter.`
  );
}

module.exports = { assertKashYieldOpsSigner, assertCanSyncHyperliquidAdapter };
