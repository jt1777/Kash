import { ethers } from 'ethers';
import { config } from '../config';
import { strategyRedeemFractionPure } from './strategyRedeemFraction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpsContext {
  /** Contract references (used by step executors) */
  kashYield: ethers.Contract;
  provider: ethers.Provider;
  /** Bot wallet — sole on-chain signer for KashYield, adapter sync, and direct HL bridge transfers. */
  signer: ethers.Signer;

  /**
   * Contract wallet balances at snapshot time, **after** subtracting owner cushions:
   * `ownerUsdcReserve` and `ownerEthReserve` / `ownerWbtcReserve` (treasury / gas buffers
   * not counted toward user NAV in the contracts). Raw on-chain balances are not stored here.
   */
  contractAsset: bigint;   // ETH (18 dec) or wBTC (8 dec)
  contractUsdc: bigint;    // USDC 6 dec

  /** Aave position (principal + accrued interest, from getUserAccountData or variable debt token) */
  aaveSupplied: bigint;    // ETH (18 dec) or wBTC (8 dec)
  aaveDebt: bigint;        // USDC 6 dec
  /** Optional debt floor to preserve for partial strategy unwinds; repay only debt above this. */
  aaveDebtFloor?: bigint;  // USDC 6 dec
  /**
   * Pre-batch HL short (18-dec internal) for this redeem ops run — set once at engine entry so
   * re-runs do not apply `strategyRedeemFraction` to an already-reduced short.
   */
  redeemInitialShortInternal18?: bigint;

  /** Hyperliquid balances */
  hlUsdcBalance: bigint;   // USDC 6 dec (spot wallet)
  /** USDC ERC-20 physically held by the HL adapter on L2. May be nonzero while `hlUsdcBalance` is 0 after sync (bridge delivered, HL API spot is 0). */
  adapterUsdcErc20: bigint;
  hlAssetBalance: bigint;  // ETH (18 dec) or wBTC (8 dec) — spot position (0 in USDC-collateral model)
  shortSize: bigint;       // perp size from adapter getPosition (18-dec internal; see HyperliquidAdapter)
  shortIsActive: boolean;
  activePerpExchange: string; // e.g. "HL"
  perpAdapterAddress: string;
  hlDirectDepositMode: boolean;
  hlAccountAddress: string;
  hlBridgeAddress: string;
  hlEventRelayEnabled: boolean; // env gate for off-chain HL execution path

  /** Redemption accounting */
  batchCycle: bigint;
  /** Gross: batchTotalRedeemKash / totalSupply — share of all KASH being redeemed (logging). */
  redeemFraction: bigint; // 18 dec; 1e18 = 100%
  /**
   * Strategy unwind: max(0, redeemKash − estMintKash) / totalSupply when batch has minters;
   * else equals redeemFraction. Used for HL partial close and proportional Aave release.
   */
  strategyRedeemFraction: bigint;
  totalRedeemAsset: bigint;  // ETH/wBTC owed to all redeemers (at lockedNAV)

  /** Prices / product */
  price: bigint;             // 18 dec USD per asset
  isBtc: boolean;
  assetDecimals: bigint;     // 18n for ETH, 8n for wBTC
  assetSymbol: string;       // 'ETH' or 'BTC'

  /** Pre-ops locked NAV (undefined when running --step=ops manually without --locked-nav) */
  lockedNAV: bigint | undefined;

  /** Token addresses (cached to avoid repeat calls in steps) */
  usdcAddress: string;
  aavePoolAddress: string;
  aaveUsdcAddress: string;
}

// ---------------------------------------------------------------------------
// Aave debt reading — real Aave V3 compatible
// ---------------------------------------------------------------------------

/**
 * Read outstanding USDC debt from Aave including accrued interest.
 *
 * Strategy (in order):
 * 1. Mock-style getBorrowedAmount(user) — direct USDC 6 dec (mock / test compat).
 * 2. Read USDC variableDebtToken.balanceOf(user) via pool.getReserveData (real Aave V3,
 *    most accurate — rebasing token includes all interest automatically).
 * 3. pool.getUserAccountData(user).totalDebtBase / 100 — real Aave V3 fallback.
 *    totalDebtBase is USD with 8 dec; dividing by 100 gives USDC 6 dec (assuming $1 peg).
 */
