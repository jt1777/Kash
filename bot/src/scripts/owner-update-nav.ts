/**
 * Compute and optionally submit a NAV-only update.
 *
 * This script does not run phase1, ops, mark-done, or phase2. It only calls
 * `updateNAV(newNAV, hlUsdcBalance, hlAssetBalance, 0)` unless `--dry-run` is set.
 *
 * Usage:
 *   PRODUCT=btc npm run owner:update-nav -- --dry-run
 *   PRODUCT=btc npm run owner:update-nav
 *   PRODUCT=btc npm run owner:update-nav:hourly
 *
 * Cron safety:
 *   By default the script skips writes when the current batch is not phase 0 or
 *   the contract is outside the user window, and within 15 minutes before the
 *   processing window. Use --force or NAV_UPDATE_FORCE=true only for manual recovery.
 *
 * Optional recovery override:
 *   HL_NAV_USDC=28.390088   # override HL equity/account value used for NAV
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { kashYieldABI } from '../contracts/kashYieldABI';
import {
  getAaveBorrowedAmountV3,
  getAaveSuppliedAmountV3,
  readHyperliquidAdapterAddress,
} from '../batch/opsContext';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
] as const;

const INITIAL_NAV = 10n ** 18n;

function shouldForceUpdate(): boolean {
  return process.argv.includes('--force') || process.env.NAV_UPDATE_FORCE === 'true';
}

function navUpdateProcessingBufferSeconds(): bigint {
  const raw = process.env.NAV_UPDATE_PROCESSING_BUFFER_SECONDS ?? '900';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 900n;
  return BigInt(parsed);
}

function hlNavUsdcOverride(): bigint | null {
  const raw = (process.env.HL_NAV_USDC || '').trim();
  if (!raw) return null;
  return decimalStringToUsdc6(raw);
}

function decimalStringToUsdc6(value: unknown): bigint {
  const raw = String(value ?? '0').trim();
  if (!raw || raw === '0') return 0n;
  const neg = raw.startsWith('-');
  const unsigned = neg ? raw.slice(1) : raw;
  const [wholeRaw, fracRaw = ''] = unsigned.split('.');
  const whole = wholeRaw || '0';
  const frac = fracRaw.slice(0, 6).padEnd(6, '0');
  const parsed = BigInt(whole) * 1_000_000n + BigInt(frac || '0');
  return neg ? -parsed : parsed;
}

async function getOwnerAssetReserve(kashYield: ethers.Contract, isBtc: boolean): Promise<bigint> {
  try {
    return isBtc
      ? BigInt((await kashYield.ownerWbtcReserve()).toString())
      : BigInt((await kashYield.ownerEthReserve()).toString());
  } catch {
    return 0n;
  }
}

async function getOwnerUsdcReserve(kashYield: ethers.Contract): Promise<bigint> {
  try {
    return BigInt((await kashYield.ownerUsdcReserve()).toString());
  } catch {
    return 0n;
  }
}

async function getContractUsdc(kashYield: ethers.Contract, provider: ethers.Provider, vaultAddr: string): Promise<bigint> {
  try {
    const usdcAddr = await kashYield.usdcAddress();
    const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
    const raw = BigInt((await usdc.balanceOf(vaultAddr)).toString());
    const reserve = await getOwnerUsdcReserve(kashYield);
    return raw > reserve ? raw - reserve : 0n;
  } catch {
    return 0n;
  }
}

type HlNavRead = {
  value: bigint;
  adapterAddr: string;
  hlUser: string;
  spotUsdc: bigint;
  withdrawable: bigint;
  accountValue: bigint;
  rawMarginSummary: unknown;
  rawCrossMarginSummary: unknown;
};

async function getHyperliquidNavUsdcBalance(kashYield: ethers.Contract, provider: ethers.Provider): Promise<HlNavRead> {
  const fallback = BigInt((await kashYield.getHyperliquidSpotBalance().catch(() => 0n)).toString());
  const empty = {
    value: fallback,
    adapterAddr: '',
    hlUser: '',
    spotUsdc: fallback,
    withdrawable: 0n,
    accountValue: 0n,
    rawMarginSummary: null,
    rawCrossMarginSummary: null,
  };
  try {
    const activePerpExchange = await kashYield.activePerpExchange().catch(() => '');
    const adapterAddr = await readHyperliquidAdapterAddress(kashYield, activePerpExchange);
    if (!adapterAddr || adapterAddr === ethers.ZeroAddress) return empty;

    const adapter = new ethers.Contract(
      adapterAddr,
      ['function hlAccount() view returns (address)'],
      provider,
    );
    let hlUser = await adapter.hlAccount().catch(() => '');
    if (!hlUser || hlUser === ethers.ZeroAddress) {
      const pk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
      if (!pk) return { ...empty, adapterAddr };
      hlUser = new ethers.Wallet(pk).address;
    }

    const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
    const hlApiUrl = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
    const info = new InfoClient({ transport: new HttpTransport({ apiUrl: hlApiUrl }) });
    const ch: any = await info.clearinghouseState({ user: hlUser });
    const spot = await info.spotClearinghouseState({ user: hlUser }).catch(() => ({ balances: [] }));
    const spotUsdc = decimalStringToUsdc6(
      (spot?.balances || []).find((b: any) => String(b?.coin || '').toUpperCase() === 'USDC')?.total || '0',
    );
    const withdrawable = decimalStringToUsdc6(ch?.withdrawable || '0');
    const accountValue = decimalStringToUsdc6(
      ch?.marginSummary?.accountValue ?? ch?.crossMarginSummary?.accountValue ?? '0',
    );
    // Do not add spot + accountValue: for this direct-HL setup the HL UI's USDC
    // figure is represented by one account view, not the sum of spot and perp equity.
    // Use the largest single read so we do not double-count collateral.
    let value = fallback;
    if (spotUsdc > value) value = spotUsdc;
    if (withdrawable > value) value = withdrawable;
    if (accountValue > value) value = accountValue;
    return {
      value,
      adapterAddr,
      hlUser,
      spotUsdc,
      withdrawable,
      accountValue,
      rawMarginSummary: ch?.marginSummary ?? null,
      rawCrossMarginSummary: ch?.crossMarginSummary ?? null,
    };
  } catch {
    return empty;
  }
}

async function getPendingMintUsdGross(
  kashYield: ethers.Contract,
  price: bigint,
  assetDecimals: bigint,
  isBtc: boolean,
): Promise<bigint> {
  const currentCycle = BigInt((await kashYield.getCurrentBatchCycle()).toString());
  let sum = 0n;
  for (let i = 0n; i <= 10n; i++) {
    if (i > currentCycle) break;
    const cycle = currentCycle - i;
    const processed = await kashYield.batchProcessed(cycle);
    if (processed) continue;

    const info = await kashYield.getBatchInfo(cycle);
    let totalMintUsd = BigInt(info.totalMintUSD.toString());
    if (totalMintUsd === 0n) {
      const totalMintAsset = isBtc
        ? BigInt((await kashYield.batchTotalMintBtc(cycle)).toString())
        : BigInt((await kashYield.batchTotalMintEth(cycle)).toString());
      totalMintUsd = (totalMintAsset * price) / (10n ** assetDecimals);
    }
    sum += totalMintUsd;
  }
  return sum;
}

async function checkNavUpdateSafety(
  provider: ethers.Provider,
  kashYield: ethers.Contract,
  dryRun: boolean,
  force: boolean,
): Promise<boolean> {
  const currentCycle = BigInt((await kashYield.getCurrentBatchCycle()).toString());
  const phase = Number(await kashYield.batchPhase(currentCycle));
  const cycleDuration = BigInt((await kashYield.cycleDurationSeconds()).toString());
  const processingWindowStart = BigInt((await kashYield.processingWindowStart().catch(() => cycleDuration)).toString());
  const latestBlock = await provider.getBlock('latest');
  const secondsIntoCycle = cycleDuration > 0n && latestBlock
    ? BigInt(latestBlock.timestamp) % cycleDuration
    : 0n;
  const secondsUntilProcessing = processingWindowStart >= secondsIntoCycle
    ? processingWindowStart - secondsIntoCycle
    : cycleDuration - secondsIntoCycle + processingWindowStart;
  const processingBufferSeconds = navUpdateProcessingBufferSeconds();
  const [isUserWindow, isProcessingWindow] = await Promise.all([
    kashYield.isUserWindow().catch(() => false),
    kashYield.isProcessingWindow().catch(() => false),
  ]);

  console.log(`Batch cycle: ${currentCycle.toString()}`);
  console.log(`Batch phase: ${phase}`);
  console.log(`User window: ${isUserWindow ? 'yes' : 'no'}`);
  console.log(`Processing window: ${isProcessingWindow ? 'yes' : 'no'}`);
  console.log(`Seconds until processing: ${secondsUntilProcessing.toString()} (buffer ${processingBufferSeconds.toString()})`);

  const unsafeReason =
    phase !== 0
      ? `current batch is phase ${phase}, so batch processing owns currentNAV`
      : isProcessingWindow
        ? 'processing window is active'
        : !isUserWindow
          ? 'user window is closed'
          : secondsUntilProcessing <= processingBufferSeconds
            ? `processing window starts in ${secondsUntilProcessing.toString()} seconds`
          : '';

  if (!unsafeReason) return true;

  const message = `Skipping NAV update: ${unsafeReason}.`;
  if (force) {
    console.warn(`⚠️  ${message} Continuing because --force/NAV_UPDATE_FORCE is set.`);
    return true;
  }
  if (dryRun) {
    console.warn(`⚠️  ${message} Dry-run will continue without sending a transaction.`);
    return true;
  }

  console.log(`\n${message}`);
  console.log('Use --force or NAV_UPDATE_FORCE=true only for manual recovery.');
  return false;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = shouldForceUpdate();
  const isBtc = config.product === 'btc';
  const vaultAddr = config.kashYieldAddress;
  if (!vaultAddr || !ethers.isAddress(vaultAddr)) {
    throw new Error(`Invalid vault address for PRODUCT=${config.product}. Check KASH_YIELD_* in bot/.env.`);
  }
  if (!config.privateKey) throw new Error('PRIVATE_KEY not set in bot/.env');

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const kashYield = new ethers.Contract(vaultAddr, kashYieldABI, wallet);
  const canUpdate = await checkNavUpdateSafety(provider, kashYield, dryRun, force);
  if (!canUpdate) return;

  const assetDecimals = isBtc ? 8n : 18n;
  const assetLabel = isBtc ? 'BTC' : 'ETH';
  const price = BigInt((await (isBtc ? kashYield.getBtcPrice() : kashYield.getEthPrice())).toString());

  const tokenAddr = await (isBtc ? kashYield.kashTokenBtc() : kashYield.kashTokenEth());
  const kashToken = new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], provider);
  const supply = BigInt((await kashToken.totalSupply()).toString());

  let contractAsset = 0n;
  if (isBtc) {
    const wbtcAddr = await kashYield.wbtcAddress();
    const wbtc = new ethers.Contract(wbtcAddr, ERC20_ABI, provider);
    contractAsset = BigInt((await wbtc.balanceOf(vaultAddr)).toString());
  } else {
    contractAsset = BigInt((await provider.getBalance(vaultAddr)).toString());
  }
  const ownerAssetReserve = await getOwnerAssetReserve(kashYield, isBtc);
  contractAsset = contractAsset > ownerAssetReserve ? contractAsset - ownerAssetReserve : 0n;

  const aaveUser = config.aaveUserAddress || vaultAddr;
  const poolAddr = await kashYield.aavePoolAddress().catch(() => '');
  let aaveSupplied = 0n;
  if (poolAddr && poolAddr !== ethers.ZeroAddress) {
    const reserveAsset = isBtc
      ? await kashYield.wbtcAddress().catch(() => ethers.ZeroAddress)
      : await kashYield.wethAddress?.().catch(() => ethers.ZeroAddress) ?? ethers.ZeroAddress;
    aaveSupplied = await getAaveSuppliedAmountV3(provider, poolAddr, reserveAsset, aaveUser);
  }
  const aaveDebt = await getAaveBorrowedAmountV3(provider, poolAddr, config.aaveUsdcAddress, aaveUser).catch(() => 0n);

  const hlAsset = BigInt((await kashYield.getExchangeAssetBalance().catch(() => 0n)).toString());
  const contractUsdc = await getContractUsdc(kashYield, provider, vaultAddr);
  const hlNavRead = await getHyperliquidNavUsdcBalance(kashYield, provider);
  const hlNavUsdcAuto = hlNavRead.value;
  const hlNavOverride = hlNavUsdcOverride();
  const hlNavUsdc = hlNavOverride ?? hlNavUsdcAuto;
  const hlSpotForUpdate = BigInt((await kashYield.getHyperliquidSpotBalance().catch(() => 0n)).toString());
  const hlAssetForUpdate = hlAsset;
  const pendingMintUsdGross = await getPendingMintUsdGross(kashYield, price, assetDecimals, isBtc);

  const totalAsset = contractAsset + aaveSupplied + hlAsset;
  const assetUsd = (totalAsset * price) / (10n ** assetDecimals);
  const netUsdc = contractUsdc + hlNavUsdc - aaveDebt;
  const netUsdcUsd = netUsdc * 10n ** 12n;
  let portfolioUsd = assetUsd + netUsdcUsd;
  portfolioUsd = portfolioUsd > pendingMintUsdGross ? portfolioUsd - pendingMintUsdGross : 0n;
  const newNav = supply === 0n ? INITIAL_NAV : (portfolioUsd * 10n ** 18n) / supply || 1n;

  console.log('\nNAV-only update');
  console.log('═'.repeat(50));
  console.log(`Product:  ${config.product.toUpperCase()}`);
  console.log(`Contract: ${vaultAddr}`);
  console.log(`Wallet:   ${wallet.address}`);
  console.log(dryRun ? '(dry-run: no transaction will be sent)\n' : '');
  console.log(`KASH supply:              ${ethers.formatEther(supply)}`);
  console.log(`Asset total:              ${ethers.formatUnits(totalAsset, Number(assetDecimals))} ${assetLabel}`);
  console.log(`Asset USD:                $${ethers.formatEther(assetUsd)}`);
  console.log(`Contract USDC (adj.):     ${ethers.formatUnits(contractUsdc, 6)} USDC`);
  console.log(`HL NAV USDC/equity:       ${ethers.formatUnits(hlNavUsdc, 6)} USDC${hlNavOverride != null ? ` (override; auto=${ethers.formatUnits(hlNavUsdcAuto, 6)} USDC)` : ''}`);
  console.log(`  HL adapter:              ${hlNavRead.adapterAddr || '(not resolved)'}`);
  console.log(`  HL user:                 ${hlNavRead.hlUser || '(not resolved)'}`);
  console.log(`  HL spot USDC:            ${ethers.formatUnits(hlNavRead.spotUsdc, 6)} USDC`);
  console.log(`  HL withdrawable:         ${ethers.formatUnits(hlNavRead.withdrawable, 6)} USDC`);
  console.log(`  HL account value:        ${ethers.formatUnits(hlNavRead.accountValue, 6)} USDC`);
  console.log(`Aave debt:                ${ethers.formatUnits(aaveDebt, 6)} USDC`);
  console.log(`Pending mint excluded:    $${ethers.formatEther(pendingMintUsdGross)} (gross; protocol mint fee is owner reserve)`);
  console.log(`Portfolio USD for NAV:    $${ethers.formatEther(portfolioUsd)}`);
  console.log(`Computed NAV:             $${ethers.formatEther(newNav)} per KASH`);
  console.log(`updateNAV usdcBalance arg: ${ethers.formatUnits(hlSpotForUpdate, 6)} USDC`);
  console.log(`updateNAV assetBalance arg: ${ethers.formatUnits(hlAssetForUpdate, Number(assetDecimals))} ${assetLabel}`);

  if (dryRun) return;

  const tx = await kashYield.updateNAV(newNav, hlSpotForUpdate, hlAssetForUpdate, 0n);
  console.log(`\nSent updateNAV tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ owner:update-nav failed:', err?.message ?? err);
    process.exit(1);
  });
