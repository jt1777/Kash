import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { getDailyYield } from './dailyYield';

const TOKEN_ADDRESSES = {
  USDC: config.tokens.USDC,
  /** For borrow/repay - use Aave's expected USDC (MockUSDC when using MockAave) */
  AAVE_USDC: config.aaveUsdcAddress,
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
    console.log(`📅 Batch cycle: ${currentCycle}\n`);

    // Check previous batches for incomplete work (phase 1: ops not done; phase 2: distribution not run)
    const lookback = 10; // check last 10 days of batches
    for (let i = 1; i <= lookback; i++) {
      const prevCycle = currentCycle - BigInt(i);
      if (prevCycle < 0n) break;
      const prevPhase = await this.kashYield.batchPhase(prevCycle);
      const prevInfo = await this.kashYield.getBatchInfo(prevCycle);
      if (prevInfo.processed) continue;
      const prevPhaseNum = Number(prevPhase);
      const prevNet = BigInt(prevInfo.totalMintUSD.toString()) - BigInt(prevInfo.totalRedeemUSD.toString());
      const isPhase1Orphan = prevPhaseNum === 1 && prevNet !== 0n;
      const isPhase2Orphan = prevPhaseNum === 2; // ops done but Phase 2 (distribution) never ran
      if (isPhase1Orphan || isPhase2Orphan) {
        const action = isPhase2Orphan ? 'phase 2 (distribution) pending' : prevNet > 0n ? `net mint ${ethers.formatEther(prevNet)} USD` : `net redeem ${ethers.formatEther(-prevNet)} USD`;
        console.log(`⚠️  Found incomplete batch ${prevCycle} (${isPhase2Orphan ? 'phase 2' : 'phase 1'}, ${action})`);
        console.log(`   Completing orphaned batch before processing current batch...\n`);
        await this.runBatch(prevCycle, prevInfo);
        break; // complete one at a time, then re-run for more if needed
      }
    }

    const batchInfo = await this.kashYield.getBatchInfo(currentCycle);
    await this.runBatch(currentCycle, batchInfo);
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
      let newNAV = computeNAVFromPortfolioAndYield(portfolioValueUSD, dailyYield.netYield, kashSupply);
      if (newNAV === 0n) {
        newNAV = await this.kashYield.currentNAV();
        if (newNAV === 0n) newNAV = 1n * 10n ** 18n;
        console.log(`   📈 KASH supply is 0, using current NAV for updateNAV`);
      }
      console.log('📈 Updating NAV and marking ops done...');
      await (await this.kashYield.updateNAV(newNAV)).wait();
      await (await this.kashYield.markBatchOpsDone(batchCycle)).wait();
      console.log('   ✅ markBatchOpsDone\n');

      await this.runPhase2ForBatch(batchCycle);
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
      let newNAV = computeNAVFromPortfolioAndYield(portfolioValueUSD, dailyYield.netYield, kashSupply);
      if (newNAV === 0n) {
        newNAV = await this.kashYield.currentNAV();
        if (newNAV === 0n) newNAV = 1n * 10n ** 18n;
        console.log(`   📈 KASH supply is 0, using current NAV for updateNAV`);
      }
      await (await this.kashYield.updateNAV(newNAV)).wait();
      await (await this.kashYield.markBatchOpsDone(batchCycle)).wait();
      await this.runPhase2ForBatch(batchCycle);
      return;
    }

    if (phaseNum === 2) {
      await this.runPhase2ForBatch(batchCycle);
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
   * Run Phase 2 (mint KASH to minters, pay redeemers). For current cycle use performUpkeep();
   * for a past/orphan batch use processBatchPhase2ForCycle(batchCycle) so the correct batch gets finalized.
   */
  private async runPhase2ForBatch(batchCycle: bigint): Promise<void> {
    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    const currentCycleBn = typeof currentCycle === 'bigint' ? currentCycle : BigInt(currentCycle.toString());
    if (batchCycle === currentCycleBn) {
      console.log('🔄 Phase 2: Calling performUpkeep()...');
      const tx2 = await this.kashYield.performUpkeep('0x');
      const receipt2 = await tx2.wait();
      console.log(`   ✅ Phase 2 done in block ${receipt2.blockNumber}\n`);
      await this.handleEventsFromReceipt(receipt2, true);
    } else {
      console.log(`🔄 Phase 2: Calling processBatchPhase2ForCycle(${batchCycle}) (orphan batch)...`);
      const tx2 = await this.kashYield.processBatchPhase2ForCycle(batchCycle);
      const receipt2 = await tx2.wait();
      console.log(`   ✅ Phase 2 for batch ${batchCycle} done in block ${receipt2.blockNumber}\n`);
      await this.handleEventsFromReceipt(receipt2, true);
    }
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

      const aaveSupplied = await this.getAaveSuppliedAmount();
      if (aaveSupplied >= depositAmount) {
        console.log(`   Stage 1: Already deposited to Aave`);
      } else {
        const toDeposit = depositAmount - aaveSupplied;
        console.log(`   Stage 1: Deposit ${config.strategy.aaveDepositPct}% to Aave`);
        const txDeposit = await this.kashYield.depositToAave(toDeposit);
        await txDeposit.wait();
      }

      // Step 2: Borrow 70% of deposit’s USD value as USDC, send to Hyperliquid as collateral
      const ltv = BigInt(config.strategy.borrowLtvPct);
      const borrowAmountUSD = (depositAmountUSD * ltv) / 100n;
      const borrowUsdcUnits = borrowAmountUSD / (10n ** 12n);
      console.log(`   Stage 2a: Borrow ${config.strategy.borrowLtvPct}% as USDC`);
      const aaveDebt = await this.getAaveBorrowedAmount();
      if (aaveDebt < borrowUsdcUnits) {
        await this.borrowFromAave(TOKEN_ADDRESSES.AAVE_USDC, borrowUsdcUnits - aaveDebt);
      }
      const contractUsdc = await this.getContractUsdcBalance();
      if (contractUsdc > 0n) {
        console.log(`   Stage 2b: Deposit ${ethers.formatUnits(contractUsdc, 6)} USDC to Hyperliquid`);
        await this.depositToHyperliquid(contractUsdc);
      }

      console.log(`   Stage 3: Spot buy ${isBtc ? 'wBTC' : 'ETH'} on Hyperliquid`);
      const hlSpot = await this.getHyperliquidSpotBalance();
      if (hlSpot >= borrowUsdcUnits) {
        const txSpot = await this.kashYield.spotBuyOnHyperliquid(borrowUsdcUnits);
        await txSpot.wait();
      }

      const shortSymbol = isBtc ? 'BTC' : 'ETH';
      const hasShort = await this.hasHyperliquidShort(shortSymbol);
      if (!hasShort) {
        const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
        const shortSizeUSD = (amountUSD * leverageScaled) / 100n;
        console.log(`   Stage 4: Open ${config.strategy.shortLeverage}x ${shortSymbol} short`);
        await this.openShortOnHyperliquid(shortSizeUSD, price, shortSymbol);
      }

      console.log('   ✅ NET_MINT complete!\n');

    } catch (error: any) {
      console.error('❌ Failed to handle NET_MINT:', error.message);
      console.error('   Re-run the bot to resume from the last completed stage.');
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
      await this.repayToAave(TOKEN_ADDRESSES.AAVE_USDC, usdcWithdrawUnits);

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

  private async getAaveSuppliedAmount(): Promise<bigint> {
    const poolAddr = await this.kashYield.aavePoolAddress();
    if (!poolAddr || poolAddr === ethers.ZeroAddress) return 0n;
    const aavePool = new ethers.Contract(
      poolAddr,
      [
        { inputs: [{ name: 'asset', type: 'address' }, { name: 'user', type: 'address' }], name: 'getATokenBalance', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
        { inputs: [], name: 'wbtcAddress', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
      ],
      this.provider
    );
    const addr = config.kashYieldAddress!;
    try {
      if (isBtc) {
        const wbtcAddr = await aavePool.wbtcAddress?.().catch(() => null);
        if (wbtcAddr) return await aavePool.getATokenBalance(wbtcAddr, addr);
      }
      const wethAddr = await this.kashYield.wethAddress?.().catch(() => null);
      if (wethAddr) return await aavePool.getATokenBalance(wethAddr, addr);
      return await aavePool.getATokenBalance(ethers.ZeroAddress, addr);
    } catch {
      return 0n;
    }
  }

  private async getAaveBorrowedAmount(): Promise<bigint> {
    const poolAddr = await this.kashYield.aavePoolAddress();
    if (!poolAddr || poolAddr === ethers.ZeroAddress) return 0n;
    try {
      const pool = new ethers.Contract(
        poolAddr,
        [{ inputs: [{ name: 'user', type: 'address' }], name: 'getBorrowedAmount', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }],
        this.provider
      );
      return await pool.getBorrowedAmount(config.kashYieldAddress!);
    } catch {
      return 0n;
    }
  }

  private async getContractUsdcBalance(): Promise<bigint> {
    try {
      const usdcAddr = await this.kashYield.usdcAddress();
      const usdc = new ethers.Contract(usdcAddr, [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }], this.provider);
      return await usdc.balanceOf(config.kashYieldAddress!);
    } catch {
      return 0n;
    }
  }

  private async getHyperliquidSpotBalance(): Promise<bigint> {
    try {
      return await this.kashYield.getHyperliquidSpotBalance();
    } catch {
      return 0n;
    }
  }

  private async hasHyperliquidShort(symbol: string): Promise<boolean> {
    try {
      const [, , , , isActive] = await this.kashYield.getHyperliquidPosition(symbol);
      return !!isActive;
    } catch {
      return false;
    }
  }
}
