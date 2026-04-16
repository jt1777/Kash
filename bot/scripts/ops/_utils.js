/**
 * Shared utilities for KashYield ops scripts.
 *
 * Reads product config from bot/.env (or env vars already set).
 * Run scripts from the repo root:
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/01-deposit-to-aave.js --network arbitrumSepolia
 */
require("dotenv").config({ path: "./bot/.env" });
const { ethers } = require("hardhat");
const {
  assertKashYieldOpsSigner,
  assertCanSyncHyperliquidAdapter,
} = require("../../../scripts/opsAccessChecks");

// ── Product config ────────────────────────────────────────────────────────────
const PRODUCT  = (process.env.PRODUCT || "eth").toLowerCase();
const IS_BTC   = PRODUCT === "btc";
const DECIMALS = IS_BTC ? 8 : 18;
const ASSET_SYMBOL = IS_BTC ? "wBTC" : "ETH";
const USDC_DECIMALS = 6;

// ── ABI ───────────────────────────────────────────────────────────────────────
const KASH_ABI = [
  // Views
  "function owner() view returns (address)",
  "function botAddress() view returns (address)",
  "function keeperRegistry() view returns (address)",
  "function wethAddress() view returns (address)",
  "function wbtcAddress() view returns (address)",
  "function usdcAddress() view returns (address)",
  "function aavePoolAddress() view returns (address)",
  "function hyperliquidAddress() view returns (address)",
  "function spotDexAddress() view returns (address)",
  "function activePerpExchange() view returns (string)",
  "function getCurrentBatchCycle() view returns (uint256)",
  "function batchPhase(uint256) view returns (uint8)",
  "function batchTotalRedeemKash(uint256) view returns (uint256)",
  "function kashTokenEth() view returns (address)",
  "function kashTokenBtc() view returns (address)",
  "function currentNAV() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function getEthPrice() view returns (uint256)",
  "function getBtcPrice() view returns (uint256)",
  "function getHyperliquidSpotBalance() view returns (uint256)",
  "function getExchangeAssetBalance() view returns (uint256)",
  "function getHyperliquidPosition(string) view returns (uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive)",
  // Owner / treasury reserves (excluded from user-facing balances in getState)
  "function ownerUsdcReserve() view returns (uint256)",
  "function ownerEthReserve() view returns (uint256)",
  "function ownerWbtcReserve() view returns (uint256)",
  "function markOwnerUsdcDeposit(uint256 amount)",
  "function markOwnerEthDeposit() payable",
  "function markOwnerWbtcDeposit(uint256 amount)",
  "function coverUsdcShortfall(uint256 amount)",
  // Aave
  "function depositToAave(uint256 amount)",
  "function withdrawFromAave(uint256 amount)",
  "function borrowFromAave(address asset, uint256 amount)",
  "function repayToAave(address asset, uint256 amount)",
  // Perp DEX (USDC-collateral path — HL)
  "function depositToHyperliquid(uint256 amount)",
  "function withdrawFromHyperliquid(uint256 amount)",
  "function addCollateralToHyperliquid(uint256 amount)",
  "function spotBuyOnHyperliquid(uint256 usdcAmount)",
  "function spotSellOnHyperliquid(uint256 amount)",
  "function openShort(string symbol, uint256 size)",
  "function closeShort(string symbol)",
  "function closeShort(string symbol, uint256 closeSize)",
  // Perp DEX (asset-collateral path — Aster or other)
  "function withdrawEthFromHyperliquid(uint256 amount)",
  "function withdrawBtcFromHyperliquid(uint256 amount)",
  // Spot DEX (Uniswap / MockSpotDex)
  "function swapForUsdc(uint256 amount)",     // ETH/wBTC → USDC
  "function swapFromUsdc(uint256 usdcAmount)", // USDC → ETH/wBTC
  // Owner rescue
  "function rescueERC20(address token, uint256 amount, address recipient)",
];

