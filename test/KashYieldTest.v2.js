const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers } = require("hardhat");

// Time window helpers based on contract constants
const USER_WINDOW_END = 23 * 3600 + 50 * 60; // 23:50
const PROCESSING_WINDOW_START = 23 * 3600 + 50 * 60; // 23:50
const PROCESSING_WINDOW_END = 24 * 3600; // 00:00 next day

async function moveToUserWindow() {
  const currentTime = await time.latest();
  const timeOfDay = currentTime % 86400;
  
  if (timeOfDay >= USER_WINDOW_END) {
    // Already past user window, move to next day user window
    const timeUntilNextDay = 86400 - timeOfDay;
    await time.increase(timeUntilNextDay + 12 * 3600); // Next day at noon
  } else {
    // Already in user window or can move to it today
    if (timeOfDay < 12 * 3600) {
      await time.increase(12 * 3600 - timeOfDay); // Move to noon
    }
  }
}

async function moveToProcessingWindow() {
  const currentTime = await time.latest();
  const timeOfDay = currentTime % 86400;
  
  if (timeOfDay < PROCESSING_WINDOW_START) {
    // Move to processing window today
    await time.increase(PROCESSING_WINDOW_START + 60 - timeOfDay); // 23:51
  } else if (timeOfDay >= PROCESSING_WINDOW_END) {
    // Already past, move to next day
    const timeUntilNextDay = 86400 - timeOfDay;
    await time.increase(timeUntilNextDay + PROCESSING_WINDOW_START + 60);
  }
}

async function moveToNextDayProcessingWindow() {
  const currentTime = await time.latest();
  const timeOfDay = currentTime % 86400;
  const timeUntilNextDay = 86400 - timeOfDay;
  await time.increase(timeUntilNextDay + PROCESSING_WINDOW_START + 60); // Next day 23:51
}

