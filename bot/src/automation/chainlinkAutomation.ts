import { ethers } from 'ethers';
import { kashYieldABI } from '../contracts/kashYieldABI';
import { config } from '../config';

/**
 * Chainlink Automation Integration
 * 
 * This module implements Chainlink Automation (formerly Chainlink Keepers)
 * compatible checkUpkeep and performUpkeep functions.
 * 
 * Three types of Upkeeps:
 * 1. Batch Processor - Daily at 23:45 UTC
 * 2. Rebalancer - Hourly allocation checks
 * 3. Liquidation Guard - Continuous health factor monitoring
 * 
 * Link Token for Arbitrum: 0xf97f4df75117a78c1A5a0DBb814Af92458539FB4
 * Automation Registry: 0x75c0530885F385721fddA23C509AFe76b8411cf8 (Arbitrum)
 */

// LINK Token address (Arbitrum)
const LINK_TOKEN_ADDRESS = '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4';

// Automation Registry (Arbitrum)
const AUTOMATION_REGISTRY = '0x75c0530885F385721fddA23C509AFe76b8411cf8';

interface UpkeepConfig {
  name: string;
  upkeepId?: string; // Assigned by Chainlink after registration
  checkData: string;
  performGasLimit: number;
  linkBalance: bigint;
}

interface UpkeepStatus {
  isActive: boolean;
  lastTimestamp: number;
  balance: bigint;
  linkBalance: bigint;
}

/**
 * Chainlink Automation Manager
 * 
 * Manages all Chainlink Automation upkeeps for the KASH protocol
 */
export class ChainlinkAutomationManager {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private kashYield: ethers.Contract;
  private linkToken: ethers.Contract;

  // Upkeep configurations
  private upkeeps: Map<string, UpkeepConfig> = new Map();

  constructor(provider: ethers.Provider, signer: ethers.Signer) {
    this.provider = provider;
    this.signer = signer;
    this.kashYield = new ethers.Contract(
      config.kashYieldAddress,
      kashYieldABI,
      signer
    );
    
    // LINK Token contract
    this.linkToken = new ethers.Contract(
      LINK_TOKEN_ADDRESS,
      ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
      signer
    );

    // Initialize default upkeeps
    this.initializeUpkeeps();
  }

  /**
   * Initialize default upkeep configurations
   */
  private initializeUpkeeps(): void {
    // 1. Batch Processor - Daily at 23:45 UTC
    this.upkeeps.set('batchProcessor', {
      name: 'KASH Batch Processor',
      checkData: '0x01', // Type identifier
      performGasLimit: 500000,
      linkBalance: 0n,
    });

    // 2. Rebalancer - Hourly checks
    this.upkeeps.set('rebalancer', {
      name: 'KASH Rebalancer',
      checkData: '0x02', // Type identifier
      performGasLimit: 1000000,
      linkBalance: 0n,
    });

    // 3. Liquidation Guard - Every 5 minutes
    this.upkeeps.set('liquidationGuard', {
      name: 'KASH Liquidation Guard',
      checkData: '0x03', // Type identifier
      performGasLimit: 800000,
      linkBalance: 0n,
    });
  }

  /**
   * Check if upkeep is needed (Chainlink calls this off-chain)
   * 
   * This function is called by Chainlink nodes to determine if performUpkeep should be called
   * It must be pure/view and use minimal gas
   */
  async checkUpkeep(checkData: string): Promise<{ upkeepNeeded: boolean; performData: string }> {
    const upkeepType = parseInt(checkData);

    switch (upkeepType) {
      case 1:
        return this.checkBatchProcessorUpkeep();
      case 2:
        return this.checkRebalancerUpkeep();
      case 3:
        return this.checkLiquidationGuardUpkeep();
      default:
        return { upkeepNeeded: false, performData: '0x' };
    }
  }

  /**
   * Perform upkeep (Chainlink calls this on-chain when checkUpkeep returns true)
   * 
   * This function is called by Chainlink nodes when upkeep is needed
   */
  async performUpkeep(performData: string): Promise<void> {
    const upkeepType = parseInt(performData);

    switch (upkeepType) {
      case 1:
        await this.performBatchProcessorUpkeep();
        break;
      case 2:
        await this.performRebalancerUpkeep();
        break;
      case 3:
        await this.performLiquidationGuardUpkeep();
        break;
      default:
        throw new Error(`Unknown upkeep type: ${upkeepType}`);
    }
  }

  // ============================================================================
  // Batch Processor Upkeep
  // ============================================================================