// Aave pool ABI — covers MockAaveV3 and real Aave V3
const AAVE_ABI = [
  // Mock-only helpers
  "function suppliedAmounts(address user) view returns (uint256)",
  "function borrowedAmounts(address user) view returns (uint256)",
  // Real Aave V3
  "function getReserveData(address asset) view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ── Contract helpers ──────────────────────────────────────────────────────────

async function getContract() {
  const address = IS_BTC
    ? (process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS)
    : (process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  if (!address || !ethers.isAddress(address)) {
    throw new Error(
      `Set KASH_YIELD_${IS_BTC ? "BTC" : "ETH"}_ADDRESS in bot/.env (PRODUCT=${PRODUCT})`
    );
  }
  const [signer] = await ethers.getSigners();
  return new ethers.Contract(address, KASH_ABI, signer);
}

async function getSigner() {
  const [signer] = await ethers.getSigners();
  return signer;
}

// ── State snapshot ────────────────────────────────────────────────────────────

async function getState(contract) {
  const provider = ethers.provider;
  const addr     = await contract.getAddress();

  const usdcAddr = await contract.usdcAddress();
  const aaveAddr = await contract.aavePoolAddress();
  const price    = IS_BTC
    ? BigInt((await contract.getBtcPrice()).toString())
    : BigInt((await contract.getEthPrice()).toString());

  // On-chain balances (raw)
  let contractAssetRaw = 0n;
  if (IS_BTC) {
    const wbtcAddr = await contract.wbtcAddress();
    const wbtc = new ethers.Contract(wbtcAddr, ERC20_ABI, provider);
    contractAssetRaw = BigInt((await wbtc.balanceOf(addr)).toString());
  } else {
    contractAssetRaw = BigInt((await provider.getBalance(addr)).toString());
  }

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, provider);
  const contractUsdcRaw = BigInt((await usdc.balanceOf(addr)).toString());

  let ownerUsdcReserve = 0n;
  let ownerAssetReserve = 0n;
  try {
    ownerUsdcReserve = BigInt((await contract.ownerUsdcReserve()).toString());
  } catch {
    /* older deployment */
  }
  try {
    ownerAssetReserve = IS_BTC
      ? BigInt((await contract.ownerWbtcReserve()).toString())
      : BigInt((await contract.ownerEthReserve()).toString());
  } catch {
    ownerAssetReserve = 0n;
  }

  const sub0 = (a, b) => (a >= b ? a - b : 0n);
  const contractAsset = sub0(contractAssetRaw, ownerAssetReserve);
  const contractUsdc = sub0(contractUsdcRaw, ownerUsdcReserve);

  // Aave state — real Aave V3 compatible
  let aaveSupplied = 0n, aaveDebt = 0n;
  if (aaveAddr && aaveAddr !== ethers.ZeroAddress) {
    const aave = new ethers.Contract(aaveAddr, AAVE_ABI, provider);

    // Supplied: mock path first, then real Aave V3 via aToken balance
    try {
      aaveSupplied = BigInt((await aave.suppliedAmounts(addr)).toString());
    } catch {
      try {
        const assetAddr = IS_BTC
          ? await contract.wbtcAddress()
          : await contract.wethAddress().catch(() => ethers.ZeroAddress);
        const reserveData = await aave.getReserveData(assetAddr);
        const aToken = new ethers.Contract(
          reserveData.aTokenAddress,
          ["function balanceOf(address) view returns (uint256)"],
          provider
        );
        aaveSupplied = BigInt((await aToken.balanceOf(addr)).toString());
      } catch { /* leave as 0 */ }
    }

    // Debt: mock path first, then real Aave V3 via variable debt token, then getUserAccountData
    try {
      aaveDebt = BigInt((await aave.borrowedAmounts(addr)).toString());
    } catch {
      try {
        const usdcReserveData = await aave.getReserveData(usdcAddr);
        const debtToken = new ethers.Contract(
          usdcReserveData.variableDebtTokenAddress,
          ["function balanceOf(address) view returns (uint256)"],
          provider
        );
        aaveDebt = BigInt((await debtToken.balanceOf(addr)).toString());
      } catch {
        try {
          const data = await aave.getUserAccountData(addr);
          aaveDebt = BigInt(data.totalDebtBase.toString()) / 100n; // USD 8-dec → USDC 6-dec
        } catch { /* leave as 0 */ }
      }
    }
  }

  // Perp DEX state — HL reads may not be available on-chain for mainnet adapters
  let perpUsdc = 0n, perpAsset = 0n;
  let shortSize = 0n, entryPrice = 0n, posActive = false;
  try { perpUsdc  = BigInt((await contract.getHyperliquidSpotBalance()).toString()); } catch {}
  try { perpAsset = BigInt((await contract.getExchangeAssetBalance()).toString()); } catch {}
  try {
    const [posSize, , posEntry, , posIsActive] = await contract.getHyperliquidPosition(
      IS_BTC ? "BTC" : "ETH"
    );
    shortSize  = BigInt(posSize.toString());
    entryPrice = BigInt(posEntry.toString());
    posActive  = Boolean(posIsActive);
  } catch {}

  // Unrealized P&L (short position: profit when price falls)
  let perpPnlUsdc = 0n;
  if (posActive && shortSize > 0n && entryPrice > 0n) {
    const priceDiff18 = entryPrice > price ? entryPrice - price : 0n;
    perpPnlUsdc = (shortSize * priceDiff18) / BigInt(1e18) / BigInt(1e12);
  }

  // Batch info
  const batchCycle = BigInt((await contract.getCurrentBatchCycle()).toString());
  const batchPhase = Number(await contract.batchPhase(batchCycle));

  return {
    addr, price,
    contractAssetRaw, contractUsdcRaw,
    ownerUsdcReserve, ownerAssetReserve,
    contractAsset, contractUsdc,
    aaveSupplied, aaveDebt,
    perpUsdc, perpAsset,
    shortSize, entryPrice, posActive,
    perpPnlUsdc, batchCycle, batchPhase,
  };
}

function displayState(s, label = "State") {
  const fmt  = (v) => ethers.formatUnits(v, DECIMALS);
  const fmtU = (v) => ethers.formatUnits(v, USDC_DECIMALS);
  const fmtP = (v) => ethers.formatUnits(v, 18);
  const line = "─".repeat(56);

  console.log(`\n${label}`);
  console.log(line);
  console.log(`  Owner USDC reserve   : ${fmtU(s.ownerUsdcReserve)} USDC (excluded below)`);
  console.log(`  Owner ${ASSET_SYMBOL} reserve  : ${fmt(s.ownerAssetReserve)} ${ASSET_SYMBOL} (excluded below)`);
  console.log(`  Contract ${ASSET_SYMBOL} (raw)  : ${fmt(s.contractAssetRaw)} ${ASSET_SYMBOL}`);
  console.log(`  Contract USDC (raw)  : ${fmtU(s.contractUsdcRaw)} USDC`);
  console.log(`  Contract ${ASSET_SYMBOL} (adj.) : ${fmt(s.contractAsset)} ${ASSET_SYMBOL}  ← raw minus owner reserve`);
  console.log(`  Contract USDC (adj.) : ${fmtU(s.contractUsdc)} USDC  ← raw minus owner USDC reserve`);
  console.log(`  ${IS_BTC ? "BTC" : "ETH"} price           : $${fmtP(s.price)}`);
  console.log(`  Aave supplied        : ${fmt(s.aaveSupplied)} ${ASSET_SYMBOL}`);
  console.log(`  Aave borrowed        : ${fmtU(s.aaveDebt)} USDC`);
  console.log(`  Perp USDC balance    : ${fmtU(s.perpUsdc)} USDC`);
  console.log(`  Perp ${ASSET_SYMBOL} balance  : ${fmt(s.perpAsset)} ${ASSET_SYMBOL}`);
  if (s.posActive) {
    console.log(`  Short size           : ${fmtP(s.shortSize)} ${IS_BTC ? "BTC" : "ETH"}`);
    console.log(`  Short entry price    : $${fmtP(s.entryPrice)}`);
    console.log(`  Short est. P&L       : +${fmtU(s.perpPnlUsdc)} USDC (if ETH fell)`);
  } else {
    console.log(`  Short                : no active position`);
  }
  console.log(`  Batch cycle / phase  : ${s.batchCycle} / ${s.batchPhase}`);
  console.log(line);
}

// ── Redeem fraction ───────────────────────────────────────────────────────────

/**
 * Compute the fraction of the total KASH supply being redeemed in the given batch cycle.
 * Returns a value between 0 and 1e18 (1e18 = 100%).
 * Also returns the human-readable percentage string for logging.
 */
async function getRedeemFraction(contract, batchCycle) {
  const provider = ethers.provider;
  const kashAddrFn = IS_BTC ? contract.kashTokenBtc : contract.kashTokenEth;
  const kashAddr   = await kashAddrFn.call(contract).catch(() => null);
  if (!kashAddr || kashAddr === ethers.ZeroAddress) {
    throw new Error("KASH token address not set on contract.");
  }
  const kashToken    = new ethers.Contract(kashAddr, ["function totalSupply() view returns (uint256)"], provider);
  const totalSupply  = BigInt((await kashToken.totalSupply()).toString());
  const redeemKash   = BigInt((await contract.batchTotalRedeemKash(batchCycle)).toString());

  if (totalSupply === 0n) return { fraction18: BigInt(1e18), pct: "100.00" };
  if (redeemKash  === 0n) return { fraction18: 0n, pct: "0.00" };

  const fraction18 = redeemKash * BigInt(1e18) / totalSupply;
  const capped     = fraction18 > BigInt(1e18) ? BigInt(1e18) : fraction18;
  const pct        = (Number(capped) / 1e16).toFixed(2);
  return { fraction18: capped, pct, redeemKash, totalSupply };
}

// ── Amount helpers ────────────────────────────────────────────────────────────

function parseAsset(str) {
  return ethers.parseUnits(str, DECIMALS);
}
function parseUsdc(str) {
  return ethers.parseUnits(str, USDC_DECIMALS);
}
function fmtAsset(v) {
  return `${ethers.formatUnits(v, DECIMALS)} ${ASSET_SYMBOL}`;
}
function fmtUsdc(v) {
  return `${ethers.formatUnits(v, USDC_DECIMALS)} USDC`;
}
function fmtUsd18(v) {
  return `$${ethers.formatEther(v)}`;
}

// ── Transaction helper ────────────────────────────────────────────────────────

async function exec(label, txPromise) {
  console.log(`\n▶  ${label}`);
  const tx = await txPromise;
  process.stdout.write("   Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(` ✅  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return receipt;
}

module.exports = {
  PRODUCT, IS_BTC, DECIMALS, ASSET_SYMBOL, USDC_DECIMALS,
  KASH_ABI, AAVE_ABI, ERC20_ABI,
  getContract, getSigner, getState, displayState,
  getRedeemFraction,
  parseAsset, parseUsdc, fmtAsset, fmtUsdc, fmtUsd18, exec,
  assertKashYieldOpsSigner,
  assertCanSyncHyperliquidAdapter,
};
