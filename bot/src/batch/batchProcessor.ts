import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { getDailyYield } from './dailyYield';

const TOKEN_ADDRESSES = {
  USDC: config.tokens.USDC,
};

const AAVE_POOL_ADDRESS = config.aavePoolAddress;
const isBtc = config.product === 'btc';

/**
 * Batch Processor - Two-phase daily batch for KashYieldETH or KashYieldBtc.
 * Phase 1: performUpkeep() → indicative; handle NET_MINT/NET_REDEEM, updateNAV, markBatchOpsDone.
 * Phase 2: performUpkeep() → distribute; optionally handle NET_MINT_ETH_DEPLOY.
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

  async run(): Promise<void> {
    console.log('🚀 Starting Batch Processor...\n');

    const isProcessingWindow = await this.kashYield.isProcessingWindow();
    if (!isProcessingWindow) {
      console.log('⏳ Not in processing window (23:50-23:59 UTC)');
      if (config.waitForProcessingWindow) {
        console.log('   Waiting for processing window...');
        await this.waitForProcessingWindow();
      } else {
        console.log('   Exiting (set WAIT_FOR_PROCESSING_WINDOW=true to wait)');
        return;
      }
    }

    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    const batchCycle = currentCycle;
    console.log(`📅 Batch cycle: ${batchCycle}\n`);

    const batchInfo = await this.kashYield.getBatchInfo(batchCycle);
    await this.runBatch(batchCycle, batchInfo);
  }

  /**
   * Two-phase flow: Phase 1 → ops + updateNAV + markBatchOpsDone → Phase 2
   */
  private async runBatch(
    batchCycle: bigint,
    batchInfo: { totalMintUSD: bigint; totalRedeemUSD: bigint; processed: boolean; mintUsersCount: bigint; redeemUsersCount: bigint }
  ): Promise<void> {
    const phase = await this.kashYield.batchPhase(batchCycle);
    const phaseNum = Number(phase);

    if (batchInfo.processed) {
      console.log(`✅ Batch ${batchCycle} already processed (phase 3)\n`);
      return;
    }

    const hasRequests = batchInfo.mintUsersCount > 0n || batchInfo.redeemUsersCount > 0n;
    if (phaseNum === 0) {
      if (!hasRequests) {
        console.log(`📭 Batch ${batchCycle} has no mint/redeem requests, skipping.\n`);
        return;
      }
      console.log('🔄 Phase 1: Calling performUpkeep()...');
      const tx1 = await this.kashYield.performUpkeep('0x');
      const receipt1 = await tx1.wait();
      console.log(`   ✅ Phase 1 done in block ${receipt1.blockNumber}\n`);

      await this.handleEventsFromReceipt(receipt1);
      const dailyYield = await getDailyYield(this.provider, {
        kashYield: this.kashYield,
        aavePoolAddress: AAVE_POOL_ADDRESS,
        aaveUserAddress: config.aaveUserAddress || config.kashYieldAddress,
      });
      const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
      const kashSupply = tokenAddr
        ? await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()
        : 0n;
      const portfolioValueUSD = await this.estimatePortfolioValueUSD();
      const { computeNAVFromPortfolioAndYield } = await import('./dailyYield');
      const newNAV = computeNAVFromPortfolioAndYield(portfolioValueUSD, dailyYield.netYield, kashSupply);
      console.log('📈 Updating NAV and marking ops done...');
      await (await this.kashYield.updateNAV(newNAV)).wait();
      await (await this.kashYield.markBatchOpsDone(batchCycle)).wait();
      console.log('   ✅ markBatchOpsDone\n');

      console.log('🔄 Phase 2: Calling performUpkeep()...');
      const tx2 = await this.kashYield.performUpkeep('0x');
      const receipt2 = await tx2.wait();
      console.log(`   ✅ Phase 2 done in block ${receipt2.blockNumber}\n`);
      await this.handleEventsFromReceipt(receipt2, true);
      return;
    }

    if (phaseNum === 1) {
      // Phase 1 already ran; we do ops + updateNAV + markBatchOpsDone then Phase 2
      const netPositionUSD = BigInt(batchInfo.totalMintUSD.toString()) - BigInt(batchInfo.totalRedeemUSD.toString());
      if (netPositionUSD > 0n) await this.handleNetMint(netPositionUSD, ethers.ZeroAddress);
      else if (netPositionUSD < 0n) await this.handleNetRedeem(-netPositionUSD, ethers.ZeroAddress);
      const dailyYield = await getDailyYield(this.provider, {
        kashYield: this.kashYield,
        aavePoolAddress: AAVE_POOL_ADDRESS,
        aaveUserAddress: config.aaveUserAddress || config.kashYieldAddress,
      });
      const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
      const kashSupply = tokenAddr
        ? await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()
        : 0n;
      const portfolioValueUSD = await this.estimatePortfolioValueUSD();
      const { computeNAVFromPortfolioAndYield } = await import('./dailyYield');
      const newNAV = computeNAVFromPortfolioAndYield(portfolioValueUSD, dailyYield.netYield, kashSupply);
      await (await this.kashYield.updateNAV(newNAV)).wait();
      await (await this.kashYield.markBatchOpsDone(batchCycle)).wait();
      const tx2 = await this.kashYield.performUpkeep('0x');
      const receipt2 = await tx2.wait();
      console.log(`   ✅ Phase 2 done in block ${receipt2.blockNumber}\n`);
      await this.handleEventsFromReceipt(receipt2, true);
      return;
    }

    if (phaseNum === 2) {
      console.log('🔄 Phase 2: Calling performUpkeep()...');
      const tx2 = await this.kashYield.performUpkeep('0x');
      const receipt2 = await tx2.wait();
      console.log(`   ✅ Phase 2 done in block ${receipt2.blockNumber}\n`);
      await this.handleEventsFromReceipt(receipt2, true);
      return;
    }

    console.log(`✅ Batch ${batchCycle} already finalized (phase ${phaseNum}).\n`);
  }

  /**
   * Rough portfolio value in USD (18 decimals) for NAV. Override or improve with real Aave/HL data.
   */
  private async estimatePortfolioValueUSD(): Promise<bigint> {
    try {
      const nav = await this.kashYield.currentNAV();
      const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
      const kashSupply = tokenAddr
        ? await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()
        : 0n;
      return (BigInt(nav.toString()) * kashSupply) / (10n ** 18n);
    } catch {
      return 0n;
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
   * Parse ProtocolInteraction events from transaction receipt.
   * @param phase2Only If true (Phase 2 receipt), only handle NET_MINT_ETH_DEPLOY.
   */
  private async handleEventsFromReceipt(receipt: ethers.TransactionReceipt, phase2Only?: boolean): Promise<void> {
    console.log('📡 Parsing ProtocolInteraction events from receipt...\n');

    const iface = new ethers.Interface(kashYieldABI);
    let eventsFound = 0;
    const kashYieldAddr = config.kashYieldAddress?.toLowerCase() ?? (await this.kashYield.getAddress()).toLowerCase();

    for (const log of receipt.logs) {
      try {
        if (log.address.toLowerCase() !== kashYieldAddr) continue;

        const parsedLog = iface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });

        if (parsedLog && parsedLog.name === 'ProtocolInteraction') {
          eventsFound++;
          const action = parsedLog.args[0] as string;
          const asset = parsedLog.args[1] as string;
          const amount = parsedLog.args[2] as bigint;

          console.log(`📡 ProtocolInteraction: ${action}, asset=${asset}, amount=${ethers.formatEther(amount)}\n`);

          if (phase2Only) {
            if (action === 'NET_MINT_ETH_DEPLOY') {
              await this.handleNetMintEthDeploy(amount);
            }
            continue;
          }

          if (action === 'NET_MINT') {
            await this.handleNetMint(amount, asset);
          } else if (action === 'NET_REDEEM') {
            await this.handleNetRedeem(amount, asset);
          }
        }
      } catch {
        continue;
      }
    }

    if (eventsFound === 0) {
      console.log('⚠️  No ProtocolInteraction events found in receipt\n');
    } else {
      console.log(`✅ Processed ${eventsFound} ProtocolInteraction event(s)\n`);
    }
  }

  /** V2 Phase 2: Deploy excess mint ETH to Aave when contract emits NET_MINT_ETH_DEPLOY */
  private async handleNetMintEthDeploy(amountWei: bigint): Promise<void> {
    if (amountWei === 0n) return;
    console.log(`💰 NET_MINT_ETH_DEPLOY: deploying ${ethers.formatEther(amountWei)} ETH to Aave...`);
    const tx = await this.kashYield.depositToAave(amountWei);
    await tx.wait();
    console.log('   ✅ Excess mint ETH deployed to Aave\n');
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
   * 1. Send the actual net-deposited asset to Aave (ETH→wETH, wETH). No conversion to USDC.
   * 2. Borrow 70% of that deposit’s USD value as USDC and send to Hyperliquid as collateral.
   * 3. Swap USDC to ETH on Hyperliquid (step 2b: spotBuyOnHyperliquid) — already in code.
   * 4. Transfer from Spot to Perp: real HL uses API (spot_perp_transfer), not on-chain — add
   *    in this file only when integrating real HL; no contract change. Mock needs no transfer.
   * 5. Open a 1.7x short on Hyperliquid in the same asset (ETH or wBTC) as was minted.
   *
   * @param amount Net mint amount in USD (18 decimals)
   */
  private async handleNetMint(amount: bigint, _asset: string): Promise<void> {
    console.log(`💰 Handling NET_MINT (${isBtc ? 'BTC' : 'ETH'}) - Deploying capital...`);
    console.log(`   Net amount: ${ethers.formatEther(amount)} USD\n`);

    try {
      const amountUSD = amount;
      const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
      const pct = BigInt(config.strategy.aaveDepositPct);
      const depositAmountUSD = (amountUSD * pct) / 100n;
      const depositAmount = isBtc
        ? (depositAmountUSD * (10n ** 8n)) / price
        : (depositAmountUSD * (10n ** 18n)) / price;

      console.log(`   Step 1: Deposit ${config.strategy.aaveDepositPct}% (${isBtc ? Number(depositAmount) / 1e8 + ' wBTC' : ethers.formatEther(depositAmount) + ' ETH'}) to Aave`);
      const txDeposit = await this.kashYield.depositToAave(depositAmount);
      await txDeposit.wait();

      // Step 2: Borrow 70% of deposit’s USD value as USDC, send to Hyperliquid as collateral
      const ltv = BigInt(config.strategy.borrowLtvPct);
      const borrowAmountUSD = (depositAmountUSD * ltv) / 100n;
      const borrowUsdcUnits = borrowAmountUSD / (10n ** 12n);
      console.log(`   Step 2: Borrow ${config.strategy.borrowLtvPct}% as USDC, send to Hyperliquid`);
      await this.borrowFromAave(TOKEN_ADDRESSES.USDC, borrowUsdcUnits);
      await this.depositToHyperliquid(borrowUsdcUnits);

      console.log(`   Step 2b: Spot buy ${isBtc ? 'wBTC' : 'ETH'} on Hyperliquid`);
      const txSpot = await this.kashYield.spotBuyOnHyperliquid(borrowUsdcUnits);
      await txSpot.wait();

      const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
      const shortSizeUSD = (amountUSD * leverageScaled) / 100n;
      const shortSymbol = isBtc ? 'BTC' : 'ETH';
      console.log(`   Step 3: Open ${config.strategy.shortLeverage}x ${shortSymbol} short`);
      await this.openShortOnHyperliquid(shortSizeUSD, price, shortSymbol);

      console.log('   ✅ NET_MINT complete!\n');

    } catch (error: any) {
      console.error('❌ Failed to handle NET_MINT:', error.message);
      throw error;
    }
  }

  /**
   * Handle NET_REDEEM - Withdraw capital (reverse of NET_MINT).
   *
   * Unwind flow: 1) Cover short; 2) Send ETH from perp to spot on HL (API, real HL only);
   * 3) Sell ETH for USDC on HL; 4) Withdraw USDC from HL; 5) Repay Aave; 6) Withdraw ETH from Aave.
   *
   * @param amountUSD Net redeem amount in USD (18 decimals)
   */
  private async handleNetRedeem(amountUSD: bigint, _asset: string): Promise<void> {
    console.log(`💸 Handling NET_REDEEM (${isBtc ? 'BTC' : 'ETH'}) - Withdrawing capital...`);
    console.log(`   Net amount: ${ethers.formatEther(amountUSD)} USD\n`);

    try {
      const shortSymbol = isBtc ? 'BTC' : 'ETH';
      console.log(`   Step 1: Close ${shortSymbol} short on Hyperliquid`);
      await this.closeShortOnHyperliquid(shortSymbol);

      const ltv = BigInt(config.strategy.borrowLtvPct);
      const usdcToWithdrawUSD = (amountUSD * ltv) / 100n;
      const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
      // Spot sell: Mock HL uses 18 decimals for both eth and btc internal balances
      const spotSellAmount = (usdcToWithdrawUSD * (10n ** 18n)) / price;
      console.log(`   Step 1b: Spot sell ${isBtc ? 'wBTC' : 'ETH'} to USDC on Hyperliquid`);
      const txSell = isBtc
        ? await this.kashYield.spotSellOnHyperliquid(spotSellAmount)
        : await this.kashYield.spotSellOnHyperliquid(spotSellAmount, { value: spotSellAmount });
      await txSell.wait();

      const usdcWithdrawUnits = usdcToWithdrawUSD / (10n ** 12n);
      console.log(`   Step 2: Withdraw USDC from Hyperliquid`);
      await this.withdrawFromHyperliquid(usdcWithdrawUnits);

      console.log(`   Step 3: Repay Aave borrow with USDC`);
      await this.repayToAave(TOKEN_ADDRESSES.USDC, usdcWithdrawUnits);

      const withdrawAmount = isBtc
        ? (amountUSD * (10n ** 8n)) / price
        : (amountUSD * (10n ** 18n)) / price;
      console.log(`   Step 4: Withdraw ${isBtc ? Number(withdrawAmount) / 1e8 + ' wBTC' : ethers.formatEther(withdrawAmount) + ' ETH'} from Aave`);
      const txWithdraw = await this.kashYield.withdrawFromAave(withdrawAmount);
      await txWithdraw.wait();

      console.log('   ✅ NET_REDEEM complete!\n');
    } catch (error: any) {
      console.error('❌ Failed to handle NET_REDEEM:', error.message);
      throw error;
    }
  }

  // ============================================================================
  // Protocol interaction helpers
  // ============================================================================

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
   * Size = leverage x net mint in USD; convert to asset units (18 decimals for both ETH and BTC per MockHyperliquid).
   */
  private async openShortOnHyperliquid(amountUSD: bigint, price: bigint, symbol: 'ETH' | 'BTC'): Promise<void> {
    try {
      if (price === 0n) throw new Error(`${symbol} price is zero`);
      const size = (amountUSD * (10n ** 18n)) / price;

      console.log(`   → Opening ${ethers.formatEther(amountUSD)} USD (${ethers.formatEther(size)} ${symbol}) short on Hyperliquid`);
      const tx = await this.kashYield.openShort(symbol, size);
      await tx.wait();
      console.log(`   ✅ Opened ${symbol} short on Hyperliquid`);
    } catch (error: any) {
      console.error(`   ❌ Failed to open short on Hyperliquid: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close short position on Hyperliquid in the same asset (ETH or BTC).
   */
  private async closeShortOnHyperliquid(symbol: 'ETH' | 'BTC'): Promise<void> {
    try {
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
