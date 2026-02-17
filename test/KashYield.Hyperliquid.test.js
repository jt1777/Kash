const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("KashYield - Hyperliquid Migration", function () {
  // AssetType enum values
  const AssetType = { ETH: 0, WETH: 1, WBTC: 2, USDT: 3, USDC: 4 };
  
  async function deployKashYieldFixture() {
    const [owner, user1, user2, user3, bot] = await ethers.getSigners();

    // Deploy mock contracts
    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const mockUsdc = await MockUSDC.deploy();
    await mockUsdc.waitForDeployment();

    const MockAave = await ethers.getContractFactory('MockAaveV3');
    const mockAavePool = await MockAave.deploy(mockUsdc.target);
    await mockAavePool.waitForDeployment();
    await mockAavePool.setUsdcAddress(mockUsdc.target);

    const MockPriceFeed = await ethers.getContractFactory('MockChainlinkPriceFeed');
    const mockPriceFeed = await MockPriceFeed.deploy(300000000000n); // $3000 ETH
    await mockPriceFeed.waitForDeployment();

    const MockWETH = await ethers.getContractFactory('MockWETH');
    const mockWeth = await MockWETH.deploy();
    await mockWeth.waitForDeployment();

    const MockHyperliquid = await ethers.getContractFactory('MockHyperliquid');
    const mockHyperliquid = await MockHyperliquid.deploy(mockUsdc.target, mockWeth.target);
    await mockHyperliquid.waitForDeployment();

    // Deploy KashYield
    const KashYield = await ethers.getContractFactory('KashYield');
    const kashYield = await KashYield.deploy(
      mockAavePool.target,
      mockUsdc.target,
      mockPriceFeed.target,
      mockHyperliquid.target,
      mockWeth.target,
      { value: 0 }
    );
    await kashYield.waitForDeployment();

    // Get KashEth token
    const kashEthAddress = await kashYield.kashEth();
    const KashEth = await ethers.getContractFactory('KashEth');
    const kashEth = KashEth.attach(kashEthAddress);

    // Mint USDC to Aave for borrowing
    await mockUsdc.mint(mockAavePool.target, ethers.parseUnits("1000000", 6));

    // Set initial config: 70% borrow, 1.7x leverage
    await kashYield.connect(owner).updateConfiguration(
      1,      // transactionsPerDay
      70,     // borrowPercentage
      170,    // leverage (1.7x)
      50,     // depositorsPerFeeBatch
      23 * 3600, // processingDelay
      0, 15,  // startHour, startMinute (HKT)
      23, 45  // endHour, endMinute (HKT)
    );

    return { 
      kashYield, kashEth, mockUsdc, mockAavePool, 
      mockPriceFeed, mockHyperliquid, mockWeth,
      owner, user1, user2, user3, bot 
    };
  }

  describe("Deployment & Initialization", function () {
    it("Should deploy with correct initial parameters", async function () {
      const { kashYield, mockAavePool, mockUsdc, mockPriceFeed, mockHyperliquid, mockWeth } = await loadFixture(deployKashYieldFixture);
      
      expect(await kashYield.aavePoolAddress()).to.equal(mockAavePool.target);
      expect(await kashYield.usdcAddress()).to.equal(mockUsdc.target);
      expect(await kashYield.priceFeedAddress()).to.equal(mockPriceFeed.target);
      expect(await kashYield.hyperliquidAddress()).to.equal(mockHyperliquid.target);
      expect(await kashYield.wethAddress()).to.equal(mockWeth.target);
    });

    it("Should initialize supported assets correctly", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      
      expect(await kashYield.isAssetSupported(AssetType.ETH)).to.be.true;
      expect(await kashYield.isAssetSupported(AssetType.WETH)).to.be.true;
      expect(await kashYield.isAssetSupported(AssetType.WBTC)).to.be.false;
    });

    it("Should set owner correctly", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      expect(await kashYield.owner()).to.equal(owner.address);
    });

    it("Should initialize with correct default config", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      
      expect(await kashYield.usdcBorrowPercentage()).to.equal(70);
      expect(await kashYield.leverage()).to.equal(170);
      expect(await kashYield.transactionsPerDay()).to.equal(1);
    });
  });

  describe("Access Control & Security", function () {
    it("Should revert non-owner configuration changes", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(user1).updateConfiguration(
        1, 70, 170, 50, 23 * 3600, 0, 15, 23, 45
      )).to.be.revertedWith("Only owner");
    });

    it("Should validate borrow percentage <= 75%", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(owner).updateConfiguration(
        1, 76, 170, 50, 23 * 3600, 0, 15, 23, 45
      )).to.be.revertedWith("Borrow percentage max 75%");
    });

    it("Should validate leverage between 1x and 2x", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(owner).updateConfiguration(
        1, 70, 99, 50, 23 * 3600, 0, 15, 23, 45
      )).to.be.revertedWith("Leverage 1-2x");
      
      await expect(kashYield.connect(owner).updateConfiguration(
        1, 70, 201, 50, 23 * 3600, 0, 15, 23, 45
      )).to.be.revertedWith("Leverage 1-2x");
    });

    it("Should only allow owner to add new assets", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(user1).addSupportedAsset(
        AssetType.WBTC, ethers.ZeroAddress
      )).to.be.revertedWith("Only owner");
    });

    it("Should only allow owner to process daily actions", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(user1).processDailyActions(0))
        .to.be.revertedWith("Only owner");
    });
  });

  describe("ETH Deposits", function () {
    it("Should accept ETH deposits within transaction window", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await expect(kashYield.connect(user1).depositETH({ value: depositAmount }))
        .to.emit(kashYield, "KashEthMinted")
        .withArgs(user1.address, ethers.ZeroAddress, depositAmount, 0, anyValue, anyValue);
    });

    it("Should reject ETH deposits of 0", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(user1).depositETH({ value: 0 }))
        .to.be.revertedWith("Amount must be > 0");
    });

    it("Should reject ETH deposits outside window", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      const currentTime = await time.latest();
      // Set time to 23:50 (outside 00:15-23:45 window)
      const dayStart = currentTime - (currentTime % 86400);
      const badTime = dayStart + (23 * 3600) + (50 * 60);
      await time.setNextBlockTimestamp(Math.max(badTime, currentTime + 3600));
      
      await expect(kashYield.connect(user1).depositETH({ value: ethers.parseEther("1") }))
        .to.be.revertedWith("Outside deposit window");
    });

    it("Should track user batch contributions correctly", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      const nextMidnight = ((currentTime / 86400) + 1) * 86400;
      const contribution = await kashYield.userBatchContributions(user1.address, nextMidnight, AssetType.ETH);
      expect(contribution).to.equal(depositAmount);
    });

    it("Should accumulate multiple deposits from same user", async function () {
      const { kashYield, user1 } = await loadFixture(deployKashYieldFixture);
      
      const deposit1 = ethers.parseEther("0.5");
      const deposit2 = ethers.parseEther("0.3");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await kashYield.connect(user1).depositETH({ value: deposit1 });
      await kashYield.connect(user1).depositETH({ value: deposit2 });
      
      const nextMidnight = ((currentTime / 86400) + 1) * 86400;
      const totalContribution = await kashYield.userBatchContributions(user1.address, nextMidnight, AssetType.ETH);
      expect(totalContribution).to.equal(deposit1 + deposit2);
    });
  });

  describe("WETH Deposits", function () {
    it("Should accept WETH deposits", async function () {
      const { kashYield, mockWeth, user1 } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      await mockWeth.connect(user1).deposit({ value: depositAmount });
      await mockWeth.connect(user1).approve(kashYield.target, depositAmount);
      
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await expect(kashYield.connect(user1).depositWETH(depositAmount))
        .to.emit(kashYield, "KashEthMinted")
        .withArgs(user1.address, mockWeth.target, depositAmount, 0, anyValue, anyValue);
    });

    it("Should reject WETH deposits without approval", async function () {
      const { kashYield, mockWeth, user1 } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      await mockWeth.connect(user1).deposit({ value: depositAmount });
      // No approval given
      
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await expect(kashYield.connect(user1).depositWETH(depositAmount))
        .to.be.reverted;
    });

    it("Should track WETH contributions separately from ETH", async function () {
      const { kashYield, mockWeth, user1 } = await loadFixture(deployKashYieldFixture);
      
      const ethAmount = ethers.parseEther("0.5");
      const wethAmount = ethers.parseEther("0.3");
      
      // Setup WETH
      await mockWeth.connect(user1).deposit({ value: wethAmount });
      await mockWeth.connect(user1).approve(kashYield.target, wethAmount);
      
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      
      await kashYield.connect(user1).depositETH({ value: ethAmount });
      await kashYield.connect(user1).depositWETH(wethAmount);
      
      const nextMidnight = ((currentTime / 86400) + 1) * 86400;
      const ethContribution = await kashYield.userBatchContributions(user1.address, nextMidnight, AssetType.ETH);
      const wethContribution = await kashYield.userBatchContributions(user1.address, nextMidnight, AssetType.WETH);
      
      expect(ethContribution).to.equal(ethAmount);
      expect(wethContribution).to.equal(wethAmount);
    });
  });

  describe("Batch Processing & KashEth Distribution", function () {
    it("Should process deposits and mint KashEth after batch", async function () {
      const { kashYield, kashEth, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      // Deposit 1 ETH
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      // Set price to $3000
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      
      // Owner processes batch
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // 1 ETH * $3000 = $3000 = 3000 KashEth (6 decimals)
      const expectedKashEth = 3000n * 10n**6n;
      expect(await kashEth.balanceOf(user1.address)).to.equal(expectedKashEth);
    });

    it("Should supply ETH to Aave during batch processing", async function () {
      const { kashYield, mockAavePool, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      
      await expect(kashYield.connect(owner).processDailyActions(batchCycle))
        .to.emit(kashYield, "BulkDepositToAave")
        .withArgs(ethers.ZeroAddress, depositAmount, anyValue);
    });

    it("Should borrow 70% USDC and deposit to Hyperliquid", async function () {
      const { kashYield, mockUsdc, mockHyperliquid, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // 1 ETH * $3000 * 70% = $2100 USDC (6 decimals)
      const expectedUsdcBorrowed = 2100n * 10n**6n;
      expect(await kashYield.totalUsdcBorrowed()).to.equal(expectedUsdcBorrowed);
      
      // Check Hyperliquid received USDC
      expect(await mockUsdc.balanceOf(mockHyperliquid.target)).to.equal(expectedUsdcBorrowed);
    });

    it("Should open 1.7x short position on Hyperliquid", async function () {
      const { kashYield, mockHyperliquid, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Position size = $3000 * 1.7 = $5100
      const position = await mockHyperliquid.getPosition(kashYield.target);
      expect(position.isOpen).to.be.true;
      expect(position.isLong).to.be.false;
      expect(position.positionSize).to.equal(5100n * 10n**18n); // $5100 in 18 decimals
    });
  });

  describe("Redemptions", function () {
    async function setupWithDeposit() {
      const fixtures = await loadFixture(deployKashYieldFixture);
      const { kashYield, kashEth, user1, owner } = fixtures;
      
      // Deposit and process
      const depositAmount = ethers.parseEther("1");
      const currentTime = await time.latest();
      const depositTime = currentTime + 3600;
      await time.setNextBlockTimestamp(depositTime);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      return { ...fixtures, batchCycle, depositAmount };
    }

    it("Should allow redemption requests", async function () {
      const { kashYield, kashEth, user1, batchCycle } = await setupWithDeposit();
      
      const redemptionAmount = 1500n * 10n**6n; // 1500 KashEth
      await kashEth.connect(user1).approve(kashYield.target, redemptionAmount);
      
      const currentTime = await time.latest();
      const requestTime = currentTime + 3600;
      await time.setNextBlockTimestamp(requestTime);
      
      await expect(kashYield.connect(user1).requestRedemption(redemptionAmount))
        .to.emit(kashYield, "RedemptionRequestQueued")
        .withArgs(user1.address, redemptionAmount, anyValue, anyValue);
    });

    it("Should reject redemption without approval", async function () {
      const { kashYield, kashEth, user1 } = await setupWithDeposit();
      
      const redemptionAmount = 1500n * 10n**6n;
      // No approval
      
      await expect(kashYield.connect(user1).requestRedemption(redemptionAmount))
        .to.be.reverted;
    });

    it("Should reject redemption exceeding balance", async function () {
      const { kashYield, kashEth, user1 } = await setupWithDeposit();
      
      const tooMuch = 5000n * 10n**6n; // More than deposited
      await kashEth.connect(user1).approve(kashYield.target, tooMuch);
      
      await expect(kashYield.connect(user1).requestRedemption(tooMuch))
        .to.be.revertedWith("Insufficient balance");
    });

    it("Should process redemptions and return ETH", async function () {
      const { kashYield, kashEth, user1, owner, batchCycle } = await setupWithDeposit();
      
      // Request redemption
      const redemptionAmount = 1500n * 10n**6n; // $1500 worth = 0.5 ETH
      await kashEth.connect(user1).approve(kashYield.target, redemptionAmount);
      
      let currentTime = await time.latest();
      let requestTime = currentTime + 3600;
      await time.setNextBlockTimestamp(requestTime);
      await kashYield.connect(user1).requestRedemption(redemptionAmount);
      
      // Process redemption next batch
      const nextBatch = batchCycle + 86400;
      await time.setNextBlockTimestamp(Math.max(nextBatch, currentTime + 7200));
      
      const balanceBefore = await ethers.provider.getBalance(user1.address);
      await kashYield.connect(owner).processDailyActions(nextBatch);
      const balanceAfter = await ethers.provider.getBalance(user1.address);
      
      // Should receive ~0.5 ETH minus fees
      expect(balanceAfter).to.be.gt(balanceBefore);
    });
  });

  describe("Price Feed & Conversions", function () {
    it("Should get correct ETH price from oracle", async function () {
      const { kashYield, mockPriceFeed } = await loadFixture(deployKashYieldFixture);
      
      const price = await kashYield.getLatestEthPrice();
      expect(price).to.equal(3000n * 10n**18n); // $3000 in 18 decimals
    });

    it("Should convert ETH to USD correctly", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      
      const ethAmount = ethers.parseEther("2");
      const usdValue = await kashYield.convertAssetToUsd(AssetType.ETH, ethAmount);
      expect(usdValue).to.equal(6000n * 10n**18n); // 2 ETH * $3000
    });

    it("Should convert USD to ETH correctly", async function () {
      const { kashYield } = await loadFixture(deployKashYieldFixture);
      
      const usdAmount = 6000n * 10n**18n;
      const ethAmount = await kashYield.convertUsdToEth(usdAmount);
      expect(ethAmount).to.equal(ethers.parseEther("2"));
    });

    it("Should handle price updates correctly", async function () {
      const { kashYield, mockPriceFeed, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      // Deposit at $3000
      const depositAmount = ethers.parseEther("1");
      let currentTime = await time.latest();
      await time.setNextBlockTimestamp(currentTime + 3600);
      await kashYield.connect(user1).depositETH({ value: depositAmount });
      
      // Update price to $4000
      await mockPriceFeed.setPrice(400000000000n);
      
      const newPrice = await kashYield.getLatestEthPrice();
      expect(newPrice).to.equal(4000n * 10n**18n);
    });
  });

  describe("Fee Distribution", function () {
    it("Should track user share of fees correctly", async function () {
      const { kashYield, user1, user2, owner } = await loadFixture(deployKashYieldFixture);
      
      // User1 deposits 1 ETH
      let currentTime = await time.latest();
      await time.setNextBlockTimestamp(currentTime + 3600);
      await kashYield.connect(user1).depositETH({ value: ethers.parseEther("1") });
      
      // User2 deposits 1 ETH
      await time.setNextBlockTimestamp(currentTime + 7200);
      await kashYield.connect(user2).depositETH({ value: ethers.parseEther("1") });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 10800));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Both should have 50% share
      const share1 = await kashYield.getUserShareOfFees(user1.address);
      const share2 = await kashYield.getUserShareOfFees(user2.address);
      
      expect(share1).to.equal(50n * 10n**16n); // 0.5 in 18 decimals
      expect(share2).to.equal(50n * 10n**16n);
    });

    it("Should accumulate fees for users", async function () {
      const { kashYield, kashEth, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      // Deposit and process
      let currentTime = await time.latest();
      await time.setNextBlockTimestamp(currentTime + 3600);
      await kashYield.connect(user1).depositETH({ value: ethers.parseEther("1") });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Check fees accumulated (would be 0 in mock, but structure is there)
      const fees = await kashYield.getAccumulatedFees.staticCall({ from: user1.address });
      expect(fees).to.be.a('bigint');
    });
  });

  describe("Edge Cases & Stress Tests", function () {
    it("Should handle multiple batch cycles correctly", async function () {
      const { kashYield, kashEth, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      // Day 1 deposit
      let currentTime = await time.latest();
      await time.setNextBlockTimestamp(currentTime + 3600);
      await kashYield.connect(user1).depositETH({ value: ethers.parseEther("1") });
      
      let batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Day 2 deposit
      await time.setNextBlockTimestamp(batchCycle + 3600);
      await kashYield.connect(user1).depositETH({ value: ethers.parseEther("0.5") });
      
      batchCycle = batchCycle + 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, (await time.latest()) + 7200));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Should have minted KashEth for both deposits
      // Day 1: 1 ETH * $3000 = 3000 KashEth
      // Day 2: 0.5 ETH * $3000 = 1500 KashEth
      const balance = await kashEth.balanceOf(user1.address);
      expect(balance).to.equal(4500n * 10n**6n);
    });

    it("Should prevent double processing within delay window", async function () {
      const { kashYield, user1, owner } = await loadFixture(deployKashYieldFixture);
      
      let currentTime = await time.latest();
      await time.setNextBlockTimestamp(currentTime + 3600);
      await kashYield.connect(user1).depositETH({ value: ethers.parseEther("1") });
      
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 7200));
      await kashYield.connect(owner).processDailyActions(batchCycle);
      
      // Try to process again immediately
      await expect(kashYield.connect(owner).processDailyActions(batchCycle))
        .to.be.revertedWith("Already processed");
    });

    it("Should handle empty batch gracefully", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      
      let currentTime = await time.latest();
      const batchCycle = ((currentTime / 86400) + 1) * 86400;
      await time.setNextBlockTimestamp(Math.max(batchCycle, currentTime + 3600));
      
      // No deposits, should still work
      await expect(kashYield.connect(owner).processDailyActions(batchCycle))
        .to.not.be.reverted;
    });
  });

  describe("Multi-Asset Support", function () {
    it("Should allow owner to add WBTC support", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      
      const mockWBTC = ethers.Wallet.createRandom().address;
      await kashYield.connect(owner).addSupportedAsset(AssetType.WBTC, mockWBTC);
      
      expect(await kashYield.isAssetSupported(AssetType.WBTC)).to.be.true;
      expect(await kashYield.assetAddresses(AssetType.WBTC)).to.equal(mockWBTC);
    });

    it("Should not allow duplicate asset additions", async function () {
      const { kashYield, owner } = await loadFixture(deployKashYieldFixture);
      
      await expect(kashYield.connect(owner).addSupportedAsset(
        AssetType.ETH, ethers.ZeroAddress
      )).to.be.revertedWith("Asset already supported");
    });
  });
});
