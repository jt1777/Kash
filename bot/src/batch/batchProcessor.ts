import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { calculateNetPosition } from './calculateNetPosition';

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
   * Strategy:
   * 1. Take net ETH amount X to be minted
   * 2. Send wETH to Aave
   * 3. Borrow 70% of X total worth of minted ETH as USDC
   * 4. Send USDC to Hyperliquid to be used as collateral for a 1.7X short of wETH to earn funding
   * 5. Same for wBTC
   * 
   * @param amount Net mint amount in USD (18 decimals)
   * @param asset Asset address (ETH, wETH, or wBTC)
   */
  private async handleNetMint(amount: bigint, asset: string): Promise<void> {
    console.log('💰 Handling NET_MINT - Deploying capital...');
    console.log(`   Amount: ${ethers.formatEther(amount)} USD\n`);

    try {
      // Determine which asset we're working with
      const assetSymbol = await this.getAssetSymbol(asset);
      console.log(`   Asset: ${assetSymbol}`);

      // Step 1: Deposit to Aave (40% of capital)
      const depositAmount = (amount * 40n) / 100n; // 40%
      console.log(`   Step 1: Deposit ${ethers.formatEther(depositAmount)} USD to Aave (40%)`);
      
      // For ETH deposits, use WETH address
      const depositAsset = (asset === ethers.ZeroAddress) ? TOKEN_ADDRESSES.WETH : asset;
      await this.depositToAave(depositAsset, depositAmount);

      // Step 2: Borrow USDC (70% LTV of deposited amount)
      const borrowAmount = (depositAmount * 70n) / 100n;
      console.log(`   Step 2: Borrow ${ethers.formatEther(borrowAmount)} USDC (70% LTV)`);
      await this.borrowFromAave(TOKEN_ADDRESSES.USDC, borrowAmount);

      // Step 3: Send USDC to Hyperliquid
      console.log(`   Step 3: Transfer USDC to Hyperliquid as collateral`);
      await this.depositToHyperliquid(borrowAmount);

      // Step 4: Open 1.7x ETH short on Hyperliquid
      const shortAmount = (amount * 35n) / 100n; // 35% of total
      console.log(`   Step 4: Open ${ethers.formatEther(shortAmount)} USD ETH short on Hyperliquid (35%)`);
      await this.openShortOnHyperliquid(shortAmount);

      console.log('   ✅ NET_MINT capital deployment complete!\n');

      // Log the target allocation
      console.log('📊 Target Allocation:');
      console.log(`   Aave Deposit: ${ethers.formatEther(depositAmount)} USD (40%)`);
      console.log(`   Hyperliquid Short: ${ethers.formatEther(shortAmount)} USD (35%)`);
      console.log(`   Stablecoin Reserve: ${ethers.formatEther((amount * 20n) / 100n)} USD (20%)`);
      console.log(`   Operational Buffer: ${ethers.formatEther((amount * 5n) / 100n)} USD (5%)\n`);

    } catch (error: any) {
      console.error('❌ Failed to handle NET_MINT:', error.message);
      throw error;
    }
  }

  /**
   * Handle NET_REDEEM - Withdraw capital to fulfill redemptions
   * 
   * Strategy (reverse of NET_MINT):
   * 1. Close Hyperliquid short position
   * 2. Withdraw USDC from Hyperliquid
   * 3. Repay Aave borrow
   * 4. Withdraw wETH from Aave
   * 5. Payout original amount plus yield
   * 6. Same for wBTC
   * 
   * @param amount Net redeem amount in USD (18 decimals)
   * @param asset Asset address (ETH, wETH, or wBTC)
   */
  private async handleNetRedeem(amount: bigint, asset: string): Promise<void> {
    console.log('💸 Handling NET_REDEEM - Withdrawing capital...');
    console.log(`   Amount: ${ethers.formatEther(amount)} USD\n`);

    try {
      const assetSymbol = await this.getAssetSymbol(asset);
      console.log(`   Asset: ${assetSymbol}`);

      // Step 1: Close Hyperliquid short position (proportional to redeem amount)
      const shortToClose = (amount * 35n) / 100n;
      console.log(`   Step 1: Close ${ethers.formatEther(shortToClose)} USD ETH short on Hyperliquid`);
      await this.closeShortOnHyperliquid(shortToClose);

      // Step 2: Withdraw USDC from Hyperliquid
      const usdcToWithdraw = (amount * 70n) / 100n;
      console.log(`   Step 2: Withdraw ${ethers.formatEther(usdcToWithdraw)} USDC from Hyperliquid`);
      await this.withdrawFromHyperliquid(usdcToWithdraw);

      // Step 3: Repay Aave borrow
      console.log(`   Step 3: Repay ${ethers.formatEther(usdcToWithdraw)} USDC to Aave`);
      await this.repayToAave(TOKEN_ADDRESSES.USDC, usdcToWithdraw);

      // Step 4: Withdraw wETH from Aave
      const wethToWithdraw = (amount * 40n) / 100n;
      console.log(`   Step 4: Withdraw ${ethers.formatEther(wethToWithdraw)} USD worth of wETH from Aave`);
      await this.withdrawFromAave(TOKEN_ADDRESSES.WETH, wethToWithdraw);

      // Step 5: If needed, unwrap wETH to ETH for redemption
      if (asset === ethers.ZeroAddress) {
        console.log(`   Step 5: Unwrap wETH to ETH for redemption`);
        // Note: Contract handles unwrapping internally if needed
      }

      console.log('   ✅ NET_REDEEM capital withdrawal complete!\n');

      // Note: The actual payout to users is handled by the contract in processBatch()
      // The bot just needs to ensure sufficient liquidity is available

    } catch (error: any) {
      console.error('❌ Failed to handle NET_REDEEM:', error.message);
      throw error;
    }
  }

  /**
   * Get the symbol for an asset address
   */
  private async getAssetSymbol(asset: string): Promise<string> {
    if (asset === ethers.ZeroAddress) return 'ETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WETH.toLowerCase()) return 'WETH';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.WBTC.toLowerCase()) return 'WBTC';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.USDT.toLowerCase()) return 'USDT';
    if (asset.toLowerCase() === TOKEN_ADDRESSES.USDC.toLowerCase()) return 'USDC';
    return 'UNKNOWN';
  }

  // ============================================================================
  // Protocol Interaction Functions (to be implemented when addresses are set)
  // ============================================================================

  /**
   * Deposit asset to Aave
   */
  private async depositToAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling depositToAave(${asset}, ${ethers.formatEther(amount)})`);
    const tx = await this.kashYield.depositToAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Deposited to Aave`);
  }

  /**
   * Withdraw asset from Aave
   */
  private async withdrawFromAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling withdrawFromAave(${asset}, ${ethers.formatEther(amount)})`);
    const tx = await this.kashYield.withdrawFromAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Withdrawn from Aave`);
  }

  /**
   * Borrow asset from Aave
   */
  private async borrowFromAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling borrowFromAave(${asset}, ${ethers.formatEther(amount)})`);
    const tx = await this.kashYield.borrowFromAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Borrowed from Aave`);
  }

  /**
   * Repay borrowed asset to Aave
   */
  private async repayToAave(asset: string, amount: bigint): Promise<void> {
    console.log(`   → Calling repayToAave(${asset}, ${ethers.formatEther(amount)})`);
    const tx = await this.kashYield.repayToAave(asset, amount);
    await tx.wait();
    console.log(`   ✅ Repaid to Aave`);
  }

  /**
   * Deposit to Hyperliquid (via contract)
   * Note: This requires hyperliquidAddress to be set on the contract
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
      console.log(`   → Depositing ${ethers.formatEther(amount)} to Hyperliquid`);
      const tx = await this.kashYield.depositToHyperliquid(amount);
      await tx.wait();
      console.log(`   ✅ Deposited to Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to deposit to Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Withdraw from Hyperliquid
   */
  private async withdrawFromHyperliquid(amount: bigint): Promise<void> {
    try {
      console.log(`   → Withdrawing ${ethers.formatEther(amount)} from Hyperliquid`);
      const tx = await this.kashYield.withdrawFromHyperliquid(amount);
      await tx.wait();
      console.log(`   ✅ Withdrawn from Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to withdraw from Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Open short position on Hyperliquid
   * Contract expects openShort(string symbol, uint256 size)
   */
  private async openShortOnHyperliquid(amount: bigint): Promise<void> {
    try {
      console.log(`   → Opening ${ethers.formatEther(amount)} USD ETH short on Hyperliquid`);
      
      // Get current ETH price to calculate size in ETH terms
      const ethPrice = await this.kashYield.getLatestPrice(TOKEN_ADDRESSES.WETH);
      const ethPriceBigInt = BigInt(ethPrice.toString());
      
      // size = amount / price (both in 18 decimals)
      // size in ETH = amountUSD / pricePerETH
      const size = (amount * (10n ** 18n)) / ethPriceBigInt;
      
      const tx = await this.kashYield.openShort("ETH", size);
      await tx.wait();
      console.log(`   ✅ Opened ${ethers.formatEther(size)} ETH short on Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to open short on Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close short position on Hyperliquid
   * Contract expects closeShort(string symbol)
   */
  private async closeShortOnHyperliquid(amount: bigint): Promise<void> {
    try {
      console.log(`   → Closing ETH short on Hyperliquid (amount: ${ethers.formatEther(amount)} USD)`);
      const tx = await this.kashYield.closeShort("ETH");
      await tx.wait();
      console.log(`   ✅ Closed ETH short on Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to close short on Hyperliquid: ${error.message}`);
      throw error;
    }
  }
}
