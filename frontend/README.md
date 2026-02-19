# KashYield Frontend

Beautiful, mobile-friendly web interface for the KashYield DeFi protocol.

## Where We Are

- **Frontend**: Live on Arbitrum Sepolia. Users can connect wallets, mint KASH (ETH, wETH, wBTC), and submit redeem requests. Stats, time-window status, and forms work.
- **Contracts**: KashYield and KashToken deployed. Daily batch runs in a single on-chain step: `processBatch()` values mints via Chainlink, settles redeems, mints/burns KASH, and distributes in one tx. No separate “claim” step.
- **Still needed**:
  - **Hyperliquid address**: Contract has `hyperliquidAddress` (currently unset). Owner must call `setHyperliquid(adapter)` so the bot can use `depositToHyperliquid`, `withdrawFromHyperliquid`, `openShort`, `closeShort`, etc. Use a real HL bridge/adapter or the mock for testnet.
  - **Bot batch actions**: Bot currently computes net position (mint vs redeem USD) but does **not** yet:
    - Call `processBatch()` during the processing window (23:50–23:59 UTC), or register with Chainlink Automation to do so.
    - React to `ProtocolInteraction("NET_MINT", ...)` / `("NET_REDEEM", ...)` by moving capital (e.g. deposit to Aave/Hyperliquid on net mint, withdraw/close shorts on net redeem).
  - **Chainlink Automation (optional)**: Contract exposes `checkUpkeep` / `performUpkeep` so a keeper can call `processBatch()` at 23:50 UTC without running the bot manually.

---

## Smart Contract: Current vs Older Version

| Aspect | Older version | Current (KashYield.sol) |
|--------|----------------|--------------------------|
| **Mint valuation** | Bot called `setMintValuation(user, batchCycle, amountInUSD)` | Done inside `processBatch()` using Chainlink oracles (`getTokenUSD`) |
| **NAV** | Bot called `updateNAV(newNAV)` before batch | NAV used in batch is `currentNAV`; bot can still call `updateNAV()` for daily updates if desired |
| **Distribution** | Users called `claimTokens()` after batch | No claim: `processBatch()` mints KASH to minters and sends tokens to redeemers in the same tx |
| **Batch entrypoint** | Bot did multi-step: set valuations → updateNAV → processBatch / claim | Single `processBatch()`: values mints, burns redeemed KASH, mints/sends, marks batch processed |
| **Time window** | Possibly owner-only | `processBatch()` is `onlyProcessingWindow` (23:50–23:59 UTC); anyone or Chainlink can call |
| **Hyperliquid** | Same idea | `hyperliquidAddress` stored on contract; all HL functions require it to be set via `setHyperliquid()` |

The frontend and bot should target this current contract behavior (single-step batch, no claim flow).

---

## Smart Contract: What You Can Change Without Redeploying

The contract is **not upgradeable** (no proxy pattern). You must **redeploy** for any change to logic or to storage layout (new state variables, new functions, different batch flow, etc.).

You **do not** need to redeploy for these (owner-only setters):

| What | Function | Notes |
|------|----------|--------|
| Aave pool | `setAavePool(address)` | Switch to mock or different Aave pool |
| Hyperliquid adapter | `setHyperliquid(address)` | Set HL bridge/adapter (or 0 to disable) |
| Token addresses | `setTokenAddresses(weth, wbtc, usdt, usdc)` | wETH, wBTC, USDT, USDC |
| Oracle per token | `setOracle(token, oracle)` | Chainlink feed for a token |
| Token decimals | `setTokenDecimals(token, decimals)` | If you add a new token |
| Protocol fee | `setFeeBps(uint256)` | 0–100 (0–1%); default 3 (0.03%) |
| Pause | `pause()` / `unpause()` | Emergency pause user actions |

So: any **configuration** (addresses, oracles, fee, pause) can be updated in place. Only **new behavior or new data** requires a new deployment.

---

## Features

- 📱 **Mobile-First Design** - Fully responsive with Tailwind CSS
- 🔗 **Wallet Integration** - Connect with RainbowKit (MetaMask, WalletConnect, etc.)
- 💰 **Mint & Redeem** - Easy-to-use forms for minting KASH and redeeming assets
- 📊 **Real-Time Stats** - Live NAV, fees, and balance tracking
- ⏰ **Status Indicators** - Shows user/processing window status
- 🎨 **Modern UI** - Clean gradient design with smooth animations

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env.local` file:

```env
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id_here
```

Get your WalletConnect Project ID from: https://cloud.walletconnect.com/

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Styling**: Tailwind CSS
- **Web3**: wagmi + viem + RainbowKit
- **Network**: Arbitrum Sepolia Testnet

## Contract Addresses (Arbitrum Sepolia)

- **KashYield**: `0x4C3910E93aB0c5983c6DEE003749485E525E5Db7`
- **KashToken**: `0x3461e725Fb77ead9a4FD22A10e0f0c9373156297`

(Source: `lib/contracts/addresses.ts` and deployment artifacts.)

## Features

### Mint KASH
1. Select your deposit token (ETH, wETH, wBTC)
2. Enter amount
3. Approve (if ERC20)
4. Submit mint request
5. Wait for batch processing (23:50 UTC)

### Redeem Assets
1. Select your desired output token (ETH, wETH, wBTC)
2. Enter KASH amount to redeem
3. Approve KASH
4. Submit redeem request
5. Wait for batch processing (23:50 UTC)

## Time Windows

- **User Window**: 00:00 - 23:50 UTC (submit requests)
- **Processing Window**: 23:50 - 23:59 UTC (batch processing; `processBatch()` can be called)

## Build for Production

```bash
npm run build
npm start
```

## Deploy

### Vercel (Recommended)
```bash
vercel
```

### Docker
```bash
docker build -t kashyield-frontend .
docker run -p 3000:3000 kashyield-frontend
```

## Folder Structure

```
frontend/
├── app/
│   ├── layout.tsx       # Root layout with providers
│   ├── page.tsx         # Main page
│   └── globals.css      # Global styles
├── components/
│   ├── MintForm.tsx     # Mint KASH form
│   ├── RedeemForm.tsx   # Redeem assets form
│   ├── StatsCard.tsx    # Stats display
│   ├── StatusIndicator.tsx # Window status
│   └── Providers.tsx    # Web3 providers
└── lib/
    ├── wagmi.ts         # Wagmi configuration
    └── contracts/
        ├── addresses.ts      # Contract addresses
        ├── kashYieldABI.ts   # KashYield ABI
        └── kashTokenABI.ts   # KashToken ABI
```

## Troubleshooting

### Wallet not connecting
- Make sure you're on Arbitrum Sepolia network
- Check WalletConnect Project ID is set
- Try clearing browser cache

### Transactions failing
- Ensure you're in user window (not processing window)
- Check you have enough testnet ETH for gas
- Verify token allowances are approved

### Contract not found
- Verify network is Arbitrum Sepolia (Chain ID: 421614)
- Check contract addresses in `lib/contracts/addresses.ts`

## Support

- Contract Explorer: https://sepolia.arbiscan.io/address/0x4C3910E93aB0c5983c6DEE003749485E525E5Db7
- Get Testnet ETH: https://www.alchemy.com/faucets/arbitrum-sepolia
