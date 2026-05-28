/**
 * Pull owner-marked vault asset (`ownerWbtcReserve` / `ownerEthReserve`) to the owner wallet.
 * Does not withdraw unreserved vault float that backs user NAV.
 *
 * Max withdraw on-chain: amount <= owner reserve and amount <= vault balance.
 *
 * Usage (run in bot directory)
 *   PRODUCT=btc npm run owner:withdraw-excess-asset
 *   PRODUCT=eth npm run owner:withdraw-excess-asset
 *   PRODUCT=btc npm run owner:withdraw-excess-asset -- --dry-run
 *
 * Optional env (bot/.env):
 *   WITHDRAW_AMOUNT          — cap in human units (wBTC if PRODUCT=btc, ETH if PRODUCT=eth)
 *   WITHDRAW_AMOUNT_WBTC     — btc-only cap (8 decimals), if WITHDRAW_AMOUNT unset
 *   WITHDRAW_AMOUNT_ETH      — eth-only cap (18 decimals), if WITHDRAW_AMOUNT unset
 *   MIN_EXCESS_BASE_UNITS    — skip if withdrawable reserve ≤ this (raw: sats or wei). Default 1
 *   MIN_EXCESS_SATOSHIS      — legacy alias when PRODUCT=btc (same as MIN_EXCESS_BASE_UNITS if set)
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
] as const;

function minExcessBaseUnits(isBtc: boolean): bigint {
  const legacy = (process.env.MIN_EXCESS_SATOSHIS ?? '').trim();
  if (isBtc && legacy && process.env.MIN_EXCESS_BASE_UNITS === undefined) {
    try {
      const n = BigInt(legacy);
      return n >= 0n ? n : 1n;
    } catch {
      /* fall through */
    }
  }
  const raw = (process.env.MIN_EXCESS_BASE_UNITS ?? '1').trim();
  try {
    const n = BigInt(raw);
    return n >= 0n ? n : 1n;
  } catch {
    return 1n;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const isBtc = config.product === 'btc';

  if (config.product !== 'btc' && config.product !== 'eth') {
    throw new Error('Set PRODUCT=btc or PRODUCT=eth in bot/.env');
  }
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not set in .env');
  }
  if (!config.kashYieldAddress) {
    const v =
      config.product === 'btc' ? 'KASH_YIELD_BTC_ADDRESS' : 'KASH_YIELD_ETH_ADDRESS';
    throw new Error(`${v} (or KASH_YIELD_ADDRESS) not set in .env`);
  }

  const assetDecimals = isBtc ? 8 : 18;
  const assetLabel = isBtc ? 'wBTC' : 'ETH';
  const vaultAddr = config.kashYieldAddress;

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(vaultAddr, kashYieldABI, wallet);

  console.log(`Owner withdraw owner ${assetLabel} reserve (KashYield)`);
  console.log('═'.repeat(50));
  console.log(`Product:  ${config.product.toUpperCase()}`);
  console.log(`Contract: ${vaultAddr}`);
  console.log(`Owner wallet: ${wallet.address}`);
  if (dryRun) console.log('(dry-run: no transactions)\n');
  else console.log('');

  const onchainOwner = await kashYield.owner();
  if (String(onchainOwner).toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`PRIVATE_KEY is not contract owner. Owner: ${onchainOwner}`);
  }

  let bal: bigint;
  let reserved: bigint;
  let ownerAssetReserve = 0n;

  if (isBtc) {
    const wbtcAddress: string = await kashYield.wbtcAddress();
    const wbtc = new ethers.Contract(wbtcAddress, ERC20_ABI, provider);
    bal = BigInt((await wbtc.balanceOf(vaultAddr)).toString());
    reserved = BigInt((await kashYield.getReservedBtc()).toString());
    try {
      ownerAssetReserve = BigInt((await kashYield.ownerWbtcReserve()).toString());
    } catch {
      /* older deployment */
    }
  } else {
    bal = BigInt((await provider.getBalance(vaultAddr)).toString());
    reserved = BigInt((await kashYield.getReservedEth()).toString());
    try {
      ownerAssetReserve = BigInt((await kashYield.ownerEthReserve()).toString());
    } catch {
      /* older deployment */
    }
  }

  const maxFromContract =
    ownerAssetReserve > 0n && bal < ownerAssetReserve ? bal : ownerAssetReserve;
  const minDust = minExcessBaseUnits(isBtc);

  const fmt = (v: bigint) =>
    isBtc ? ethers.formatUnits(v, 8) : ethers.formatEther(v);

  console.log(`Vault ${assetLabel} balance: ${fmt(bal)}`);
  console.log(
    `getReserved${isBtc ? 'Btc' : 'Eth'}():       ${fmt(reserved)}`,
  );
  console.log(
    `owner${isBtc ? 'Wbtc' : 'Eth'}Reserve:       ${fmt(ownerAssetReserve)}`,
  );
  console.log(`Withdrawable (cap):     ${fmt(maxFromContract)}`);
  console.log(`MIN_EXCESS_BASE_UNITS:  ${minDust}\n`);

  if (maxFromContract <= 0n) {
    console.log(`No owner ${assetLabel} reserve to withdraw. Nothing to do.`);
    return;
  }

  let amount = maxFromContract;

  const unified = (process.env.WITHDRAW_AMOUNT ?? '').trim();
  const capBtc = (process.env.WITHDRAW_AMOUNT_WBTC ?? '').trim();
  const capEth = (process.env.WITHDRAW_AMOUNT_ETH ?? '').trim();
  const capStr =
    unified ||
    (isBtc ? capBtc : capEth);

  if (capStr) {
    const cap = isBtc
      ? ethers.parseUnits(capStr, 8)
      : ethers.parseEther(capStr);
    if (cap <= 0n) throw new Error('Withdraw cap must be positive');
    amount = cap < maxFromContract ? cap : maxFromContract;
  }

  if (amount < minDust) {
    console.log(`Owner reserve below minimum (${minDust} base units). Skip.`);
    return;
  }

  const fn = isBtc ? 'ownerWithdrawWbtc' : 'ownerWithdrawEth';
  console.log(`→ ${fn}(${fmt(amount)} ${assetLabel})`);
  if (dryRun) {
    console.log('Dry-run: not sending tx.');
    return;
  }

  const tx = isBtc
    ? await kashYield.ownerWithdrawWbtc(amount)
    : await kashYield.ownerWithdrawEth(amount);
  const receipt = await tx.wait();
  console.log(`✅ Confirmed in block ${receipt?.blockNumber}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
