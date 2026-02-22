import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { calculateNetPosition } from './calculateNetPosition';
import { getDailyYield } from './dailyYield';

// Token addresses from config (Arbitrum Sepolia)
const TOKEN_ADDRESSES = {
  ETH: config.tokens.ETH,
  WETH: config.tokens.WETH,
  WBTC: config.tokens.WBTC,
  USDT: config.tokens.USDT,
  USDC: config.tokens.USDC,
};

// Aave V3 Pool address from config (Arbitrum Sepolia)
const AAVE_POOL_ADDRESS = config.aavePoolAddress;

/**
 * Batch Processor - Handles daily batch processing and capital deployment
 * 
 * Flow:
 * 1. Wait for processing window (23:50-23:59 UTC)
 * 2. Call processBatch() on the contract
 * 3. Listen for ProtocolInteraction events
 * 4. Execute capital deployment (NET_MINT) or withdrawal (NET_REDEEM)
 */
export class BatchProcessor {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private kashYield: ethers.Contract;

  constructor(provider: ethers.Provider, signer: ethers.Signer) {
    this.provider = provider;
    this.signer = signer;
    this.kashYield = new ethers.Contract(
      config.kashYieldAddress,
      kashYieldABI,
      signer
    );
  }

  /**
   * Main entry point - runs the batch processor
   */
  async run(): Promise<void> {
    console.log('🚀 Starting Batch Processor...\n');

    // Check if we're in the processing window
    const isProcessingWindow = await this.kashYield.isProcessingWindow();
    if (!isProcessingWindow) {
      console.log('⏳ Not in processing window (23:50-23:59 UTC)');
      console.log('   Waiting for processing window...');
      await this.waitForProcessingWindow();
    }

    // Get yesterday's batch cycle
    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    const batchCycle = currentCycle - 1n;
    console.log(`📅 Processing batch cycle: ${batchCycle}\n`);

    // Check if already processed
    const batchInfo = await this.kashYield.getBatchInfo(batchCycle);
    if (batchInfo.processed) {
      console.log(`✅ Batch ${batchCycle} already processed`);
      console.log(`   Total Mint USD: ${ethers.formatEther(batchInfo.totalMintUSD)}`);
      console.log(`   Total Redeem USD: ${ethers.formatEther(batchInfo.totalRedeemUSD)}`);
      return;
    }

    // Show estimated net position if batch not yet processed
    if (!batchInfo.processed) {
      const mintCount = Number(batchInfo.mintUsersCount);
      const redeemCount = Number(batchInfo.redeemUsersCount);
      
      if (mintCount > 0 || redeemCount > 0) {
        try {
          const estimatedPosition = await calculateNetPosition(this.provider, batchCycle);
          console.log(`📊 Estimated Net Position (pending): ${ethers.formatEther(estimatedPosition.netPositionUSD)} USD`);
          console.log(`   Mints: ${estimatedPosition.mintCount} users, ${ethers.formatEther(estimatedPosition.totalMintUSD)} USD`);
          console.log(`   Redeems: ${estimatedPosition.redeemCount} users, ${ethers.formatEther(estimatedPosition.totalRedeemUSD)} USD\n`);
        } catch (error: any) {
          console.log(`⚠️  Could not calculate estimated position: ${error.message}\n`);
        }
      }
    }

    const netPositionUSD = BigInt(batchInfo.totalMintUSD.toString()) - BigInt(batchInfo.totalRedeemUSD.toString());
    console.log(`📊 Stored Net Position: ${ethers.formatEther(netPositionUSD)} USD`);
    console.log(`   Mints: ${ethers.formatEther(batchInfo.totalMintUSD)} USD`);
    console.log(`   Redeems: ${ethers.formatEther(batchInfo.totalRedeemUSD)} USD\n`);

    // Daily yield: Aave supply earned, Aave borrow cost, HL funding → net (used to update NAV before redeems)
    const dailyYield = await getDailyYield(this.provider, {
      kashYield: this.kashYield,
      aavePoolAddress: AAVE_POOL_ADDRESS,
      aaveUserAddress: config.aaveUserAddress || config.kashYieldAddress,
    });
    console.log(`📈 Daily yield (net used for NAV before redeem):`);
    console.log(`   Aave supply earned: ${ethers.formatEther(dailyYield.aaveSupplyEarned)} USD`);
    console.log(`   Aave borrow cost:   ${ethers.formatEther(dailyYield.aaveBorrowCost)} USD`);
    console.log(`   HL funding:        ${ethers.formatEther(dailyYield.hlFunding)} USD (positive = we receive)`);
    console.log(`   Net yield:         ${ethers.formatEther(dailyYield.netYield)} USD\n`);
    // To reflect this in redeems: compute newNAV = (portfolioValueUSD + netYield) / totalKashSupply and call updateNAV(newNAV) before processBatch.

    // Call processBatch
    try {
      console.log('🔄 Calling processBatch()...');
      const tx = await this.kashYield.processBatch();
      console.log(`   Transaction: ${tx.hash}`);
      
      const receipt = await tx.wait();
      console.log(`   ✅ Batch processed in block ${receipt.blockNumber}\n`);

      // Parse ProtocolInteraction events from receipt (primary path)
      await this.handleEventsFromReceipt(receipt);

    } catch (error: any) {
      console.error('❌ Failed to process batch:', error.message);
      throw error;
    }
  }

