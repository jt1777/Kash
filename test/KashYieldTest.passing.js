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

describe("KashYield - Passing Tests", function () {
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

  describe("Deployment", function () {
    it("Should deploy KashYield with minimal setup", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      expect(await kashYield.owner()).to.equal(owner.address);
    });

    it("Should set the right owner", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      expect(await kashYield.owner()).to.equal(owner.address);
    });

    it("Should initialize mock contracts correctly", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      expect(await kashYield.aavePoolAddress()).to.equal(mockAavePool.target);
      expect(await kashYield.usdtAddress()).to.equal(mockUsdt.target);
      expect(await kashYield.priceFeedAddress()).to.equal(mockPriceFeed.target);
      expect(await kashYield.gmxAddress()).to.equal(mockGmx.target);
    });

    it("Should initialize KashEth token", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      const kashEthAddress = await kashYield.kashEth();
      expect(kashEthAddress).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Configuration Updates", function () {
    it("Should allow owner to update configuration parameters", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      await kashYield.connect(owner).updateConfiguration(2, 70, 100, 7200);
      expect(await kashYield.transactionsPerDay()).to.equal(2);
      expect(await kashYield.depositorsPerFeeBatch()).to.equal(100);
      expect(await kashYield.processingDelaySeconds()).to.equal(7200);
    });

    it("Should revert if non-owner tries to update configuration", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      await expect(kashYield.connect(user1).updateConfiguration(2, 70, 100, 7200))
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Should revert if transactions per day is set to 0", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      await expect(kashYield.connect(owner).updateConfiguration(0, 70, 100, 7200))
        .to.be.revertedWith("Transactions per day must be greater than 0");
    });

    it("Should revert if depositors per fee batch is 0", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      await expect(kashYield.connect(owner).updateConfiguration(1, 70, 0, 7200))
        .to.be.revertedWith("Depositors per fee batch must be greater than 0");
    });

    it("Should revert if processing delay is less than 1 hour", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      await expect(kashYield.connect(owner).updateConfiguration(1, 70, 50, 3000))
        .to.be.revertedWith("Processing delay must be at least 1 hour");
    });
  });

  describe("User Deposits and Minting", function () {
    it("Should accept ETH deposits and queue for minting within transaction window", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

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
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      const currentDay = Math.floor(depositTime / 86400);
      expect(await kashYield.eligibleCycleDay(user1.address)).to.equal(currentDay);
    });

    it("Should accumulate multiple deposits from same user in same batch cycle", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("0.5") });
      
      expect(await kashYield.userTotalEthDeposited(user1.address)).to.equal(ethers.parseEther("1.5"));
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

      expect(await kashYield.totalEthDepositedToAave()).to.equal(ethers.parseEther("1"));
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

      const expectedUsdtBorrow = 1400000000n; // 1 ETH * $2000 * 70% = $1400 USDT (6 decimals)
      expect(await kashYield.totalBorrowedUSDT()).to.equal(expectedUsdtBorrow);
    });

    it("Should swap USDT to ETH and open short position on GMX after borrowing", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      console.log("Listening for debug events during bulk deposit processing...");
      
      let currentTime = await time.latest();
      const depositTime = getTransactionWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(depositTime);
      await ethers.provider.send("evm_mine");
      await kashYield.connect(user1).mintKashEth({ value: ethers.parseEther("1") });

      currentTime = await time.latest();
      const processingTime = getProcessingWindowTimestamp(currentTime);
      await time.setNextBlockTimestamp(processingTime);
      await ethers.provider.send("evm_mine");

      const kashYieldUsdtBefore = await mockUsdt.balanceOf(kashYield.target);
      const gmxUsdtBefore = await mockUsdt.balanceOf(mockGmx.target);
      console.log(`KashYield USDT Balance: ${kashYieldUsdtBefore}`);
      console.log(`GMX USDT Balance: ${gmxUsdtBefore}`);

      await kashYield.connect(owner).processDailyActions();

      const gmxUsdtAfter = await mockUsdt.balanceOf(mockGmx.target);
      const expectedGmxUsdt = gmxUsdtBefore + 1400000000n;
      console.log(`Expected GMX USDT Balance: ${expectedGmxUsdt}`);
      expect(gmxUsdtAfter).to.equal(expectedGmxUsdt);
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



  describe("Fee Calculations and Distribution", function () {
    it("Should record daily metrics for Aave balance, USDT debt, and GMX funding", async function () {
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

      const currentDay = Math.floor(processingTime / 86400);
      const dailyAToken = await kashYield.dailyATokenBalance(currentDay);
      const dailyDebt = await kashYield.dailyUsdtDebtBalance(currentDay);

      expect(dailyAToken).to.be.greaterThan(0);
      expect(dailyDebt).to.be.greaterThan(0);
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should prevent processing outside processing window", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      let currentTime = await time.latest();
      const outsideWindowTime = currentTime + 2 * 3600; // 2 hours offset
      await time.setNextBlockTimestamp(outsideWindowTime);
      await ethers.provider.send("evm_mine");
      
      await expect(kashYield.connect(owner).processDailyActions()).to.be.revertedWith("Not within processing window");
    });
  });
});