  /**
   * Check if batch processing is needed.
   * Upkeep needed when in processing window and (phase 0 with requests, or phase 2).
   */
  private async checkBatchProcessorUpkeep(): Promise<{ upkeepNeeded: boolean; performData: string }> {
    try {
      const isProcessingWindow = await this.kashYield.isProcessingWindow();
      if (!isProcessingWindow) {
        return { upkeepNeeded: false, performData: '0x' };
      }

      const currentCycle = await this.kashYield.getCurrentBatchCycle();
      const batchCycle = currentCycle;

      const batchInfo = await this.kashYield.getBatchInfo(batchCycle);
      if (batchInfo.processed) {
        return { upkeepNeeded: false, performData: '0x' };
      }

      const phase = await this.kashYield.batchPhase(batchCycle);
      const phaseNum = Number(phase);
      const hasRequests = batchInfo.mintUsersCount > 0n || batchInfo.redeemUsersCount > 0n;
      if (phaseNum === 0 && !hasRequests) return { upkeepNeeded: false, performData: '0x' };
      if (phaseNum === 0 || phaseNum === 2) {
        return { upkeepNeeded: true, performData: '0x01' };
      }
      return { upkeepNeeded: false, performData: '0x' };
    } catch (error) {
      console.error('Error checking batch processor upkeep:', error);
      return { upkeepNeeded: false, performData: '0x' };
    }
  }

  /**
   * Perform batch processing upkeep
   */
  private async performBatchProcessorUpkeep(): Promise<void> {
    console.log('🤖 Chainlink Automation: Executing Batch Processor');
    
    // Import and run batch processor
    const { BatchProcessor } = await import('../batch/batchProcessor');
    const processor = new BatchProcessor(this.provider, this.signer);
    await processor.run();
  }

  // ============================================================================
  // Rebalancer Upkeep
  // ============================================================================

  /**
   * Check if rebalancing is needed
   */
  private async checkRebalancerUpkeep(): Promise<{ upkeepNeeded: boolean; performData: string }> {
    try {
      // Only rebalance during user window (not during batch processing)
      const isUserWindow = await this.kashYield.isUserWindow?.().catch(() => true);
      if (!isUserWindow) {
        return { upkeepNeeded: false, performData: '0x' };
      }

      // Check allocation drift
      // This would need to calculate current vs target allocation
      // For now, simplified check
      const needsRebalance = await this.checkAllocationDrift();
      
      if (!needsRebalance) {
        return { upkeepNeeded: false, performData: '0x' };
      }

      return { 
        upkeepNeeded: true, 
        performData: '0x02' // Type 2 = Rebalancer
      };

    } catch (error) {
      console.error('Error checking rebalancer upkeep:', error);
      return { upkeepNeeded: false, performData: '0x' };
    }
  }

  /**
   * Check if allocation drift exceeds threshold
   */
  private async checkAllocationDrift(): Promise<boolean> {
    // This would calculate actual allocation and compare to target
    // For now, return false (placeholder)
    // In real implementation:
    // 1. Get portfolio state from Aave and Hyperliquid
    // 2. Calculate current allocation
    // 3. Compare to target (40/35/20/5)
    // 4. Return true if any category drifts > 10%
    return false;
  }

  /**
   * Perform rebalancer upkeep
   */
  private async performRebalancerUpkeep(): Promise<void> {
    console.log('🤖 Chainlink Automation: Executing Rebalancer');
    
    // Import and run rebalancer
    const { default: RebalancerBot } = await import('../batch/rebalancerBot');
    const rebalancer = new RebalancerBot(this.provider, this.signer);
    await rebalancer.runScheduledCheck();
  }

  // ============================================================================
  // Liquidation Guard Upkeep
  // ============================================================================