  /**
   * Wait for the processing window (23:50-23:59 UTC)
   */
  private async waitForProcessingWindow(): Promise<void> {
    return new Promise(async (resolve) => {
      const checkWindow = async () => {
        const isWindow = await this.kashYield.isProcessingWindow();
        if (isWindow) {
          console.log('✅ Processing window is now open!\n');
          resolve();
        } else {
          // Check again in 30 seconds
          setTimeout(checkWindow, 30000);
        }
      };
      
      checkWindow();
    });
  }

  /**
   * Parse ProtocolInteraction events from transaction receipt
   * This is the primary path for handling events (more reliable than listener)
   */
  private async handleEventsFromReceipt(receipt: ethers.TransactionReceipt): Promise<void> {
    console.log('📡 Parsing ProtocolInteraction events from receipt...\n');

    // Create interface for decoding logs
    const iface = new ethers.Interface(kashYieldABI);
    
    let eventsFound = 0;

    for (const log of receipt.logs) {
      try {
        // Only process logs from our contract
        if (log.address.toLowerCase() !== config.kashYieldAddress.toLowerCase()) {
          continue;
        }

        const parsedLog = iface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });

        if (parsedLog && parsedLog.name === 'ProtocolInteraction') {
          eventsFound++;
          const action = parsedLog.args[0] as string;
          const asset = parsedLog.args[1] as string;
          const amount = parsedLog.args[2] as bigint;

          console.log(`📡 ProtocolInteraction Event:`);
          console.log(`   Action: ${action}`);
          console.log(`   Asset: ${asset}`);
          console.log(`   Amount: ${ethers.formatEther(amount)}\n`);

          if (action === 'NET_MINT') {
            await this.handleNetMint(amount, asset);
          } else if (action === 'NET_REDEEM') {
            await this.handleNetRedeem(amount, asset);
          }
        }
      } catch (error) {
        // Log might not be from our contract or not decodable
        continue;
      }
    }

    if (eventsFound === 0) {
      console.log('⚠️  No ProtocolInteraction events found in receipt\n');
    } else {
      console.log(`✅ Processed ${eventsFound} ProtocolInteraction event(s)\n`);
    }
  }

  /**
   * Set up listener for ProtocolInteraction events (fallback for long-running mode)
   */
  private setupEventListener(): void {
    console.log('👂 Setting up ProtocolInteraction event listener (fallback mode)...\n');

    this.kashYield.on('ProtocolInteraction', async (action: string, asset: string, amount: bigint, event: any) => {
      console.log(`📡 ProtocolInteraction Event (from listener):`);
      console.log(`   Action: ${action}`);
      console.log(`   Asset: ${asset}`);
      console.log(`   Amount: ${ethers.formatEther(amount)}\n`);

      if (action === 'NET_MINT') {
        await this.handleNetMint(amount, asset);
      } else if (action === 'NET_REDEEM') {
        await this.handleNetRedeem(amount, asset);
      }
    });
  }

  /**
   * Handle NET_MINT - Deploy capital to earn yield
   *
   * Strategy (net mints vs redemptions):
   * 1. Send the actual net-deposited asset to Aave (ETH→wETH, wETH, or wBTC). No conversion to USDC.
   * 2. Borrow 70% of that deposit’s USD value as USDC and send to Hyperliquid as collateral.
   * 3. Open a 1.7x short on Hyperliquid in the same asset (ETH or wBTC) as was minted.
   *
   * @param amount Net mint amount in USD (18 decimals)
   * @param asset Asset address (ETH=0x0, wETH, or wBTC) – contract may emit 0x0; we treat as ETH/wETH
   */
  private async handleNetMint(amount: bigint, asset: string): Promise<void> {
    console.log('💰 Handling NET_MINT - Deploying capital...');
    console.log(`   Net amount: ${ethers.formatEther(amount)} USD\n`);

    try {
      const assetSymbol = await this.getAssetSymbol(asset);
      console.log(`   Asset: ${assetSymbol}`);

      // Step 1: Deposit configured % of net to Aave (default 100%) in same asset. No conversion to USDC.
      const pct = BigInt(config.strategy.aaveDepositPct);
      const depositAmountUSD = (amount * pct) / 100n;
      const depositAsset = (asset === ethers.ZeroAddress) ? TOKEN_ADDRESSES.WETH : asset;
      const depositTokenAmount = await this.usdToTokenAmount(depositAsset, depositAmountUSD);
      console.log(`   Step 1: Deposit ${config.strategy.aaveDepositPct}% (${ethers.formatEther(depositAmountUSD)} USD) of ${assetSymbol} to Aave`);
      await this.depositToAave(depositAsset, depositTokenAmount);

      // Step 2: Borrow 70% of deposit’s USD value as USDC, send to Hyperliquid as collateral
      const ltv = BigInt(config.strategy.borrowLtvPct);
      const borrowAmountUSD = (depositAmountUSD * ltv) / 100n;
      const borrowTokenAmount = await this.usdToTokenAmount(TOKEN_ADDRESSES.USDC, borrowAmountUSD);
      console.log(`   Step 2: Borrow ${config.strategy.borrowLtvPct}% (${ethers.formatEther(borrowAmountUSD)} USD) as USDC, send to Hyperliquid`);
      await this.borrowFromAave(TOKEN_ADDRESSES.USDC, borrowTokenAmount);
      await this.depositToHyperliquid(borrowTokenAmount);

      // Step 2b: Spot buy ETH or BTC on Hyperliquid (USDC → asset) so we can short that asset
      const spotBuyTokenOut = this.getSpotAssetAddress(asset);
      console.log(`   Step 2b: Spot buy ${assetSymbol} on Hyperliquid with borrowed USDC`);
      await this.spotBuyOnHyperliquid(spotBuyTokenOut, borrowTokenAmount);

      // Step 3: Open short on Hyperliquid: notional = configured leverage × net mint (default 1.7x)
      const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
      const shortSizeUSD = (amount * leverageScaled) / 100n;
      console.log(`   Step 3: Open ${config.strategy.shortLeverage}x short: ${ethers.formatEther(shortSizeUSD)} USD notional in ${assetSymbol}`);
      await this.openShortOnHyperliquid(shortSizeUSD, asset);

      console.log('   ✅ NET_MINT capital deployment complete!\n');

      console.log('📊 Summary:');
      console.log(`   Aave: ${config.strategy.aaveDepositPct}% = ${ethers.formatEther(depositAmountUSD)} USD in ${assetSymbol}`);
      console.log(`   Borrow ${config.strategy.borrowLtvPct}% → USDC to Hyperliquid`);
      console.log(`   Short ${config.strategy.shortLeverage}x: ${ethers.formatEther(shortSizeUSD)} USD in ${assetSymbol}\n`);

    } catch (error: any) {
      console.error('❌ Failed to handle NET_MINT:', error.message);
      throw error;
    }
  }

  /**
   * Handle NET_REDEEM - Withdraw capital to fulfill redemptions
   *
   * Strategy (reverse of NET_MINT). Order matters:
   * 1. Close Hyperliquid short in same asset (ETH or BTC).
   * 2. Withdraw collateral (USDC) from Hyperliquid.
   * 3. Repay Aave borrow with that USDC. Only after the borrow is repaid can we withdraw collateral from Aave.
   * 4. Withdraw the original asset (wETH or wBTC) from Aave so the contract can redeem users.
   *
   * @param amount Net redeem amount in USD (18 decimals)
   * @param asset Asset address (ETH=0x0, wETH, or wBTC)
   */
  private async handleNetRedeem(amount: bigint, asset: string): Promise<void> {
    console.log('💸 Handling NET_REDEEM - Withdrawing capital...');
    console.log(`   Net amount: ${ethers.formatEther(amount)} USD\n`);

    try {
      const assetSymbol = await this.getAssetSymbol(asset);
      console.log(`   Asset: ${assetSymbol}`);

      // Step 1: Close Hyperliquid short in same asset (ETH or BTC)
      console.log(`   Step 1: Close ${assetSymbol} short on Hyperliquid`);
      await this.closeShortOnHyperliquid(asset);

      // Step 1b: Spot sell ETH or BTC on Hyperliquid (asset → USDC) before withdrawing USDC
      const ltv = BigInt(config.strategy.borrowLtvPct);
      const usdcToWithdrawUSD = (amount * ltv) / 100n;
      const spotSellTokenIn = this.getSpotAssetAddress(asset);
      const spotSellAmount = await this.usdToTokenAmount(
        asset === ethers.ZeroAddress ? TOKEN_ADDRESSES.WETH : asset,
        usdcToWithdrawUSD
      );
      console.log(`   Step 1b: Spot sell ${assetSymbol} to USDC on Hyperliquid: ${ethers.formatEther(spotSellAmount)} units`);
      await this.spotSellOnHyperliquid(spotSellTokenIn, spotSellAmount);

      // Step 2: Withdraw collateral (USDC) from Hyperliquid (same % as borrow LTV)
      const usdcWithdrawAmount = await this.usdToTokenAmount(TOKEN_ADDRESSES.USDC, usdcToWithdrawUSD);
      console.log(`   Step 2: Withdraw collateral (USDC) from Hyperliquid: ${ethers.formatEther(usdcToWithdrawUSD)} USD (${usdcWithdrawAmount} USDC units)`);
      await this.withdrawFromHyperliquid(usdcWithdrawAmount);

      // Step 3: Repay Aave borrow with that USDC (must be done before withdrawing our collateral from Aave)
      console.log(`   Step 3: Repay Aave borrow with USDC`);
      await this.repayToAave(TOKEN_ADDRESSES.USDC, usdcWithdrawAmount);

      // Step 4: Withdraw original asset from Aave (only after borrow is repaid)
      const withdrawAsset = (asset === ethers.ZeroAddress) ? TOKEN_ADDRESSES.WETH : asset;
      const withdrawTokenAmount = await this.usdToTokenAmount(withdrawAsset, amount);
      console.log(`   Step 4: Withdraw ${ethers.formatEther(amount)} USD worth of ${assetSymbol} from Aave (redeem users)`);
      await this.withdrawFromAave(withdrawAsset, withdrawTokenAmount);

      console.log('   ✅ NET_REDEEM capital withdrawal complete!\n');

      // Note: The actual payout to users is handled by the contract in processBatch()
      // The bot just needs to ensure sufficient liquidity is available

    } catch (error: any) {
      console.error('❌ Failed to handle NET_REDEEM:', error.message);
      throw error;
    }
  }

  /**
   * Get the symbol for an asset address (for display)
   */
  private async getAssetSymbol(asset: string): Promise<string> {
    if (asset === ethers.ZeroAddress) return 'ETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) return 'WETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WBTC.toLowerCase()) return 'WBTC';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.USDT.toLowerCase()) return 'USDT';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.USDC.toLowerCase()) return 'USDC';
    return 'UNKNOWN';
  }

  /**
   * Map asset address to Hyperliquid perp symbol (same asset as deposit: ETH or BTC)
   */
  private getShortSymbol(asset: string): string {
    if (asset === ethers.ZeroAddress) return 'ETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) return 'ETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WBTC.toLowerCase()) return 'BTC';
    return 'ETH'; // default when contract emits address(0)
  }

  /**
   * Map asset to spot token address for HL: ETH = address(0), BTC = wBTC
   */
  private getSpotAssetAddress(asset: string): string {
    if (asset === ethers.ZeroAddress) return ethers.ZeroAddress;
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) return ethers.ZeroAddress;
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WBTC.toLowerCase()) return TOKEN_ADDRESSES.WBTC;
    return ethers.ZeroAddress;
  }

  /**
   * Convert USD (18 decimals) to token amount using contract oracle
   */
  private async usdToTokenAmount(token: string, usdAmount: bigint): Promise<bigint> {
    if (usdAmount === 0n) return 0n;
    const tokenAmount = await this.kashYield.calculateTokenAmount(token, usdAmount);
    return BigInt(tokenAmount.toString());
  }

  // ============================================================================
  // Protocol Interaction Functions (contract expects token amounts, not USD)
  // ============================================================================

  /**
   * Deposit asset to Aave (amount in token units, e.g. wei for WETH)
   */
  private async depositToAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling depositToAave(${asset}, ${ethers.formatEther(amount)} token units)`);
    const tx = await this.kashYield.depositToAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Deposited to Aave`);
  }

  /**
   * Withdraw asset from Aave
   */
  private async withdrawFromAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling withdrawFromAave(${asset}, ${amount} token units)`);
    const tx = await this.kashYield.withdrawFromAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Withdrawn from Aave`);
  }

  /**
   * Borrow asset from Aave (amount in token units)
   */
  private async borrowFromAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling borrowFromAave(${asset}, ${amount} token units)`);
    const tx = await this.kashYield.borrowFromAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Borrowed from Aave`);
  }

  /**
   * Repay borrowed asset to Aave (amount in token units)
   */
  private async repayToAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling repayToAave(${asset}, ${amount} token units)`);
    const tx = await this.kashYield.repayToAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Repaid to Aave`);
  }

  /**
   * Deposit to Hyperliquid (via contract)
   * Amount must be in USDC token units (6 decimals). Requires hyperliquidAddress to be set.
   */
  private async depositToHyperliquid(amount: bigint): Promise<void> {
    // Check if hyperliquidAddress is set
    let hlAddress: string;
    try {
      hlAddress = await this.kashYield.hyperliquidAddress();
    } catch (error) {
      console.log(`   ⚠️  Hyperliquid address not set on contract. Skipping HL deposit.`);
      return;
    }
    
    if (!hlAddress || hlAddress === ethers.ZeroAddress) {
      console.log(`   ⚠️  Hyperliquid address not set on contract. Skipping HL deposit.`);
      return;
    }
    
    try {
      console.log(`   → Depositing ${amount} USDC units to Hyperliquid`);
      const tx = await this.kashYield.depositToHyperliquid(amount);
      await tx.wait();
      console.log(`   ✅ Deposited to Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to deposit to Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Spot buy on Hyperliquid: USDC → ETH (address(0)) or wBTC. Call after depositToHyperliquid.
   */
  private async spotBuyOnHyperliquid(tokenOut: string, usdcAmount: bigint): Promise<void> {
    try {
      console.log(`   → Spot buy on Hyperliquid: ${usdcAmount} USDC → ${tokenOut === ethers.ZeroAddress ? 'ETH' : 'WBTC'}`);
      const tx = await this.kashYield.spotBuyOnHyperliquid(tokenOut, usdcAmount);
      await tx.wait();
      console.log(`   ✅ Spot buy on Hyperliquid done`);
    } catch (error: any) {
      console.error(`   ❌ Failed to spot buy on Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Spot sell on Hyperliquid: ETH or wBTC → USDC. For ETH, send value with the tx.
   */
  private async spotSellOnHyperliquid(tokenIn: string, amount: bigint): Promise<void> {
    try {
      const opts = tokenIn === ethers.ZeroAddress ? { value: amount } : {};
      console.log(`   → Spot sell on Hyperliquid: ${ethers.formatEther(amount)} ${tokenIn === ethers.ZeroAddress ? 'ETH' : 'WBTC'} → USDC`);
      const tx = await this.kashYield.spotSellOnHyperliquid(tokenIn, amount, opts);
      await tx.wait();
      console.log(`   ✅ Spot sell on Hyperliquid done`);
    } catch (error: any) {
      console.error(`   ❌ Failed to spot sell on Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Withdraw from Hyperliquid (amount in USDC token units, 6 decimals)
   */
  private async withdrawFromHyperliquid(amount: bigint): Promise<void> {
    try {
      console.log(`   → Withdrawing ${amount} USDC units from Hyperliquid`);
      const tx = await this.kashYield.withdrawFromHyperliquid(amount);
      await tx.wait();
      console.log(`   ✅ Withdrawn from Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to withdraw from Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Open short position on Hyperliquid in the same asset as the mint (ETH or BTC).
   * Size = 1.7x net mint in USD; we convert to notional in asset units.
   * Contract expects openShort(string symbol, uint256 size) with size in 18 decimals.
   */
  private async openShortOnHyperliquid(amountUSD: bigint, asset: string): Promise<void> {
    try {
      const symbol = this.getShortSymbol(asset);
      const priceToken = symbol === 'BTC' ? TOKEN_ADDRESSES.WBTC : TOKEN_ADDRESSES.WETH;
      const oneUnit = symbol === 'BTC' ? 10n ** 8n : 10n ** 18n; // WBTC 8 decimals, WETH 18

      const priceUSD = await this.kashYield.getTokenUSD(priceToken, oneUnit);
      const priceBigInt = BigInt(priceUSD.toString());
      if (priceBigInt === 0n) throw new Error(`${symbol} price is zero`);

      const size = (amountUSD * (10n ** 18n)) / priceBigInt; // size in 18 decimals for contract

      console.log(`   → Opening ${ethers.formatEther(amountUSD)} USD (${ethers.formatEther(size)} ${symbol}) short on Hyperliquid`);
      const tx = await this.kashYield.openShort(symbol, size);
      await tx.wait();
      console.log(`   ✅ Opened 1.7x ${symbol} short on Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to open short on Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close short position on Hyperliquid in the same asset (ETH or BTC).
   */
  private async closeShortOnHyperliquid(asset: string): Promise<void> {
    try {
      const symbol = this.getShortSymbol(asset);
      console.log(`   → Closing ${symbol} short on Hyperliquid`);
      const tx = await this.kashYield.closeShort(symbol);
      await tx.wait();
      console.log(`   ✅ Closed ${symbol} short on Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to close short on Hyperliquid: ${error.message}`);
      throw error;
    }
  }
}
