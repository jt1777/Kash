# Hyperliquid Integration Guide

## Overview
KASH integrates with Hyperliquid for delta-neutral yield through ETH short positions.

## Architecture

```
User Deposit ETH
    ↓
Supply to Aave → Borrow 70% USDC
    ↓
Deposit USDC to Hyperliquid as collateral
    ↓
Open 1.7x ETH short position
    ↓
Earn funding rate yield
```

## Contract Addresses

### Arbitrum Mainnet (Production)

| Contract | Address | Purpose |
|----------|---------|---------|
| `Hyperliquid Deposit Bridge` | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` | Main L1 bridge contract for deposits/withdrawals |
| `USDC (Native)` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | Circle's native USDC on Arbitrum |
| `USDC.e (Bridged)` | `0xff970a61a04b1ca14834a43f5de4533ebddb5cc8` | Bridged USDC from Ethereum |
| `ETH-PERP` | N/A | Not a contract - use API via coin name "ETH" |

### Nova's Trading Bot Wallet
- **Address:** `0x4485716f61Db964ff03469310582f6103537c2e3`
- **Network:** Hyperliquid mainnet
- **Access:** API-based (no direct contract interactions for trading)

### Arbitrum Sepolia (Testnet)

| Contract | Address | Purpose |
|----------|---------|---------|
| **MockHyperliquid** | Deploy via `scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js` | Implements `IHyperliquid` for testing; set on KashYieldETH with `setHyperliquid(mockAddress)` |
| `USDC` | `0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5` (script default) | Used by mock and KashYieldETH for HL spot |
| `USDT` | `0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1` (script default) | Optional on mock |
| `wBTC` | `0x4D8b720b94D341F54df948696747B05998c5FbD5` (script default) | Optional on mock |

**Note:** On testnet we use **MockHyperliquid** on Arbitrum Sepolia, not the real Hyperliquid bridge. The real bridge address (`0x2Df1c51...`) is for mainnet HL deposits/withdrawals when you switch to production.

## Hyperliquid Interaction Flow

### Current (Mock) – IHyperliquid interface

KashYieldETH talks to any address that implements `IHyperliquid`. Our **MockHyperliquid.sol** (used on Arbitrum Sepolia) implements:

```solidity
// Spot wallet (USDC or USDT)
function depositToSpotWallet(address stableToken, uint256 amount) external;
function withdrawFromSpotWallet(address stableToken, uint256 amount) external;
function getSpotBalance(address user) external view returns (uint256);

// Spot trading: ETH/wBTC ↔ USDC/USDT
function tradeSpot(address tokenIn, address tokenOut, uint256 amountIn) external payable returns (uint256 amountOut);

// Perps
function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external;
function closePerpPosition(string calldata symbol) external;
function getPosition(address user, string calldata symbol) external view returns (
    uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
);

