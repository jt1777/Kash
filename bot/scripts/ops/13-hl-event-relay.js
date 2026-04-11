/**
 * 13-hl-event-relay — off-chain Hyperliquid execution worker.
 *
 * Why this exists:
 * - KashYield emits ProtocolInteraction events on Arbitrum.
 * - Real HL trading is off-chain via HL API.
 * - This script watches those on-chain intents, executes the actual HL trades,
 *   then syncs adapter state on-chain (syncBalances/syncPosition).
 *
 * Supported ProtocolInteraction actions:
 * - EXCHANGE_OPEN_SHORT
 * - EXCHANGE_CLOSE_SHORT
 * - EXCHANGE_SPOT_BUY
 * - EXCHANGE_SPOT_SELL
 *
 * Usage (one-shot recent range):
 *   PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... \
 *   HYPERLIQUID_API_PRIVATE_KEY=0x... \
 *   npx hardhat run bot/scripts/ops/13-hl-event-relay.js --network arbitrumOne
 *
 * Usage (watch mode):
 *   PRODUCT=eth KASH_YIELD_ETH_ADDRESS=0x... \
 *   HYPERLIQUID_API_PRIVATE_KEY=0x... WATCH=true POLL_INTERVAL_MS=15000 \
 *   npx hardhat run bot/scripts/ops/13-hl-event-relay.js --network arbitrumOne
 *
 * Optional env:
 *   FROM_BLOCK=450000000               # starting block (default: latest-400)
 *   TO_BLOCK=latest                    # ending block for one-shot mode
 *   CONFIRMATIONS=2                    # ignore newest N blocks
 *   WATCH=true                         # keep polling
 *   DRY_RUN=true                       # decode + print, no HL/API or on-chain sync writes
 *   HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
 *   HYPERLIQUID_API_PRIVATE_KEY=0x...  # wallet used to sign HL API actions
 *   HL_ACCOUNT_ADDRESS=0x...           # override HL user account (default derived from adapter mode)
 *   HL_ORDER_SLIPPAGE_BPS=50           # 0.50% default IOC limit padding
 *   HL_SPOT_ASSET_ID=10042             # optional hard override for spot order asset id
 *
 * Notes:
 * - If adapter.directDepositMode=false, HL account is usually the adapter address.
 * - If adapter.directDepositMode=true, HL account is adapter.hlAccount().
 * - Your HL signer wallet must be authorised as an HL agent for that HL account.
 */
require("dotenv").config({ path: "./bot/.env" });
const hre = require("hardhat");
const { ethers } = hre;

const TARGET_ACTIONS = new Set([
  "EXCHANGE_OPEN_SHORT",
  "EXCHANGE_CLOSE_SHORT",
  "EXCHANGE_SPOT_BUY",
  "EXCHANGE_SPOT_SELL",
]);

const KASH_ABI = [
  "event ProtocolInteraction(string action, address token, uint256 amount)",
  "function owner() view returns (address)",
  "function activePerpExchange() view returns (string)",
  "function perpExchanges(string) view returns (address)",
  "function hyperliquidAddress() view returns (address)",
  "function usdcAddress() view returns (address)",
  "function openShort(string symbol, uint256 size)",
  "function closeShort(string symbol)",
  "function closeShort(string symbol, uint256 closeSize)",
  "function spotBuyOnHyperliquid(uint256 usdcAmount)",
  "function spotSellOnHyperliquid(uint256 amount)",
];

const ADAPTER_ABI = [
  "function owner() view returns (address)",
  "function directDepositMode() view returns (bool)",
  "function hlAccount() view returns (address)",
  "function syncBalances(uint256 newUsdcBalance, uint256 newAssetBalance)",
  "function syncPosition(string symbol, uint256 size, uint256 entryPrice, bool isActive)",
];

const ACTION_IFACE = new ethers.Interface([
  "function openShort(string symbol, uint256 size)",
  "function closeShort(string symbol)",
  "function closeShort(string symbol, uint256 closeSize)",
  "function spotBuyOnHyperliquid(uint256 usdcAmount)",
  "function spotSellOnHyperliquid(uint256 amount)",
]);

