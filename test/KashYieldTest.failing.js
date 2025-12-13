const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

// Helper functions to calculate timestamps within contract time windows
function getProcessingWindowTimestamp(currentTime) {
  const SECONDS_PER_DAY = 86400;
  const dayStart = currentTime - (currentTime % SECONDS_PER_DAY);
  // Processing window: 23:31 to 23:45 (14 minutes)
  const processingStart = dayStart + 23 * 3600 + 31 * 60; // 23:31
  return Math.max(processingStart, currentTime + 1);
}

function getDistributionWindowTimestamp(currentTime) {
  const SECONDS_PER_DAY = 86400;
  const dayStart = currentTime - (currentTime % SECONDS_PER_DAY);
  // Distribution window: 23:46 to 23:59 (13 minutes) - same day
  const distributionStart = dayStart + 23 * 3600 + 46 * 60; // 23:46
  return Math.max(distributionStart, currentTime + 1);
}

function getTransactionWindowTimestamp(currentTime) {
  const SECONDS_PER_DAY = 86400;
  const dayStart = currentTime - (currentTime % SECONDS_PER_DAY);
  // Transaction window: 00:00 to 23:30 (23.5 hours)
  const transactionStart = dayStart + 5 * 60; // 5 minutes after day start (00:05)
  return Math.max(transactionStart, currentTime + 1);
}