// Orders (mock: no-op / empty)
function cancelOrder(bytes32 orderId) external;
function getOpenOrderIds(address account) external view returns (bytes32[] memory);
```

KashYieldETH uses **USDC** for Hyperliquid (its `usdcAddress`); the mock accepts USDC or USDT. Deploy the mock with `scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js`, then set that address on KashYieldETH via `setHyperliquid(mockAddress)`.

### Our interface is the contract (names do not “switch” in KashYield)

KashYield **only** calls the address in `hyperliquidAddress` via the **`IHyperliquid`** interface. The function names and signatures are fixed in our codebase:

| Our name (IHyperliquid) | Used by KashYield for |
|------------------------|------------------------|
| `depositToSpotWallet(stableToken, amount)` | Sending USDC to HL as collateral |
| `withdrawFromSpotWallet(stableToken, amount)` | Pulling USDC back to the contract |
| `tradeSpot(tokenIn, tokenOut, amountIn)` | Spot buy/sell (e.g. wBTC↔USDC) |
| `openPerpPosition(symbol, size, isLong)` | Opening or adding to a short |
| `closePerpPosition(symbol)` | Full close |
| `closePerpPosition(symbol, closeSize)` | Partial close |
| `getSpotBalance(user)` | Reading USDC balance on HL |
| `getPosition(user, symbol)` | Reading perp size/collateral/active |
| `cancelOrder(orderId)` / `getOpenOrderIds(account)` | Orders (mock: no-op) |

**We never change these names in KashYield.** Whatever is at `hyperliquidAddress` must implement exactly this interface. On testnet that’s **MockHyperliquid**; on mainnet it must be an **adapter** (see below).

### Mainnet: adapter pattern (real HL has different names/API)

Real Hyperliquid on Arbitrum mainnet does **not** expose this interface:

- The **bridge** (e.g. `0x2Df1c51...`) has its own function names (e.g. deposit/withdraw with different signatures).
- **Perp trading** is done on the Hyperliquid chain via **REST API**, not on-chain.

So you don’t “switch” our function names to HL’s. You add a layer that speaks both:

1. **Deploy an adapter contract** on Arbitrum that:
   - **Implements `IHyperliquid`** (our names and signatures).
   - **Internally** calls the real HL bridge (e.g. `depositToSpotWallet` → bridge’s `deposit` or equivalent) and/or triggers off-chain execution (e.g. keeper that calls HL API when `openPerpPosition` / `closePerpPosition` is invoked).
2. **Point KashYield at the adapter:** `setHyperliquid(adapterAddress)`.
3. KashYield keeps calling the same `IHyperliquid` functions; the adapter translates to whatever the real HL uses (bridge + API).

So: **our names stay; the adapter maps them to real HL.**

### Mapping: IHyperliquid → real Hyperliquid (reference for adapter)

When implementing the mainnet adapter, map as follows. Real HL ABIs and API docs may use different names; this table is the intended behavior.

| IHyperliquid (our name) | Real HL (typical) | Notes |
|-------------------------|-------------------|--------|
| `depositToSpotWallet(usdc, amount)` | Bridge `deposit` / `sendUsd` etc. | USDC (6 decimals) to HL spot. |
| `withdrawFromSpotWallet(usdc, amount)` | Bridge `withdraw` / `withdrawUsd` | USDC from HL spot to `msg.sender`. |
| `getSpotBalance(user)` | Bridge balance view or API balance | Return USDC (6 decimals) for `user`. |
| `openPerpPosition(symbol, size, isLong)` | API `order` / `market_open` or future on-chain | Symbol "ETH"/"BTC"; size in asset units (HL may use different decimals). |
| `closePerpPosition(symbol)` | API close full position or equivalent | Full close for `symbol`. |
| `closePerpPosition(symbol, closeSize)` | API reduce position by `closeSize` | Partial close; same units as `openPerpPosition`. |
| `getPosition(user, symbol)` | API `user_state` / positions | Return size, collateral, entryPrice, isLong, isActive (match our units/meaning). |
| `tradeSpot(tokenIn, tokenOut, amountIn)` | API spot trade or HL spot market | Map token addresses to HL asset names; return `amountOut` in same decimals as `tokenOut`. |

Exact bridge/API names and ABI must be taken from official Hyperliquid docs; the adapter implements the translation and keeps our interface stable.

### Behavioral spec: how we know “real” matches testing

We ensure behavior is consistent in two ways.

1. **Single source of truth: IHyperliquid behavior**  
   Define what each function must do from KashYield’s perspective (preconditions, units, postconditions). The **mock** is implemented to this spec for tests. The **mainnet adapter** must be implemented to the same spec when talking to the real bridge/API. No “switching” of names in KashYield; only the implementation behind the interface changes (mock vs adapter).

2. **Behavioral expectations (summary)**  
   - **Spot:** `depositToSpotWallet` increases the user’s USDC balance on HL; `withdrawFromSpotWallet` decreases it and sends USDC to the user. `getSpotBalance(user)` returns that balance (6 decimals).  
   - **Perps:** `openPerpPosition(symbol, size, isLong)` opens or adds to a position; `closePerpPosition(symbol)` closes 100%; `closePerpPosition(symbol, closeSize)` closes that many asset units (or full if `closeSize >= size`). `getPosition` returns current size, collateral, entry price, direction, and whether the position is active.  
   - **Spot trade:** `tradeSpot(in, out, amountIn)` swaps and returns `amountOut` in the same decimals as `out`.  
   Units (e.g. size/collateral in 18 vs 8 decimals) must be documented and matched by both mock and adapter so KashYield’s math stays correct.

3. **Testing and verification**  
   - **Unit/integration tests:** Run against **MockHyperliquid**; they validate that KashYield + bot logic behave correctly for the defined interface.  
   - **Mainnet adapter:** Implement the adapter to satisfy the same behavioral spec using real HL bridge + API. Manually or via integration tests (e.g. testnet with real HL API), verify: deposit → open short → getPosition → partial/full close → withdraw, and that `getSpotBalance` / `getPosition` return values consistent with what KashYield expects (units and semantics).  
   - **Checklist:** Before mainnet, confirm each IHyperliquid function used in production has been verified against real HL (bridge + API) in a testnet or staging environment.

With this, “how we know the real functions perform the same as testing” is: **same interface and same documented behavior**; mock and adapter are two implementations of that contract; tests and a short verification checklist cover the real integration.

**Canonical interface:** The exact function signatures KashYield uses are in `contracts/KashYieldBtc.sol` and `contracts/KashYieldETH.sol` (the `interface IHyperliquid { ... }` block). Any mainnet adapter must implement that interface; no changes to KashYield are required to “switch” to real HL names.

### Real Hyperliquid (summary)

The actual integration would use:

1. **Deposit to L1** → Bridge USDC to Hyperliquid (e.g. bridge contract on Arbitrum)
2. **API** → Open/close perp positions via REST API (real HL may not expose perps on-chain)
3. **Adapter contract** that implements `IHyperliquid` and forwards to bridge/API (see above)

## Important: Hyperliquid Architecture

Hyperliquid is **NOT a typical DEX**:
- It's an L1 blockchain with its own consensus
- The "L1" contracts on Arbitrum are bridge contracts
- Actual trading happens on Hyperliquid chain
- We interact via:
  - **REST API** for orders/positions
  - **Arbitrum contracts** for deposits/withdrawals

## Implementation Options

### Option A: Mock Mode (Current)
Use `MockHyperliquid.sol` for testing logic without real positions.

### Option B: Real Hyperliquid via API
Integrate with Hyperliquid's Python/TS SDK:
```python
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

