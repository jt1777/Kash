# Architecture Changes: Bot-Calculated Pricing

## Overview

The KashYield contract has been refactored to remove on-chain price feed dependencies. All pricing and valuation is now handled by the off-chain bot during daily batch processing.

## Key Changes

### 1. Removed Dependencies
- ❌ `IChainlinkPriceFeed` interface
- ❌ `priceFeeds` mapping
- ❌ `setPriceFeed()` function
- ❌ `getTokenValueInUSD()` function (removed Chainlink calls)
- ❌ `getUSDValueInToken()` function (removed Chainlink calls)

### 2. Updated Data Structures

**MintRequest** (Before):
```solidity
struct MintRequest {
    address user;
    address tokenIn;
    uint256 amountIn;
    uint256 expectedKashAmount;  // Calculated on-chain
    uint256 batchCycle;
    bool claimed;
}
```

**MintRequest** (After):
```solidity
struct MintRequest {
    address user;
    address tokenIn;
    uint256 amountIn;
    uint256 amountInUSD;  // Set by bot during processing
    uint256 batchCycle;
    bool claimed;
}
```

**RedeemRequest** (Before):
```solidity
struct RedeemRequest {
    address user;
    uint256 kashAmount;
    address tokenOut;
    uint256 expectedAmountOut;  // Calculated on-chain
    uint256 batchCycle;
    bool claimed;
}
```

**RedeemRequest** (After):
```solidity
struct RedeemRequest {
    address user;
    uint256 kashAmount;
    address tokenOut;
    uint256 batchCycle;
    bool claimed;
}
```

### 3. New State Variables
- ✅ `mapping(uint256 => uint256) public batchNAV` - Stores NAV for each batch

### 4. New Functions
- ✅ `setMintValuation(address user, uint256 batchCycle, uint256 amountInUSD)` - Bot sets USD value for deposits

### 5. Updated Functions

**`requestMint()`**:
- No longer calculates `expectedKashAmount` on-chain
- Just stores the deposit amount
- Bot will value it later

**`requestRedeem()`**:
- No longer calculates `expectedAmountOut` on-chain
- Just stores the Kash amount and desired output token

**`claimTokens()`**:
- Calculates Kash amount using: `(amountInUSD * 1e18) / batchNAV[batchCycle]`
- Uses stored batch NAV for consistent pricing

**`processBatch()`**:
- Now stores `batchNAV[batchCycle] = currentNAV` for future claims
- Changed to `onlyOwner` (bot calls it)

## New Flow

### Old Flow (With Chainlink):
1. User calls `requestMint()` → Contract queries Chainlink → Calculates expected Kash
2. User calls `requestRedeem()` → Contract queries Chainlink → Calculates expected output
3. Batch processes
4. Users claim exact amounts calculated at request time (even if stale)

### New Flow (Bot Pricing):
1. User calls `requestMint()` → Contract just stores deposit amount
2. User calls `requestRedeem()` → Contract just stores Kash amount
3. **Bot values all deposits** using real-time prices → Calls `setMintValuation()`
4. **Bot calculates portfolio NAV** → Calls `updateNAV()`
5. **Bot calls `processBatch()`** → Stores batch NAV
6. Users claim → Amounts calculated using **batch NAV** (consistent, fair pricing)

## Benefits

### 1. **No Oracle Manipulation Risk**
- No on-chain price feeds to manipulate
- Bot uses multiple price sources for accuracy

### 2. **True End-of-Day Pricing**
- Works like real-world funds
- Everyone gets the same NAV for a given batch
- Fair pricing based on actual portfolio value at settlement time

### 3. **Gas Savings**
- No Chainlink oracle calls during user transactions
- Cheaper `requestMint()` and `requestRedeem()` operations

### 4. **Flexibility**
- Bot can use any price source (Chainlink, Pyth, DEX TWAPs, CEX prices)
- Can implement sophisticated pricing logic off-chain
- Can handle edge cases (depegged stablecoins, illiquid assets, etc.)

### 5. **Simpler Contract**
- Fewer dependencies
- Cleaner code
- Easier to audit

## Bot Responsibilities

The off-chain bot now handles:

1. **Price Fetching** (23:50 UTC)
   - Query real-time prices for all deposited assets
   - Use Chainlink, Pyth, or other reliable sources
   - Implement sanity checks and circuit breakers

2. **Deposit Valuation** (23:50 - 23:52 UTC)
   - For each mint request, calculate USD value
   - Call `setMintValuation()` for each user
   - Ensure all deposits are valued before processing

3. **Portfolio NAV Calculation** (23:50 - 23:52 UTC)
   - Query all protocol positions (Aave, Hyperliquid)
   - Calculate total assets and liabilities
   - Compute NAV = (Assets - Liabilities) / Kash Supply

4. **NAV Update** (23:52 - 23:55 UTC)
   - Call `updateNAV()` with calculated value

5. **Protocol Interactions** (23:55 - 23:57 UTC)
   - Execute rebalancing operations
   - Deploy capital from mints
   - Free up capital for redeems

6. **Batch Settlement** (23:57 - 23:59 UTC)
   - Call `processBatch()` to finalize

## Migration Notes

### For Testing:
- Mock price feeds no longer needed in tests
- Tests should mock bot's valuation calls instead
- Update test expectations for new flow

### For Deployment:
- No need to deploy or configure price feed contracts
- Bot needs access to reliable price APIs
- Bot needs sufficient ETH for gas

### For Frontend:
- Can show "indicative" prices to users during requests
- Final amounts depend on batch processing NAV
- Display historical NAV for transparency

## Security Considerations

### Centralization Risk:
- Bot now has significant control (sets valuations)
- Mitigation: Multi-sig for bot wallet, monitoring, circuit breakers

### Price Manipulation:
- Bot could set incorrect valuations
- Mitigation: 
  - Use multiple price sources
  - Implement bounds checking
  - Public monitoring of bot operations
  - Eventually move to decentralized oracle network

### Bot Failure:
- If bot fails, batch doesn't process
- Mitigation:
  - Redundant bot instances
  - Fallback mechanisms
  - Emergency procedures for manual intervention

## Next Steps

1. ✅ Update smart contracts (DONE)
2. ✅ Update deployment scripts (DONE)
3. ✅ Update documentation (DONE)
4. ⏳ Update test suite to match new flow
5. ⏳ Implement bot with pricing logic
6. ⏳ Add monitoring and alerting
7. ⏳ Security audit with new architecture
