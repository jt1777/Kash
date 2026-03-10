/**
 * Recover USDC from Hyperliquid spot and repay Aave.
 * Use when USDC was left in HL spot (e.g. after a failed NET_REDEEM at withdrawFromHyperliquid).
 *
 * Usage:
 *   npm run owner:recover-hl-usdc
 *   npm run owner:recover-hl-usdc -- --dry-run
 *
 * Env (bot .env):
 *   PRIVATE_KEY, KASH_YIELD_ADDRESS (or product-specific), RPC/ARBITRUM_SEPOLIA_RPC_URL
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

const USDC_DECIMALS = 6;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env');
  }
  if (!config.kashYieldAddress) {
    throw new Error('KASH_YIELD_ADDRESS (or KASH_YIELD_BTC_ADDRESS etc.) not set in .env');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(
    config.kashYieldAddress,
    kashYieldABI,
    wallet
  );

  console.log('Recover HL USDC to Aave');
  console.log('═'.repeat(50));
  console.log(`Contract: ${config.kashYieldAddress}`);
  console.log(`Caller:   ${wallet.address}`);
  if (dryRun) console.log('(dry-run: no transactions will be sent)\n');
  else console.log('');

  const owner = await kashYield.owner();
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`Caller is not the contract owner. Owner: ${owner}`);
  }
  console.log('Confirmed as owner.\n');

  let hlAddress: string;
  try {
    hlAddress = await kashYield.hyperliquidAddress();
  } catch {
    hlAddress = ethers.ZeroAddress;
  }
  if (!hlAddress || hlAddress === ethers.ZeroAddress) {
    throw new Error('Hyperliquid address not set on contract. Nothing to recover.');
  }

  const spotBalance = await kashYield.getHyperliquidSpotBalance();
  if (spotBalance === 0n) {
    console.log('HL spot USDC balance is 0. Nothing to recover.');
    console.log('(getHyperliquidSpotBalance only returns USDC. If owner-status shows wBTC in HL spot, run Step 1 first: from repo root, npx hardhat run scripts/ownerSellHlWbtc.js --network arbitrumSepolia)');
    return;
  }

  const usdcAddress = await kashYield.usdcAddress();
  console.log(`HL spot balance: ${ethers.formatUnits(spotBalance, USDC_DECIMALS)} USDC`);
  console.log(`USDC address:    ${usdcAddress}`);
  console.log('');
  console.log('Planned:');
  console.log('  1. withdrawFromHyperliquid(' + spotBalance.toString() + ')');
  console.log('  2. repayToAave(' + usdcAddress + ', ' + spotBalance.toString() + ')');
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Run without --dry-run to execute.');
    return;
  }

  console.log('Sending withdrawFromHyperliquid...');
  const tx1 = await kashYield.withdrawFromHyperliquid(spotBalance);
  await tx1.wait();
  console.log('  Done. USDC is now in the contract.\n');

  console.log('Sending repayToAave...');
  const tx2 = await kashYield.repayToAave(usdcAddress, spotBalance);
  await tx2.wait();
  console.log('  Done. USDC repaid to Aave.\n');

  console.log('Recovery complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
