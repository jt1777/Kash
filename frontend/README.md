# KashYield Frontend

Beautiful, mobile-friendly web interface for the KashYield DeFi protocol.

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

- **KashYield**: `0xc4aF7357c36DE37da8183ACeebe8519d4cd1e310`
- **KashToken**: `0xb6a74Fb6Bb240e754237982F1943cAd77361d554`

## Features

### Mint KASH
1. Select your deposit token (ETH, USDC, USDT, wETH, wBTC)
2. Enter amount
3. Approve (if ERC20)
4. Submit mint request
5. Wait for batch processing (23:50 UTC)

### Redeem Assets
1. Select your desired output token
2. Enter KASH amount to redeem
3. Approve KASH
4. Submit redeem request
5. Wait for batch processing (23:50 UTC)

## Time Windows

- **User Window**: 00:00 - 23:50 UTC (submit requests)
- **Processing Window**: 23:50 - 23:59 UTC (batch processing)

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

- Contract Explorer: https://sepolia.arbiscan.io/address/0xc4aF7357c36DE37da8183ACeebe8519d4cd1e310
- Get Testnet ETH: https://www.alchemy.com/faucets/arbitrum-sepolia