export async function getAaveBorrowedAmountV3(
  provider: ethers.Provider,
  poolAddr: string,
  usdcAddr: string,
  userAddr: string,
): Promise<bigint> {
  if (!poolAddr || poolAddr === ethers.ZeroAddress) return 0n;

  // 1. Mock compatibility: getBorrowedAmount returns USDC 6 dec directly
  try {
    const pool = new ethers.Contract(
      poolAddr,
      ['function getBorrowedAmount(address) view returns (uint256)'],
      provider,
    );
    return BigInt((await pool.getBorrowedAmount(userAddr)).toString());
  } catch { /* not mock — continue */ }

  // 2. Real Aave V3: variable debt token balance (most accurate)
  try {
    const pool = new ethers.Contract(
      poolAddr,
      ['function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))'],
      provider,
    );
    const reserveData = await pool.getReserveData(usdcAddr);
    const variableDebtTokenAddr: string = reserveData.variableDebtTokenAddress;
    if (variableDebtTokenAddr && variableDebtTokenAddr !== ethers.ZeroAddress) {
      const debtToken = new ethers.Contract(
        variableDebtTokenAddr,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      return BigInt((await debtToken.balanceOf(userAddr)).toString());
    }
  } catch { /* continue to fallback */ }

  // 3. Real Aave V3 fallback: getUserAccountData — totalDebtBase is USD 8 dec
  try {
    const pool = new ethers.Contract(
      poolAddr,
      ['function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256, uint256, uint256, uint256)'],
      provider,
    );
    const data = await pool.getUserAccountData(userAddr);
    const totalDebtBase = BigInt(data.totalDebtBase.toString());
    // USD 8 dec → USDC 6 dec: divide by 10^(8-6) = 100 (valid while USDC ≈ $1)
    return totalDebtBase / 100n;
  } catch { return 0n; }
}

/**
 * Read Aave supplied collateral balance (aToken balance, includes yield).
 *
 * Strategy (in order):
 * 1. Mock-style getATokenBalance(asset, user) on pool.
 * 2. Real Aave V3: aToken.balanceOf(user) via pool.getReserveData.
 */
export async function getAaveSuppliedAmountV3(
  provider: ethers.Provider,
  poolAddr: string,
  assetAddr: string,      // wETH address (or address(0) for native ETH)
  userAddr: string,
): Promise<bigint> {
  if (!poolAddr || poolAddr === ethers.ZeroAddress) return 0n;

  // 1. Mock path
  try {
    const pool = new ethers.Contract(
      poolAddr,
      ['function getATokenBalance(address asset, address user) view returns (uint256)'],
      provider,
    );
    return BigInt((await pool.getATokenBalance(assetAddr, userAddr)).toString());
  } catch { /* not mock */ }

  // 2. Real Aave V3: read via getReserveData → aTokenAddress → balanceOf
  // For native ETH positions, we must use the WETH address as the Aave reserve key.
  try {
    const pool = new ethers.Contract(
      poolAddr,
      ['function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))'],
      provider,
    );
    const reserveData = await pool.getReserveData(assetAddr);
    const aTokenAddr: string = reserveData.aTokenAddress;
    if (aTokenAddr && aTokenAddr !== ethers.ZeroAddress) {
      const aToken = new ethers.Contract(
        aTokenAddr,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      return BigInt((await aToken.balanceOf(userAddr)).toString());
    }
  } catch { return 0n; }

  return 0n;
}

// ---------------------------------------------------------------------------
// Total redeem asset computation — canonical formula (shared with mark-done)
// ---------------------------------------------------------------------------

/**
 * Compute total asset (ETH or wBTC) consumed by pending redeems in the given batch cycle.
 * This is the gross KASH claim: redeemer payout plus protocol fee retained as owner reserve.
 * This is the single authoritative formula used by:
 *   - snapshotOpsContext (to populate ctx.totalRedeemAsset)
 *   - runStepMarkDone preflight gate
 *   - 11b swap sizing (how much USDC to swap for the asset shortfall)
 */
export async function computeTotalRedeemAsset(
  kashYield: ethers.Contract,
  batchCycle: bigint,
  lockedNAV: bigint | undefined,
  price: bigint,
  assetDecimals: bigint,
): Promise<bigint> {
  const nav = lockedNAV ?? BigInt((await kashYield.currentNAV()).toString());
  const info = await kashYield.getBatchInfo(batchCycle);
  const redeemUsersCount = BigInt(info.redeemUsersCount.toString());
  if (redeemUsersCount === 0n) return 0n;

  let total = 0n;
  for (let i = 0n; i < redeemUsersCount; i++) {
    // Solidity's public getter for `mapping(uint256 => address[])` is indexed:
    // batchRedeemUsers(batchCycle, index), not batchRedeemUsers(batchCycle) -> address[].
    const addr: string = await kashYield.batchRedeemUsers(batchCycle, i);
    const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
    const kashAmt = BigInt(req.kashAmount.toString());
    if (kashAmt === 0n) continue;
    const usdValue = (kashAmt * nav) / (10n ** 18n);
    total += (usdValue * (10n ** assetDecimals)) / price;
  }
  return total;
}

/** Sum mint protocol fees (asset units) for a batch — matches Phase 2 `totalMintFee*`. */
export async function computeBatchMintFeeAsset(
  kashYield: ethers.Contract,
  batchCycle: bigint,
): Promise<bigint> {
  const info = await kashYield.getBatchInfo(batchCycle);
  const mintUsersCount = BigInt(info.mintUsersCount.toString());
  if (mintUsersCount === 0n) return 0n;
  const feeBps = BigInt((await kashYield.feeBps()).toString());
  let total = 0n;
  for (let i = 0n; i < mintUsersCount; i++) {
    const addr: string = await kashYield.batchMintUsers(batchCycle, i);
    const req = await kashYield.getPendingMintRequest(addr, batchCycle);
    const amountIn = BigInt(req.amountIn.toString());
    if (amountIn === 0n) continue;
    total += (amountIn * feeBps) / 10000n;
  }
  return total;
}

/**
 * Phase 2 balance gate using on-chain locked gross redeem G (Phase-1 NAV sizing).
 * Required vault asset = ownerReserve + mintProtocolFees + G.
 * `toleranceAsset` adds slack on the vault side (few sats / wei) for rounding and oracle noise.
 */
export async function vaultCoversRedeemPayoutFromGross(
  kashYield: ethers.Contract,
  provider: ethers.Provider,
  batchCycle: bigint,
  grossRedeemAsset: bigint,
  isBtc: boolean,
  toleranceAsset: bigint = config.markDonePayoutToleranceAsset,
): Promise<{
  covers: boolean;
  grossRedeemAsset: bigint;
  mintFeeAsset: bigint;
  contractBalance: bigint;
  required: bigint;
  ownerAssetReserve: bigint;
  toleranceAsset: bigint;
  shortfall: bigint;
}> {
  if (grossRedeemAsset === 0n) {
    return {
      covers: true,
      grossRedeemAsset: 0n,
      mintFeeAsset: 0n,
      contractBalance: 0n,
      required: 0n,
      ownerAssetReserve: 0n,
      toleranceAsset,
      shortfall: 0n,
    };
  }

  const mintFeeAsset = await computeBatchMintFeeAsset(kashYield, batchCycle);
  const contractAddr = await kashYield.getAddress();
  let contractBalance = 0n;
  let ownerAssetReserve = 0n;
  if (isBtc) {
    try {
      const wbtcAddr: string = await kashYield.wbtcAddress();
      const wbtc = new ethers.Contract(
        wbtcAddr,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      contractBalance = BigInt((await wbtc.balanceOf(contractAddr)).toString());
      ownerAssetReserve = BigInt((await kashYield.ownerWbtcReserve()).toString());
    } catch {
      contractBalance = 0n;
    }
  } else {
    contractBalance = BigInt((await provider.getBalance(contractAddr)).toString());
    try {
      ownerAssetReserve = BigInt((await kashYield.ownerEthReserve()).toString());
    } catch {
      ownerAssetReserve = 0n;
    }
  }

  const required = ownerAssetReserve + mintFeeAsset + grossRedeemAsset;
  const shortfall = required > contractBalance ? required - contractBalance : 0n;
  return {
    covers: contractBalance + toleranceAsset >= required,
    grossRedeemAsset,
    mintFeeAsset,
    contractBalance,
    required,
    ownerAssetReserve,
    toleranceAsset,
    shortfall,
  };
}

/** Same balance gate as `runStepMarkDone` / Phase 2 `InsufficientWbtcForRedeems`. */
export async function vaultCoversRedeemPayout(
  kashYield: ethers.Contract,
  provider: ethers.Provider,
  batchCycle: bigint,
  lockedNAV: bigint | undefined,
  isBtc: boolean,
): Promise<{
  covers: boolean;
  totalRedeemAsset: bigint;
  contractBalance: bigint;
  required: bigint;
  ownerAssetReserve: bigint;
}> {
  const assetDecimals = isBtc ? 8n : 18n;
  const price = isBtc
    ? BigInt((await kashYield.getBtcPrice()).toString())
    : BigInt((await kashYield.getEthPrice()).toString());
  const totalRedeemAsset = await computeTotalRedeemAsset(
    kashYield,
    batchCycle,
    lockedNAV,
    price,
    assetDecimals,
  );
  if (totalRedeemAsset === 0n) {
    return {
      covers: true,
      totalRedeemAsset: 0n,
      contractBalance: 0n,
      required: 0n,
      ownerAssetReserve: 0n,
    };
  }

  const contractAddr = await kashYield.getAddress();
  let contractBalance = 0n;
  let ownerAssetReserve = 0n;
  if (isBtc) {
    try {
      const wbtcAddr: string = await kashYield.wbtcAddress();
      const wbtc = new ethers.Contract(
        wbtcAddr,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      contractBalance = BigInt((await wbtc.balanceOf(contractAddr)).toString());
      ownerAssetReserve = BigInt((await kashYield.ownerWbtcReserve()).toString());
    } catch {
      contractBalance = 0n;
    }
  } else {
    contractBalance = BigInt((await provider.getBalance(contractAddr)).toString());
    try {
      ownerAssetReserve = BigInt((await kashYield.ownerEthReserve()).toString());
    } catch {
      ownerAssetReserve = 0n;
    }
  }

  const required = totalRedeemAsset + ownerAssetReserve;
  return {
    covers: contractBalance >= required,
    totalRedeemAsset,
    contractBalance,
    required,
    ownerAssetReserve,
  };
}

// ---------------------------------------------------------------------------
// Perp / Hyperliquid adapter address (ETH vault has hyperliquid(); BTC lacked it historically)
// ---------------------------------------------------------------------------

/**
 * Resolve the HL adapter address for bot checks and tooling. Prefer the active perp
 * exchange; fall back to hyperliquidAddress() (KashYieldETH); then perpExchanges("HL").
 */
export async function readHyperliquidAdapterAddress(
  kashYield: ethers.Contract,
  cachedActivePerpExchange?: string,
): Promise<string> {
  const asAddr = (x: unknown): string => {
    if (typeof x === 'string') return x;
    if (x == null) return '';
    return String(x);
  };
  let activeName = (cachedActivePerpExchange ?? '').trim();
  if (!activeName) {
    try {
      activeName = asAddr(await kashYield.activePerpExchange()).trim();
    } catch {
      activeName = '';
    }
  }
  if (activeName) {
    try {
      const a = asAddr(await kashYield.perpExchanges(activeName));
      if (a && a !== ethers.ZeroAddress) return a;
    } catch { /* */ }
  }
  try {
    const a = asAddr(await kashYield.hyperliquidAddress());
    if (a && a !== ethers.ZeroAddress) return a;
  } catch { /* KashYieldBtc before hyperliquidAddress() was added */ }
  try {
    const a = asAddr(await kashYield.perpExchanges('HL'));
    if (a && a !== ethers.ZeroAddress) return a;
  } catch { /* */ }
  return '';
}

// ---------------------------------------------------------------------------
// Context snapshot
// ---------------------------------------------------------------------------

/**
 * Snapshot all on-chain state needed for ops classification, dry-run, idempotency
 * checks, and step execution.  Call once before running any playbook step; refresh
 * mid-playbook on steps tagged refreshCtx=true (e.g. after HL close + USDC withdraw).
 */
export async function snapshotOpsContext(
  kashYield: ethers.Contract,
  provider: ethers.Provider,
  signer: ethers.Signer,
  batchCycle: bigint,
  lockedNAV: bigint | undefined,
): Promise<OpsContext> {
  const isBtc = config.product === 'btc';
  const assetDecimals = isBtc ? 8n : 18n;
  const assetSymbol = isBtc ? 'BTC' : 'ETH';
  const shortSymbol = assetSymbol;
  const contractAddr = config.kashYieldAddress!;
  const aaveUserAddr = config.aaveUserAddress || contractAddr;

  // -- Price --
  const price = isBtc
    ? BigInt((await kashYield.getBtcPrice()).toString())
    : BigInt((await kashYield.getEthPrice()).toString());

  // -- Token addresses --
  const usdcAddress: string = await kashYield.usdcAddress().catch(() => '');
  const aavePoolAddress: string = await kashYield.aavePoolAddress().catch(() => '');
  const aaveUsdcAddress = config.aaveUsdcAddress || usdcAddress;

  // -- Contract balances --
  let contractAsset = 0n;
  if (isBtc) {
    try {
      const wbtcAddr: string = await kashYield.wbtcAddress();
      const wbtc = new ethers.Contract(wbtcAddr, ['function balanceOf(address) view returns (uint256)'], provider);
      contractAsset = BigInt((await wbtc.balanceOf(contractAddr)).toString());
    } catch { contractAsset = 0n; }
  } else {
    contractAsset = BigInt((await provider.getBalance(contractAddr)).toString());
  }

  let contractUsdc = 0n;
  if (usdcAddress) {
    try {
      const usdc = new ethers.Contract(usdcAddress, ['function balanceOf(address) view returns (uint256)'], provider);
      contractUsdc = BigInt((await usdc.balanceOf(contractAddr)).toString());
    } catch { contractUsdc = 0n; }
  }

  let ownerUsdcReserve = 0n;
  let ownerAssetReserve = 0n;
  try {
    ownerUsdcReserve = BigInt((await kashYield.ownerUsdcReserve()).toString());
  } catch { /* older deployment */ }
  try {
    ownerAssetReserve = isBtc
      ? BigInt((await kashYield.ownerWbtcReserve()).toString())
      : BigInt((await kashYield.ownerEthReserve()).toString());
  } catch { ownerAssetReserve = 0n; }

  const sub0 = (a: bigint, b: bigint) => (a >= b ? a - b : 0n);
  contractAsset = sub0(contractAsset, ownerAssetReserve);
  contractUsdc = sub0(contractUsdc, ownerUsdcReserve);

  // -- Aave position --
  let aaveSupplied = 0n;
  if (aavePoolAddress && aavePoolAddress !== ethers.ZeroAddress) {
    try {
      // Prefer wETH address as the Aave reserve key; fall back to address(0) for native ETH
      const wethAddr: string | null = isBtc
        ? await kashYield.wbtcAddress().catch(() => null)
        : await kashYield.wethAddress?.().catch(() => null) ?? null;
      const assetAddr = wethAddr ?? ethers.ZeroAddress;
      aaveSupplied = await getAaveSuppliedAmountV3(provider, aavePoolAddress, assetAddr, aaveUserAddr);
    } catch { aaveSupplied = 0n; }
  }

  const aaveDebt = await getAaveBorrowedAmountV3(provider, aavePoolAddress, aaveUsdcAddress, aaveUserAddr);

  // -- HL / perp exchange state --
  let hlUsdcBalance = 0n;
  let hlAssetBalance = 0n;
  let shortSize = 0n;
  let shortIsActive = false;
  let activePerpExchange = '';
  let perpAdapterAddress = '';
  let hlDirectDepositMode = false;
  let hlAccountAddress = '';
  let hlBridgeAddress = '';
  const hlEventRelayEnabled = (process.env.HL_EVENT_RELAY_ENABLED || 'true').toLowerCase() !== 'false';

  try { hlUsdcBalance = BigInt((await kashYield.getHyperliquidSpotBalance()).toString()); } catch { hlUsdcBalance = 0n; }
  try { hlAssetBalance = BigInt((await kashYield.getExchangeAssetBalance()).toString()); } catch { hlAssetBalance = 0n; }
  try {
    const [size, , , , isActive] = await kashYield.getHyperliquidPosition(shortSymbol);
    shortSize = BigInt(size.toString());
    shortIsActive = !!isActive;
  } catch { /* no position */ }
  try {
    activePerpExchange = await kashYield.activePerpExchange();
  } catch { activePerpExchange = ''; }
  try {
    perpAdapterAddress = await readHyperliquidAdapterAddress(kashYield, activePerpExchange);
  } catch { perpAdapterAddress = ''; }
  if (perpAdapterAddress && perpAdapterAddress !== ethers.ZeroAddress) {
    try {
      const hlAdapter = new ethers.Contract(
        perpAdapterAddress,
        [
          'function directDepositMode() view returns (bool)',
          'function hlAccount() view returns (address)',
          'function hlBridgeAddress() view returns (address)',
        ],
        provider,
      );
      hlDirectDepositMode = await hlAdapter.directDepositMode().catch(() => false);
      hlAccountAddress = await hlAdapter.hlAccount().catch(() => '');
      hlBridgeAddress = await hlAdapter.hlBridgeAddress().catch(() => '');
    } catch { /* leave defaults */ }
  }

  let adapterUsdcErc20 = 0n;
  if (perpAdapterAddress && perpAdapterAddress !== ethers.ZeroAddress && usdcAddress) {
    try {
      const usdcErc = new ethers.Contract(
        usdcAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      adapterUsdcErc20 = BigInt((await usdcErc.balanceOf(perpAdapterAddress)).toString());
    } catch {
      adapterUsdcErc20 = 0n;
    }
  }

  // -- Redemption accounting --
  const redeemFraction = await computeRedeemFraction(kashYield, provider, batchCycle, isBtc);
  const strategyRedeemFraction = await computeStrategyRedeemFraction(
    kashYield,
    provider,
    batchCycle,
    isBtc,
    lockedNAV,
  );
  const totalRedeemAsset = await computeTotalRedeemAsset(kashYield, batchCycle, lockedNAV, price, assetDecimals);

  return {
    kashYield,
    provider,
    signer,
    contractAsset,
    contractUsdc,
    aaveSupplied,
    aaveDebt,
    hlUsdcBalance,
    adapterUsdcErc20,
    hlAssetBalance,
    shortSize,
    shortIsActive,
    activePerpExchange,
    perpAdapterAddress,
    hlDirectDepositMode,
    hlAccountAddress,
    hlBridgeAddress,
    hlEventRelayEnabled,
    batchCycle,
    redeemFraction,
    strategyRedeemFraction,
    totalRedeemAsset,
    price,
    isBtc,
    assetDecimals,
    assetSymbol,
    lockedNAV,
    usdcAddress,
    aavePoolAddress,
    aaveUsdcAddress,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export async function computeRedeemFraction(
  kashYield: ethers.Contract,
  provider: ethers.Provider,
  batchCycle: bigint,
  isBtc: boolean,
): Promise<bigint> {
  try {
    const tokenAddr: string | null = await (isBtc
      ? kashYield.kashTokenBtc()
      : kashYield.kashTokenEth()
    ).catch(() => null);
    if (!tokenAddr) return BigInt(1e18);
    const kashToken = new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], provider);
    const totalSupply = BigInt((await kashToken.totalSupply()).toString());
    if (totalSupply === 0n) return BigInt(1e18);
    const redeemKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
    if (redeemKash === 0n) return 0n;
    const fraction = (redeemKash * BigInt(1e18)) / totalSupply;
    return fraction > BigInt(1e18) ? BigInt(1e18) : fraction;
  } catch {
    return BigInt(1e18);
  }
}

/**
 * Fraction of HL short / Aave collateral to unwind for this batch's **net** redemption
 * after offsetting incoming mints (same batch). Uses Phase-1 NAV (`lockedNAV` or on-chain `currentNAV`)
 * to estimate mint KASH like Phase 2.
 */
export async function computeStrategyRedeemFraction(
  kashYield: ethers.Contract,
  provider: ethers.Provider,
  batchCycle: bigint,
  isBtc: boolean,
  phase1Nav: bigint | undefined,
): Promise<bigint> {
  try {
    const tokenAddr: string | null = await (isBtc
      ? kashYield.kashTokenBtc()
      : kashYield.kashTokenEth()
    ).catch(() => null);
    if (!tokenAddr) return BigInt(1e18);
    const kashToken = new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], provider);
    const totalSupply = BigInt((await kashToken.totalSupply()).toString());
    const redeemKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
    const gross = await computeRedeemFraction(kashYield, provider, batchCycle, isBtc);
    if (totalSupply === 0n || redeemKash === 0n) return gross;

    const info = await kashYield.getBatchInfo(batchCycle);
    const mintUsersCount = BigInt(info.mintUsersCount.toString());
    const totalMintUSD = BigInt(info.totalMintUSD.toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    const nav = phase1Nav ?? BigInt((await kashYield.currentNAV()).toString());

    return strategyRedeemFractionPure({
      totalSupply,
      redeemKash,
      mintUsersCount,
      totalMintUSD,
      feeBps,
      nav: nav === 0n ? 1n : nav,
    });
  } catch {
    return computeRedeemFraction(kashYield, provider, batchCycle, isBtc);
  }
}
