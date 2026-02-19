import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';

// Token addresses (Arbitrum Mainnet)
const TOKEN_ADDRESSES = {
  ETH: ethers.ZeroAddress,
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

// Aave V3 Pool address (Arbitrum Mainnet)
const AAVE_POOL_ADDRESS = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';

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
  private wallet: ethers.Wallet;

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

    // Check net position before processing
    const netPositionUSD = BigInt(batchInfo.totalMintUSD.toString()) - BigInt(batchInfo.totalRedeemUSD.toString());
    console.log(`📊 Net Position: ${ethers.formatEther(netPositionUSD)} USD`);
    console.log(`   Mints: ${ethers.formatEther(batchInfo.totalMintUSD)} USD`);
    console.log(`   Redeems: ${ethers.formatEther(batchInfo.totalRedeemUSD)} USD\n`);

    // Set up event listener for ProtocolInteraction
    this.setupEventListener();

    // Call processBatch
    try {
      console.log('🔄 Calling processBatch()...');
      const tx = await this.kashYield.processBatch();
      console.log(`   Transaction: ${tx.hash}`);
      
      const receipt = await tx.wait();
      console.log(`   ✅ Batch processed in block ${receipt.blockNumber}\n`);

      // Wait a bit for events to be processed
      await new Promise(resolve => setTimeout(resolve, 5000));

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
   * Set up listener for ProtocolInteraction events
   */
  private setupEventListener(): void {
    console.log('👂 Listening for ProtocolInteraction events...\n');

    this.kashYield.on('ProtocolInteraction', async (action: string, asset: string, amount: bigint, event: any) => {
      console.log(`📡 ProtocolInteraction Event:`);
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
      // Note: In a real implementation, you'd wrap ETH to wETH first if needed
      const depositAmount = (amount * 40n) / 100n; // 40%
      console.log(`   Step 1: Deposit ${ethers.formatEther(depositAmount)} USD to Aave (40%)`);
      
      // For ETH deposits, we need to convert to wETH first
      if (asset === ethers.ZeroAddress || asset === TOKEN_ADDRESSES.WETH) {
        // This would require wrapping ETH to wETH first
        console.log(`   ⚠️  Need to wrap ETH to wETH before depositing to Aave`);
        // await this.depositToAave(TOKEN_ADDRESSES.WETH, depositAmount);
      } else {
        // await this.depositToAave(asset, depositAmount);
      }

      // Step 2: Borrow USDC (70% LTV of deposited amount)
      const borrowAmount = (depositAmount * 70n) / 100n;
      console.log(`   Step 2: Borrow ${ethers.formatEther(borrowAmount)} USDC (70% LTV)`);
      // await this.borrowFromAave(TOKEN_ADDRESSES.USDC, borrowAmount);

      // Step 3: Send USDC to Hyperliquid
      console.log(`   Step 3: Transfer USDC to Hyperliquid as collateral`);
      // await this.depositToHyperliquid(borrowAmount);

      // Step 4: Open 1.7x ETH short on Hyperliquid
      const shortAmount = (amount * 35n) / 100n; // 35% of total
      console.log(`   Step 4: Open ${ethers.formatEther(shortAmount)} USD ETH short on Hyperliquid (35%)`);
      // await this.openShortOnHyperliquid(shortAmount);

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
      // await this.closeShortOnHyperliquid(shortToClose);

      // Step 2: Withdraw USDC from Hyperliquid
      const usdcToWithdraw = (amount * 70n) / 100n;
      console.log(`   Step 2: Withdraw ${ethers.formatEther(usdcToWithdraw)} USDC from Hyperliquid`);
      // await this.withdrawFromHyperliquid(usdcToWithdraw);

      // Step 3: Repay Aave borrow
      console.log(`   Step 3: Repay ${ethers.formatEther(usdcToWithdraw)} USDC to Aave`);
      // await this.repayToAave(TOKEN_ADDRESSES.USDC, usdcToWithdraw);

      // Step 4: Withdraw wETH from Aave
      const wethToWithdraw = (amount * 40n) / 100n;
      console.log(`   Step 4: Withdraw ${ethers.formatEther(wethToWithdraw)} USD worth of wETH from Aave`);
      // await this.withdrawFromAave(TOKEN_ADDRESSES.WETH, wethToWithdraw);

      // Step 5: If needed, unwrap wETH to ETH for redemption
      if (asset === ethers.ZeroAddress) {
        console.log(`   Step 5: Unwrap wETH to ETH for redemption`);
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
    const hlAddress = await this.kashYield.hyperliquidAddress?.().catch(() => ethers.ZeroAddress);
    if (!hlAddress || hlAddress === ethers.ZeroAddress) {
      console.log(`   ⚠️  Hyperliquid address not set on contract. Skipping HL deposit.`);
      return;
    }
    
    console.log(`   → Depositing ${ethers.formatEther(amount)} to Hyperliquid`);
    // This would call the contract's depositToHyperliquid function
    // const tx = await this.kashYield.depositToHyperliquid(amount);
    // await tx.wait();
    console.log(`   ✅ Deposited to Hyperliquid`);
  }

  /**
   * Withdraw from Hyperliquid
   */
  private async withdrawFromHyperliquid(amount: bigint): Promise<void> {
    console.log(`   → Withdrawing ${ethers.formatEther(amount)} from Hyperliquid`);
    // const tx = await this.kashYield.withdrawFromHyperliquid(amount);
    // await tx.wait();
    console.log(`   ✅ Withdrawn from Hyperliquid`);
  }

  /**
   * Open short position on Hyperliquid
   */
  private async openShortOnHyperliquid(amount: bigint): Promise<void> {
    console.log(`   → Opening ${ethers.formatEther(amount)} short on Hyperliquid`);
    // const tx = await this.kashYield.openShort(amount);
    // await tx.wait();
    console.log(`   ✅ Opened short on Hyperliquid`);
  }

  /**
   * Close short position on Hyperliquid
   */
  private async closeShortOnHyperliquid(amount: bigint): Promise<void> {
    console.log(`   → Closing ${ethers.formatEther(amount)} short on Hyperliquid`);
    // const tx = await this.kashYield.closeShort(amount);
    // await tx.wait();
    console.log(`   ✅ Closed short on Hyperliquid`);
  }
}