describe("KashYield - Failing Tests (Fee Calculations)", function () {
  let KashYield, kashYield, KashEth, kashEth;
  let owner, user1, user2, user3, bot;
  let mockAavePool, mockUsdt, mockPriceFeed, mockGmx;

  async function deployKashYieldFixture() {
    [owner, user1, user2, user3, bot] = await ethers.getSigners();

    console.log("Deploying MockUSDT...");
    const MockUsdt = await ethers.getContractFactory('MockUSDT');
    mockUsdt = await MockUsdt.deploy(1000000);
    await mockUsdt.waitForDeployment();
    console.log("MockUSDT deployed at:", mockUsdt.target);

    console.log("Deploying MockAaveV3...");
    const MockAave = await ethers.getContractFactory('MockAaveV3');
    mockAavePool = await MockAave.deploy(mockUsdt.target);
    await mockAavePool.waitForDeployment();
    console.log("MockAaveV3 deployed at:", mockAavePool.target);

    console.log("Deploying MockChainlinkPriceFeed...");
    const MockPriceFeed = await ethers.getContractFactory('MockChainlinkPriceFeed');
    mockPriceFeed = await MockPriceFeed.deploy(200000000000n);
    await mockPriceFeed.waitForDeployment();
    console.log("MockChainlinkPriceFeed deployed at:", mockPriceFeed.target);
    await mockPriceFeed.setPrice(200000000000n);

    console.log("Deploying MockGMX...");
    const MockGmx = await ethers.getContractFactory('MockGMX');
    mockGmx = await MockGmx.deploy(mockUsdt.target, mockPriceFeed.target);
    await mockGmx.waitForDeployment();
    console.log("MockGMX deployed at:", mockGmx.target);

    console.log("Set funding rate on MockGMX to 0.1% per day");
    await mockGmx.setFundingRatePerDayBps(10);

    await owner.sendTransaction({
      to: mockGmx.target,
      value: ethers.parseEther("100")
    });
    console.log("Sent 100 ETH to MockGMX for swaps");

    console.log("Deploying KashYield...");
    const KashYield = await ethers.getContractFactory('KashYield');
    kashYield = await KashYield.deploy(
      mockAavePool.target,
      mockUsdt.target,
      mockPriceFeed.target,
      mockGmx.target,
      { value: 0 }
    );
    await kashYield.waitForDeployment();
    console.log("KashYield deployed at:", kashYield.target);

    const kashEthAddress = await kashYield.kashEth();
    kashEth = await ethers.getContractAt('KashEth', kashEthAddress);
    await kashEth.connect(owner).transferOwnership(kashYield.target);
    console.log("Transferred KashEth ownership to KashYield contract");

    await mockUsdt.mint(mockAavePool.target, BigInt(1000000) * BigInt(10 ** 6));
    console.log("Minted 1,000,000 USDT to MockAaveV3");
    await mockUsdt.connect(owner).approve(mockGmx.target, BigInt(1000000) * BigInt(10 ** 6));
    console.log("Approved MockGMX to spend USDT from KashYield");

    await kashYield.updateConfiguration(1, 70, 50, 3600);
    console.log("Set configuration: 1 transaction/day, 70% borrow, 50 depositors/batch, 3600s delay");

    return { kashYield, owner, user1, user2, user3, bot };
  }

  describe("Fee Calculations and Distribution - FAILING", function () {
    it("Should calculate fees based on daily metrics", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      // DAY 0: Deposit ETH
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      // DAY 0: Process daily actions (should record 0 fees - no previous day data)
      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      // DAY 0: Set initial funding to 0 (no funding earned yet)
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0"));
      await mockAavePool.setInterestRatePerSecond(0);
      await kashYield.connect(owner).processDailyActions();

      // DAY 0: Distribution (should distribute 0 fees)
      currentTime = await time.latest();
      let distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDistributions();

      // No manual yield injection - yield should accumulate naturally through Aave interest rates
      // The MockAaveV3 should handle yield accumulation automatically over time

      // DAY 1: Process daily actions (should calculate fees based on Day 0 vs Day 1 comparison)
      // Increase by more than 24 hours to ensure processingDelaySeconds requirement is met
      await time.increase(86400 + 3600); // 25 hours to ensure we're past the 23-hour delay + in processing window
      currentTime = await time.latest();
      const nextProcessingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextProcessingTime);
      await ethers.provider.send("evm_mine");
      
      // Update current time after setting the block timestamp
      currentTime = await time.latest();
      // DAY 1: Set cumulative funding to 0.0017 ETH (funding earned over 1 day)
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await mockAavePool.setInterestRatePerSecond(0);
      await kashYield.connect(owner).processDailyActions();

      const currentDay = Math.floor(nextProcessingTime / 86400);
      const netFees = await kashYield.dailyNetFeesEarned(currentDay);
      console.log(`Day ${currentDay} fees: ${netFees}`);
      
      // Debug: Check what funding amounts are recorded
      const day0Funding = await kashYield.dailyGmxFunding(currentDay - 1);
      const day1Funding = await kashYield.dailyGmxFunding(currentDay);
      console.log(`Day ${currentDay - 1} funding: ${day0Funding}`);
      console.log(`Day ${currentDay} funding: ${day1Funding}`);
      console.log(`Funding change: ${day1Funding - day0Funding}`);

      // DAY 1: Distribution (should distribute Day 1's fees which represent Day 0's yield)
      currentTime = await time.latest();
      distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDistributions();

      // Calculate expected fees with updated MockAave yield logic:
      // - Time elapsed: ~25 hours = ~1.04 days
      // - Aave yield: 1 ETH × 0.0001 ETH/day × 1.04 days = ~0.000104 ETH
      // - GMX funding: 0.0017 ETH (as set in test)
      // - Total expected: ~0.000104 + 0.0017 = ~0.001804 ETH
      const actualFees = await kashYield.userCumulativeFeesEarned(user1.address);
      console.log(`User received fees: ${ethers.formatEther(actualFees)} ETH`);
      
      const expectedFees = ethers.parseEther("0.0018"); // ~0.000104 Aave yield + 0.0017 GMX funding
      expect(actualFees).to.be.closeTo(expectedFees, ethers.parseEther("0.0005")); // Allow 0.0005 ETH tolerance
    });

    it("Should accumulate Aave yield over multiple days", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await mockAavePool.setInterestRatePerSecond(0);
      await kashYield.connect(owner).processDailyActions();

      await mockAavePool.connect(owner).supply(ethers.ZeroAddress, ethers.parseEther("0.01"), kashYield.target, 0, { value: ethers.parseEther("0.01") });

      await time.increase(86400);
      currentTime = await time.latest();
      let nextProcessingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextProcessingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await kashYield.connect(owner).processDailyActions();

      let currentDay = Math.floor(nextProcessingTime / 86400);
      console.log(`Day ${currentDay} fees: ${await kashYield.dailyNetFeesEarned(currentDay)}`);

      await mockAavePool.connect(owner).supply(ethers.ZeroAddress, ethers.parseEther("0.01"), kashYield.target, 0, { value: ethers.parseEther("0.01") });

      await time.increase(86400);
      currentTime = await time.latest();
      nextProcessingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextProcessingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await kashYield.connect(owner).processDailyActions();

      currentDay = Math.floor(nextProcessingTime / 86400);
      console.log(`Day ${currentDay} fees: ${await kashYield.dailyNetFeesEarned(currentDay)}`);

      await time.increase(86400);
      currentTime = await time.latest();
      nextProcessingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextProcessingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await kashYield.connect(owner).processDailyActions();

      currentDay = Math.floor(nextProcessingTime / 86400);
      console.log(`Final fees for day ${currentDay}: ${await kashYield.dailyNetFeesEarned(currentDay)}`);

      currentTime = await time.latest();
      const distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDistributions();

      const expectedFees = ethers.parseEther("0.0351"); // 3 days * (0.01 ETH + 0.0017 ETH)
      expect(await kashYield.userCumulativeFeesEarned(user1.address)).to.be.closeTo(expectedFees, ethers.parseEther("0.001"));
    });
  });

  describe("Redemption Requests and Processing - FAILING", function () {
    it("Should revert if redemption amount is 0", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const redemptionTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(redemptionTime);
      await ethers.provider.send("evm_mine");
      await expect(kashYield.connect(user1).requestRedemption(0))
        .to.be.revertedWith("Redemption amount must be greater than 0");
    });

    it("Should revert if user has insufficient KashEth balance", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const redemptionTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(redemptionTime);
      await ethers.provider.send("evm_mine");
      await expect(kashYield.connect(user1).requestRedemption(ethers.parseEther("1000")))
        .to.be.revertedWith("Insufficient KashEth balance");
    });

    it("Should process redemptions and return ETH to users", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDailyActions();

      currentTime = await time.latest();
      const distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDistributions();

      currentTime = await time.latest();
      const redemptionTime = currentTime + 86400 + 900; // Next day, 15 minutes offset
      await time.setNextBlockTimestamp(redemptionTime);
      await ethers.provider.send("evm_mine");
      const userKashEthBalance = await kashEth.balanceOf(user1.address);
      console.log(`User KashEth balance after processing: ${ethers.formatEther(userKashEthBalance)}`);
      await kashEth.connect(user1).approve(kashYield.target, userKashEthBalance);
      await kashYield.connect(user1).requestRedemption(userKashEthBalance);

      const balanceBefore = await ethers.provider.getBalance(user1.address);
      await kashYield.connect(owner).processDistributions();
      const balanceAfter = await ethers.provider.getBalance(user1.address);

      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });
  });

  describe("Edge Cases and Security - FAILING", function () {
    it("Should handle large number of depositors with batch fee processing", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      const depositors = Array.from({ length: 50 }, (_, i) => ethers.Wallet.createRandom().connect(ethers.provider));
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      
      for (const dep of depositors) {
        await owner.sendTransaction({ to: dep.address, value: ethers.parseEther("1") });
        await kashYield.connect(dep).mintKashEth({ value: ethers.parseEther("0.1") });
      }

      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.085"));
      await mockAavePool.setInterestRatePerSecond(0);
      await kashYield.connect(owner).processDailyActions();
      
      await mockAavePool.connect(owner).supply(ethers.ZeroAddress, ethers.parseEther("0.5"), kashYield.target, 0, { value: ethers.parseEther("0.5") });
      
      await time.increase(86400);
      currentTime = await time.latest();
      const currentDay = Math.floor(currentTime / 86400);
      const distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      console.log(`Fees before distribution: ${await kashYield.dailyNetFeesEarned(currentDay)}`);
      await kashYield.connect(owner).processDistributions();

      const expectedFeePerDepositor = ethers.parseEther("0.0117"); // (0.5 ETH + 0.085 ETH) / 50
      expect(await kashYield.userCumulativeFeesEarned(depositors[0].address)).to.be.closeTo(expectedFeePerDepositor, ethers.parseEther("0.001"));
    });

    it("Should handle ETH price fluctuations in redemption calculations", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const initialBalance = await ethers.provider.getBalance(user1.address);
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("2") });

      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await mockAavePool.setInterestRatePerSecond(0);
      await kashYield.connect(owner).processDailyActions();
      
      currentTime = await time.latest();
      const distributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(distributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).distributeKashEths(Math.floor(depositTime / 86400));
      
      console.log(`User fees before redemption: ${await kashYield.userCumulativeFeesEarned(user1.address)}`);

      await mockPriceFeed.setPrice(250000000000n); // ETH price to $2500
      
      await time.increase(86400);
      currentTime = await time.latest();
      const redemptionTransactionTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(redemptionTransactionTime);
      await ethers.provider.send("evm_mine");
      await kashEth.connect(user1).approve(kashYield.target, ethers.parseEther("2500"));
      await kashYield.connect(user1).requestRedemption(ethers.parseEther("2500"));
      
      await time.increase(86400);
      currentTime = await time.latest();
      const nextProcessingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextProcessingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
      await kashYield.connect(owner).processDailyActions();
      
      currentTime = await time.latest();
      const nextDistributionTime = getDistributionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(nextDistributionTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).distributeRedeemedEth(Math.floor(redemptionTransactionTime / 86400));
      
      const expectedEthPayout = ethers.parseEther("1");
      expect(await ethers.provider.getBalance(user1.address)).to.be.closeTo(initialBalance + expectedEthPayout, ethers.parseEther("0.3"));
    });
  });
});
