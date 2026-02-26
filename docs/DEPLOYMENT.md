# KashYield Deployment Guide

## Prerequisites

1. **Node.js & npm** – Installed and in use
2. **Hardhat** – Configured in repo (use supported Node version; Hardhat may warn on Node 25+)
3. **dotenv** – Install if not present: `npm install dotenv`

## Environment Setup

Create a `.env` file in the root with:

```env
# Private Key (DO NOT COMMIT - ADD .env TO .gitignore)
PRIVATE_KEY=your_private_key_here

# RPC URLs (optional - defaults provided)
ARBITRUM_SEPOLIA_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/YOUR_API_KEY
ARBITRUM_ONE_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Arbiscan API Key (for verification)
ARBISCAN_API_KEY=your_arbiscan_api_key

# Gas Reporter (optional)
REPORT_GAS=false
```

## Get Testnet Funds

### Arbitrum Sepolia ETH

1. Get Sepolia ETH from a faucet (e.g. https://sepoliafaucet.com/)
2. Bridge to Arbitrum Sepolia: https://bridge.arbitrum.io/?l2ChainId=421614

**Or** use direct Arbitrum Sepolia faucets:

- https://www.alchemy.com/faucets/arbitrum-sepolia  
- https://faucet.quicknode.com/arbitrum/sepolia  

---

# Deployment checklist (KashYieldETH now, KashYieldBTC later)

## Recovering ETH from the old (pre-rename) contract

If the **old** deployed contract (e.g. at `0x4C39...`) still holds ETH and you are the owner:

- **New KashYieldETH** has `ownerWithdrawEth(uint256 amount)` (onlyOwner). After you deploy the new contract, use this to withdraw excess ETH from the **new** deployment when needed.
- **Old contract** may not have this. Options:
  1. Check the old contract’s ABI: if it has an owner-only withdraw/rescue function, call it (e.g. via cast or Hardhat script).
  2. If there is no such function, you can only reduce the balance by processing **redemptions**. Once migrated to KashYieldETH, you can pause the old contract (if it has `pause`) and treat any remaining ETH as unrecoverable unless you have an older build with a rescue function.

## Now: ETH product only

Deploy in either order. **Recommended:** deploy MockHyperliquid first so you have its address, then deploy KashYieldETH, then set the HL address on KashYieldETH.

### 1. Test locally first

```bash
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.js
```

### 2. Deploy MockHyperliquid (optional; do this first if you want HL on testnet)

```bash
npx hardhat run scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js --network arbitrumSepolia
```

Save the **MockHyperliquid** address. (Use the same USDC/USDT/wBTC addresses as KashYieldETH / frontend, or the script’s defaults.)

### 3. Deploy KashYieldETH

```bash
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumSepolia
```

Save the printed **KashYieldETH** and **KashTokenEth** addresses. (KashTokenEth is created in the constructor.)

### 4. Configure KashYieldETH

- **Set Hyperliquid** (use the MockHyperliquid address from step 2 or your real HL adapter):

  ```bash
  # .env: KASH_YIELD_ADDRESS=<KashYieldETH from step 3>, HYPERLIQUID_ADDRESS=<MockHyperliquid from step 2>
  npx hardhat run scripts/setHyperliquid.js --network arbitrumSepolia
  ```

- **Set Aave pool** (if different from built-in):

  ```bash
  npx hardhat run scripts/setAavePool.js --network arbitrumSepolia
  ```

### 5. Verify contracts on Arbiscan

```bash
# Verify KashYieldETH (use your deployed address and constructor args if required)
npx hardhat verify --network arbitrumSepolia KASH_YIELD_ETH_ADDRESS

# Verify KashTokenEth (if deployed separately)
npx hardhat verify --network arbitrumSepolia KASH_TOKEN_ETH_ADDRESS

# Verify MockHyperliquid (with constructor args as in your deploy script)
npx hardhat verify --network arbitrumSepolia MOCK_HYPER_ADDRESS USDC_ADDRESS USDT_ADDRESS WBTC_ADDRESS
```

### 6. Update frontend

In **`frontend/lib/contracts/addresses.ts`** set:

- `kashYieldEth`: deployed KashYieldETH address (from step 3)
- `kashTokenEth`: deployed KashTokenEth address (from step 3)

### 7. Bot

In **`bot/.env`** set:

- `KASH_YIELD_ADDRESS` = KashYieldETH address
- `KASH_TOKEN_ADDRESS` = KashTokenEth address (if the bot uses it)

No bot code changes: it already handles the flow (spot buy/sell, ETH vs BTC by asset). When you add KashYieldBTC later, run `processBatch()` on both contracts and handle each contract’s events.

### 8. Frontend – BTC minting

- **Mint:** Only ETH and wETH are offered; wBTC is disabled with “wBTC (KASH_BTC) coming soon.”
- **Redeem:** Users can redeem KASH_ETH for ETH, wETH, or wBTC (unchanged).

---

## Later: BTC product

1. Deploy **KashYieldBTC** and **KashToken_BTC** (clone of KashYieldETH for wBTC-only).
2. Update frontend: add `kashYieldBtc` / `kashTokenBtc` to addresses; add wBTC to mint tokens in `MintForm`; in RedeemForm, use KASH_BTC when user selects “Receive wBTC.”
3. Bot: call `processBatch()` on both KashYieldETH and KashYieldBTC; handle NET_MINT/NET_REDEEM from each (asset = ETH vs BTC).

---

## Post-deployment checklist

- [ ] Save deployment addresses (e.g. from script output or `./deployments/` if used)
- [ ] Verify all contracts on Arbiscan
- [ ] Test mint/redeem via Etherscan or scripts
- [ ] Monitor time windows (user window vs processing window)
- [ ] Test batch processing after 24 hours
- [ ] Frontend and bot `.env` / addresses updated as above

## Useful commands

```bash
# Check account balance
npx hardhat run scripts/checkBalance.js --network arbitrumSepolia

# Interact with deployed contract
npx hardhat console --network arbitrumSepolia

# Clean artifacts and cache
npx hardhat clean

# Get current NAV
npx hardhat run scripts/getNAV.js --network arbitrumSepolia
```

## Network details

### Arbitrum Sepolia

- **Chain ID**: 421614  
- **RPC**: https://sepolia-rollup.arbitrum.io/rpc  
- **Explorer**: https://sepolia.arbiscan.io  
- **Faucet**: https://www.alchemy.com/faucets/arbitrum-sepolia  

### Arbitrum One (mainnet)

- **Chain ID**: 42161  
- **RPC**: https://arb1.arbitrum.io/rpc  
- **Explorer**: https://arbiscan.io  

## Troubleshooting

### "Insufficient funds"

- Get more testnet ETH from the faucets above.
- Check balance: `npx hardhat run scripts/checkBalance.js --network arbitrumSepolia`

### "Invalid nonce"

- Reset account in MetaMask: Settings → Advanced → Reset Account.

### "Stack too deep" when compiling

- Ensure `hardhat.config.js` has `viaIR: true` in `solidity.settings` (and optimizer enabled).

### Contract verification fails

- Constructor arguments must match exactly.
- Wait a few minutes after deployment before verifying.
- Confirm Arbiscan API key and network.

## Security notes

- Never commit `.env` or private keys.
- Use a separate test wallet for testnets.
- Audit contracts before mainnet.
- Test on testnet thoroughly (e.g. at least one week).
- Consider a professional security audit before mainnet.