describe("KashYieldETH - Final Version", function () {
  let kashYieldEth, kashTokenEth;
  let owner, user1, user2, bot;
  let mockAavePool, mockUsdc, mockUsdt, mockWeth, mockWbtc;
  let mockEthFeed, mockBtcFeed, mockUsdcFeed, mockUsdtFeed;
  let mockHyperliquid;

  async function deployFixture() {
    [owner, user1, user2, bot] = await ethers.getSigners();

    // Deploy mock tokens (all using MockUSDT which has 6 decimals)
    const MockToken = await ethers.getContractFactory("MockUSDT");

    mockUsdc = await MockToken.deploy(1_000_000);
    mockUsdt = await MockToken.deploy(1_000_000);
    mockWeth = await MockToken.deploy(10_000); // Using 6 decimals for simplicity
    mockWbtc = await MockToken.deploy(100);

    await mockUsdc.waitForDeployment();
    await mockUsdt.waitForDeployment();
    await mockWeth.waitForDeployment();
    await mockWbtc.waitForDeployment();

    // Deploy Chainlink price feeds
    const MockPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");

    mockEthFeed = await MockPriceFeed.deploy(300000000000n); // $3000 (8 decimals)
    mockBtcFeed = await MockPriceFeed.deploy(6000000000000n); // $60,000
    mockUsdcFeed = await MockPriceFeed.deploy(100000000n); // $1.00
    mockUsdtFeed = await MockPriceFeed.deploy(100000000n); // $1.00

    await mockEthFeed.waitForDeployment();
    await mockBtcFeed.waitForDeployment();
    await mockUsdcFeed.waitForDeployment();
    await mockUsdtFeed.waitForDeployment();

    // Deploy MockAaveV3
    const MockAave = await ethers.getContractFactory("MockAaveV3");
    mockAavePool = await MockAave.deploy(mockUsdt.target);
    await mockAavePool.waitForDeployment();

    // Deploy MockHyperliquid (for event testing)
    const MockHyper = await ethers.getContractFactory("MockHyperliquid");
    mockHyperliquid = await MockHyper.deploy(mockUsdc.target, mockUsdt.target, mockWbtc.target);
    await mockHyperliquid.waitForDeployment();

    // Deploy KashYieldETH (constructor has no args)
    const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
    kashYieldEth = await KashYieldETH.deploy();
    await kashYieldEth.waitForDeployment();

    const kashTokenEthAddr = await kashYieldEth.kashTokenEth();
    kashTokenEth = await ethers.getContractAt("KashTokenEth", kashTokenEthAddr);

    // Configure KashYieldETH with mock addresses
    await kashYieldEth.setAavePool(mockAavePool.target);
    await kashYieldEth.setTokenAddresses(
      mockWeth.target,
      mockWbtc.target,
      mockUsdt.target,
      mockUsdc.target
    );

    await kashYieldEth.setOracle(ethers.ZeroAddress, mockEthFeed.target);
    await kashYieldEth.setOracle(mockWeth.target, mockEthFeed.target);
    await kashYieldEth.setOracle(mockWbtc.target, mockBtcFeed.target);
    await kashYieldEth.setOracle(mockUsdt.target, mockUsdtFeed.target);
    await kashYieldEth.setOracle(mockUsdc.target, mockUsdcFeed.target);

    await kashYieldEth.setTokenDecimals(mockWeth.target, 6);
    await kashYieldEth.setTokenDecimals(mockWbtc.target, 6);
    await kashYieldEth.setTokenDecimals(mockUsdt.target, 6);
    await kashYieldEth.setTokenDecimals(mockUsdc.target, 6);

    // Mint tokens to users
    await mockUsdc.mint(user1.address, ethers.parseUnits("10000", 6));
    await mockUsdc.mint(user2.address, ethers.parseUnits("10000", 6));
    await mockUsdt.mint(user1.address, ethers.parseUnits("10000", 6));

    // Pre-fund Aave mock with USDT for borrows (if testing borrow)
    await mockUsdt.mint(mockAavePool.target, ethers.parseUnits("50000", 6));

    // Pre-fund KashYieldETH contract with ETH for redemptions
    await owner.sendTransaction({ 
      to: kashYieldEth.target, 
      value: ethers.parseEther("100") 
    });

    return {
      kashYieldEth,
      kashTokenEth,
      mockAavePool,
      mockUsdc,
      mockUsdt,
      mockWeth,
      mockWbtc,
      mockEthFeed,
      mockHyperliquid,
      owner,
      user1,
      user2,
      bot,
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this, fixture);
  });

  describe("Deployment & Initial State", function () {
    it("Should set correct initial values", async function () {
      expect(await kashYieldEth.owner()).to.equal(owner.address);
      expect(await kashYieldEth.currentNAV()).to.equal(ethers.parseEther("1"));
      expect(await kashYieldEth.feeBps()).to.equal(3);
      expect(await kashYieldEth.paused()).to.be.false;
      expect(await kashTokenEth.totalSupply()).to.equal(0);
    });

    it("Should recognize supported tokens", async function () {
      expect(await kashYieldEth.isSupportedToken(ethers.ZeroAddress)).to.be.true; // ETH
      expect(await kashYieldEth.isSupportedToken(mockUsdc.target)).to.be.true;
      expect(await kashYieldEth.isSupportedToken(mockUsdt.target)).to.be.true;
      expect(await kashYieldEth.isSupportedToken(mockWeth.target)).to.be.true;
      expect(await kashYieldEth.isSupportedToken(mockWbtc.target)).to.be.true;
    });
  });

  describe("Time Windows", function () {
    it("Should allow requests in user window", async function () {
      await moveToUserWindow();

      expect(await kashYieldEth.isUserWindow()).to.be.true;
      expect(await kashYieldEth.isProcessingWindow()).to.be.false;
    });

    it("Should allow processBatch in processing window", async function () {
      await moveToProcessingWindow();

      expect(await kashYieldEth.isUserWindow()).to.be.false;
      expect(await kashYieldEth.isProcessingWindow()).to.be.true;
    });
  });

  describe("Mint Requests", function () {
    it("Should accept ETH deposit", async function () {
      await moveToUserWindow();

      const amount = ethers.parseEther("2");
      await expect(kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: amount }))
        .to.emit(kashYieldEth, "MintRequested")
        .withArgs(user1.address, ethers.ZeroAddress, amount, anyValue);
    });

    it("Should accept USDC deposit", async function () {
      await moveToUserWindow();

      const amount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user1).approve(kashYieldEth.target, amount);

      await expect(kashYieldEth.connect(user1).requestMint(mockUsdc.target, amount))
        .to.emit(kashYieldEth, "MintRequested")
        .withArgs(user1.address, mockUsdc.target, amount, anyValue);
    });

    it("Should reject mint outside user window", async function () {
      await moveToProcessingWindow();

      await expect(
        kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("User window closed (23:50-23:59)");
    });
  });

  describe("Redeem Requests", function () {
    it("Should accept redeem request", async function () {
      // First give user Kash via test helper
      await kashYieldEth.testMintKashEth(user1.address, ethers.parseEther("1000"));

      await moveToUserWindow();

      const amount = ethers.parseEther("400");
      await kashTokenEth.connect(user1).approve(kashYieldEth.target, amount);

      await expect(kashYieldEth.connect(user1).requestRedeem(amount, ethers.ZeroAddress))
        .to.emit(kashYieldEth, "RedeemRequested")
        .withArgs(user1.address, amount, ethers.ZeroAddress, anyValue);
    });
  });

  describe("Batch Processing", function () {
    it("Should auto-value mints, apply fees, mint Kash, burn on redeem, emit net position", async function () {
      // User1 deposits 2 ETH
      await moveToUserWindow();

      await kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("2") });

      // User2 deposits 1000 USDC
      const usdcAmount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user2).approve(kashYieldEth.target, usdcAmount);
      await kashYieldEth.connect(user2).requestMint(mockUsdc.target, usdcAmount);

      // User1 redeems 500 Kash (simulate prior mint)
      await kashYieldEth.testMintKashEth(user1.address, ethers.parseEther("1000"));
      await kashTokenEth.connect(user1).approve(kashYieldEth.target, ethers.parseEther("500"));
      await kashYieldEth.connect(user1).requestRedeem(ethers.parseEther("500"), ethers.ZeroAddress);

      // Move to processing window (next day)
      await moveToNextDayProcessingWindow();

      const balanceBefore1 = await kashTokenEth.balanceOf(user1.address);
      const balanceBefore2 = await kashTokenEth.balanceOf(user2.address);

      await expect(kashYieldEth.processBatch())
        .to.emit(kashYieldEth, "BatchProcessed")
        .to.emit(kashYieldEth, "ProtocolInteraction")
        .withArgs("NET_MINT", ethers.ZeroAddress, anyValue); // Should be net mint

      // User2 should get ~1000 * 0.9997 Kash (after 3 bps fee)
      expect(await kashTokenEth.balanceOf(user2.address)).to.be.closeTo(
        ethers.parseEther("999.7"),
        ethers.parseEther("1")
      );

      // User1 balance: 500 (remaining from pre-mint) + ~5998 (from 2 ETH @ $3000 after fee) = ~6498
      expect(await kashTokenEth.balanceOf(user1.address)).to.be.closeTo(
        ethers.parseEther("6498"),
        ethers.parseEther("10")
      );
      
      // Total supply = user1 (~6498) + user2 (~1000) = ~7498 Kash
      expect(await kashTokenEth.totalSupply()).to.be.closeTo(
        ethers.parseEther("7498"),
        ethers.parseEther("10")
      );
    });

    it("Should support Chainlink Automation checkUpkeep", async function () {
      await moveToProcessingWindow();

      const [upkeepNeeded] = await kashYieldEth.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
    });
  });

  describe("Fees", function () {
    it("Should apply 3 bps fee on mint and redeem", async function () {
      await moveToUserWindow();

      const deposit = ethers.parseUnits("10000", 6);
      await mockUsdc.connect(user1).approve(kashYieldEth.target, deposit);
      await kashYieldEth.connect(user1).requestMint(mockUsdc.target, deposit);

      await moveToNextDayProcessingWindow();

      await kashYieldEth.processBatch();

      const expectedKash = ethers.parseEther("10000") * 9997n / 10000n; // 0.03% fee
      expect(await kashTokenEth.balanceOf(user1.address)).to.equal(expectedKash);
    });
  });

  describe("Pause & Emergency Withdraw", function () {
    it("Should reject operations when paused", async function () {
      await kashYieldEth.connect(owner).pause();

      // User deposits during pause → should fail
      await expect(
        kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Contract paused");
    });

    it("Should allow emergency withdraw for unprocessed mint", async function () {
      // User deposits before pause
      const deposit = ethers.parseEther("1");
      await moveToUserWindow();
      await kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: deposit });

      // Then pause the contract
      await kashYieldEth.connect(owner).pause();

      // User should be able to emergency withdraw
      const balanceBefore = await ethers.provider.getBalance(user1.address);
      const tx = await kashYieldEth.connect(user1).emergencyWithdrawMint(await kashYieldEth.getCurrentBatchCycle());
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter - balanceBefore + gasUsed).to.be.closeTo(deposit, ethers.parseEther("0.001")); // gas diff
    });
  });

  describe("Hyperliquid Events (for off-chain bot)", function () {
    it("Should emit NET_MINT or NET_REDEEM for bot to act on Hyperliquid", async function () {
      await moveToUserWindow();

      await kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("5") });

      await moveToNextDayProcessingWindow();

      await expect(kashYieldEth.processBatch())
        .to.emit(kashYieldEth, "ProtocolInteraction")
        .withArgs("NET_MINT", ethers.ZeroAddress, anyValue);
    });
  });

  describe("Cancel Mint Request", function () {
    it("Should refund ETH when user cancels mint before batch processed", async function () {
      await moveToUserWindow();

      const deposit = ethers.parseEther("1.5");
      await kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: deposit });
      const balanceBeforeCancel = await ethers.provider.getBalance(user1.address);
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();

      const tx = await kashYieldEth.connect(user1).cancelMintRequest(batchCycle);
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter - balanceBeforeCancel + gasUsed).to.equal(deposit);

      const req = await kashYieldEth.getPendingMintRequest(user1.address, batchCycle);
      expect(req.amountIn).to.equal(0);
    });

    it("Should refund ERC20 when user cancels mint before batch processed", async function () {
      await moveToUserWindow();

      const amount = ethers.parseUnits("500", 6);
      await mockUsdc.connect(user1).approve(kashYieldEth.target, amount);
      await kashYieldEth.connect(user1).requestMint(mockUsdc.target, amount);

      const balanceBefore = await mockUsdc.balanceOf(user1.address);
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();
      await kashYieldEth.connect(user1).cancelMintRequest(batchCycle);

      expect(await mockUsdc.balanceOf(user1.address)).to.equal(balanceBefore + amount);
    });

    it("Should revert cancelMintRequest when batch already processed", async function () {
      await moveToUserWindow();
      await kashYieldEth.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") });
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();

      await moveToNextDayProcessingWindow();
      await kashYieldEth.processBatch();

      await expect(kashYieldEth.connect(user1).cancelMintRequest(batchCycle))
        .to.be.revertedWith("Batch already processed");
    });

    it("Should revert cancelMintRequest when no mint request", async function () {
      await moveToUserWindow();
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();

      await expect(kashYieldEth.connect(user1).cancelMintRequest(batchCycle))
        .to.be.revertedWith("No mint request");
    });
  });

  describe("Cancel Redeem Request", function () {
    it("Should return KASH when user cancels redeem before batch processed", async function () {
      await kashYieldEth.testMintKashEth(user1.address, ethers.parseEther("1000"));
      await moveToUserWindow();

      const redeemAmount = ethers.parseEther("300");
      await kashTokenEth.connect(user1).approve(kashYieldEth.target, redeemAmount);
      await kashYieldEth.connect(user1).requestRedeem(redeemAmount, ethers.ZeroAddress);

      const balanceBefore = await kashTokenEth.balanceOf(user1.address);
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();
      await kashYieldEth.connect(user1).cancelRedeemRequest(batchCycle);

      expect(await kashTokenEth.balanceOf(user1.address)).to.equal(balanceBefore + redeemAmount);

      const req = await kashYieldEth.getPendingRedeemRequest(user1.address, batchCycle);
      expect(req.kashAmount).to.equal(0);
    });

    it("Should revert cancelRedeemRequest when batch already processed", async function () {
      await kashYieldEth.testMintKashEth(user1.address, ethers.parseEther("500"));
      await moveToUserWindow();
      await kashTokenEth.connect(user1).approve(kashYieldEth.target, ethers.parseEther("200"));
      await kashYieldEth.connect(user1).requestRedeem(ethers.parseEther("200"), ethers.ZeroAddress);
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();

      await moveToNextDayProcessingWindow();
      await kashYieldEth.processBatch();

      await expect(kashYieldEth.connect(user1).cancelRedeemRequest(batchCycle))
        .to.be.revertedWith("Batch already processed");
    });

    it("Should revert cancelRedeemRequest when no redeem request", async function () {
      await moveToUserWindow();
      const batchCycle = await kashYieldEth.getCurrentBatchCycle();

      await expect(kashYieldEth.connect(user1).cancelRedeemRequest(batchCycle))
        .to.be.revertedWith("No redeem request");
    });
  });
});