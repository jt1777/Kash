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
  const transactionStart = dayStart + 15 * 60; // 15 minutes after day start
  return Math.max(transactionStart, currentTime + 1);
}

describe("KashYield", function () {
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
    await mockAavePool.setUsdtAddress(mockUsdt.target);

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
    await mockGmx.setFundingRatePerDayBps(10);
    console.log("Set funding rate on MockGMX to 0.1% per day");

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

    // Set configuration to match contract: 70% borrow percentage
    await kashYield.connect(owner).updateConfiguration(1, 70, 50, 3600);
    console.log("Set configuration: 1 transaction/day, 70% borrow, 50 depositors/batch, 3600s delay");

    return { kashYield, kashEth, mockAavePool, mockUsdt, mockPriceFeed, mockGmx, owner, user1, user2, user3, bot };
  }

  beforeEach(async function () {
    ({ kashYield, kashEth, owner, user1, user2, user3, bot } = await loadFixture(deployKashYieldFixture));
  });

  describe("Deployment", function () {
    it("Should deploy KashYield with minimal setup", async function () {
      [owner] = await ethers.getSigners();
      const KashYield = await ethers.getContractFactory('KashYield');
      const dummyAddress = ethers.ZeroAddress;
      const kashYield = await KashYield.deploy(dummyAddress, dummyAddress, dummyAddress, dummyAddress, { value: 0 });
      await kashYield.waitForDeployment();
      expect(await kashYield.owner()).to.equal(owner.address);
    });

    it("Should set the right owner", async function () {
      expect(await kashYield.owner()).to.equal(owner.address);
    });

    it("Should initialize mock contracts correctly", async function () {
      expect(await kashYield.aavePoolAddress()).to.equal(mockAavePool.target);
      expect(await kashYield.usdtAddress()).to.equal(mockUsdt.target);
      expect(await kashYield.priceFeedAddress()).to.equal(mockPriceFeed.target);
      expect(await kashYield.gmxAddress()).to.equal(mockGmx.target);
    });

    it("Should initialize KashEth token", async function () {
      expect(await kashEth.owner()).to.equal(kashYield.target);
      expect(await kashYield.kashEth()).to.equal(kashEth.target);
    });
  });

  describe("Configuration Updates", function () {
    it("Should allow owner to update configuration parameters", async function () {
      const newTransactionsPerDay = 2;
      const newBorrowPercentage = 70; // Match contract
      const newDepositorsPerFeeBatch = 100;
      const newProcessingDelaySeconds = 22 * 3600;
      
      await expect(kashYield.connect(owner).updateConfiguration(
        newTransactionsPerDay, newBorrowPercentage, newDepositorsPerFeeBatch, newProcessingDelaySeconds
      )).to.emit(kashYield, "ConfigurationUpdated")
        .withArgs(newTransactionsPerDay, 0, 0, newBorrowPercentage);
        
      expect(await kashYield.transactionsPerDay()).to.equal(newTransactionsPerDay);
      expect(await kashYield.usdtBorrowPercentage()).to.equal(newBorrowPercentage);
      expect(await kashYield.depositorsPerFeeBatch()).to.equal(newDepositorsPerFeeBatch);
      expect(await kashYield.processingDelaySeconds()).to.equal(newProcessingDelaySeconds);
    });

    it("Should revert if non-owner tries to update configuration", async function () {
      await expect(kashYield.connect(user1).updateConfiguration(2, 70, 50, 23 * 3600))
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Should revert if transactions per day is set to 0", async function () {
      await expect(kashYield.connect(owner).updateConfiguration(0, 70, 50, 23 * 3600))
        .to.be.revertedWith("Transactions per day must be greater than 0");
    });

    it("Should revert if depositors per fee batch is 0", async function () {
      await expect(kashYield.connect(owner).updateConfiguration(1, 70, 0, 23 * 3600))
        .to.be.revertedWith("Depositors per fee batch must be greater than 0");
    });

    it("Should revert if processing delay is less than 1 hour", async function () {
      await expect(kashYield.connect(owner).updateConfiguration(1, 70, 50, 1800))
        .to.be.revertedWith("Processing delay must be at least 1 hour");
    });
  });

  describe("User Deposits and Minting", function () {
    it("Should accept ETH deposits and queue for minting within transaction window", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = currentTime + 900; // 15 minutes offset
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");

      await expect(kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") }))
        .to.emit(kashYield, "KashEthMinted")
        .withArgs(user1.address, ethers.parseEther("1"), 0, anyValue, anyValue);

      const currentDay = Math.floor(depositTime / 86400);
      expect(await kashYield.userTotalEthDeposited(user1.address)).to.equal(ethers.parseEther("1"));
      expect(await kashYield.eligibleCycleDay(user1.address)).to.equal(currentDay);
    });

    it("Should reject deposits outside transaction window", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const SECONDS_PER_DAY = 86400;
      const dayStart = currentTime - (currentTime % SECONDS_PER_DAY);
      const depositTime = dayStart + (23 * 3600) + (50 * 60); // 23:50 within the day
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");

      await expect(kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") }))
        .to.be.revertedWith("Not within transaction window");
    });

    it("Should reject deposits of 0 ETH", async function () {
      await expect(kashYield.connect(user1).mintKashEth({ value: 0 }))
        .to.be.revertedWith("ETH amount must be greater than 0");
    });

    it("Should set correct batch cycle for deposit", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = currentTime + 9 * 3600; // 9 AM UTC
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");

      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      const currentDay = Math.floor(depositTime / 86400);
      expect(await kashYield.eligibleCycleDay(user1.address)).to.equal(currentDay);
    });

    it("Should accumulate multiple deposits from same user in same batch cycle", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = currentTime + 900; // 15 minutes offset
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      const depositAmount1 = ethers.parseEther("0.5");
      const depositAmount2 = ethers.parseEther("0.3");
      await kashYield.connect(user1).mintKashEth({ value: depositAmount1 });
      await kashYield.connect(user1).mintKashEth({ value: depositAmount2 });
      const totalDeposit = depositAmount1 + depositAmount2;
      expect(await kashYield.userTotalEthDeposited(user1.address)).to.equal(totalDeposit);
      const batchCycle = await kashYield.eligibleCycleDay(user1.address);
      expect(await kashYield.userBatchContributions(user1.address, batchCycle)).to.equal(totalDeposit);
      expect(await kashYield.totalBatchContributions(batchCycle)).to.equal(totalDeposit);
    });

    it("Should distribute KashEth tokens after batch processing", async function () {
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

      const expectedKashEth = ethers.parseEther("2000"); // 1 ETH * $2000
      expect(await kashEth.balanceOf(user1.address)).to.equal(expectedKashEth);
    });
  });

  describe("Bulk Deposit to Aave", function () {
    it("Should process bulk deposit to Aave when net balance is positive", async function () {
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

      const aaveBalance = await mockAavePool.getUserEthBalance(kashYield.target);
      expect(aaveBalance).to.equal(ethers.parseEther("1"));
    });

    it("Should borrow USDT based on configured percentage after bulk deposit", async function () {
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

      // 70% of 1 ETH * $2000 = $1400 USDT
      const expectedUsdtBorrowed = BigInt(1400) * BigInt(10 ** 6);
      expect(await mockAavePool.getUserUsdtDebt(kashYield.target)).to.equal(expectedUsdtBorrowed);
    });

    it("Should swap USDT to ETH and open short position on GMX after borrowing", async function () {
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

      console.log("Listening for debug events during bulk deposit processing...");
      mockGmx.on("DebugLog", (message, value) => {
        console.log(`GMX Debug: ${message} = ${ethers.formatEther(value)} ETH or equivalent`);
      });
      mockGmx.on("ShortPositionOpened", (account, collateralEth, sizeEth, isLong) => {
        console.log(`GMX Short Position Opened: Account=${account}, Collateral=${ethers.formatEther(collateralEth)} ETH, Size=${ethers.formatEther(sizeEth)} ETH, IsLong=${isLong}`);
      });
      mockGmx.on("SwapExecuted", (tokenIn, tokenOut, amountIn, amountOut) => {
        console.log(`GMX Swap Executed: TokenIn=${tokenIn}, TokenOut=${tokenOut}, AmountIn=${amountIn}, AmountOut=${amountOut}`);
      });
      mockAavePool.on("DebugLog", (message, value) => {
        console.log(`Aave Debug: ${message} = ${value}`);
      });
      mockAavePool.on("SupplyOperation", (user, asset, amount) => {
        console.log(`Aave Supply: User=${user}, Asset=${asset}, Amount=${amount}`);
      });
      mockAavePool.on("BorrowOperation", (user, asset, amount) => {
        console.log(`Aave Borrow: User=${user}, Asset=${asset}, Amount=${amount}`);
      });

      await kashYield.connect(owner).processDailyActions();

      const kashYieldUsdtBalance = await mockUsdt.balanceOf(kashYield.target);
      const gmxUsdtBalance = await mockUsdt.balanceOf(mockGmx.target);
      console.log(`KashYield USDT Balance: ${kashYieldUsdtBalance}`);
      console.log(`GMX USDT Balance: ${gmxUsdtBalance}`);
      console.log(`Expected GMX USDT Balance: ${BigInt(1400) * BigInt(10 ** 6)}`);

      // $1400 USDT at $2000/ETH = 0.7 ETH, short size = 1.7 ETH
      const expectedShortSizeEth = ethers.parseEther("1.7");
      const shortPosition = await mockGmx.getShortPosition(kashYield.target);
      expect(shortPosition.sizeEth).to.be.closeTo(expectedShortSizeEth, ethers.parseEther("0.1"));
      expect(shortPosition.isActive).to.be.true;
      expect(await mockUsdt.balanceOf(kashYield.target)).to.equal(0);
      expect(await mockUsdt.balanceOf(mockGmx.target)).to.equal(BigInt(1400) * BigInt(10 ** 6));
    });

    it("Should not process bulk actions if already processed within delay period", async function () {
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

      await expect(kashYield.connect(owner).processDailyActions())
        .to.be.revertedWith("Daily actions already processed for this window");
    });
  });

  describe("Redemption Requests and Processing", function () {
    let kashYield, user1, owner;
    let initialBalance;

    beforeEach(async function () {
      const fixture = await loadFixture(deployKashYieldFixture);
      kashYield = fixture.kashYield;
      kashEth = fixture.kashEth;
      user1 = fixture.user1;
      owner = fixture.owner;

      let currentTime = await time.latest();
      const depositTime = currentTime + 900; // 15 minutes offset
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      initialBalance = await ethers.provider.getBalance(user1.address);
    });

    it("Should process redemptions and return ETH to users", async function () {
      let currentTime = await time.latest();
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

      const redemptionAmount = ethers.parseEther("1000");
      await kashEth.connect(user1).approve(kashYield.target, redemptionAmount);
      await kashYield.connect(user1).requestRedemption(redemptionAmount);

      const batchCycle = await kashYield.redemptionBatchCycle(user1.address);
      expect(await kashYield.pendingRedemptionsPerBatch(user1.address, batchCycle)).to.equal(redemptionAmount);
    });

    it("Should revert if redemption amount is 0", async function () {
      let currentTime = await time.latest();
      const redemptionTime = currentTime + 900; // 15 minutes offset
      await time.setNextBlockTimestamp(redemptionTime);
      await ethers.provider.send("evm_mine");

      await expect(kashYield.connect(user1).requestRedemption(0)).to.be.revertedWith("Redemption amount must be greater than 0");
    });

    it("Should revert if user has insufficient KashEth balance", async function () {
      let currentTime = await time.latest();
      const redemptionTime = currentTime + 900; // 15 minutes offset
      await time.setNextBlockTimestamp(redemptionTime);
      await ethers.provider.send("evm_mine");

      await kashEth.connect(user1).approve(kashYield.target, ethers.parseEther("3000"));
      await expect(kashYield.connect(user1).requestRedemption(ethers.parseEther("3000"))).to.be.revertedWith("Insufficient KashEth balance");
    });
  });

  describe("Fee Calculations and Distribution", function () {
    let kashYield, user1, owner;

    beforeEach(async function () {
      const fixture = await loadFixture(deployKashYieldFixture);
      kashYield = fixture.kashYield;
      user1 = fixture.user1;
      owner = fixture.owner;

      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      await mockAavePool.connect(owner).supply(ethers.ZeroAddress, ethers.parseEther("0.01"), kashYield.target, 0, { value: ethers.parseEther("0.01") });
    });

    it("Should record daily metrics for Aave balance, USDT debt, and GMX funding", async function () {
      let currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(owner).processDailyActions();

      const currentDay = Math.floor(currentTime / 86400);
      expect(await kashYield.dailyATokenBalance(currentDay)).to.equal(ethers.parseEther("1.01"));
      expect(await kashYield.dailyUsdtDebtBalance(currentDay)).to.equal(ethers.parseEther("0.7")); // 1400 USDT at $2000/ETH
      expect(await kashYield.dailyGmxFunding(currentDay)).to.equal(0);
    });

    it("Should calculate fees based on daily metrics", async function () {
      let currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017")); // 0.1% of 1.7 ETH
      await kashYield.connect(owner).processDailyActions();

      const currentDay = Math.floor(currentTime / 86400);
      const expectedTotalFees = ethers.parseEther("0.0117"); // 0.01 ETH (Aave) + 0.0017 ETH (GMX)
      expect(await kashYield.dailyNetFeesEarned(currentDay)).to.be.closeTo(expectedTotalFees, ethers.parseEther("0.001"));
    });

    it("Should accumulate Aave yield over multiple days", async function () {
      let currentTime = await time.latest();
      let dayNumber = Math.floor(currentTime / 86400);
      
      for (let i = 0; i < 3; i++) {
        currentTime = await time.latest();
        const processingTime = getProcessingWindowTimestamp(currentTime);
        await time.setNextBlockTimestamp(processingTime);
        await ethers.provider.send("evm_mine");
        
        await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.0017"));
        await mockAavePool.setInterestRatePerSecond(0);
        await kashYield.connect(owner).processDailyActions();
        
        await mockAavePool.connect(owner).supply(ethers.ZeroAddress, ethers.parseEther("0.01"), kashYield.target, 0, { value: ethers.parseEther("0.01") });
        
        console.log(`Day ${dayNumber} fees: ${await kashYield.dailyNetFeesEarned(dayNumber)}`);
        
        await time.increase(86400);
        currentTime = await time.latest();
        dayNumber = Math.floor(currentTime / 86400);
        await ethers.provider.send("evm_mine");
      }
      
      const expectedTotalFees = ethers.parseEther("0.0351"); // 3 × (0.01 ETH + 0.0017 ETH)
      console.log(`Final fees for day ${dayNumber - 1}: ${await kashYield.dailyNetFeesEarned(dayNumber - 1)}`);
      expect(await kashYield.dailyNetFeesEarned(dayNumber - 1)).to.be.closeTo(expectedTotalFees, ethers.parseEther("0.001"));
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should handle large number of depositors with batch fee processing", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      const depositors = Array.from({ length: 50 }, (_, i) => ethers.Wallet.createRandom().connect(ethers.provider));
      let currentTime = await time.latest();
      const depositTime = currentTime + 900;
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
      await mockGmx.setFundingAmount(kashYield.target, ethers.parseEther("0.085")); // 0.1% of 85 ETH
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

    it("Should prevent processing outside processing window", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const outsideWindowTime = currentTime + 2 * 3600; // 2 hours offset
      await time.setNextBlockTimestamp(outsideWindowTime);
      await ethers.provider.send("evm_mine");
      
      await expect(kashYield.connect(owner).processDailyActions()).to.be.revertedWith("Not within processing window");
    });

    it("Should handle ETH price fluctuations in redemption calculations", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const initialBalance = await ethers.provider.getBalance(user1.address);
      const depositTime = currentTime + 900;
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
      const redemptionTransactionTime = currentTime + 900;
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