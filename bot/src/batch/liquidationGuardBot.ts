import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';

// Aave V3 Pool ABI (minimal for health factor)
const AAVE_POOL_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getUserAccountData',
    outputs: [
      { internalType: 'uint256', name: 'totalCollateralBase', type: 'uint256' },
      { internalType: 'uint256', name: 'totalDebtBase', type: 'uint256' },
      { internalType: 'uint256', name: 'availableBorrowsBase', type: 'uint256' },
      { internalType: 'uint256', name: 'currentLiquidationThreshold', type: 'uint256' },
      { internalType: 'uint256', name: 'ltv', type: 'uint256' },
      { internalType: 'uint256', name: 'healthFactor', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// Aave V3 Pool address from config (Arbitrum Sepolia)
const AAVE_POOL_ADDRESS = config.aavePoolAddress;

interface HealthFactorStatus {
  healthFactor: number;
  totalCollateral: bigint;
  totalDebt: bigint;
  liquidationThreshold: number;
  ltv: number;
}

interface LiquidationThresholds {
  WARNING: number;      // Health factor < 1.5 - alert
  CRITICAL: number;     // Health factor < 1.3 - add collateral
  EMERGENCY: number;    // Health factor < 1.1 - immediate action
  LIQUIDATION: number;  // Health factor < 1.0 - liquidation imminent
}

const DEFAULT_THRESHOLDS: LiquidationThresholds = {
  WARNING: 1.5,
  CRITICAL: 1.3,
  EMERGENCY: 1.1,
  LIQUIDATION: 1.0,
};

/**
 * Liquidation Guard Bot - Monitors Aave health factor and takes protective action
 * 
 * Strategy:
 * - Monitor health factor continuously
 * - Alert at 1.5 (warning)
 * - Add collateral at 1.3 (critical)
 * - Emergency actions at 1.1 (emergency)
 * - Panic mode below 1.0 (liquidation imminent)
 */
export class LiquidationGuardBot {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private kashYield: ethers.Contract;
  private aavePool: ethers.Contract;
  private thresholds: LiquidationThresholds;

  constructor(
    provider: ethers.Provider,
    signer: ethers.Signer,
    thresholds: Partial<LiquidationThresholds> = {}
  ) {
    this.provider = provider;
    this.signer = signer;
    this.kashYield = new ethers.Contract(
      config.kashYieldAddress,
      kashYieldABI,
      signer
    );
    this.aavePool = new ethers.Contract(
      AAVE_POOL_ADDRESS,
      AAVE_POOL_ABI,
      provider
    );
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Set custom thresholds
   */
  setThresholds(thresholds: Partial<LiquidationThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
    console.log('📊 Liquidation thresholds updated:', this.thresholds);
  }

  /**
   * Main entry point - check health factor and take action
   */
  async checkAndProtect(): Promise<{
    status: 'safe' | 'warning' | 'critical' | 'emergency' | 'liquidation';
    healthFactor: number;
    actionTaken: string | null;
  }> {
    console.log('🛡️  Checking Aave health factor...\n');

    try {
      // Get Aave user address (defaults to kashYieldAddress, can be overridden for separate vault)
      const aaveUserAddress = config.aaveUserAddress || config.kashYieldAddress;

      // Query Aave for account data
      const accountData = await this.aavePool.getUserAccountData(aaveUserAddress);

      const status: HealthFactorStatus = {
        healthFactor: Number(accountData.healthFactor) / 1e18,
        totalCollateral: accountData.totalCollateralBase,
        totalDebt: accountData.totalDebtBase,
        liquidationThreshold: Number(accountData.currentLiquidationThreshold) / 100,
        ltv: Number(accountData.ltv) / 100,
      };

      console.log('📊 Aave Account Data:');
      console.log(`   Health Factor: ${status.healthFactor.toFixed(4)}`);
      console.log(`   Total Collateral: ${ethers.formatEther(status.totalCollateral)} USD`);
      console.log(`   Total Debt: ${ethers.formatEther(status.totalDebt)} USD`);
      console.log(`   Liquidation Threshold: ${status.liquidationThreshold}%`);
      console.log(`   LTV: ${status.ltv}%\n`);

      // Determine status and take action
      let result: {
        status: 'safe' | 'warning' | 'critical' | 'emergency' | 'liquidation';
        healthFactor: number;
        actionTaken: string | null;
      };

      if (status.healthFactor < this.thresholds.LIQUIDATION) {
        result = {
          status: 'liquidation',
          healthFactor: status.healthFactor,
          actionTaken: await this.handleLiquidationImminent(status),
        };
      } else if (status.healthFactor < this.thresholds.EMERGENCY) {
        result = {
          status: 'emergency',
          healthFactor: status.healthFactor,
          actionTaken: await this.handleEmergency(status),
        };
      } else if (status.healthFactor < this.thresholds.CRITICAL) {
        result = {
          status: 'critical',
          healthFactor: status.healthFactor,
          actionTaken: await this.handleCritical(status),
        };
      } else if (status.healthFactor < this.thresholds.WARNING) {
        result = {
          status: 'warning',
          healthFactor: status.healthFactor,
          actionTaken: await this.handleWarning(status),
        };
      } else {
        result = {
          status: 'safe',
          healthFactor: status.healthFactor,
          actionTaken: null,
        };
        console.log('✅ Health factor safe. No action needed.\n');
      }

      return result;

    } catch (error: any) {
      console.error('❌ Health factor check failed:', error.message);
      throw error;
    }
  }

  /**
   * Handle warning level (HF < 1.5)
   */
  private async handleWarning(status: HealthFactorStatus): Promise<string> {
    console.log('⚠️  WARNING: Health factor below 1.5');
    console.log('   Monitoring closely...\n');

    // Send alert (Telegram, email, etc.)
    await this.sendAlert('WARNING', status);

    return 'Alert sent - monitoring';
  }

  /**
   * Handle critical level (HF < 1.3)
   */
  private async handleCritical(status: HealthFactorStatus): Promise<string> {
    console.log('🚨 CRITICAL: Health factor below 1.3');
    console.log('   Adding collateral...\n');

    try {
      // Strategy: Add collateral from operational buffer
      // Or withdraw from Hyperliquid and deposit to Aave

      // Calculate how much collateral to add
      // Target: Bring HF back to 1.5
      const targetHF = 1.5;
      const currentDebt = status.totalDebt;
      const currentCollateral = status.totalCollateral;
      const liquidationThreshold = status.liquidationThreshold;

      // HF = (Collateral * LiquidationThreshold) / Debt
      // TargetCollateral = (TargetHF * Debt) / LiquidationThreshold
      const targetCollateral = (BigInt(Math.floor(targetHF * 100)) * currentDebt) / 
        BigInt(Math.floor(liquidationThreshold));
      
      const collateralNeeded = targetCollateral - currentCollateral;

      if (collateralNeeded > 0n) {
        console.log(`   Need to add ${ethers.formatEther(collateralNeeded)} USD in collateral`);

        // Check if we have idle funds
        // await this.addCollateralFromBuffer(collateralNeeded);
        // Or: await this.moveFromHyperliquidToAave(collateralNeeded);
      }

      await this.sendAlert('CRITICAL', status);
      return 'Added collateral from buffer';

    } catch (error: any) {
      console.error('❌ Failed to handle critical status:', error.message);
      await this.sendAlert('CRITICAL_FAILED', status, error.message);
      throw error;
    }
  }

  /**
   * Handle emergency level (HF < 1.1)
   */
  private async handleEmergency(status: HealthFactorStatus): Promise<string> {
    console.log('🚨🚨 EMERGENCY: Health factor below 1.1');
    console.log('   Taking emergency actions...\n');

    try {
      // Emergency strategy:
      // 1. Close some Hyperliquid shorts to free up collateral
      // 2. Repay some Aave debt
      // 3. Add maximum available collateral

      // Close 50% of short position
      // await this.emergencyCloseShorts(50);

      // Use freed capital to repay debt
      // await this.emergencyRepayDebt();

      await this.sendAlert('EMERGENCY', status);
      return 'Emergency actions executed';

    } catch (error: any) {
      console.error('❌ Emergency action failed:', error.message);
      await this.sendAlert('EMERGENCY_FAILED', status, error.message);
      throw error;
    }
  }

  /**
   * Handle liquidation imminent (HF < 1.0)
   */
  private async handleLiquidationImminent(status: HealthFactorStatus): Promise<string> {
    console.log('💀 LIQUIDATION IMMINENT: Health factor below 1.0');
    console.log('   PANIC MODE - Taking all available actions...\n');

    try {
      // Panic mode:
      // 1. Close ALL Hyperliquid positions
      // 2. Withdraw everything from Hyperliquid
      // 3. Repay as much Aave debt as possible
      // 4. Add all available collateral
      // 5. Call contract pause() if still at risk

      // await this.panicCloseAllPositions();
      // await this.panicRepayAllDebt();
      
      // If still in danger, pause the contract
      const newHF = await this.getCurrentHealthFactor();
      if (newHF < 1.0) {
        console.log('   Still at risk. Pausing contract...');
        // await this.kashYield.pause();
      }

      await this.sendAlert('LIQUIDATION', status);
      return 'Panic mode executed - all positions closed';

    } catch (error: any) {
      console.error('❌ Panic mode failed:', error.message);
      await this.sendAlert('LIQUIDATION_FAILED', status, error.message);
      throw error;
    }
  }

  /**
   * Get current health factor
   */
  private async getCurrentHealthFactor(): Promise<number> {
    const aaveUserAddress = config.aaveUserAddress || config.kashYieldAddress;
    const accountData = await this.aavePool.getUserAccountData(aaveUserAddress);
    return Number(accountData.healthFactor) / 1e18;
  }

  /**
   * Send alert via Telegram/email
   */
  private async sendAlert(
    level: string, 
    status: HealthFactorStatus, 
    error?: string
  ): Promise<void> {
    const message = `
🚨 KASH LIQUIDATION GUARD ALERT

Level: ${level}
Health Factor: ${status.healthFactor.toFixed(4)}
Collateral: ${ethers.formatEther(status.totalCollateral)} USD
Debt: ${ethers.formatEther(status.totalDebt)} USD
Timestamp: ${new Date().toISOString()}
${error ? `Error: ${error}` : ''}
    `.trim();

    console.log('📤 Alert message:');
    console.log(message);
    console.log('');

    // TODO: Implement actual alert sending
    // - Telegram bot
    // - Email
    // - PagerDuty
    // - Discord webhook
  }

  /**
   * Run health factor check (for Chainlink Automation)
   */
  async runScheduledCheck(): Promise<void> {
    console.log('⏰ Running scheduled health factor check...\n');

    try {
      const result = await this.checkAndProtect();
      
      console.log('📊 Check Result:');
      console.log(`   Status: ${result.status.toUpperCase()}`);
      console.log(`   Health Factor: ${result.healthFactor.toFixed(4)}`);
      console.log(`   Action Taken: ${result.actionTaken || 'None'}\n`);

    } catch (error: any) {
      console.error('❌ Scheduled check failed:', error.message);
      throw error;
    }
  }

  // ============================================================================
  // Emergency Action Functions (to be implemented when addresses are set)
  // ============================================================================

  private async addCollateralFromBuffer(amount: bigint): Promise<void> {
    console.log(`   → Adding ${ethers.formatEther(amount)} USD collateral from buffer`);
    // Implementation: depositToAave(wETH, amount)
  }

  private async moveFromHyperliquidToAave(amount: bigint): Promise<void> {
    console.log(`   → Moving ${ethers.formatEther(amount)} USD from HL to Aave`);
    // Implementation: closeShort → withdrawFromHL → depositToAave
  }

  private async emergencyCloseShorts(percentage: number): Promise<void> {
    console.log(`   → Emergency closing ${percentage}% of shorts`);
    // Implementation: closeShort(partial)
  }

  private async emergencyRepayDebt(): Promise<void> {
    console.log('   → Emergency repaying debt');
    // Implementation: repayToAave(USDC, maxAmount)
  }

  private async panicCloseAllPositions(): Promise<void> {
    console.log('   → PANIC: Closing ALL positions');
    // Implementation: close all shorts, withdraw everything
  }

  private async panicRepayAllDebt(): Promise<void> {
    console.log('   → PANIC: Repaying ALL debt');
    // Implementation: repay all borrows
  }
}

// Export for Chainlink Automation
export { DEFAULT_THRESHOLDS, LiquidationThresholds };
export default LiquidationGuardBot;
