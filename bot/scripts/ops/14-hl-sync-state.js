/**
 * 14-hl-sync-state — one-shot adapter state sync from Hyperliquid API.
 *
 * Use this after manual HL actions (or as a recovery step) to refresh:
 * - adapter.syncBalances(usdc, asset)
 * - adapter.syncPosition(symbol, size, entryPrice, isActive)
 *
 * Usage:
 *   PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... \
 *   npx hardhat run bot/scripts/ops/14-hl-sync-state.js --network arbitrumOne
 *
 * Optional env:
 *   HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
 *   HL_ACCOUNT_ADDRESS=0x...    # override detected HL account
 *   SYMBOL=ETH                  # position symbol to sync (default from PRODUCT)
 *   DRY_RUN=true
 */
require("dotenv").config({ path: "./bot/.env" });
const hre = require("hardhat");
const { ethers } = hre;

const KASH_ABI = [
  "function owner() view returns (address)",
  "function activePerpExchange() view returns (string)",
  "function perpExchanges(string) view returns (address)",
  "function hyperliquidAddress() view returns (address)",
];

const ADAPTER_ABI = [
  "function owner() view returns (address)",
  "function directDepositMode() view returns (bool)",
  "function hlAccount() view returns (address)",
  "function syncBalances(uint256 newUsdcBalance, uint256 newAssetBalance)",
  "function syncPosition(string symbol, uint256 size, uint256 entryPrice, bool isActive)",
];

async function main() {
  const product = (process.env.PRODUCT || "eth").toLowerCase();
  const isBtc = product === "btc";
  const symbol = (process.env.SYMBOL || (isBtc ? "BTC" : "ETH")).toUpperCase();
  const dryRun = process.env.DRY_RUN === "true";

  const kashYieldAddress = isBtc
    ? (process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS)
    : (process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  if (!kashYieldAddress || !ethers.isAddress(kashYieldAddress)) {
    throw new Error(`Set KASH_YIELD_${isBtc ? "BTC" : "ETH"}_ADDRESS (or KASH_YIELD_ADDRESS).`);
  }

  const [signer] = await ethers.getSigners();
  const kash = new ethers.Contract(kashYieldAddress, KASH_ABI, signer);
  const owner = await kash.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not KashYield owner (${owner}).`);
  }

  const activeExchange = await kash.activePerpExchange().catch(() => "");
  let adapterAddress = ethers.ZeroAddress;
  if (activeExchange) adapterAddress = await kash.perpExchanges(activeExchange).catch(() => ethers.ZeroAddress);
  if (adapterAddress === ethers.ZeroAddress) adapterAddress = await kash.hyperliquidAddress().catch(() => ethers.ZeroAddress);
  if (adapterAddress === ethers.ZeroAddress) throw new Error("No active perp adapter found.");

  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer);
  const adapterOwner = await adapter.owner();
  if (signer.address.toLowerCase() !== adapterOwner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not HyperliquidAdapter owner (${adapterOwner}).`);
  }

  const hlApiUrl = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
  const { InfoClient, HttpTransport } = await import("@nktkas/hyperliquid");
  const info = new InfoClient({
    transport: new HttpTransport({ url: `${hlApiUrl.replace(/\/+$/, "")}/info` }),
  });

  const hlUser = process.env.HL_ACCOUNT_ADDRESS || await resolveHlUserAddress(adapter);
  const ch = await info.clearinghouseState({ user: hlUser });
  const spot = await info.spotClearinghouseState({ user: hlUser }).catch(() => ({ balances: [] }));

  const usdcSpotStr = findSpotBalance(spot, "USDC");
  const withdrawableStr = String(ch.withdrawable || "0");
  const usdcStr = selectUsdcForSync(usdcSpotStr, withdrawableStr);
  const assetStr = findSpotBalance(spot, symbol);
  const pos = (ch.assetPositions || []).find((p) => String(p?.position?.coin || "").toUpperCase() === symbol);

  const usdc6 = decimalToBigInt(usdcStr, 6);
  const asset18 = decimalToBigInt(assetStr || "0", 18);
  const size18 = decimalToBigInt(absDecimal(pos?.position?.szi || "0"), 18);
  const entry18 = decimalToBigInt(pos?.position?.entryPx || "0", 18);
  const isActive = size18 > 0n;

  console.log(`\n14 — HL sync state [product=${product.toUpperCase()} symbol=${symbol}]`);
  console.log(`KashYield:    ${kashYieldAddress}`);
  console.log(`HL adapter:   ${adapterAddress}`);
  console.log(`HL user:      ${hlUser}`);
  console.log(`USDC balance: ${trimDecimal(usdcStr)}`);
  console.log(`${symbol} bal:  ${trimDecimal(assetStr || "0")}`);
  console.log(`${symbol} pos:  size=${trimDecimal(absDecimal(pos?.position?.szi || "0"))} entry=${trimDecimal(pos?.position?.entryPx || "0")} active=${isActive}`);
  console.log(`Dry run:      ${dryRun}`);

  if (!dryRun) {
    const tx1 = await adapter.syncBalances(usdc6, asset18);
    await tx1.wait();
    const tx2 = await adapter.syncPosition(symbol, size18, entry18, isActive);
    await tx2.wait();
    console.log("✅ syncBalances + syncPosition completed");
  }
}

async function resolveHlUserAddress(adapter) {
  const direct = await adapter.directDepositMode().catch(() => false);
  if (direct) {
    const hlAccount = await adapter.hlAccount().catch(() => ethers.ZeroAddress);
    if (!hlAccount || hlAccount === ethers.ZeroAddress) {
      throw new Error("adapter directDepositMode=true but hlAccount is unset");
    }
    return hlAccount;
  }
  return await adapter.getAddress();
}

function findSpotBalance(spotState, coin) {
  const bal = (spotState?.balances || []).find((b) => String(b.coin || "").toUpperCase() === coin.toUpperCase());
  return bal?.total || "0";
}

function decimalToBigInt(value, decimals) {
  const s = String(value ?? "0").trim();
  if (!s || s === "0") return 0n;
  const neg = s.startsWith("-");
  const clean = neg ? s.slice(1) : s;
  const [intPartRaw, fracRaw = ""] = clean.split(".");
  const intPart = intPartRaw || "0";
  const fracPadded = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const combined = `${intPart}${fracPadded}`.replace(/^0+/, "") || "0";
  const v = BigInt(combined);
  return neg ? -v : v;
}

function absDecimal(value) {
  const s = String(value || "0");
  return s.startsWith("-") ? s.slice(1) : s;
}

function selectUsdcForSync(spotUsdcStr, withdrawableStr) {
  const spot6 = decimalToBigInt(spotUsdcStr || "0", 6);
  const wd6 = decimalToBigInt(withdrawableStr || "0", 6);
  return wd6 > spot6 ? withdrawableStr : spotUsdcStr;
}

function trimDecimal(value) {
  const s = String(value);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

