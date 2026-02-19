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
| `Hyperliquid Deposit Bridge` | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` | Same address on testnet |
| `USDC` | `0xd9CBEC81df392A88AEff575E962d149d57F4d6bc` | Testnet USDC |

**Note:** The trading bot uses Hyperliquid's REST API, not direct contract calls for trading. The bridge contract is only used for deposits/withdrawals.

## Hyperliquid Interaction Flow

### Current (Mock)
Our `MockHyperliquid.sol` simulates:
```solidity
function depositCollateralAndOpenShort(usdcAmount, positionSize, user)
function closePosition(user) returns (collateralReturned, pnl)
function getPositionFunding(user) returns fundingAmount
```

### Real Hyperliquid
The actual integration would use:

1. **Deposit to L1** → Bridge USDC to Hyperliquid
2. **API Calls** → Open/close positions via REST API
3. **Or** → Direct contract calls to Clearinghouse

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

### Option C: Real Hyperliquid via Contracts
Direct contract calls (limited functionality):
```solidity
// Deposit to Hyperliquid L1
IClearinghouse(clearinghouse).deposit(usdcAmount);
// Note: Opening positions requires API, not direct contract calls
```

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

**Updated**: 2026-02-19 - Added actual contract addresses from Nova's AI Trading Bot project
