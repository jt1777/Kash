import { ethers } from 'ethers';
import { config } from '../config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OpsContext {
  /** Contract references (used by step executors) */
  kashYield: ethers.Contract;
  provider: ethers.Provider;

  /** Contract wallet balances at snapshot time */
  contractAsset: bigint;   // ETH (18 dec) or wBTC (8 dec)
  contractUsdc: bigint;    // USDC 6 dec

  /** Aave position (principal + accrued interest, from getUserAccountData or variable debt token) */
  aaveSupplied: bigint;    // ETH (18 dec) or wBTC (8 dec)
  aaveDebt: bigint;        // USDC 6 dec

  /** Hyperliquid balances */
  hlUsdcBalance: bigint;   // USDC 6 dec (spot wallet)
  hlAssetBalance: bigint;  // ETH (18 dec) or wBTC (8 dec) — spot position (0 in USDC-collateral model)
  shortSize: bigint;       // asset units
  shortIsActive: boolean;

  /** Redemption accounting */
  batchCycle: bigint;
  redeemFraction: bigint;    // 18 dec; 1e18 = 100%
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
 * Compute total asset (ETH or wBTC) owed to all redeemers in the given batch cycle.
 * This is the single authoritative formula used by:
 *   - snapshotOpsContext (to populate ctx.totalRedeemAsset)
 *   - runStepMarkDone preflight gate
 *   - 11b swap sizing (how much USDC to swap for the asset shortfall)
 *   - dex_swap_from_usdc canSkip check
 */
export async function computeTotalRedeemAsset(
  kashYield: ethers.Contract,
  batchCycle: bigint,
  lockedNAV: bigint | undefined,
  price: bigint,
  assetDecimals: bigint,
): Promise<bigint> {
  try {
    const redeemers: string[] = await kashYield.batchRedeemUsers(batchCycle);
    if (redeemers.length === 0) return 0n;
    const nav = lockedNAV ?? BigInt((await kashYield.currentNAV()).toString());
    const feeBps = BigInt((await kashYield.feeBps()).toString());
    let total = 0n;
    for (const addr of redeemers) {
      const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
      const kashAmt = BigInt(req.kashAmount.toString());
      if (kashAmt === 0n) continue;
      const usdAfterFee = (kashAmt * nav / (10n ** 18n)) * (10000n - feeBps) / 10000n;
      total += usdAfterFee * (10n ** assetDecimals) / price;
    }
    return total;
  } catch {
    return 0n;
  }
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

  try { hlUsdcBalance = BigInt((await kashYield.getHyperliquidSpotBalance()).toString()); } catch { hlUsdcBalance = 0n; }
  try { hlAssetBalance = BigInt((await kashYield.getExchangeAssetBalance()).toString()); } catch { hlAssetBalance = 0n; }
  try {
    const [size, , , , isActive] = await kashYield.getHyperliquidPosition(shortSymbol);
    shortSize = BigInt(size.toString());
    shortIsActive = !!isActive;
  } catch { /* no position */ }

  // -- Redemption accounting --
  const redeemFraction = await computeRedeemFraction(kashYield, provider, batchCycle, isBtc);
  const totalRedeemAsset = await computeTotalRedeemAsset(kashYield, batchCycle, lockedNAV, price, assetDecimals);

  return {
    kashYield,
    provider,
    contractAsset,
    contractUsdc,
    aaveSupplied,
    aaveDebt,
    hlUsdcBalance,
    hlAssetBalance,
    shortSize,
    shortIsActive,
    batchCycle,
    redeemFraction,
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

async function computeRedeemFraction(
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
    if (redeemKash === 0n) return BigInt(1e18);
    const fraction = (redeemKash * BigInt(1e18)) / totalSupply;
    return fraction > BigInt(1e18) ? BigInt(1e18) : fraction;
  } catch {
    return BigInt(1e18);
  }
}
