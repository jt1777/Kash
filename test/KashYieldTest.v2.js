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

describe("KashYield - Final Version", function () {
  let kashYield, kashToken;
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

    // Deploy KashYield (constructor has no args now)
    const KashYield = await ethers.getContractFactory("KashYield");
    kashYield = await KashYield.deploy();
    await kashYield.waitForDeployment();

    const kashTokenAddr = await kashYield.kashToken();
    kashToken = await ethers.getContractAt("Kash", kashTokenAddr);

    // Configure KashYield with mock addresses
    await kashYield.setAavePool(mockAavePool.target);
    await kashYield.setTokenAddresses(
      mockWeth.target,
      mockWbtc.target,
      mockUsdt.target,
      mockUsdc.target
    );

    // Set oracles for all supported tokens
    await kashYield.setOracle(ethers.ZeroAddress, mockEthFeed.target); // ETH
    await kashYield.setOracle(mockWeth.target, mockEthFeed.target);
    await kashYield.setOracle(mockWbtc.target, mockBtcFeed.target);
    await kashYield.setOracle(mockUsdt.target, mockUsdtFeed.target);
    await kashYield.setOracle(mockUsdc.target, mockUsdcFeed.target);

    // Set token decimals (all mock tokens use 6 decimals)
    await kashYield.setTokenDecimals(mockWeth.target, 6);
    await kashYield.setTokenDecimals(mockWbtc.target, 6);
    await kashYield.setTokenDecimals(mockUsdt.target, 6);
    await kashYield.setTokenDecimals(mockUsdc.target, 6);

    // Mint tokens to users
    await mockUsdc.mint(user1.address, ethers.parseUnits("10000", 6));
    await mockUsdc.mint(user2.address, ethers.parseUnits("10000", 6));
    await mockUsdt.mint(user1.address, ethers.parseUnits("10000", 6));

    // Pre-fund Aave mock with USDT for borrows (if testing borrow)
    await mockUsdt.mint(mockAavePool.target, ethers.parseUnits("50000", 6));

    // Pre-fund KashYield contract with ETH for redemptions
    await owner.sendTransaction({ 
      to: kashYield.target, 
      value: ethers.parseEther("100") 
    });

    return {
      kashYield,
      kashToken,
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
      expect(await kashYield.owner()).to.equal(owner.address);
      expect(await kashYield.currentNAV()).to.equal(ethers.parseEther("1"));
      expect(await kashYield.feeBps()).to.equal(3);
      expect(await kashYield.paused()).to.be.false;
      expect(await kashToken.totalSupply()).to.equal(0);
    });

    it("Should recognize supported tokens", async function () {
      expect(await kashYield.isSupportedToken(ethers.ZeroAddress)).to.be.true; // ETH
      expect(await kashYield.isSupportedToken(mockUsdc.target)).to.be.true;
      expect(await kashYield.isSupportedToken(mockUsdt.target)).to.be.true;
      expect(await kashYield.isSupportedToken(mockWeth.target)).to.be.true;
      expect(await kashYield.isSupportedToken(mockWbtc.target)).to.be.true;
    });
  });

  describe("Time Windows", function () {
    it("Should allow requests in user window", async function () {
      await moveToUserWindow();

      expect(await kashYield.isUserWindow()).to.be.true;
      expect(await kashYield.isProcessingWindow()).to.be.false;
    });

    it("Should allow processBatch in processing window", async function () {
      await moveToProcessingWindow();

      expect(await kashYield.isUserWindow()).to.be.false;
      expect(await kashYield.isProcessingWindow()).to.be.true;
    });
  });

  describe("Mint Requests", function () {
    it("Should accept ETH deposit", async function () {
      await moveToUserWindow();

      const amount = ethers.parseEther("2");
      await expect(kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: amount }))
        .to.emit(kashYield, "MintRequested")
        .withArgs(user1.address, ethers.ZeroAddress, amount, anyValue);
    });

    it("Should accept USDC deposit", async function () {
      await moveToUserWindow();

      const amount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user1).approve(kashYield.target, amount);

      await expect(kashYield.connect(user1).requestMint(mockUsdc.target, amount))
        .to.emit(kashYield, "MintRequested")
        .withArgs(user1.address, mockUsdc.target, amount, anyValue);
    });

    it("Should reject mint outside user window", async function () {
      await moveToProcessingWindow();

      await expect(
        kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("User window closed (23:50-23:59)");
    });
  });

  describe("Redeem Requests", function () {
    it("Should accept redeem request", async function () {
      // First give user Kash via test helper
      await kashYield.testMintKash(user1.address, ethers.parseEther("1000"));

      await moveToUserWindow();

      const amount = ethers.parseEther("400");
      await kashToken.connect(user1).approve(kashYield.target, amount);

      await expect(kashYield.connect(user1).requestRedeem(amount, ethers.ZeroAddress))
        .to.emit(kashYield, "RedeemRequested")
        .withArgs(user1.address, amount, ethers.ZeroAddress, anyValue);
    });
  });

  describe("Batch Processing", function () {
    it("Should auto-value mints, apply fees, mint Kash, burn on redeem, emit net position", async function () {
      // User1 deposits 2 ETH
      await moveToUserWindow();

      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("2") });

      // User2 deposits 1000 USDC
      const usdcAmount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user2).approve(kashYield.target, usdcAmount);
      await kashYield.connect(user2).requestMint(mockUsdc.target, usdcAmount);

      // User1 redeems 500 Kash (simulate prior mint)
      await kashYield.testMintKash(user1.address, ethers.parseEther("1000"));
      await kashToken.connect(user1).approve(kashYield.target, ethers.parseEther("500"));
      await kashYield.connect(user1).requestRedeem(ethers.parseEther("500"), ethers.ZeroAddress);

      // Move to processing window (next day)
      await moveToNextDayProcessingWindow();

      const balanceBefore1 = await kashToken.balanceOf(user1.address);
      const balanceBefore2 = await kashToken.balanceOf(user2.address);

      await expect(kashYield.processBatch())
        .to.emit(kashYield, "BatchProcessed")
        .to.emit(kashYield, "ProtocolInteraction")
        .withArgs("NET_MINT", ethers.ZeroAddress, anyValue); // Should be net mint

      // User2 should get ~1000 * 0.9997 Kash (after 3 bps fee)
      expect(await kashToken.balanceOf(user2.address)).to.be.closeTo(
        ethers.parseEther("999.7"),
        ethers.parseEther("1")
      );

      // User1 balance: 500 (remaining from pre-mint) + ~5998 (from 2 ETH @ $3000 after fee) = ~6498
      expect(await kashToken.balanceOf(user1.address)).to.be.closeTo(
        ethers.parseEther("6498"),
        ethers.parseEther("10")
      );
      
      // Total supply = user1 (~6498) + user2 (~1000) = ~7498 Kash
      expect(await kashToken.totalSupply()).to.be.closeTo(
        ethers.parseEther("7498"),
        ethers.parseEther("10")
      );
    });

    it("Should support Chainlink Automation checkUpkeep", async function () {
      await moveToProcessingWindow();

      const [upkeepNeeded] = await kashYield.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
    });
  });

  describe("Fees", function () {
    it("Should apply 3 bps fee on mint and redeem", async function () {
      await moveToUserWindow();

      const deposit = ethers.parseUnits("10000", 6);
      await mockUsdc.connect(user1).approve(kashYield.target, deposit);
      await kashYield.connect(user1).requestMint(mockUsdc.target, deposit);

      await moveToNextDayProcessingWindow();

      await kashYield.processBatch();

      const expectedKash = ethers.parseEther("10000") * 9997n / 10000n; // 0.03% fee
      expect(await kashToken.balanceOf(user1.address)).to.equal(expectedKash);
    });
  });

  describe("Pause & Emergency Withdraw", function () {
    it("Should reject operations when paused", async function () {
      await kashYield.connect(owner).pause();

      // User deposits during pause → should fail
      await expect(
        kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Contract paused");
    });

    it("Should allow emergency withdraw for unprocessed mint", async function () {
      // User deposits before pause
      const deposit = ethers.parseEther("1");
      await moveToUserWindow();
      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: deposit });

      // Then pause the contract
      await kashYield.connect(owner).pause();

      // User should be able to emergency withdraw
      const balanceBefore = await ethers.provider.getBalance(user1.address);
      const tx = await kashYield.connect(user1).emergencyWithdrawMint(await kashYield.getCurrentBatchCycle());
      const receipt = await tx.wait();
      const gasUsed = receipt.gasUsed * receipt.gasPrice;

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter - balanceBefore + gasUsed).to.be.closeTo(deposit, ethers.parseEther("0.001")); // gas diff
    });
  });

  describe("Hyperliquid Events (for off-chain bot)", function () {
    it("Should emit NET_MINT or NET_REDEEM for bot to act on Hyperliquid", async function () {
      await moveToUserWindow();

      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("5") });

      await moveToNextDayProcessingWindow();

      await expect(kashYield.processBatch())
        .to.emit(kashYield, "ProtocolInteraction")
        .withArgs("NET_MINT", ethers.ZeroAddress, anyValue);
    });
  });
});