async function main() {
  const product = (process.env.PRODUCT || "eth").toLowerCase();
  const isBtc = product === "btc";
  const defaultSymbol = isBtc ? "BTC" : "ETH";

  const kashYieldAddress = isBtc
    ? (process.env.KASH_YIELD_BTC_ADDRESS || process.env.KASH_YIELD_ADDRESS)
    : (process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS);
  if (!kashYieldAddress || !ethers.isAddress(kashYieldAddress)) {
    throw new Error(`Set KASH_YIELD_${isBtc ? "BTC" : "ETH"}_ADDRESS (or KASH_YIELD_ADDRESS).`);
  }

  const [signer] = await ethers.getSigners();
  const kashContractName = isBtc ? "KashYieldBtc" : "KashYieldETH";
  const kash = new ethers.Contract(kashYieldAddress, KASH_ABI, signer);
  const owner = await kash.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not KashYield owner (${owner}).`);
  }

  const activeExchange = await kash.activePerpExchange().catch(() => "");
  let adapterAddress = ethers.ZeroAddress;
  if (activeExchange) {
    adapterAddress = await kash.perpExchanges(activeExchange).catch(() => ethers.ZeroAddress);
  }
  if (adapterAddress === ethers.ZeroAddress) {
    // Legacy fallback
    adapterAddress = await kash.hyperliquidAddress().catch(() => ethers.ZeroAddress);
  }
  if (adapterAddress === ethers.ZeroAddress) {
    throw new Error("No active perp adapter address found.");
  }
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, signer);

  const adapterOwner = await adapter.owner();
  if (signer.address.toLowerCase() !== adapterOwner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not HyperliquidAdapter owner (${adapterOwner}).`);
  }

  const hlApiUrl = process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz";
  const hlPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!hlPk) {
    throw new Error("Set HYPERLIQUID_API_PRIVATE_KEY (or PRIVATE_KEY) for HL API signing.");
  }

  const { ExchangeClient, InfoClient, HttpTransport } = await import("@nktkas/hyperliquid");
  const hlWallet = new ethers.Wallet(hlPk);
  const transport = new HttpTransport({ url: `${hlApiUrl.replace(/\/+$/, "")}/info` });
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ url: `${hlApiUrl.replace(/\/+$/, "")}/exchange` }),
    wallet: hlWallet,
    // Use Arbitrum chain id in signed domain (matches setup in this repo).
    signatureChainId: "0xa4b1",
  });

  const hlUser = await resolveHlUserAddress(adapter);
  const hlAccountAddress = process.env.HL_ACCOUNT_ADDRESS || hlUser;
  const useVaultAddress = hlAccountAddress.toLowerCase() !== hlWallet.address.toLowerCase();

  const slippageBps = parseInt(process.env.HL_ORDER_SLIPPAGE_BPS || "50", 10);
  const dryRun = process.env.DRY_RUN === "true";
  const watch = process.env.WATCH === "true";
  const confirmations = parseInt(process.env.CONFIRMATIONS || "2", 10);
  const pollMs = parseInt(process.env.POLL_INTERVAL_MS || "15000", 10);

  console.log(`\n13 — HL event relay [product=${product.toUpperCase()}]`);
  console.log(`KashYield:      ${kashYieldAddress}`);
  console.log(`Active exchange: ${activeExchange || "(legacy)"}`);
  console.log(`HL adapter:     ${adapterAddress}`);
  console.log(`HL user:        ${hlAccountAddress}`);
  console.log(`HL signer:      ${hlWallet.address}`);
  console.log(`HL API:         ${hlApiUrl}`);
  console.log(`Dry run:        ${dryRun}`);

  const latest = await ethers.provider.getBlockNumber();
  let fromBlock = process.env.FROM_BLOCK ? parseInt(process.env.FROM_BLOCK, 10) : Math.max(0, latest - 400);
  const toBlockEnv = process.env.TO_BLOCK;

  const seen = new Set();
  do {
    const chainLatest = await ethers.provider.getBlockNumber();
    const safeTo = (toBlockEnv && toBlockEnv !== "latest")
      ? parseInt(toBlockEnv, 10)
      : Math.max(0, chainLatest - confirmations);

    if (fromBlock > safeTo) {
      if (!watch) break;
      await sleep(pollMs);
      continue;
    }

    const logs = await kash.queryFilter(kash.filters.ProtocolInteraction(), fromBlock, safeTo);
    const interesting = logs.filter((ev) => TARGET_ACTIONS.has(ev.args?.action || ""));
    console.log(`\nScanning blocks ${fromBlock}..${safeTo} => ${interesting.length} HL intent event(s).`);

    for (const ev of interesting) {
      const key = `${ev.transactionHash}:${ev.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        await handleEvent({
          ev,
          defaultSymbol,
          kash,
          adapter,
          info,
          exchange,
          useVaultAddress,
          hlAccountAddress,
          slippageBps,
          dryRun,
        });
      } catch (err) {
        console.error(`❌ Failed handling event ${key}:`, err?.message ?? err);
      }
    }

    fromBlock = safeTo + 1;
    if (!watch) break;
    await sleep(pollMs);
  } while (true);

  console.log("\nDone.");
}

async function handleEvent(ctx) {
  const {
    ev,
    defaultSymbol,
    kash,
    adapter,
    info,
    exchange,
    useVaultAddress,
    hlAccountAddress,
    slippageBps,
    dryRun,
  } = ctx;

  const action = ev.args.action;
  const tx = await ethers.provider.getTransaction(ev.transactionHash);
  if (!tx) throw new Error("missing tx for event");

  const parsed = ACTION_IFACE.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsed) throw new Error("could not decode tx calldata");

  console.log(`\n▶ ${action} @ tx ${ev.transactionHash}`);
  console.log(`   calldata method: ${parsed.signature}`);

  const orderOpts = useVaultAddress ? { vaultAddress: hlAccountAddress } : undefined;
  const perpMeta = await info.meta();
  const mids = await info.allMids();

  if (action === "EXCHANGE_OPEN_SHORT") {
    const symbol = String(parsed.args[0] ?? defaultSymbol).toUpperCase();
    const sizeWei = BigInt(parsed.args[1].toString());
    const size = trimDecimal(ethers.formatUnits(sizeWei, 18));
    if (sizeWei === 0n) throw new Error("open short size is 0");
    const assetId = findPerpAssetId(perpMeta, symbol);
    const price = computeLimitPrice(mids[symbol], false, slippageBps);
    console.log(`   HL order: SELL ${size} ${symbol} (asset=${assetId}) @ IOC ${price}`);
    if (!dryRun) {
      await exchange.order({
        orders: [{ a: assetId, b: false, p: price, s: size, r: false, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      }, orderOpts);
    }
    await syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun });
    return;
  }

  if (action === "EXCHANGE_CLOSE_SHORT") {
    const symbol = String(parsed.args[0] ?? defaultSymbol).toUpperCase();
    let closeSizeWei = 0n;
    if (parsed.args.length > 1) closeSizeWei = BigInt(parsed.args[1].toString());

    let closeSize = closeSizeWei > 0n ? trimDecimal(ethers.formatUnits(closeSizeWei, 18)) : "";
    if (!closeSize) {
      const ch = await info.clearinghouseState({ user: hlAccountAddress });
      const pos = findPosition(ch, symbol);
      closeSize = trimDecimal(absDecimal(pos?.position?.szi || "0"));
    }
    if (!closeSize || closeSize === "0") {
      console.log(`   No open ${symbol} short found on HL; nothing to close.`);
      await syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun });
      return;
    }
    const assetId = findPerpAssetId(perpMeta, symbol);
    const price = computeLimitPrice(mids[symbol], true, slippageBps);
    console.log(`   HL order: BUY ${closeSize} ${symbol} reduce-only (asset=${assetId}) @ IOC ${price}`);
    if (!dryRun) {
      await exchange.order({
        orders: [{ a: assetId, b: true, p: price, s: closeSize, r: true, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      }, orderOpts);
    }
    await syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun });
    return;
  }

  if (action === "EXCHANGE_SPOT_BUY") {
    const usdcAmount6 = BigInt(parsed.args[0].toString());
    const symbol = defaultSymbol;
    const spot = await info.spotMeta();
    const pair = resolveSpotPairName(spot, symbol);
    const pairIndex = resolveSpotPairIndex(spot, pair);
    const spotAssetId = resolveSpotAssetId(pairIndex);
    const mid = mids[pair] || mids[symbol];
    const price18 = decimalToBigInt(mid, 18);
    const sizeWei = (usdcAmount6 * 10n ** 30n) / price18;
    const size = trimDecimal(ethers.formatUnits(sizeWei, 18));
    const price = computeLimitPrice(mid, true, slippageBps);
    console.log(`   HL order: SPOT BUY ${size} ${pair} (asset=${spotAssetId}) @ IOC ${price}`);
    if (!dryRun) {
      await exchange.order({
        orders: [{ a: spotAssetId, b: true, p: price, s: size, r: false, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      }, orderOpts);
    }
    await syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun });
    return;
  }

  if (action === "EXCHANGE_SPOT_SELL") {
    const amountWei = BigInt(parsed.args[0].toString());
    const symbol = defaultSymbol;
    const spot = await info.spotMeta();
    const pair = resolveSpotPairName(spot, symbol);
    const pairIndex = resolveSpotPairIndex(spot, pair);
    const spotAssetId = resolveSpotAssetId(pairIndex);
    const size = trimDecimal(ethers.formatUnits(amountWei, 18));
    const price = computeLimitPrice(mids[pair] || mids[symbol], false, slippageBps);
    console.log(`   HL order: SPOT SELL ${size} ${pair} (asset=${spotAssetId}) @ IOC ${price}`);
    if (!dryRun) {
      await exchange.order({
        orders: [{ a: spotAssetId, b: false, p: price, s: size, r: false, t: { limit: { tif: "Ioc" } } }],
        grouping: "na",
      }, orderOpts);
    }
    await syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun });
    return;
  }

  console.log(`   Skipping unsupported action: ${action}`);
}

async function resolveHlUserAddress(adapter) {
  const direct = await adapter.directDepositMode().catch(() => false);
  if (direct) {
    const hlAccount = await adapter.hlAccount().catch(() => ethers.ZeroAddress);
    if (!hlAccount || hlAccount === ethers.ZeroAddress) {
      throw new Error("adapter directDepositMode=true but hlAccount is not set");
    }
    return hlAccount;
  }
  return await adapter.getAddress();
}

async function syncAdapterState({ adapter, info, hlAccountAddress, symbol, dryRun }) {
  const ch = await info.clearinghouseState({ user: hlAccountAddress });
  const spot = await info.spotClearinghouseState({ user: hlAccountAddress }).catch(() => ({ balances: [] }));

  const usdcFromSpot = findSpotBalance(spot, "USDC");
  const withdrawableStr = String(ch.withdrawable || "0");
  const usdcStr = selectUsdcForSync(usdcFromSpot, withdrawableStr);
  const assetStr = findSpotBalance(spot, symbol);
  const pos = findPosition(ch, symbol);

  const usdc6 = decimalToBigInt(usdcStr, 6);
  const asset18 = decimalToBigInt(assetStr || "0", 18);
  const sziAbs = absDecimal(pos?.position?.szi || "0");
  const size18 = decimalToBigInt(sziAbs, 18);
  const entry18 = decimalToBigInt(pos?.position?.entryPx || "0", 18);
  const isActive = size18 > 0n;

  console.log(`   syncBalances: usdc=${trimDecimal(usdcStr)} asset=${trimDecimal(assetStr || "0")}`);
  console.log(`   syncPosition(${symbol}): size=${trimDecimal(sziAbs)} entry=${trimDecimal(pos?.position?.entryPx || "0")} active=${isActive}`);
  if (!dryRun) {
    await (await adapter.syncBalances(usdc6, asset18)).wait();
    await (await adapter.syncPosition(symbol, size18, entry18, isActive)).wait();
  }
}

function findPerpAssetId(meta, symbol) {
  const idx = (meta?.universe || []).findIndex((u) => String(u.name || "").toUpperCase() === symbol.toUpperCase());
  if (idx < 0) throw new Error(`could not find perp asset id for ${symbol} in HL meta`);
  return idx;
}

function findPosition(clearinghouseState, symbol) {
  return (clearinghouseState?.assetPositions || []).find((p) =>
    String(p?.position?.coin || "").toUpperCase() === symbol.toUpperCase()
  );
}

function findSpotBalance(spotState, coin) {
  const bal = (spotState?.balances || []).find((b) =>
    String(b.coin || "").toUpperCase() === coin.toUpperCase()
  );
  return bal?.total || "0";
}

function resolveSpotPairName(spotMeta, symbol) {
  const explicit = process.env.HL_SPOT_PAIR_NAME;
  if (explicit) return explicit;
  const target = `${symbol.toUpperCase()}/USDC`;
  const match = (spotMeta?.universe || []).find((u) =>
    String(u.name || "").toUpperCase() === target
  );
  if (!match) {
    throw new Error(`could not find spot pair "${target}" in HL spotMeta; set HL_SPOT_PAIR_NAME or HL_SPOT_ASSET_ID`);
  }
  return match.name;
}

function resolveSpotPairIndex(spotMeta, pairName) {
  const match = (spotMeta?.universe || []).find((u) => String(u.name || "") === pairName);
  if (!match) throw new Error(`could not resolve spot pair index for ${pairName}`);
  return Number(match.index);
}

function resolveSpotAssetId(pairIndex) {
  if (process.env.HL_SPOT_ASSET_ID) return parseInt(process.env.HL_SPOT_ASSET_ID, 10);
  // Hyperliquid spot asset ids use 10000 + spotPairIndex.
  return 10000 + pairIndex;
}

function computeLimitPrice(midStr, isBuy, slippageBps) {
  const mid18 = decimalToBigInt(midStr, 18);
  if (mid18 <= 0n) throw new Error(`invalid mid price: ${midStr}`);
  const bps = BigInt(slippageBps);
  const px18 = isBuy
    ? (mid18 * (10000n + bps)) / 10000n
    : (mid18 * (10000n - bps)) / 10000n;
  return trimDecimal(ethers.formatUnits(px18, 18));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