exchange = Exchange(wallet, constants.TESTNET_API_URL)
exchange.market_open("ETH", True, sz=1.7)  # Open 1.7x short
```

### Option C: Real Hyperliquid via adapter contract
KashYieldETH calls `IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount)` etc. For real HL you’d deploy an **adapter** that implements this interface and either calls the HL bridge or forwards to an API. Real HL perp opening may still require the API.

## Recommended Approach

For KASH, we recommend **hybrid approach**:

1. **Smart contract** handles deposits, batching, KashEth minting
2. **Off-chain bot** (owner-controlled initially) manages Hyperliquid positions via API
3. **Future**: On-chain integration as Hyperliquid adds more contract functionality

This is similar to how your AI trading bot works!

## Getting Testnet Funds

1. **Hyperliquid testnet USDC**: https://app.hyperliquid-testnet.xyz/drip
   - Requires same address that deposited on mainnet
   - You mentioned you have this ✓

2. **Arbitrum Sepolia ETH**: https://faucet.quicknode.com/arbitrum/sepolia
   - For gas fees

## Configuration

Add to your `.env`:
```bash
# Hyperliquid Mainnet (Production)
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
HYPERLIQUID_CLEARINGHOUSE=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
HYPERLIQUID_USDC=0xaf88d065e77c8cC2239327C5EDb3A432268e5831

# Hyperliquid Testnet
HYPERLIQUID_TESTNET_API_URL=https://api.hyperliquid-testnet.xyz
HYPERLIQUID_TESTNET_CLEARINGHOUSE=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
HYPERLIQUID_TESTNET_USDC=0xd9CBEC81df392A88AEff575E962d149d57F4d6bc

# Wallet (same as AI trading bot)
HYPERLIQUID_MAIN_WALLET_ADDRESS=0x4485716f61Db964ff03469310582f6103537c2e3
DEPLOYER_PRIVATE_KEY=0x...
```

## Testing Checklist

Before mainnet:
- [ ] Deploy to Arbitrum Sepolia
- [ ] Get testnet USDC from faucet
- [ ] Test ETH deposit flow
- [ ] Verify batch processing works
- [ ] Test Hyperliquid position opening (via API)
- [ ] Test redemption flow
- [ ] Monitor funding rate accrual

## Security Notes

1. **API Keys**: If using Hyperliquid API, store keys securely
2. **Position Monitoring**: Real positions can be liquidated
3. **Funding Rate Risk**: Can turn negative (shorts pay longs)
4. **Bridge Risk**: Funds locked during deposit/withdrawal

## Resources

- [Hyperliquid Docs](https://hyperliquid.gitbook.io/hyperliquid-docs/)
- [Python SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk)
- [Testnet Faucet](https://app.hyperliquid-testnet.xyz/drip)

---

**Updated**: 2026-02-26 - Corrected Mock/IHyperliquid API (depositToSpotWallet, openPerpPosition, etc.), testnet uses deployed MockHyperliquid; fixed Sepolia addresses to match deploy script.
