const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AaveYieldLock", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployAaveYieldLockFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    // Deploy the mock Aave V3 contract
    const MockAaveV3 = await ethers.getContractFactory("MockAaveV3");
    // Deploy mock USDT contract first for Aave mock
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const mockUsdt = await MockUSDT.deploy(1000000); // 1M USDT initial supply
    await mockUsdt.waitForDeployment();
    const mockAave = await MockAaveV3.deploy(mockUsdt.target);
    await mockAave.waitForDeployment();

    // Deploy mock Chainlink price feed (ETH/USD price, e.g., $2,000 with 8 decimals)
    const MockChainlinkPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
    const mockPriceFeed = await MockChainlinkPriceFeed.deploy(200000000000); // $2,000.00 with 8 decimals
    await mockPriceFeed.waitForDeployment();

    // Deploy the AaveYieldLock contract with an initial deposit
    const initialDeposit = ethers.parseEther("1.0");
    const AaveYieldLock = await ethers.getContractFactory("AaveYieldLock");
    const aaveYieldLock = await AaveYieldLock.deploy(mockAave.target, mockPriceFeed.target, mockUsdt.target, { value: initialDeposit });
    await aaveYieldLock.waitForDeployment();

    return { aaveYieldLock, mockAave, mockUsdt, mockPriceFeed, owner, user1, user2, initialDeposit };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { aaveYieldLock, owner } = await loadFixture(deployAaveYieldLockFixture);
      expect(await aaveYieldLock.owner()).to.equal(owner.address);
    });

    it("Should receive and store the initial deposit for owner", async function () {
      const { aaveYieldLock, owner, initialDeposit } = await loadFixture(deployAaveYieldLockFixture);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(owner.address)).to.equal(initialDeposit);
    });

    it("Should have default configuration values", async function () {
      const { aaveYieldLock } = await loadFixture(deployAaveYieldLockFixture);
      expect(await aaveYieldLock.depositsPerDay()).to.equal(1);
      expect(await aaveYieldLock.cutoffHourHKT()).to.equal(16); // 4:00 PM HKT
      expect(await aaveYieldLock.borrowPercentage()).to.equal(40);
    });
  });

  describe("Configuration Updates", function () {
    it("Should allow owner to update configuration parameters", async function () {
      const { aaveYieldLock, owner } = await loadFixture(deployAaveYieldLockFixture);
      const newDepositsPerDay = 2;
      const newCutoffHourHKT = 14; // 2:00 PM HKT
      const newBorrowPercentage = 50;
      await expect(aaveYieldLock.connect(owner).updateConfiguration(newDepositsPerDay, newCutoffHourHKT, newBorrowPercentage))
        .to.emit(aaveYieldLock, "ConfigurationUpdated")
        .withArgs(newDepositsPerDay, newCutoffHourHKT, newBorrowPercentage);
      expect(await aaveYieldLock.depositsPerDay()).to.equal(newDepositsPerDay);
      expect(await aaveYieldLock.cutoffHourHKT()).to.equal(newCutoffHourHKT);
      expect(await aaveYieldLock.borrowPercentage()).to.equal(newBorrowPercentage);
    });

    it("Should revert if non-owner tries to update configuration", async function () {
      const { aaveYieldLock, user1 } = await loadFixture(deployAaveYieldLockFixture);
      await expect(aaveYieldLock.connect(user1).updateConfiguration(2, 14, 50))
        .to.be.revertedWith("Only owner can call this function");
    });

    it("Should revert if deposits per day is set to 0", async function () {
      const { aaveYieldLock, owner } = await loadFixture(deployAaveYieldLockFixture);
      await expect(aaveYieldLock.connect(owner).updateConfiguration(0, 14, 50))
        .to.be.revertedWith("Deposits per day must be greater than 0");
    });

    it("Should revert if cutoff hour is invalid (24 or more)", async function () {
      const { aaveYieldLock, owner } = await loadFixture(deployAaveYieldLockFixture);
      await expect(aaveYieldLock.connect(owner).updateConfiguration(2, 24, 50))
        .to.be.revertedWith("Cutoff hour must be between 0 and 23");
    });

    it("Should revert if borrow percentage exceeds 100", async function () {
      const { aaveYieldLock, owner } = await loadFixture(deployAaveYieldLockFixture);
      await expect(aaveYieldLock.connect(owner).updateConfiguration(2, 14, 101))
        .to.be.revertedWith("Borrow percentage must be between 0 and 100");
    });
  });

  describe("Deposits", function () {
    it("Should accept deposits from other users", async function () {
      const { aaveYieldLock, user1 } = await loadFixture(deployAaveYieldLockFixture);
      const depositAmount = ethers.parseEther("0.5");
      await expect(aaveYieldLock.connect(user1).deposit({ value: depositAmount }))
        .to.emit(aaveYieldLock, "Deposit")
        .withArgs(depositAmount, user1.address, anyValue);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(depositAmount);
    });

    it("Should reject deposits of 0 ETH", async function () {
      const { aaveYieldLock, user1 } = await loadFixture(deployAaveYieldLockFixture);
      await expect(aaveYieldLock.connect(user1).deposit({ value: 0 }))
        .to.be.revertedWith("Deposit amount must be greater than 0");
    });

    it("Should set correct eligible cycle day based on deposit time (before cutoff)", async function () {
      const { aaveYieldLock, user1 } = await loadFixture(deployAaveYieldLockFixture);
      const depositAmount = ethers.parseEther("0.5");
      // Set time to 3:59 PM HKT (just before default cutoff of 4:00 PM)
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600) + (59 * 60); // 3:59 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      const tx = await aaveYieldLock.connect(user1).deposit({ value: depositAmount });
      const receipt = await tx.wait();
      const event = receipt.logs[0].decodeData[2]; // eligibleCycleDay from event
      const currentDayStartHKT = depositTime - ((depositTime + hktOffset) % (24 * 3600));
      const expectedCycleDay = currentDayStartHKT + (24 * 3600); // Next day first cycle
      expect(event).to.equal(expectedCycleDay);
    });

    it("Should set correct eligible cycle day based on deposit time (after cutoff)", async function () {
      const { aaveYieldLock, user1 } = await loadFixture(deployAaveYieldLockFixture);
      const depositAmount = ethers.parseEther("0.5");
      // Set time to 4:01 PM HKT (just after default cutoff of 4:00 PM)
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (16 * 3600) + 60; // 4:01 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      const tx = await aaveYieldLock.connect(user1).deposit({ value: depositAmount });
      const receipt = await tx.wait();
      const event = receipt.logs[0].decodeData[2]; // eligibleCycleDay from event
      const currentDayStartHKT = depositTime - ((depositTime + hktOffset) % (24 * 3600));
      const expectedCycleDay = currentDayStartHKT + (2 * 24 * 3600); // Day after next first cycle
      expect(event).to.equal(expectedCycleDay);
    });

    it("Should respect updated cutoff hour for deposit eligibility", async function () {
      const { aaveYieldLock, owner, user1 } = await loadFixture(deployAaveYieldLockFixture);
      // Update cutoff hour to 2:00 PM HKT (14:00)
      await aaveYieldLock.connect(owner).updateConfiguration(1, 14, 40);
      const depositAmount = ethers.parseEther("0.5");
      // Set time to 2:01 PM HKT (just after new cutoff)
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (14 * 3600) + 60; // 2:01 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      const tx = await aaveYieldLock.connect(user1).deposit({ value: depositAmount });
      const receipt = await tx.wait();
      const event = receipt.logs[0].decodeData[2]; // eligibleCycleDay from event
      const currentDayStartHKT = depositTime - ((depositTime + hktOffset) % (24 * 3600));
      const expectedCycleDay = currentDayStartHKT + (2 * 24 * 3600); // Day after next first cycle
      expect(event).to.equal(expectedCycleDay);
    });
  });

  describe("Bulk Deposit to Aave", function () {
    it("Should allow bulk deposit to Aave for eligible users at cycle time", async function () {
      const { aaveYieldLock, mockAave, owner, user1, user2, initialDeposit } = await loadFixture(deployAaveYieldLockFixture);
      const user1Deposit = ethers.parseEther("0.5");
      const user2Deposit = ethers.parseEther("0.3");
      // Deposits before deadline
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600); // 3:00 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      await aaveYieldLock.connect(user2).deposit({ value: user2Deposit });
      // Set time to 12:00 AM HKT next day for bulk transfer (first cycle with depositsPerDay=1)
      const bulkTransferTime = depositTime + (9 * 3600); // Approx 12:00 AM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      const totalExpectedTransfer = initialDeposit + user1Deposit + user2Deposit;
      await expect(aaveYieldLock.bulkDepositToAave([owner.address, user1.address, user2.address]))
        .to.emit(aaveYieldLock, "BulkDepositedToAave")
        .withArgs(totalExpectedTransfer, anyValue);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(owner.address)).to.equal(0);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(0);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user2.address)).to.equal(0);
      expect(await aaveYieldLock.getTotalDepositedToAave(owner.address)).to.equal(initialDeposit);
      expect(await aaveYieldLock.getTotalDepositedToAave(user1.address)).to.equal(user1Deposit);
      expect(await aaveYieldLock.getTotalDepositedToAave(user2.address)).to.equal(user2Deposit);
      expect(await mockAave.getSuppliedAmount(aaveYieldLock.target)).to.equal(totalExpectedTransfer);
    });

    it("Should not transfer funds for deposits after deadline", async function () {
      const { aaveYieldLock, owner, user1 } = await loadFixture(deployAaveYieldLockFixture);
      const user1Deposit = ethers.parseEther("0.5");
      // Deposit after deadline (4:01 PM HKT)
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (16 * 3600) + 60; // 4:01 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      // Set time to 12:00 AM HKT next day for bulk transfer
      const bulkTransferTime = depositTime + (8 * 3600) - 60; // Approx 12:00 AM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      await aaveYieldLock.bulkDepositToAave([owner.address, user1.address]);
      // Only owner's initial deposit should be transferred
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(user1Deposit);
      expect(await aaveYieldLock.getTotalDepositedToAave(user1.address)).to.equal(0);
    });

    it("Should respect updated deposits per day for cycle timing", async function () {
      const { aaveYieldLock, owner, user1, initialDeposit } = await loadFixture(deployAaveYieldLockFixture);
      // Update deposits per day to 2 (cycles every 12 hours)
      await aaveYieldLock.connect(owner).updateConfiguration(2, 16, 40);
      const user1Deposit = ethers.parseEther("0.5");
      // Deposit before deadline
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600); // 3:00 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      // Set time to 12:00 PM HKT next day (second cycle of the day with depositsPerDay=2)
      const bulkTransferTime = depositTime + (21 * 3600); // Approx 12:00 PM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      const totalExpectedTransfer = initialDeposit + user1Deposit;
      await expect(aaveYieldLock.bulkDepositToAave([owner.address, user1.address]))
        .to.emit(aaveYieldLock, "BulkDepositedToAave")
        .withArgs(totalExpectedTransfer, anyValue);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(0);
      expect(await aaveYieldLock.getTotalDepositedToAave(user1.address)).to.equal(user1Deposit);
    });
  });

  describe("Balance Tracking", function () {
    it("Should correctly track balances before and after bulk transfer", async function () {
      const { aaveYieldLock, user1, user2 } = await loadFixture(deployAaveYieldLockFixture);
      const user1Deposit = ethers.parseEther("0.5");
      const user2Deposit = ethers.parseEther("0.3");
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600); // 3:00 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      await aaveYieldLock.connect(user2).deposit({ value: user2Deposit });
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(user1Deposit);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user2.address)).to.equal(user2Deposit);
      // Set time to 12:00 AM HKT next day for bulk transfer
      const bulkTransferTime = depositTime + (9 * 3600); // Approx 12:00 AM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      await aaveYieldLock.bulkDepositToAave([user1.address, user2.address]);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user1.address)).to.equal(0);
      expect(await aaveYieldLock.getBalanceBeforeTransfer(user2.address)).to.equal(0);
      expect(await aaveYieldLock.getTotalDepositedToAave(user1.address)).to.equal(user1Deposit);
      expect(await aaveYieldLock.getTotalDepositedToAave(user2.address)).to.equal(user2Deposit);
    });
  });

  describe("USDT Borrow After Bulk Deposit", function () {
    it("Should borrow configured percentage of ETH value in USDT immediately after bulk deposit", async function () {
      const { aaveYieldLock, mockAave, mockUsdt, owner, user1, initialDeposit } = await loadFixture(deployAaveYieldLockFixture);
      const user1Deposit = ethers.parseEther("0.5");
      // Deposits before deadline
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600); // 3:00 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      // Set time to 12:00 AM HKT next day for bulk transfer and borrow
      const bulkTransferTime = depositTime + (9 * 3600); // Approx 12:00 AM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      const totalEthDeposited = initialDeposit + user1Deposit;
      // Assuming ETH price is $2,000 (from mock price feed, 8 decimals: 200000000000)
      // ETH value in USD = totalEthDeposited * 2000
      // Configured percentage (default 40%) of value in USD for borrow
      // USDT has 6 decimals, and 1 USDT = 1 USD
      const ethPriceUsd = 2000;
      const totalEthValueUsd = (Number(ethers.formatEther(totalEthDeposited)) * ethPriceUsd);
      const borrowValueUsd = (totalEthValueUsd * 40) / 100;
      const expectedUsdtBorrowed = ethers.parseUnits(borrowValueUsd.toString(), 6); // USDT 6 decimals
      await expect(aaveYieldLock.bulkDepositToAave([owner.address, user1.address]))
        .to.emit(aaveYieldLock, "UsdtBorrowed")
        .withArgs(expectedUsdtBorrowed, anyValue);
      expect(await aaveYieldLock.totalUsdtBorrowed()).to.equal(expectedUsdtBorrowed);
      expect(await mockUsdt.balanceOf(aaveYieldLock.target)).to.equal(expectedUsdtBorrowed);
      expect(await mockAave.getBorrowedAmount(aaveYieldLock.target)).to.equal(expectedUsdtBorrowed);
    });

    it("Should respect updated borrow percentage for USDT borrow amount", async function () {
      const { aaveYieldLock, mockAave, mockUsdt, owner, user1, initialDeposit } = await loadFixture(deployAaveYieldLockFixture);
      // Update borrow percentage to 50%
      await aaveYieldLock.connect(owner).updateConfiguration(1, 16, 50);
      const user1Deposit = ethers.parseEther("0.5");
      // Deposits before deadline
      const hktOffset = 8 * 3600;
      const depositTime = Math.floor(Date.now() / 1000) - hktOffset + (15 * 3600); // 3:00 PM HKT
      await time.setNextBlockTimestamp(depositTime);
      await aaveYieldLock.connect(user1).deposit({ value: user1Deposit });
      // Set time to 12:00 AM HKT next day for bulk transfer and borrow
      const bulkTransferTime = depositTime + (9 * 3600); // Approx 12:00 AM HKT next day
      await time.setNextBlockTimestamp(bulkTransferTime);
      const totalEthDeposited = initialDeposit + user1Deposit;
      // Assuming ETH price is $2,000
      // ETH value in USD = totalEthDeposited * 2000
      // Updated percentage (50%) of value in USD for borrow
      const ethPriceUsd = 2000;
      const totalEthValueUsd = (Number(ethers.formatEther(totalEthDeposited)) * ethPriceUsd);
      const borrowValueUsd = (totalEthValueUsd * 50) / 100;
      const expectedUsdtBorrowed = ethers.parseUnits(borrowValueUsd.toString(), 6); // USDT 6 decimals
      await expect(aaveYieldLock.bulkDepositToAave([owner.address, user1.address]))
        .to.emit(aaveYieldLock, "UsdtBorrowed")
        .withArgs(expectedUsdtBorrowed, anyValue);
      expect(await aaveYieldLock.totalUsdtBorrowed()).to.equal(expectedUsdtBorrowed);
      expect(await mockUsdt.balanceOf(aaveYieldLock.target)).to.equal(expectedUsdtBorrowed);
    });
  });
}); 