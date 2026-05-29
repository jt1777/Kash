import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { protocolActionName } from '../contracts/protocolActionCodes';
import { config } from '../config';
import {
  snapshotOpsContext,
  computeTotalRedeemAsset,
  vaultCoversRedeemPayout,
  vaultCoversRedeemPayoutFromGross,
  getAaveBorrowedAmountV3,
  getAaveSuppliedAmountV3,
  readHyperliquidAdapterAddress,
} from './opsContext';
import { classifyScenario, scenarioLabel } from './opsClassifier';
import { runTargetStateEngine } from './targetStateEngine';
import { runTestAaveLoopPlaybook } from './opsTestPlaybook';
import { execTx } from './txSend';
import { BatchRunLock } from './batchRunLock';

const isBtc = config.product === 'btc';

/** Initial NAV (18 decimals) used only before any KASH supply exists. */
const INITIAL_NAV = 10n ** 18n;

const BATCH_STEP_NAMES = ['phase1', 'ops', 'nav', 'mark-done', 'phase2'] as const;
function isSingleStepMode(): boolean {
  return BATCH_STEP_NAMES.includes(config.batchStep as (typeof BATCH_STEP_NAMES)[number]);
}

/**
 * Batch Processor - Two-phase daily batch for KashYieldETH or KashYieldBtc.
 *
 * NAV (two on-chain updates per batch when starting from phase 0):
 * 1. Pre-Phase-1: computeNewNAV (MTM) → updateNAV so Phase 1 on-chain signals use fresh NAV.
 * 2. Ops: NET_MINT / NET_REDEEM (sizing uses Phase-1-era NAV, same as on-chain currentNAV after step 1).
 * 3. Settlement: computeNewNAV after ops → updateNAV so Phase 2 mint/redeem uses post-fee / post-slippage MTM.
 * Phase 2: performUpkeep() → distribute KASH and pay redeemers.
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
    const runLock = new BatchRunLock();
    runLock.acquire();
    try {
      await this.runLocked();
    } finally {
      runLock.release();
    }
  }

  private async runLocked(): Promise<void> {
    console.log('🚀 Starting Batch Processor...\n');

    // isProcessingWindow() can revert on some testnet deployments (e.g. cycleDurationSeconds=0
    // or older contract version). Treat any revert as "not in window" so the skip flag still works.
    let isProcessingWindow = false;
    try {
      isProcessingWindow = await this.kashYield.isProcessingWindow();
    } catch (err: any) {
      if (!config.skipProcessingWindowCheck) {
        throw new Error(`isProcessingWindow() reverted: ${err?.message ?? err}`);
      }
      console.log('⚠️  isProcessingWindow() reverted on this contract; treating as outside window.\n');
    }
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

    // Test scenarios skip all batch management (getCurrentBatchCycle, batchPhase, getBatchInfo, orphan
    // check) and run ops directly. This avoids any contract call that depends on cycleDurationSeconds
    // or batch state that may not be set up for ad-hoc testing.
    if (config.opsScenarioOverride === 'test_aave_loop') {
      const cycle = config.batchCycleOverride ?? 0n;
      console.log(`🧪 Test scenario "${config.opsScenarioOverride}" — running ops directly (cycle=${cycle})\n`);
      const emptyBatchInfo = { totalMintUSD: 0n, totalRedeemUSD: 0n };
      await this.runStepOps(cycle, emptyBatchInfo, config.lockedNav ?? undefined);
      return;
    }

    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    const currentCycleBn = typeof currentCycle === 'bigint' ? currentCycle : BigInt(currentCycle.toString());

    // Detect stale phase-0 requests from prior cycles.
    // These cannot be processed by performUpkeep() anymore because upkeep always targets
    // the current timestamp cycle. Users must cancel and resubmit in the current cycle.
    await this.warnStalePastCycleRequests(currentCycleBn);

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
   * Warn when older cycles (before current) still have phase=0 and pending users.
   * Those requests are effectively stranded for automated processing and should be
   * canceled/resubmitted by users.
   */
  private async warnStalePastCycleRequests(currentCycle: bigint): Promise<void> {
    const lookback = 14; // two weeks of daily cycles by default
    const stale: Array<{ cycle: bigint; mintUsers: bigint; redeemUsers: bigint }> = [];
    for (let i = 1; i <= lookback; i++) {
      const cycle = currentCycle - BigInt(i);
      if (cycle < 0n) break;
      try {
        const phase = Number(await this.kashYield.batchPhase(cycle));
        const info = await this.kashYield.getBatchInfo(cycle);
        if (info.processed) continue;
        const mintUsers = BigInt(info.mintUsersCount.toString());
        const redeemUsers = BigInt(info.redeemUsersCount.toString());
        if (phase === 0 && (mintUsers > 0n || redeemUsers > 0n)) {
          stale.push({ cycle, mintUsers, redeemUsers });
        }
      } catch {
        // Non-critical diagnostics; continue scanning.
      }
    }

    if (stale.length === 0) return;

    console.warn('⚠️  Found stale phase-0 requests in past cycle(s):');
    for (const s of stale) {
      console.warn(`   - cycle ${s.cycle}: mintUsers=${s.mintUsers}, redeemUsers=${s.redeemUsers}`);
    }
    console.warn('   These cannot be processed by performUpkeep() because upkeep only processes the current cycle.');
    console.warn('   Ask users to cancel old requests and resubmit in the current cycle.\n');
  }

  /**
   * Past-cycle batches stuck at phase 0 cannot run Phase 1: performUpkeep() always targets
   * block.timestamp / cycleDurationSeconds (the current cycle). Fail before ops/mark-done
   * so operators are not misled by a partial pipeline on the wrong cycle.
   */
  private async rejectStalePhaseZeroBatch(
    batchCycle: bigint,
    phaseNum: number,
    batchInfo: { processed: boolean; mintUsersCount: bigint; redeemUsersCount: bigint },
  ): Promise<void> {
    if (batchInfo.processed || phaseNum !== 0) return;

    const hasRequests =
      BigInt(batchInfo.mintUsersCount.toString()) > 0n ||
      BigInt(batchInfo.redeemUsersCount.toString()) > 0n;
    if (!hasRequests) return;

    const currentCycleRaw = await this.kashYield.getCurrentBatchCycle();
    const currentCycle =
      typeof currentCycleRaw === 'bigint' ? currentCycleRaw : BigInt(currentCycleRaw.toString());
    if (batchCycle >= currentCycle) return;

    throw new Error(
      `Cycle ${batchCycle} is stale phase 0 (current cycle is ${currentCycle}). ` +
        'performUpkeep() only processes the current cycle, so Phase 1 never ran for this batch. ' +
        `Users must cancel mint/redeem requests on cycle ${batchCycle} and resubmit in the current cycle.`,
    );
  }

  /**
   * Two-phase flow: pre-Phase-1 updateNAV → Phase 1 → ops → settlement updateNAV → markBatchOpsDone → Phase 2.
   * When BATCH_STEP is phase1|ops|nav|mark-done|phase2, runs only that step and exits.
   */
  private async runBatch(
    batchCycle: bigint,
    batchInfo: { totalMintUSD: bigint; totalRedeemUSD: bigint; processed: boolean; mintUsersCount: bigint; redeemUsersCount: bigint }
  ): Promise<void> {
    const phase = await this.kashYield.batchPhase(batchCycle);
    const phaseNum = Number(phase);

    await this.rejectStalePhaseZeroBatch(batchCycle, phaseNum, batchInfo);

    if (batchInfo.processed && !config.allowProcessedBatch) {
      console.log(`✅ Batch ${batchCycle} already processed (phase 3)\n`);
      return;
    }
    if (batchInfo.processed && config.allowProcessedBatch) {
      console.log(`⚠️  Batch ${batchCycle} is already processed; running with --allow-processed.\n`);
    }

    const hasRequests = batchInfo.mintUsersCount > 0n || batchInfo.redeemUsersCount > 0n;

    // Test scenarios (e.g. test_aave_loop) only need ops — no phase1, nav, mark-done, or phase2.
    // They bypass the "no requests" gate and run regardless of batch phase.
    const isTestScenario = config.opsScenarioOverride === 'test_aave_loop';
    if (isTestScenario && !isSingleStepMode()) {
      console.log(`🧪 Test scenario (${config.opsScenarioOverride}) — skipping phase1/nav/mark-done/phase2\n`);
      await this.runStepOps(batchCycle, batchInfo, config.lockedNav ?? undefined);
      return;
    }

    if (isSingleStepMode()) {
      const step = config.batchStep as (typeof BATCH_STEP_NAMES)[number];
      if (step === 'phase1') {
        if (phaseNum !== 0) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; step phase1 requires phase 0.`);
        if (!hasRequests) {
          console.log(`📭 Batch ${batchCycle} has no mint/redeem requests, skipping.\n`);
          return;
        }
        const preOpsNav = await this.computeNewNAV();
        console.log(`   Pre-Phase-1 NAV (MTM): $${ethers.formatEther(preOpsNav)} per KASH\n`);
        await this.runStepNav(batchCycle, preOpsNav, 'Step pre-Phase-1 nav');
        await this.runStepPhase1(batchCycle);
        return;
      }
      if (step === 'ops') {
        if (phaseNum !== 1 && !(batchInfo.processed && config.allowProcessedBatch)) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step phase1 first.`);
        const phase1EraNav =
          config.lockedNav ?? BigInt((await this.kashYield.currentNAV()).toString());
        if (config.lockedNav != null) {
          console.log(`📊 Using --locked-nav for ops sizing: $${ethers.formatEther(config.lockedNav)} per KASH\n`);
        } else {
          console.log(
            `📊 Ops sizing uses on-chain currentNAV (Phase-1 era): $${ethers.formatEther(phase1EraNav)} per KASH\n`,
          );
        }
        await this.runStepOps(batchCycle, batchInfo, phase1EraNav);
        return;
      }
      if (step === 'nav') {
        if (phaseNum !== 1) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step ops first.`);
        const settlementOrOverride = config.lockedNav ?? undefined;
        if (settlementOrOverride != null) {
          console.log(`📊 Using --locked-nav for settlement updateNAV: $${ethers.formatEther(settlementOrOverride)} per KASH\n`);
        }
        await this.runStepNav(batchCycle, settlementOrOverride, 'Step settlement nav', { computeForSettlement: true });
        return;
      }
      if (step === 'mark-done') {
        if (phaseNum !== 1) throw new Error(`Batch ${batchCycle} is in phase ${phaseNum}; run step nav first.`);
        const phase1Nav =
          config.lockedNav ?? BigInt((await this.kashYield.currentNAV()).toString());
        await this.runStepMarkDone(batchCycle, phase1Nav);
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
      console.log('📊 Computing NAV (pre-Phase-1 MTM for on-chain Phase 1 signals)...');
      const preOpsNav = await this.computeNewNAV();
      console.log(`   Pre-Phase-1 NAV: $${ethers.formatEther(preOpsNav)} per KASH`);
      console.log('   (Final settlement NAV is computed after ops.)\n');
      await this.runStepNav(batchCycle, preOpsNav, 'Step pre-Phase-1 nav');
      await this.runStepPhase1(batchCycle);
      // Re-read batchInfo after Phase 1 so totalMintUSD/totalRedeemUSD are set (Phase 1 writes them on-chain).
      const batchInfoAfterPhase1 = await this.kashYield.getBatchInfo(batchCycle);
      await this.runStepOps(batchCycle, batchInfoAfterPhase1, preOpsNav);
      console.log('📊 Computing NAV (post-ops settlement for Phase 2)...');
      const settlementNav = await this.computeNewNAV({ applySettlementBuffer: true });
      console.log(`   Settlement NAV: $${ethers.formatEther(settlementNav)} per KASH\n`);
      await this.runStepNav(batchCycle, settlementNav, 'Step settlement nav');
      await this.runStepMarkDone(batchCycle, preOpsNav);
      await this.runPhase2ForBatch(batchCycle);
      return;
    }

    if (phaseNum === 1) {
      // Resume: Phase 1 already ran; on-chain currentNAV should be the pre-Phase-1 MTM for this batch.
      const phase1EraNav = BigInt((await this.kashYield.currentNAV()).toString());
      console.log(
        `📊 Resuming from phase 1 — ops sizing uses Phase-1-era NAV: $${ethers.formatEther(phase1EraNav)} per KASH`,
      );
      if (config.lockedNav != null) {
        console.log(
          `   (--locked-nav override: $${ethers.formatEther(config.lockedNav)} per KASH for ops sizing)\n`,
        );
      } else {
        console.log('');
      }
      await this.runStepOps(batchCycle, batchInfo, config.lockedNav ?? phase1EraNav);
      console.log('📊 Computing NAV (post-ops settlement for Phase 2)...');
      const settlementNav = await this.computeNewNAV({ applySettlementBuffer: true });
      console.log(`   Settlement NAV: $${ethers.formatEther(settlementNav)} per KASH\n`);
      await this.runStepNav(batchCycle, settlementNav, 'Step settlement nav');
      await this.runStepMarkDone(batchCycle, config.lockedNav ?? phase1EraNav);
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

  private async getCurrentBatchCycleBn(): Promise<bigint> {
    const currentCycle = await this.kashYield.getCurrentBatchCycle();
    return typeof currentCycle === 'bigint' ? currentCycle : BigInt(currentCycle.toString());
  }

  /** Step 1: Call performUpkeep() (Phase 1 indicative). Batch must be phase 0 with requests. */
  private async runStepPhase1(batchCycle: bigint): Promise<void> {
    const phaseBefore = Number(await this.kashYield.batchPhase(batchCycle));
    if (phaseBefore >= 1) {
      console.log(
        `   ℹ️  Phase 1 already done for batch ${batchCycle} (phase ${phaseBefore}) — skipping performUpkeep.\n`,
      );
      return;
    }

    const currentCycle = await this.getCurrentBatchCycleBn();
    if (currentCycle !== batchCycle) {
      throw new Error(
        `Refusing performUpkeep: bot targets cycle ${batchCycle} but chain current cycle is ${currentCycle}. ` +
          `performUpkeep would run Phase 1 on ${currentCycle}, not ${batchCycle}.`,
      );
    }

    console.log('🔄 Step phase1: Calling performUpkeep()...');
    const receipt1 = await execTx('performUpkeep (phase 1)', () => this.kashYield.performUpkeep('0x'));
    console.log(`   ✅ Phase 1 done in block ${receipt1.blockNumber}\n`);

    const phaseAfter = Number(await this.kashYield.batchPhase(batchCycle));
    if (phaseAfter !== 1) {
      throw new Error(
        `Phase 1 verify failed: expected batchPhase[${batchCycle}] === 1 after performUpkeep, got ${phaseAfter}.`,
      );
    }
  }

  /** Step 2: Run target-state ops (HL + Aave). Batch must be phase 1.
   * @param phase1EraNAV NAV aligned with Phase 1 (pre-Phase-1 `updateNAV` in the dual-NAV flow), used for
   *   ops snapshots / withdrawal sizing vs on-chain `currentNAV`. */
  private async runStepOps(
    batchCycle: bigint,
    batchInfo: { totalMintUSD: bigint; totalRedeemUSD: bigint },
    phase1EraNAV?: bigint
  ): Promise<void> {
    const net = BigInt(batchInfo.totalMintUSD.toString()) - BigInt(batchInfo.totalRedeemUSD.toString());

    // Classify the top-level scenario (reads activePerpExchange() from contract)
    const scenario = await classifyScenario(net, this.kashYield);
    console.log(`📋 Ops scenario: ${scenarioLabel(scenario)}\n`);

    if (scenario === 'net_zero') {
      console.log('   net = 0; no position changes needed.\n');
      return;
    }

    const opsSkipMinUsd = config.netMintSkipOpsMinUsd18;
    if (scenario === 'net_mint_hl' && net > 0n && net < opsSkipMinUsd) {
      console.log(
        `   NET_MINT net ${ethers.formatEther(net)} USD is below NET_MINT_SKIP_OPS_MIN_USDC (${ethers.formatEther(opsSkipMinUsd)} USD) — skipping ops playbook (collateral stays on contract).\n`,
      );
      return;
    }

    if (scenario === 'redeem_hl' && net < 0n) {
      const netRedeemUsd = -net;
      const assetSymbol = isBtc ? 'wBTC' : 'ETH';
      const assetDecimals = isBtc ? 8 : 18;
      if (netRedeemUsd < opsSkipMinUsd) {
        const cover = await vaultCoversRedeemPayout(
          this.kashYield,
          this.provider,
          batchCycle,
          phase1EraNAV,
          isBtc,
        );
        if (cover.covers) {
          console.log(
            `   NET_REDEEM net ${ethers.formatEther(netRedeemUsd)} USD is below NET_MINT_SKIP_OPS_MIN_USDC (${ethers.formatEther(opsSkipMinUsd)} USD) ` +
              `and vault ${assetSymbol} covers Phase 2 payout — skipping ops (pay redeemers from contract).\n` +
              `      vault ${assetSymbol}=${ethers.formatUnits(cover.contractBalance, assetDecimals)}, ` +
              `need=${ethers.formatUnits(cover.required, assetDecimals)} ` +
              `(redeem ${ethers.formatUnits(cover.totalRedeemAsset, assetDecimals)} + owner reserve ${ethers.formatUnits(cover.ownerAssetReserve, assetDecimals)})\n`,
          );
          return;
        }
        console.log(
          `   NET_REDEEM net ${ethers.formatEther(netRedeemUsd)} USD is below ${ethers.formatEther(opsSkipMinUsd)} USD but vault ${assetSymbol} ` +
            `(${ethers.formatUnits(cover.contractBalance, assetDecimals)}) does not cover Phase 2 need ` +
            `(${ethers.formatUnits(cover.required, assetDecimals)}) — running full redeem ops.\n`,
        );
      }
    }

    // Snapshot all on-chain state once before executing any steps
    const ctx = await snapshotOpsContext(this.kashYield, this.provider, this.signer, batchCycle, phase1EraNAV);

    if (scenario === 'net_mint_hl' || scenario === 'redeem_hl') {
      await runTargetStateEngine(ctx, scenario, net, phase1EraNAV);
    } else if (scenario === 'test_aave_loop') {
      await runTestAaveLoopPlaybook(ctx);
    }

  }

  /**
   * Step 3: Call updateNAV(newNAV, usdcBalance, assetBalance, perpPnL). May run twice per batch:
   * once pre-Phase-1 (MTM for Phase 1 on-chain signals) and once post-ops (settlement for Phase 2).
   *
   * **NAV vs Phase 2 (`_processBatchPhase2`):**
   * - `updateNAV` writes `newNAV` into **`currentNAV`**.
   * - **Phase 2** reads **`exactNAV = currentNAV()`** once for mint KASH; redeems pay locked **G** from mark-done.
   * - **Settlement** `updateNAV` (after ops) should run before `markBatchOpsDone` / Phase 2 so Phase 2 aligns
   *   with post-fee / post-slippage MTM.
   * - **Chainlink `getEthPrice()` / `getBtcPrice()`** are read again at Phase 2; small timing drift vs bot snapshots.
   *
   * Single-step `--step=nav`: typically the **settlement** update after ops (`precomputed` or `computeNewNAV()` now).
   * usdcBalance/assetBalance are snapshotted from adapter views for events.
   * perpPnL is passed as 0.
   */
  private async runStepNav(
    batchCycle: bigint,
    precomputedNAV?: bigint,
    logLabel = 'Step nav',
    options?: { computeForSettlement?: boolean },
  ): Promise<void> {
    void batchCycle;
    const newNAV =
      precomputedNAV ??
      (await this.computeNewNAV({
        applySettlementBuffer: options?.computeForSettlement === true,
      }));

    let usdcBalance = 0n;
    let assetBalance = 0n;
    try {
      usdcBalance = BigInt((await this.kashYield.getHyperliquidSpotBalance()).toString());
      assetBalance = BigInt((await this.kashYield.getExchangeAssetBalance()).toString());
    } catch {
      // Non-critical — portfolio snapshot unavailable; NAV update still proceeds
    }

    console.log(`📈 ${logLabel}: Updating NAV to $${ethers.formatEther(newNAV)} per KASH  (usdcBal=${ethers.formatUnits(usdcBalance, 6)}, assetBal=${ethers.formatEther(assetBalance)})...`);
    await execTx('updateNAV', () => this.kashYield.updateNAV(newNAV, usdcBalance, assetBalance, 0n));
    console.log('   ✅ updateNAV done\n');
  }

  /** Step 4: Call markBatchOpsDone(batchCycle). Batch must be phase 1.
   * Verifies vault wBTC/ETH covers owner reserve + mint fees + on-chain gross redeem G before Phase 2. */
  private async runStepMarkDone(batchCycle: bigint, phase1EraNAV?: bigint): Promise<void> {
    const phaseNum = Number(await this.kashYield.batchPhase(batchCycle));
    if (phaseNum >= 2) {
      console.log(
        `   ℹ️  Batch ${batchCycle} already past ops (phase ${phaseNum}) — skipping markBatchOpsDone.\n`,
      );
      return;
    }
    if (phaseNum !== 1) {
      throw new Error(`Cannot markBatchOpsDone: batch ${batchCycle} is in phase ${phaseNum}, expected phase 1.`);
    }

    const decimals = isBtc ? 8 : 18;
    const redeemKash = BigInt((await this.kashYield.batchTotalRedeemKash(batchCycle)).toString());
    let grossForCheck = 0n;

    if (redeemKash > 0n) {
      if (phase1EraNAV == null) {
        throw new Error(
          `Cannot markBatchOpsDone: batch ${batchCycle} needs gross redeem G — pass --locked-nav (Phase-1 NAV) or run the full batch after ops.`,
        );
      }
      const assetDecimals = isBtc ? 8n : 18n;
      const price = isBtc
        ? BigInt((await this.kashYield.getBtcPrice()).toString())
        : BigInt((await this.kashYield.getEthPrice()).toString());
      grossForCheck = await computeTotalRedeemAsset(
        this.kashYield,
        batchCycle,
        phase1EraNAV,
        price,
        assetDecimals,
      );
      if (grossForCheck === 0n) {
        throw new Error(
          `Cannot markBatchOpsDone: batch ${batchCycle} has redeem KASH but gross redeem asset is 0 at Phase-1 NAV.`,
        );
      }
    }

    const grossForTx = grossForCheck;

    const cover = await vaultCoversRedeemPayoutFromGross(
      this.kashYield,
      this.provider,
      batchCycle,
      grossForCheck,
      isBtc,
    );

    if (cover.grossRedeemAsset > 0n) {
      if (!cover.covers) {
        throw new Error(
          `Cannot markBatchOpsDone: contract holds ${ethers.formatUnits(cover.contractBalance, decimals)} ` +
          `but Phase 2 needs ${ethers.formatUnits(cover.required, decimals)} ` +
          `(G ${ethers.formatUnits(cover.grossRedeemAsset, decimals)} + mint fees ${ethers.formatUnits(cover.mintFeeAsset, decimals)} + owner reserve ${ethers.formatUnits(cover.ownerAssetReserve, decimals)}; ` +
          `short ${ethers.formatUnits(cover.shortfall, decimals)}, tolerance ${ethers.formatUnits(cover.toleranceAsset, decimals)}). ` +
          `Withdraw more ${isBtc ? 'wBTC' : 'ETH'} from Aave (or reduce owner reserve) before proceeding.`
        );
      }
      const tolNote =
        cover.shortfall > 0n && cover.shortfall <= cover.toleranceAsset
          ? ` (within ${ethers.formatUnits(cover.toleranceAsset, decimals)} tolerance, short ${ethers.formatUnits(cover.shortfall, decimals)})`
          : '';
      console.log(
        `   ✅ Balance check passed: contract has ${ethers.formatUnits(cover.contractBalance, decimals)} ` +
          `(need ${ethers.formatUnits(cover.required, decimals)} = G ${ethers.formatUnits(cover.grossRedeemAsset, decimals)} + mint fees ${ethers.formatUnits(cover.mintFeeAsset, decimals)} + owner reserve ${ethers.formatUnits(cover.ownerAssetReserve, decimals)})${tolNote}`,
      );
    }

    console.log('📋 Step mark-done: Marking batch ops done...');
    await execTx('markBatchOpsDone', () =>
      this.kashYield.markBatchOpsDone(batchCycle, grossForTx),
    );
    console.log('   ✅ markBatchOpsDone\n');
  }

  /** Compute new NAV (18 decimals) from portfolio and yield. Uses $1 only when no KASH exists yet. */
  private async computeNewNAV(options?: { applySettlementBuffer?: boolean }): Promise<bigint> {
    const tokenAddr = await (isBtc ? this.kashYield.kashTokenBtc() : this.kashYield.kashTokenEth()).catch(() => null);
    const kashSupply = tokenAddr
      ? await new ethers.Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], this.provider).totalSupply()
      : 0n;
    if (kashSupply === 0n) {
      // No outstanding KASH — use $1.00 per KASH (1e18) instead of stale on-chain currentNAV().
      console.log(`   📈 KASH supply is 0, using NAV = $1.00 per KASH (1e18) for updateNAV`);
      return INITIAL_NAV;
    }

    // Live mark-to-market NAV input:
    //   portfolioUSD = assetUSD(contract + Aave + HL) + netUSDCUSD(contract + HL - AaveDebt)
    // This removes dependence on mock-only daily yield views for mainnet operation.
    const portfolioValueUSD = await this.estimatePortfolioValueUSD();
    let newNAV = (portfolioValueUSD * (10n ** 18n)) / BigInt(kashSupply.toString());
    if (newNAV === 0n) {
      // Contract rejects updateNAV(0). Use the smallest non-zero NAV rather than imposing a $1 floor.
      newNAV = 1n;
    }
    const bps = options?.applySettlementBuffer ? BigInt(config.settlementNavBufferBps) : 0n;
    if (bps > 0n && newNAV > 0n) {
      const before = newNAV;
      newNAV = (newNAV * (10000n - bps)) / 10000n;
      if (newNAV === 0n) newNAV = 1n;
      console.log(
        `   📈 Settlement NAV buffer −${bps} bps: $${ethers.formatEther(before)} → $${ethers.formatEther(newNAV)} per KASH`,
      );
    }
    return newNAV;
  }

  /**
   * Live portfolio value in USD (18 decimals) for NAV.
   *
   * assetUSD:
   *   - Contract ETH/wBTC balance
   *   - Aave supplied collateral (aToken-backed balance)
   *   - HL spot asset balance (synced on adapter)
   *
   * netUSDCUSD:
   *   - Contract USDC
   *   - HL USDC (synced on adapter; now based on max(spot, withdrawable))
   *   - minus Aave USDC debt (includes accrued interest)
   */
  private async estimatePortfolioValueUSD(): Promise<bigint> {
    try {
      const price = isBtc
        ? BigInt((await this.kashYield.getBtcPrice()).toString())
        : BigInt((await this.kashYield.getEthPrice()).toString());
      const assetDecimals = isBtc ? 8n : 18n;
      const kashAddr = config.kashYieldAddress!;
      const aaveUser = config.aaveUserAddress || kashAddr;

      // 1) Contract-held asset
      let contractAsset = 0n;
      if (isBtc) {
        const wbtcAddr: string = await this.kashYield.wbtcAddress();
        const wbtc = new ethers.Contract(wbtcAddr, ['function balanceOf(address) view returns (uint256)'], this.provider);
        contractAsset = BigInt((await wbtc.balanceOf(kashAddr)).toString());
      } else {
        contractAsset = BigInt((await this.provider.getBalance(kashAddr)).toString());
      }
      const ownerAssetReserve = await this.getOwnerAssetReserve();
      if (ownerAssetReserve > 0n) {
        contractAsset = contractAsset > ownerAssetReserve ? contractAsset - ownerAssetReserve : 0n;
      }

      // 2) Aave supplied collateral (real Aave V3)
      const poolAddr: string = await this.kashYield.aavePoolAddress().catch(() => '');
      let aaveSupplied = 0n;
      if (poolAddr && poolAddr !== ethers.ZeroAddress) {
        const reserveAsset = isBtc
          ? await this.kashYield.wbtcAddress().catch(() => ethers.ZeroAddress)
          : await this.kashYield.wethAddress?.().catch(() => ethers.ZeroAddress) ?? ethers.ZeroAddress;
        aaveSupplied = await getAaveSuppliedAmountV3(this.provider, poolAddr, reserveAsset, aaveUser);
      }

      // 3) HL synced spot asset balance
      let hlAsset = 0n;
      try { hlAsset = BigInt((await this.kashYield.getExchangeAssetBalance()).toString()); } catch { hlAsset = 0n; }

      // 4) USDC legs
      const contractUsdc = await this.getContractUsdcBalance();
      const hlUsdc = await this.getHyperliquidNavUsdcBalance();
      const aaveDebtUsdc = await this.getAaveBorrowedAmount();

      const totalAsset = contractAsset + aaveSupplied + hlAsset;
      const assetUsd18 = (totalAsset * price) / (10n ** assetDecimals);
      const netUsdc6 = contractUsdc + hlUsdc - aaveDebtUsdc;
      const netUsdcUsd18 = netUsdc6 * (10n ** 12n);
      const pendingMintUsdGross = await this.getUnprocessedPendingMintUsdGross(price, assetDecimals);
      let portfolioUsd18 = assetUsd18 + netUsdcUsd18;
      portfolioUsd18 = portfolioUsd18 > pendingMintUsdGross
        ? portfolioUsd18 - pendingMintUsdGross
        : 0n;

      console.log(
        `   📈 Live portfolio: asset=${ethers.formatUnits(totalAsset, Number(assetDecimals))} ${isBtc ? 'BTC' : 'ETH'} ` +
        `(${ethers.formatEther(assetUsd18)} USD), netUSDC=${ethers.formatUnits(netUsdc6, 6)} ` +
        `(${ethers.formatEther(netUsdcUsd18)} USD), pendingMintExcluded=${ethers.formatEther(pendingMintUsdGross)} USD ` +
        `(gross; protocol mint fee is owner reserve, redeem payout on vault is not excluded)`
      );

      return portfolioUsd18 > 0n ? portfolioUsd18 : 0n;
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
      const receipt2 = await execTx('performUpkeep (phase 2)', () => this.kashYield.performUpkeep('0x'));
      console.log(`   ✅ Phase 2 done in block ${receipt2.blockNumber}`);
      console.log(`   Tx hash: ${receipt2.hash}\n`);
      await this.handleEventsFromReceipt(receipt2);
    } else {
      console.log(`🔄 Phase 2: Calling processBatchPhase2ForCycle(${batchCycle}) (orphan batch)...`);
      try {
        const receipt2 = await execTx(
          `processBatchPhase2ForCycle(${batchCycle})`,
          () => this.kashYield.processBatchPhase2ForCycle(batchCycle),
        );
        console.log(`   ✅ Phase 2 for batch ${batchCycle} done in block ${receipt2.blockNumber}`);
        console.log(`   Tx hash: ${receipt2.hash}\n`);
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
   * Parse ProtocolInteraction events from transaction receipt (informational).
   * Ops run via runStepOps → runTargetStateEngine before Phase 2; receipts here do not trigger deploy/withdraw.
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
          const actionCode = Number(parsedLog.args[0]);
          const asset = parsedLog.args[1] as string;
          const amount = parsedLog.args[2] as bigint;

          console.log(
            `📡 ProtocolInteraction: ${protocolActionName(actionCode)} (${actionCode}), asset=${asset}, amount=${ethers.formatEther(amount)}\n`,
          );
        }
      } catch (err) {
        if (parsedLog?.name === 'ProtocolInteraction') throw err;
        continue;
      }
    }

    if (eventsFound === 0) {
      console.log(
        '⚠️  No ProtocolInteraction events in receipt (expected for many Phase 2 txs — ' +
          'confirm payout on Arbiscan via TokensClaimed / BatchProcessed logs).\n'
      );
    } else {
      console.log(`✅ Processed ${eventsFound} ProtocolInteraction event(s)\n`);
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

  /**
   * Pending mint capital is not backing existing KASH yet, even if the bot already deployed it
   * into Aave/HL during ops. Subtract the gross USD value from NAV: after-fee principal backs
   * newly minted KASH, while the protocol fee is owner reserve rather than holder NAV.
   */
  private async getUnprocessedPendingMintUsdGross(price: bigint, assetDecimals: bigint): Promise<bigint> {
    const currentCycle = BigInt((await this.kashYield.getCurrentBatchCycle()).toString());
    let sum = 0n;
    const lookback = 10n;
    for (let i = 0n; i <= lookback; i++) {
      if (i > currentCycle) break;
      const cycle = currentCycle - i;
      const processed = await this.kashYield.batchProcessed(cycle);
      if (processed) continue;

      const info = await this.kashYield.getBatchInfo(cycle);
      let totalMintUsd = BigInt(info.totalMintUSD.toString());
      if (totalMintUsd === 0n) {
        let totalMintAsset: bigint;
        if (isBtc) {
          totalMintAsset = BigInt((await this.kashYield.batchTotalMintBtc(cycle)).toString());
        } else {
          totalMintAsset = BigInt((await this.kashYield.batchTotalMintEth(cycle)).toString());
        }
        totalMintUsd = (totalMintAsset * price) / (10n ** assetDecimals);
      }
      if (totalMintUsd === 0n) continue;
      sum += totalMintUsd;
    }
    return sum;
  }

  private async getOwnerUsdcReserve(): Promise<bigint> {
    try {
      return BigInt((await this.kashYield.ownerUsdcReserve()).toString());
    } catch {
      return 0n;
    }
  }

  private async getOwnerAssetReserve(): Promise<bigint> {
    try {
      return isBtc
        ? BigInt((await this.kashYield.ownerWbtcReserve()).toString())
        : BigInt((await this.kashYield.ownerEthReserve()).toString());
    } catch {
      return 0n;
    }
  }

  private async getContractUsdcBalance(): Promise<bigint> {
    try {
      const usdcAddr = await this.kashYield.usdcAddress();
      const usdc = new ethers.Contract(usdcAddr, [{ inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' }], this.provider);
      const raw = BigInt((await usdc.balanceOf(config.kashYieldAddress!)).toString());
      const res = await this.getOwnerUsdcReserve();
      return raw >= res ? raw - res : 0n;
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

  private decimalStringToUsdc6(value: unknown): bigint {
    const raw = String(value ?? '0').trim();
    if (!raw || raw === '0') return 0n;
    const neg = raw.startsWith('-');
    const unsigned = neg ? raw.slice(1) : raw;
    const [wholeRaw, fracRaw = ''] = unsigned.split('.');
    const whole = wholeRaw || '0';
    const frac = fracRaw.slice(0, 6).padEnd(6, '0');
    const parsed = BigInt(whole) * 1_000_000n + BigInt(frac || '0');
    return neg ? -parsed : parsed;
  }

  /**
   * NAV should include the best single Hyperliquid USDC/equity read, not only the
   * stale on-chain adapter balance. Spot and perp account values are alternative
   * views in this setup, so adding them can double-count HL collateral.
   */
  private async getHyperliquidNavUsdcBalance(): Promise<bigint> {
    const fallback = await this.getHyperliquidSpotBalance();
    try {
      const activePerpExchange = await this.kashYield.activePerpExchange().catch(() => '');
      const adapterAddr = await readHyperliquidAdapterAddress(this.kashYield, activePerpExchange);
      if (!adapterAddr || adapterAddr === ethers.ZeroAddress) return fallback;

      const adapter = new ethers.Contract(
        adapterAddr,
        ['function hlAccount() view returns (address)'],
        this.provider,
      );
      let hlUser = await adapter.hlAccount().catch(() => '');
      if (!hlUser || hlUser === ethers.ZeroAddress) {
        const pk = process.env.HYPERLIQUID_API_PRIVATE_KEY || config.privateKey;
        if (!pk) return fallback;
        hlUser = new ethers.Wallet(pk).address;
      }

      const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
      const hlApiUrl = (process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
      const info = new InfoClient({ transport: new HttpTransport({ apiUrl: hlApiUrl }) });
      const ch: any = await info.clearinghouseState({ user: hlUser });
      const spot = await info.spotClearinghouseState({ user: hlUser }).catch(() => ({ balances: [] }));
      const spotUsdc = this.decimalStringToUsdc6(
        (spot?.balances || []).find((b: any) => String(b?.coin || '').toUpperCase() === 'USDC')?.total || '0',
      );
      const withdrawable = this.decimalStringToUsdc6(ch?.withdrawable || '0');
      const accountValue = this.decimalStringToUsdc6(ch?.marginSummary?.accountValue ?? ch?.crossMarginSummary?.accountValue ?? '0');
      return [fallback, spotUsdc, withdrawable, accountValue].reduce(
        (max, v) => (v > max ? v : max),
        0n,
      );
    } catch {
      return fallback;
    }
  }

}
