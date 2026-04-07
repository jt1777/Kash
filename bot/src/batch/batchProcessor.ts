import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';
import { getDailyYield } from './dailyYield';
import { snapshotOpsContext, computeTotalRedeemAsset, getAaveBorrowedAmountV3 } from './opsContext';
import { classifyScenario, scenarioLabel } from './opsClassifier';
import { runMintPlaybook, runRedeemPlaybook, runTestAaveLoopPlaybook } from './opsPlaybooks';

const TOKEN_ADDRESSES = {
  USDC: config.tokens.USDC,
  /** For borrow/repay - use Aave's expected USDC (MockUSDC when using MockAave) */
  AAVE_USDC: config.aaveUsdcAddress,
};

const AAVE_POOL_ADDRESS = config.aavePoolAddress;
const isBtc = config.product === 'btc';

/** Minimum NAV (18 decimals). Prevents updateNAV(1) when supply is dust and (portfolio+yield)/supply truncates to 1. */
const MIN_NAV = 10n ** 18n;

const BATCH_STEP_NAMES = ['phase1', 'ops', 'nav', 'mark-done', 'phase2'] as const;
function isSingleStepMode(): boolean {
  return BATCH_STEP_NAMES.includes(config.batchStep as (typeof BATCH_STEP_NAMES)[number]);
}