  /**
   * Check if liquidation protection is needed
   */
  private async checkLiquidationGuardUpkeep(): Promise<{ upkeepNeeded: boolean; performData: string }> {
    try {
      // Check Aave health factor
      // This would query Aave pool for health factor
      // For now, simplified check
      const healthFactor = await this.getHealthFactor();
      
      // Trigger if health factor < 1.5 (warning level)
      if (healthFactor >= 1.5) {
        return { upkeepNeeded: false, performData: '0x' };
      }

      // Include health factor in performData for context
      const performData = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint8'],
        [ethers.parseUnits(healthFactor.toString(), 18), 3]
      );

      return { 
        upkeepNeeded: true, 
        performData: '0x03' // Type 3 = Liquidation Guard
      };

    } catch (error) {
      console.error('Error checking liquidation guard upkeep:', error);
      return { upkeepNeeded: false, performData: '0x' };
    }
  }

  /**
   * Get current health factor from Aave
   */
  private async getHealthFactor(): Promise<number> {
    // This would query Aave pool for health factor
    // For now, return safe value (placeholder)
    return 2.0;
  }

  /**
   * Perform liquidation guard upkeep
   */
  private async performLiquidationGuardUpkeep(): Promise<void> {
    console.log('🤖 Chainlink Automation: Executing Liquidation Guard');
    
    // Import and run liquidation guard
    const { LiquidationGuardBot } = await import('../batch/liquidationGuardBot');
    const guard = new LiquidationGuardBot(this.provider, this.signer);
    await guard.runScheduledCheck();
  }

  // ============================================================================
  // LINK Token Management
  // ============================================================================

  /**
   * Check LINK balance for all upkeeps
   */
  async checkAllLinkBalances(): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();

    for (const [name, upkeep] of this.upkeeps) {
      if (upkeep.upkeepId) {
        const balance = await this.linkToken.balanceOf(upkeep.upkeepId);
        balances.set(name, balance);
        console.log(`   ${name}: ${ethers.formatEther(balance)} LINK`);
      }
    }

    return balances;
  }

  /**
   * Fund an upkeep with LINK
   */
  async fundUpkeep(upkeepName: string, amount: bigint): Promise<void> {
    const upkeep = this.upkeeps.get(upkeepName);
    if (!upkeep || !upkeep.upkeepId) {
      throw new Error(`Upkeep ${upkeepName} not found or not registered`);
    }

    console.log(`💰 Funding ${upkeepName} with ${ethers.formatEther(amount)} LINK...`);
    
    const tx = await this.linkToken.transfer(upkeep.upkeepId, amount);
    await tx.wait();
    
    console.log(`✅ Funded ${upkeepName}`);
  }

  /**
   * Get recommended LINK funding for an upkeep
   */
  getRecommendedFunding(upkeepName: string): bigint {
    const upkeep = this.upkeeps.get(upkeepName);
    if (!upkeep) return 0n;

    // Estimate based on gas limit and Arbitrum gas prices
    // Rough estimate: 1 LINK should cover many executions
    switch (upkeepName) {
      case 'batchProcessor':
        // Daily execution, higher gas
        return ethers.parseEther('5'); // 5 LINK
      case 'rebalancer':
        // Hourly checks, may not always execute
        return ethers.parseEther('10'); // 10 LINK
      case 'liquidationGuard':
        // Frequent checks, may not always execute
        return ethers.parseEther('10'); // 10 LINK
      default:
        return ethers.parseEther('5');
    }
  }

  // ============================================================================
  // Upkeep Registration (One-time setup)
  // ============================================================================

  /**
   * Get registration parameters for Chainlink Automation
   */
  getRegistrationParams(upkeepName: string): {
    name: string;
    encryptedEmail: string;
    upkeepContract: string;
    gasLimit: number;
    adminAddress: string;
    triggerType: number;
    checkData: string;
    triggerConfig: string;
    offchainConfig: string;
    amount: bigint;
  } | null {
    const upkeep = this.upkeeps.get(upkeepName);
    if (!upkeep) return null;

    return {
      name: upkeep.name,
      encryptedEmail: '0x', // No email
      upkeepContract: config.kashYieldAddress,
      gasLimit: upkeep.performGasLimit,
      adminAddress: '', // Set to owner address
      triggerType: 0, // 0 = Conditional upkeep
      checkData: upkeep.checkData,
      triggerConfig: '0x',
      offchainConfig: '0x',
      amount: this.getRecommendedFunding(upkeepName),
    };
  }

  /**
   * Print registration instructions
   */
  printRegistrationInstructions(): void {
    console.log('\n📋 Chainlink Automation Registration Instructions');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('1. Go to https://automation.chain.link/arbitrum');
    console.log('2. Connect your wallet (must be contract owner)\n');

    for (const [name, upkeep] of this.upkeeps) {
      const params = this.getRegistrationParams(name);
      if (!params) continue;

      console.log(`\n🔧 ${upkeep.name}:`);
      console.log(`   Target Contract: ${params.upkeepContract}`);
      console.log(`   Gas Limit: ${params.gasLimit}`);
      console.log(`   Check Data: ${params.checkData}`);
      console.log(`   Initial Funding: ${ethers.formatEther(params.amount)} LINK`);
    }

    console.log('\n⚠️  IMPORTANT:');
    console.log('   - The contract must have checkUpkeep and performUpkeep functions');
    console.log('   - You need LINK tokens on Arbitrum to fund upkeeps');
    console.log('   - Registration requires a one-time fee in LINK\n');
  }
}

// Export for use in other modules
export default ChainlinkAutomationManager;
