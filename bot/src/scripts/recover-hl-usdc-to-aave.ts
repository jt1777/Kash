/**
 * Recover USDC from Hyperliquid spot and repay Aave (only if there is USDC debt).
 * Use when USDC was left in HL spot (e.g. after a failed NET_REDEEM at withdrawFromHyperliquid).
 *
 * If Aave borrowed USDC is already zero, step 2 is skipped — repaying with no debt reverts on Aave.
 * Withdrawn USDC stays on KashYield for ops or ownerWithdraw / depositToAave as you prefer.
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
import { getAaveBorrowedAmountV3, readHyperliquidAdapterAddress } from '../batch/opsContext';

const USDC_DECIMALS = 6;

const ERC20_BALANCE_ABI = [
  'function balanceOf(address account) view returns (uint256)',
] as const;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env');
  }
  if (!config.kashYieldAddress) {
    const v = config.product === 'btc' ? 'KASH_YIELD_BTC_ADDRESS' : 'KASH_YIELD_ETH_ADDRESS';
    throw new Error(`${v} (or KASH_YIELD_ADDRESS) not set in .env`);
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

  const hlAddress = await readHyperliquidAdapterAddress(kashYield);
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
  const aavePoolAddress = await kashYield.aavePoolAddress();
  let aaveDebt = await getAaveBorrowedAmountV3(
    provider,
    aavePoolAddress,
    usdcAddress,
    config.kashYieldAddress!,
  );

  console.log(`HL spot balance: ${ethers.formatUnits(spotBalance, USDC_DECIMALS)} USDC`);
  console.log(`USDC address:    ${usdcAddress}`);
  console.log(`Aave USDC debt:  ${ethers.formatUnits(aaveDebt, USDC_DECIMALS)} USDC`);
  console.log('');
  console.log('Planned:');
  console.log(`  1. withdrawFromHyperliquid(${spotBalance.toString()})`);
  if (aaveDebt === 0n) {
    console.log('  2. (skip repay — no Aave USDC debt; repaying would revert on Aave)');
  } else {
    console.log(`  2. repayToAave — up to ${ethers.formatUnits(aaveDebt, USDC_DECIMALS)} USDC (min(debt, balance after withdraw); MAX when balance covers debt)`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry-run complete. Run without --dry-run to execute.');
    return;
  }

  console.log('Sending withdrawFromHyperliquid...');
  const tx1 = await kashYield.withdrawFromHyperliquid(spotBalance);
  await tx1.wait();
  console.log('  Done. If USDC did not land yet (HL bridge), wait and check contract USDC balance.\n');

  aaveDebt = await getAaveBorrowedAmountV3(
    provider,
    aavePoolAddress,
    usdcAddress,
    config.kashYieldAddress!,
  );

  if (aaveDebt === 0n) {
    const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
    const onContract = await usdc.balanceOf(config.kashYieldAddress!);
    console.log(
      `No Aave USDC debt — skipped repay. KashYield USDC balance: ${ethers.formatUnits(onContract, USDC_DECIMALS)} USDC`,
    );
    console.log(
      'You can leave it as idle USDC, run depositToAave from ops, or transfer out via an owner flow if your product supports it.',
    );
    console.log('\nRecovery complete (withdraw only).');
    return;
  }

  const usdc = new ethers.Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
  const contractUsdc = await usdc.balanceOf(config.kashYieldAddress!);
  if (contractUsdc === 0n) {
    console.log(
      'Aave has debt but KashYield has 0 USDC after withdraw — bridge/settlement may be pending. Retry this script later.',
    );
    return;
  }

  const repayAmount =
    contractUsdc >= aaveDebt ? ethers.MaxUint256 : contractUsdc;
  const repayLabel =
    repayAmount === ethers.MaxUint256
      ? `full debt (~${ethers.formatUnits(aaveDebt, USDC_DECIMALS)} USDC, using MAX)`
      : ethers.formatUnits(repayAmount, USDC_DECIMALS) + ' USDC';

  console.log(`Sending repayToAave (${repayLabel})...`);
  const tx2 = await kashYield.repayToAave(usdcAddress, repayAmount);
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