/**
 * Batch Processor - Two-phase daily batch for KashYieldETH or KashYieldBtc.
 * Phase 1: performUpkeep() → indicative; handle NET_MINT/NET_REDEEM, updateNAV, markBatchOpsDone.
 * Phase 2: performUpkeep() → distribute KASH to minters and ETH to redeemers.
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
      if (config.skipProcessingWindowCheck) {
        console.log('⏳ Not in processing window (23:50-23:59 UTC); continuing anyway (SKIP_PROCESSING_WINDOW_CHECK=true)\n');
      } else {
        console.log('⏳ Not in processing window (23:50-23:59 UTC)');
        if (config.waitForProcessingWindow) {
          console.log('   Waiting for processing window...');
          await this.waitForProcessingWindow();
        } else {
          console.log('   Exiting (set WAIT_FOR_PROCESSING_WINDOW=true to wait, or SKIP_PROCESSING_WINDOW_CHECK=true to run anyway for testing)');
          return;
        }
      }
    }

    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    const currentCycleBn = typeof currentCycle === 'bigint' ? currentCycle : BigInt(currentCycle.toString());

    if (config.batchCycleOverride !== null) {
      const cycle = config.batchCycleOverride;
      console.log(`📅 Batch cycle: ${cycle} (override via --batch=${cycle} or BATCH_CYCLE)\n`);
      const batchInfo = await this.kashYield.getBatchInfo(cycle);
      await this.runBatch(cycle, batchInfo);
      return;
    }

    console.log(`📅 Batch cycle: ${currentCycle}\n`);

    // Check previous batches for incomplete work (phase 1: ops not done; phase 2: distribution not run)
    const lookback = 10; // check last 10 days of batches
    for (let i = 1; i <= lookback; i++) {
      const prevCycle = currentCycleBn - BigInt(i);
      if (prevCycle < 0n) break;
      const prevPhase = await this.kashYield.batchPhase(prevCycle);
      const prevInfo = await this.kashYield.getBatchInfo(prevCycle);
      if (prevInfo.processed) continue;
      const prevPhaseNum = Number(prevPhase);
      const prevNet = BigInt(prevInfo.totalMintUSD.toString()) - BigInt(prevInfo.totalRedeemUSD.toString());
      const isPhase1Orphan = prevPhaseNum === 1 &&
        (prevNet !== 0n || BigInt(prevInfo.mintUsersCount.toString()) > 0n || BigInt(prevInfo.redeemUsersCount.toString()) > 0n);
      const isPhase2Orphan = prevPhaseNum === 2; // ops done but Phase 2 (distribution) never ran
      if (isPhase1Orphan || isPhase2Orphan) {
        const action = isPhase2Orphan ? 'phase 2 (distribution) pending' : prevNet > 0n ? `net mint ${ethers.formatEther(prevNet)} USD` : `net redeem ${ethers.formatEther(-prevNet)} USD`;
        console.log(`⚠️  Found incomplete batch ${prevCycle} (${isPhase2Orphan ? 'phase 2' : 'phase 1'}, ${action})`);
        console.log(`   Completing orphaned batch before processing current batch...\n`);
        await this.runBatch(prevCycle, prevInfo);
        break; // complete one at a time, then re-run for more if needed
      }
    }

    const batchInfo = await this.kashYield.getBatchInfo(currentCycleBn);
    await this.runBatch(currentCycleBn, batchInfo);
  }

  /**
   * Two-phase flow: Phase 1 → ops + updateNAV + markBatchOpsDone → Phase 2.
   * When BATCH_STEP is phase1|ops|nav|mark-done|phase2, runs only that step and exits.
   */
  private async runBatch(
    batchCycle: bigint,
    batchInfo: { totalMintUSD: bigint; totalRedeemUSD: bigint; processed: boolean; mintUsersCount: bigint; redeemUsersCount: bigint }
  ): Promise<void> {
    const phase = await this.kashYield.batchPhase(batchCycle);
    const phaseNum = Number(phase);

    if (batchInfo.processed && !config.allowProcessedBatch) {
      console.log(`✅ Batch ${batchCycle} already processed (phase 3)\n`);
      return;
    }
    if (batchInfo.processed && config.allowProcessedBatch) {
      console.log(`⚠️  Batch ${batchCycle} is already processed; running with --allow-processed.\n`);
    }

    const hasRequests = batchInfo.mintUsersCount > 0n || batchInfo.redeemUsersCount > 0n;

    if (isSingleStepMode()) {
      const step = config.batchStep as (typeof BATCH_STEP_NAMES)[number];
      if (step === 'phase1') {
        if (phaseNum !== 0) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; step phase1 requires phase 0.`);
        if (!hasRequests) {
          console.log(`📭 Batch ${batchCycle} has no mint/redeem requests, skipping.\n`);
          return;
        }
        await this.runStepPhase1(batchCycle);
        return;
      }
      if (step === 'ops') {
        if (phaseNum !== 1 && !(batchInfo.processed && config.allowProcessedBatch)) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step phase1 first.`);
        const lockedNav = config.lockedNav ?? undefined;
        if (lockedNav != null) console.log(`📊 Using --locked-nav: $${ethers.formatEther(lockedNav)} per KASH\n`);
        await this.runStepOps(batchCycle, batchInfo, lockedNav);
        return;
      }
      if (step === 'nav') {
        if (phaseNum !== 1) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step ops first.`);
        const lockedNav = config.lockedNav ?? undefined;
        if (lockedNav != null) console.log(`📊 Using --locked-nav: $${ethers.formatEther(lockedNav)} per KASH\n`);
        await this.runStepNav(batchCycle, lockedNav);
        return;
      }
      if (step === 'mark-done') {
        if (phaseNum !== 1) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step nav first.`);
        await this.runStepMarkDone(batchCycle);
        return;
      }
      if (step === 'phase2') {
        if (phaseNum !== 2) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step mark-done first.`);
        await this.runPhase2ForBatch(batchCycle);
        return;
      }
    }

    if (phaseNum === 0) {
      if (!hasRequests) {
        console.log(`📭 Batch ${batchCycle} has no mint/redeem requests, skipping.\n`);
        return;
      }
      // Compute NAV once now, before any on-chain ops run. The ops (Aave deposit/borrow,
      // HL trades) change live Aave balances and HL positions, which would alter the yield
      // figures if we called computeNewNAV() after them. By computing here we lock in the
      // pre-ops NAV; the same value is passed to updateNAV() so Phase 2 settles mints and
      // redeems at this price — not at a post-ops-tainted recalculation.
      console.log('📊 Computing NAV (pre-ops snapshot)...');
      const newNAV = await this.computeNewNAV();
      console.log(`   NAV locked for this batch: $${ethers.formatEther(newNAV)} per KASH\n`);
      await this.runStepPhase1(batchCycle);
      // Re-read batchInfo after Phase 1 so totalMintUSD/totalRedeemUSD are set (Phase 1 writes them on-chain).
      const batchInfoAfterPhase1 = await this.kashYield.getBatchInfo(batchCycle);
      await this.runStepOps(batchCycle, batchInfoAfterPhase1, newNAV);
      await this.runStepNav(batchCycle, newNAV);
      await this.runStepMarkDone(batchCycle, newNAV);
      await this.runPhase2ForBatch(batchCycle);
      return;
    }

    if (phaseNum === 1) {
      // Resuming from phase 1: compute NAV now, before ops, for the same reason as above —
      // ops change Aave/HL state so computing after would give a post-ops-tainted value.
      console.log('📊 Computing NAV (pre-ops snapshot)...');
      const newNAV = await this.computeNewNAV();
      console.log(`   NAV locked for this batch: $${ethers.formatEther(newNAV)} per KASH\n`);
      await this.runStepOps(batchCycle, batchInfo, newNAV);
      await this.runStepNav(batchCycle, newNAV);
      await this.runStepMarkDone(batchCycle, newNAV);
      await this.runPhase2ForBatch(batchCycle);
      return;
    }

    if (phaseNum === 2) {
      await this.runPhase2ForBatch(batchCycle);
      return;
    }

    if (phaseNum === 3 && config.allowProcessedBatch && (config.batchStep === 'ops' || config.batchStep === 'hl' || config.batchStep === 'aave')) {
      console.log('Running ops step on processed batch (--allow-processed).');
      await this.runStepOps(batchCycle, batchInfo);
      return;
    }

    console.log(`✅ Batch ${batchCycle} already finalized (phase ${phaseNum}).\n`);
  }

  /** Step 1: Call performUpkeep() (Phase 1 indicative). Batch must be phase 0 with requests. */
  private async runStepPhase1(batchCycle: bigint): Promise<void> {
    console.log('🔄 Step phase1: Calling performUpkeep()...');
    const tx1 = await this.kashYield.performUpkeep('0x');
    const receipt1 = await tx1.wait();
    console.log(`   ✅ Phase 1 done in block ${receipt1.blockNumber}\n`);
  }

  /** Step 2: Handle NET_MINT/NET_REDEEM (HL + Aave). Batch must be phase 1. Respects --step=hl|aave.
   * @param lockedNAV Pre-ops NAV snapshot used for withdrawal sizing so redeemers receive
   *   the full value at settlement price, including daily yield not yet reflected in currentNAV. */
  private async runStepOps(
    batchCycle: bigint,
    batchInfo: { totalMintUSD: bigint; totalRedeemUSD: bigint },
    lockedNAV?: bigint
  ): Promise<void> {
    const net = BigInt(batchInfo.totalMintUSD.toString()) - BigInt(batchInfo.totalRedeemUSD.toString());

    // Classify the top-level scenario (reads activePerpExchange() from contract)
    const scenario = await classifyScenario(net, this.kashYield);
    console.log(`📋 Ops scenario: ${scenarioLabel(scenario)}\n`);

    if (scenario === 'net_zero') {
      console.log('   net = 0; no position changes needed.\n');
      return;
    }

    // Snapshot all on-chain state once before executing any steps
    const ctx = await snapshotOpsContext(this.kashYield, this.provider, batchCycle, lockedNAV);

    if (scenario === 'net_mint_hl') {
      await runMintPlaybook(ctx, net);
    } else if (scenario === 'redeem_hl') {
      // Reactive tail classification happens inside runRedeemPlaybook
      await runRedeemPlaybook(ctx, lockedNAV);
    } else if (scenario === 'test_aave_loop') {
      await runTestAaveLoopPlaybook(ctx);
    }
  }

  /** Step 3: Call updateNAV(newNAV, usdcBalance, assetBalance, perpPnL). Batch must be phase 1.
   * In the full batch flow, receives the NAV that was computed before Phase 1 and ops ran,
   * so Phase 2 settles mints/redeems at the same pre-ops price used for the indicative sizing.
   * When running in single-step mode (--step=nav) no pre-computed value is available, so it
   * falls back to computing on-demand at that point.
   * usdcBalance/assetBalance are snapshotted from on-chain adapter views for transparency.
   * perpPnL is passed as 0 because Hyperliquid perp PnL is off-chain and not accessible here. */
  private async runStepNav(batchCycle: bigint, precomputedNAV?: bigint): Promise<void> {
    const newNAV = precomputedNAV ?? await this.computeNewNAV();

    let usdcBalance = 0n;
    let assetBalance = 0n;
    try {
      usdcBalance = BigInt((await this.kashYield.getHyperliquidSpotBalance()).toString());
      assetBalance = BigInt((await this.kashYield.getExchangeAssetBalance()).toString());
    } catch {
      // Non-critical — portfolio snapshot unavailable; NAV update still proceeds
    }

    console.log(`📈 Step nav: Updating NAV to $${ethers.formatEther(newNAV)} per KASH  (usdcBal=${ethers.formatUnits(usdcBalance, 6)}, assetBal=${ethers.formatEther(assetBalance)})...`);
    await (await this.kashYield.updateNAV(newNAV, usdcBalance, assetBalance, 0n)).wait();
    console.log('   ✅ updateNAV done\n');
  }

  /** Step 4: Call markBatchOpsDone(batchCycle). Batch must be phase 1.
   * Verifies the contract holds enough ETH/wBTC to cover all pending redemptions before advancing
   * to phase 2, so Phase 2 cannot enter an InsufficientEthForRedeems state due to partial ops.
   * Uses computeTotalRedeemAsset from opsContext — same formula as the ops playbook steps. */
  private async runStepMarkDone(batchCycle: bigint, lockedNAV?: bigint): Promise<void> {
    const decimals = isBtc ? 8n : 18n;
    const price = isBtc
      ? BigInt((await this.kashYield.getBtcPrice()).toString())
      : BigInt((await this.kashYield.getEthPrice()).toString());

    const totalRedeemAsset = await computeTotalRedeemAsset(
      this.kashYield,
      batchCycle,
      lockedNAV,
      price,
      decimals,
    );

    if (totalRedeemAsset > 0n) {
      const contractAddr = config.kashYieldAddress!;
      let contractBalance: bigint;
      if (isBtc) {
        try {
          const wbtcAddr: string = await this.kashYield.wbtcAddress();
          const wbtc = new ethers.Contract(wbtcAddr, ['function balanceOf(address) view returns (uint256)'], this.provider);
          contractBalance = BigInt((await wbtc.balanceOf(contractAddr)).toString());
        } catch { contractBalance = 0n; }
      } else {
        contractBalance = BigInt((await this.provider.getBalance(contractAddr)).toString());
      }

      if (contractBalance < totalRedeemAsset) {
        throw new Error(
          `Cannot markBatchOpsDone: contract holds ${ethers.formatUnits(contractBalance, Number(decimals))} ` +
          `but redeemers need ${ethers.formatUnits(totalRedeemAsset, Number(decimals))}. ` +
          `Pull remaining funds from Aave/HL before proceeding.`
        );
      }
      console.log(`   ✅ Balance check passed: contract has ${ethers.formatUnits(contractBalance, Number(decimals))} (need ${ethers.formatUnits(totalRedeemAsset, Number(decimals))})`);
    }

    console.log('📋 Step mark-done: Marking batch ops done...');
    await (await this.kashYield.markBatchOpsDone(batchCycle)).wait();
    console.log('   ✅ markBatchOpsDone\n');
  }

  /** Compute new NAV (18 decimals) from portfolio and yield; clamp to MIN_NAV. */
  private async computeNewNAV(): Promise<bigint> {
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
      if (newNAV === 0n) newNAV = MIN_NAV;
      console.log(`   📈 KASH supply is 0, using current NAV for updateNAV`);
    }
    if (newNAV > 0n && newNAV < MIN_NAV) {
      newNAV = MIN_NAV;
      console.log(`   📈 NAV clamped to minimum $1 (was dust from small supply)`);
    }
    return newNAV;
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
      await this.handleEventsFromReceipt(receipt2);
    } else {
      console.log(`🔄 Phase 2: Calling processBatchPhase2ForCycle(${batchCycle}) (orphan batch)...`);
      try {
        const tx2 = await this.kashYield.processBatchPhase2ForCycle(batchCycle);
        const receipt2 = await tx2.wait();
        console.log(`   ✅ Phase 2 for batch ${batchCycle} done in block ${receipt2.blockNumber}\n`);
        await this.handleEventsFromReceipt(receipt2);
      } catch (err: any) {
        const info = await this.kashYield.getBatchInfo(batchCycle).catch(() => null);
        if (info?.processed) {
          console.log(`   ℹ️  Phase 2 for batch ${batchCycle} already completed — skipping.\n`);
          return;
        }
        // Detect InsufficientEthForRedeems (selector 0x56f6e9e8) and give actionable guidance
        const errData: string = err?.data ?? err?.error?.data ?? '';
        if (typeof errData === 'string' && errData.startsWith('0x56f6e9e8')) {
          console.error(`❌ Phase 2 failed: contract has insufficient ETH for redemptions.`);
          console.error(`   Funds may still be in Aave or Hyperliquid from a partial ops run.`);
          console.error(`   Recovery steps:`);
          console.error(`     1. Pull from Aave:  npx hardhat run scripts/ownerWithdrawFromAave.js --network arbitrumSepolia`);
          console.error(`     2. Re-run bot:      npm start  (will retry Phase 2 automatically)`);
          console.error(`   Or settle manually (burns KASH, pays ETH from contract balance):`);
          console.error(`     BATCH_CYCLE=${batchCycle} USER_ADDRESSES=0x... npx hardhat run scripts/ownerManuallyProcessRedeem.js --network arbitrumSepolia`);
        }
        throw err;
      }
    }
  }

  /**
   * Parse ProtocolInteraction events from transaction receipt.
   * Phase 1 receipts trigger NET_MINT/NET_REDEEM handlers; Phase 2 receipts are informational only.
   */
  private async handleEventsFromReceipt(receipt: ethers.TransactionReceipt): Promise<void> {
    console.log('📡 Parsing ProtocolInteraction events from receipt...\n');

    const iface = new ethers.Interface(kashYieldABI);
    let eventsFound = 0;
    const kashYieldAddr = config.kashYieldAddress?.toLowerCase() ?? (await this.kashYield.getAddress()).toLowerCase();

    for (const log of receipt.logs) {
      let parsedLog: { name: string; args: unknown[] } | null = null;
      try {
        if (log.address.toLowerCase() !== kashYieldAddr) continue;

        parsedLog = iface.parseLog({
          topics: log.topics as string[],
          data: log.data
        }) as { name: string; args: unknown[] } | null;

        if (parsedLog && parsedLog.name === 'ProtocolInteraction') {
          eventsFound++;
          const action = parsedLog.args[0] as string;
          const asset = parsedLog.args[1] as string;
          const amount = parsedLog.args[2] as bigint;

          console.log(`📡 ProtocolInteraction: ${action}, asset=${asset}, amount=${ethers.formatEther(amount)}\n`);

          if (action === 'NET_MINT') {
            await this.handleNetMint(amount, asset);
          } else if (action === 'NET_REDEEM') {
            const cycle = BigInt((await this.kashYield.getCurrentBatchCycle()).toString());
            await this.handleNetRedeem(amount, asset, cycle);
          }
        }
      } catch (err) {
        if (parsedLog?.name === 'ProtocolInteraction') throw err;
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
        const cycle = BigInt((await this.kashYield.getCurrentBatchCycle()).toString());
        await this.handleNetRedeem(amount, asset, cycle);
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
    const step = config.batchStep;
    console.log(`💰 Handling NET_MINT (${isBtc ? 'BTC' : 'ETH'}) - Deploying capital...`);
    console.log(`   Net amount: ${ethers.formatEther(amount)} USD${step !== 'full' ? ` [step=${step} only]` : ''}\n`);

    try {
      let extendHl = step === 'hl';
      if (step === 'full' || step === 'ops' || step === 'aave') {
        const aaveMeta = await this.handleNetMintAave(amount);
        extendHl = extendHl || aaveMeta.toDeposit > 0n || aaveMeta.borrowedUsdcDelta > 0n;
      }
      if (step === 'full' || step === 'ops' || step === 'hl') {
        await this.handleNetMintHyperliquid(amount, extendHl);
      }
      console.log('   ✅ NET_MINT complete!\n');
    } catch (error: any) {
      console.error('❌ Failed to handle NET_MINT:', error.message);
      console.error('   Re-run the bot to resume from the last completed stage.');
      throw error;
    }
  }

  /**
   * NET_MINT Aave: deposit min(per-batch target, vault balance), then borrow up to LTV × **total** supplied collateral.
   * Returns deltas so Hyperliquid can extend spot/short only when new collateral or new borrow landed.
   */
  private async handleNetMintAave(amount: bigint): Promise<{ toDeposit: bigint; borrowedUsdcDelta: bigint }> {
    const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
    const pct = BigInt(config.strategy.aaveDepositPct);
    const depositAmountUSD = (amount * pct) / 100n;
    const depositAmount = isBtc
      ? (depositAmountUSD * (10n ** 8n)) / price
      : (depositAmountUSD * (10n ** 18n)) / price;

    const kashAddr = await this.kashYield.getAddress();
    const vaultAssetBal = isBtc
      ? await new ethers.Contract(
          await this.kashYield.wbtcAddress(),
          ['function balanceOf(address) view returns (uint256)'],
          this.provider
        ).balanceOf(kashAddr)
      : await this.provider.getBalance(kashAddr);
    const toDeposit = depositAmount < vaultAssetBal ? depositAmount : vaultAssetBal;
    if (toDeposit > 0n) {
      console.log(
        `   [Aave] Stage 1: Deposit ${config.strategy.aaveDepositPct}% to Aave (${isBtc ? ethers.formatUnits(toDeposit, 8) : ethers.formatEther(toDeposit)} ${isBtc ? 'wBTC' : 'ETH'})`
      );
      const txDeposit = await this.kashYield.depositToAave(toDeposit);
      await txDeposit.wait();
    } else {
      console.log(
        `   [Aave] Stage 1: No ${isBtc ? 'wBTC' : 'ETH'} in vault to deposit (target for this batch already moved or empty vault)`
      );
    }

    const targetBorrowUsdc = await this.getTargetBorrowUsdcUnits(price);
    console.log(`   [Aave] Stage 2: Borrow up to ${config.strategy.borrowLtvPct}% of total supplied collateral (target ${targetBorrowUsdc} USDC units)`);
    const debtBefore = await this.getAaveBorrowedAmount();
    if (debtBefore < targetBorrowUsdc) {
      await this.borrowFromAave(TOKEN_ADDRESSES.AAVE_USDC, targetBorrowUsdc - debtBefore);
    }
    const debtAfter = await this.getAaveBorrowedAmount();
    return { toDeposit, borrowedUsdcDelta: debtAfter - debtBefore };
  }

  /** Max USDC debt (6-dec units) = LTV × USD value of total Aave-supplied collateral. */
  private async getTargetBorrowUsdcUnits(price: bigint): Promise<bigint> {
    const supplied = await this.getAaveSuppliedAmount();
    if (supplied === 0n) return 0n;
    const ltv = BigInt(config.strategy.borrowLtvPct);
    const suppliedUSD18 = isBtc
      ? (supplied * price) / (10n ** 8n)
      : (supplied * price) / (10n ** 18n);
    const borrowUSD18 = (suppliedUSD18 * ltv) / 100n;
    return borrowUSD18 / (10n ** 12n);
  }

  /**
   * NET_MINT Hyperliquid: move **this run's** USDC to HL, spot-buy asset, open or **add to** short
   * (MockHyperliquid aggregates `openPerpPosition`). Skips short extension when `extendShort` is false
   * and a short already exists (idempotent re-run); always opens if no short (recovery).
   */
  private async handleNetMintHyperliquid(amount: bigint, extendShort: boolean): Promise<void> {
    const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
    const contractUsdc = await this.getContractUsdcBalance();
    if (contractUsdc > 0n) {
      console.log(`   [HL] Stage 1: Deposit ${ethers.formatUnits(contractUsdc, 6)} USDC to Hyperliquid`);
      await this.depositToHyperliquid(contractUsdc);
    }

    console.log(`   [HL] Stage 2: Spot buy ${isBtc ? 'wBTC' : 'ETH'} on Hyperliquid`);
    if (contractUsdc > 0n) {
      const txSpot = await this.kashYield.spotBuyOnHyperliquid(contractUsdc);
      await txSpot.wait();
    }

    const shortSymbol = isBtc ? 'BTC' : 'ETH';
    const hasShort = await this.hasHyperliquidShort(shortSymbol);
    const shouldAddOrOpen = extendShort || !hasShort;
    if (shouldAddOrOpen) {
      const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
      const shortSizeUSD = (amount * leverageScaled) / 100n;
      console.log(
        `   [HL] Stage 3: ${hasShort ? 'Add to' : 'Open'} ${config.strategy.shortLeverage}x ${shortSymbol} short (incremental notional)`
      );
      await this.openShortOnHyperliquid(shortSizeUSD, price, shortSymbol);
    } else {
      console.log(`   [HL] Stage 3: Skip short (position already open, no new collateral or borrow this run)`);
    }
  }

  /**
   * Handle NET_REDEEM - Withdraw capital (reverse of NET_MINT).
   * Can run as one step (full) or split: --step=hl (HL only) then --step=aave (Aave only).
   *
   * Uses the fraction of total KASH supply being redeemed to determine exactly how much
   * of each position (HL short, HL spot BTC, Aave wBTC) to unwind.  This is correct
   * regardless of price movement — a USD/leverage-based close size drifts wrong when
   * price has moved since the position was opened.
   */
  private async handleNetRedeem(amountUSD: bigint, _asset: string, batchCycle: bigint, lockedNAV?: bigint): Promise<void> {
    const step = config.batchStep;
    console.log(`💸 Handling NET_REDEEM (${isBtc ? 'BTC' : 'ETH'}) - Withdrawing capital...`);
    console.log(`   Net amount: ${ethers.formatEther(amountUSD)} USD${step !== 'full' ? ` [step=${step} only]` : ''}\n`);

    const redeemFraction = await this.getRedeemFraction(batchCycle);
    const pct = (Number(redeemFraction) / 1e16).toFixed(2);
    console.log(`   Redeem fraction: ${pct}% of KASH supply\n`);

    try {
      if (step === 'full' || step === 'ops' || step === 'hl') await this.handleNetRedeemHyperliquid(redeemFraction);
      if (step === 'full' || step === 'ops' || step === 'aave') await this.handleNetRedeemAave(amountUSD, redeemFraction, lockedNAV);
      console.log('   ✅ NET_REDEEM complete!\n');
    } catch (error: any) {
      console.error('❌ Failed to handle NET_REDEEM:', error.message);
      throw error;
    }
  }

  /**
   * Compute the fraction of total KASH supply being redeemed (18-dec, 1e18 = 100%).
   * Reads the actual KASH submitted by redeemers for this specific batch cycle directly
   * from batchTotalRedeemKash — no NAV approximation needed.
   * Must receive the batch cycle being processed (not getCurrentBatchCycle()) so orphan
   * batches are read correctly.
   */
  private async getRedeemFraction(batchCycle: bigint): Promise<bigint> {
    try {
      const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
      if (!tokenAddr) return BigInt(1e18);
      const kashToken = new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider);
      const totalSupply = BigInt((await kashToken.totalSupply()).toString());
      if (totalSupply === 0n) return BigInt(1e18);
      const redeemKash = BigInt((await this.kashYield.batchTotalRedeemKash(batchCycle)).toString());
      if (redeemKash === 0n) return BigInt(1e18);
      const fraction = (redeemKash * BigInt(1e18)) / totalSupply;
      return fraction > BigInt(1e18) ? BigInt(1e18) : fraction;
    } catch (err: any) {
      console.warn(`   ⚠️  Could not compute redeem fraction for batch ${batchCycle}: ${err?.message ?? err}`);
      console.warn(`       Defaulting to 100% (full unwind). Check that batchTotalRedeemKash(${batchCycle}) exists on the contract.`);
      return BigInt(1e18);
    }
  }

  /**
   * NET_REDEEM Hyperliquid (unified for ETH and BTC products):
   *   1. Close the proportional share of the short (redeemFraction of position size)
   *   2. Sell ALL spot asset back to USDC — the redeemer's collateral (ETH or wBTC) always
   *      comes from Aave, never from HL spot.  HL is only ever a USDC in / USDC out venue.
   *   3. Withdraw all USDC from HL to the contract
   *
   * handleNetRedeemAave then uses that USDC to repay the proportional Aave borrow and
   * withdraws the proportional share of Aave collateral to fund Phase 2 payouts.
   */
  private async handleNetRedeemHyperliquid(redeemFraction: bigint): Promise<void> {
    const shortSymbol = isBtc ? 'BTC' : 'ETH';

    // ── Step 1: Close proportional share of the HL short ──────────────────
    const pct = (Number(redeemFraction) / 1e16).toFixed(2);
    console.log(`   [HL] Step 1: Close ${pct}% of ${shortSymbol} short on Hyperliquid`);
    const [posSize, , , , isActive] = await this.kashYield.getHyperliquidPosition(shortSymbol);
    if (!isActive) {
      const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
      const kashSupply = tokenAddr
        ? BigInt((await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()).toString())
        : 0n;
      if (kashSupply > 0n) {
        // KASH supply still exists but no short is open — short was already closed in a
        // previous partial run.  Continue so remaining steps still execute.
        console.warn(`   ⚠️  No active ${shortSymbol} short but KASH supply is ${ethers.formatEther(kashSupply)} KASH.`);
        console.warn(`       Assuming short was closed in a previous partial run — continuing.`);
      } else {
        console.log(`   → No open ${shortSymbol} short; skipping`);
      }
    } else {
      const fullSize = BigInt(posSize.toString());
      const closeSize = (fullSize * redeemFraction) / BigInt(1e18);
      if (closeSize >= fullSize) {
        await (await this.kashYield['closeShort(string)'](shortSymbol)).wait();
        console.log(`   ✅ Closed full ${shortSymbol} short`);
      } else {
        await (await this.kashYield['closeShort(string,uint256)'](shortSymbol, closeSize)).wait();
        console.log(`   ✅ Partially closed ${shortSymbol} short: ${ethers.formatEther(closeSize)} of ${ethers.formatEther(fullSize)}`);
      }
    }

    // ── Step 2: Sell ALL spot asset back to USDC ─────────────────────────
    // Closing the short returns the proportional spot asset collateral to HL's internal
    // ledger.  Sell it all — the redeemer's ETH/wBTC is sourced from Aave, not HL spot.
    let hlAssetBalance = 0n;
    try {
      hlAssetBalance = BigInt((await this.kashYield.getExchangeAssetBalance()).toString());
    } catch {
      console.warn('   ⚠️  Could not read exchange asset balance; spot sell skipped');
    }

    if (hlAssetBalance > 0n) {
      console.log(`   [HL] Step 2: Spot sell ${ethers.formatEther(hlAssetBalance)} ${shortSymbol} → USDC`);
      await (await this.kashYield.spotSellOnHyperliquid(hlAssetBalance)).wait();
      console.log(`   ✅ Spot sold`);
    } else {
      console.log(`   [HL] Step 2: No spot ${shortSymbol} to sell`);
    }

    // ── Step 3: Withdraw all USDC from HL ────────────────────────────────
    const spotUsdc = await this.getHyperliquidSpotBalance();
    if (spotUsdc > 0n) {
      console.log(`   [HL] Step 3: Withdraw ${ethers.formatUnits(spotUsdc, 6)} USDC from HL`);
      await this.withdrawFromHyperliquid(spotUsdc);
    }
  }

  /**
   * NET_REDEEM Aave: repay USDC debt, then withdraw the redeemer's collateral.
   *
   * Withdrawal sizing uses lockedNAV (the pre-ops NAV snapshot) when available, because
   * Phase 2 will settle redeemers at that price. Using the Phase-1 amountUSD (which is
   * priced at the older currentNAV) would leave the daily accrued yield sitting in Aave
   * as extra aTokens, causing a vault shortfall when Phase 2 tries to pay out.
   *
   * On a full (100%) redemption the residual aToken balance after repaying debt is
   * withdrawn entirely, sweeping any accrued interest and absorbing HL slippage gaps.
   */
  private async handleNetRedeemAave(amountUSD: bigint, redeemFraction: bigint, lockedNAV?: bigint): Promise<void> {
    const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
    console.log(`   [Aave] Step 1: Repay Aave borrow with USDC (contract balance)`);
    const contractUsdc = await this.getContractUsdcBalance();
    if (contractUsdc > 0n) {
      await this.repayToAave(TOKEN_ADDRESSES.AAVE_USDC, contractUsdc);
    }

    // Check whether debt was fully cleared (it may not be if price rose and
    // spot asset proceeds were insufficient to cover the full borrow).
    const remainingDebt = await this.getAaveBorrowedAmount();
    if (remainingDebt > 0n) {
      const assetDecimals = isBtc ? 8n : 18n;
      const remainingAsset = isBtc
        ? (remainingDebt * BigInt(1e12) * BigInt(1e8)) / price
        : (remainingDebt * BigInt(1e12) * BigInt(1e18)) / price;
      console.warn(`   ⚠️  Residual Aave debt: ${ethers.formatUnits(remainingDebt, 6)} USDC` +
        ` (~${ethers.formatUnits(remainingAsset, Number(assetDecimals))} ${isBtc ? 'wBTC' : 'ETH'} at current price)`);

      // If a spot DEX adapter is configured, use it to cover the residual via swapForUsdc.
      const spotDexAddress = await this.kashYield.spotDexAddress().catch(() => null);
      if (spotDexAddress && spotDexAddress !== ethers.ZeroAddress) {
        console.log(`   [Aave] Step 1b: Withdrawing ${ethers.formatUnits(remainingAsset, Number(assetDecimals))} ${isBtc ? 'wBTC' : 'ETH'} from Aave`);
        await (await this.kashYield.withdrawFromAave(remainingAsset)).wait();
        console.log(`   [Aave] Step 1c: Swapping to USDC via spot DEX (swapForUsdc)`);
        await (await this.kashYield.swapForUsdc(remainingAsset)).wait();
        const newContractUsdc = await this.getContractUsdcBalance();
        if (newContractUsdc > 0n) {
          console.log(`   [Aave] Step 1d: Repaying ${ethers.formatUnits(newContractUsdc, 6)} USDC to Aave`);
          await this.repayToAave(TOKEN_ADDRESSES.AAVE_USDC, newContractUsdc);
        }
      } else {
        console.warn(`       Spot DEX not configured (setSpotDex). Manually swap ${isBtc ? 'wBTC' : 'ETH'} to USDC and repay Aave.`);
      }
    }

    // On a full redemption, withdraw the entire remaining Aave position rather than a
    // calculated amount. This sweeps accrued yield (aTokens above the base balance) and
    // any gap left by HL slippage so Phase 2 has enough collateral to pay redeemers in full.
    const isFullRedemption = redeemFraction >= BigInt(1e18);
    if (isFullRedemption) {
      const aaveSupplied = await this.getAaveSuppliedAmount();
      if (aaveSupplied > 0n) {
        console.log(`   [Aave] Step 2: Full redemption — withdrawing entire Aave position (${isBtc ? ethers.formatUnits(aaveSupplied, 8) + ' wBTC' : ethers.formatEther(aaveSupplied) + ' ETH'})`);
        await (await this.kashYield.withdrawFromAave(aaveSupplied)).wait();
      } else {
        console.log(`   [Aave] Step 2: Full redemption — no Aave balance remaining`);
      }
      return;
    }

    // Partial redemption: size the withdrawal using lockedNAV so the amount matches what
    // Phase 2 will pay out. amountUSD was priced at the old currentNAV by Phase 1; we
    // scale it up by lockedNAV/currentNAV to cover the daily yield that wasn't reflected.
    // updateNAV() has not run yet, so currentNAV still holds yesterday's value on-chain.
    // Falls back to amountUSD if lockedNAV is unavailable (manual --step=aave runs).
    let effectiveUSD = amountUSD;
    if (lockedNAV != null && lockedNAV > 0n) {
      const currentNAVOnChain = BigInt((await this.kashYield.currentNAV()).toString());
      if (currentNAVOnChain > 0n) {
        effectiveUSD = (amountUSD * lockedNAV) / currentNAVOnChain;
      }
    }

    const withdrawAmount = isBtc
      ? (effectiveUSD * (10n ** 8n)) / price
      : (effectiveUSD * (10n ** 18n)) / price;
    const navLabel = lockedNAV != null ? ` (at locked NAV $${ethers.formatEther(lockedNAV)})` : '';
    console.log(`   [Aave] Step 2: Withdraw ${isBtc ? ethers.formatUnits(withdrawAmount, 8) + ' wBTC' : ethers.formatEther(withdrawAmount) + ' ETH'} from Aave${navLabel}`);
    await (await this.kashYield.withdrawFromAave(withdrawAmount)).wait();
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
   * Close short position on Hyperliquid (partial or full).
   * If amountUSD is provided and contract supports it, closes only the size corresponding to amountUSD (same leverage as open).
   * Otherwise or if closeSize >= position size, closes fully.
   * If no active position and KASH supply > 0, throws invariant violation.
   */
  private async closeShortOnHyperliquid(symbol: 'ETH' | 'BTC', amountUSD?: bigint): Promise<void> {
    try {
      const [size, , , , isActive] = await this.kashYield.getHyperliquidPosition(symbol);
      if (!isActive) {
        const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
        const kashSupply = tokenAddr
          ? await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()
          : 0n;
        if (kashSupply > 0n) {
          throw new Error(
            `Invariant violated: KASH supply is ${kashSupply.toString()} but HL reports no active ${symbol} short. ` +
            'Position may have been closed elsewhere or HL state is inconsistent.'
          );
        }
        console.log(`   → No open ${symbol} short on Hyperliquid; skipping close`);
        return;
      }
      const posSize = BigInt(size.toString());
      let closeSize: bigint | null = null;
      if (amountUSD != null && amountUSD > 0n && posSize > 0n) {
        const price = isBtc ? await this.kashYield.getBtcPrice() : await this.kashYield.getEthPrice();
        const leverageScaled = BigInt(Math.round(config.strategy.shortLeverage * 100));
        const shortSizeUSD = (amountUSD * leverageScaled) / 100n;
        closeSize = (shortSizeUSD * (10n ** 18n)) / price;
        if (closeSize >= posSize) closeSize = null; // full close
        else if (closeSize === 0n) closeSize = null;
      }
      if (closeSize != null && closeSize > 0n) {
        console.log(`   → Partially closing ${symbol} short: ${ethers.formatEther(closeSize)} of ${ethers.formatEther(posSize)}`);
        const tx = await this.kashYield['closeShort(string,uint256)'](symbol, closeSize);
        await tx.wait();
        console.log(`   ✅ Partially closed ${symbol} short on Hyperliquid`);
      } else {
        console.log(`   → Closing full ${symbol} short on Hyperliquid`);
        const tx = await this.kashYield['closeShort(string)'](symbol);
        await tx.wait();
        console.log(`   ✅ Closed ${symbol} short on Hyperliquid`);
      }
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
      if (wethAddr) {
        const bal = await aavePool.getATokenBalance(wethAddr, addr).catch(() => null);
        if (bal !== null) return bal;
      }
      return await aavePool.getATokenBalance(ethers.ZeroAddress, addr);
    } catch {
      return 0n;
    }
  }

  /**
   * Read outstanding USDC debt from Aave, including accrued interest.
   * Uses getAaveBorrowedAmountV3 which supports both mock (getBorrowedAmount) and
   * real Aave V3 (variable debt token / getUserAccountData fallback).
   */
  private async getAaveBorrowedAmount(): Promise<bigint> {
    const poolAddr = await this.kashYield.aavePoolAddress().catch(() => '');
    if (!poolAddr || poolAddr === ethers.ZeroAddress) return 0n;
    const userAddr = config.aaveUserAddress || config.kashYieldAddress!;
    const usdcAddr = config.aaveUsdcAddress;
    return getAaveBorrowedAmountV3(this.provider, poolAddr, usdcAddr, userAddr).catch(() => 0n);
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
