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

function getTimestampInUserWindow(currentTime) {
  const dayStart = currentTime - (currentTime % 86400);
  return dayStart + 12 * 3600; // Noon — safe in user window
}

function getTimestampInProcessingWindow(currentTime) {
  const dayStart = currentTime - (currentTime % 86400);
  return dayStart + PROCESSING_WINDOW_START + 60; // 23:51
}

function getNextDayTimestamp(currentTime) {
  const dayStart = currentTime - (currentTime % 86400);
  return dayStart + 86400 + 3600; // Next day, 01:00
}

describe("KashYield - Final Version", function () {
  let kashYield, kashToken;
  let owner, user1, user2, bot;
  let mockAavePool, mockUsdc, mockUsdt, mockWeth, mockWbtc;
  let mockEthFeed, mockBtcFeed, mockUsdcFeed, mockUsdtFeed;
  let mockHyperliquid;

  async function deployFixture() {
    [owner, user1, user2, bot] = await ethers.getSigners();

    // Deploy mock tokens
    const MockToken = await ethers.getContractFactory("MockUSDT");

    mockUsdc = await MockToken.deploy(1_000_000);
    mockUsdt = await MockToken.deploy(1_000_000);
    mockWeth = await MockToken.deploy(10_000); // 18 decimals assumed in mock
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

    // Mint tokens to users
    await mockUsdc.mint(user1.address, ethers.parseUnits("10000", 6));
    await mockUsdc.mint(user2.address, ethers.parseUnits("10000", 6));
    await mockUsdt.mint(user1.address, ethers.parseUnits("10000", 6));

    // Pre-fund Aave mock with USDT for borrows (if testing borrow)
    await mockUsdt.mint(mockAavePool.target, ethers.parseUnits("50000", 6));

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
      expect(await kashYield.isSupportedToken(await mockUsdc.getAddress())).to.be.true;
      expect(await kashYield.isSupportedToken(await mockUsdt.getAddress())).to.be.true;
    });
  });

  describe("Time Windows", function () {
    it("Should allow requests in user window", async function () {
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      expect(await kashYield.isUserWindow()).to.be.true;
      expect(await kashYield.isProcessingWindow()).to.be.false;
    });

    it("Should allow processBatch in processing window", async function () {
      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest()));
      await time.mine();

      expect(await kashYield.isUserWindow()).to.be.false;
      expect(await kashYield.isProcessingWindow()).to.be.true;
    });
  });

  describe("Mint Requests", function () {
    it("Should accept ETH deposit", async function () {
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      const amount = ethers.parseEther("2");
      await expect(kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: amount }))
        .to.emit(kashYield, "MintRequested")
        .withArgs(user1.address, ethers.ZeroAddress, amount, anyValue);
    });

    it("Should accept USDC deposit", async function () {
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      const amount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user1).approve(kashYield.target, amount);

      await expect(kashYield.connect(user1).requestMint(await mockUsdc.getAddress(), amount))
        .to.emit(kashYield, "MintRequested")
        .withArgs(user1.address, await mockUsdc.getAddress(), amount, anyValue);
    });

    it("Should reject mint outside user window", async function () {
      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest()));
      await time.mine();

      await expect(
        kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("User window closed");
    });
  });

  describe("Redeem Requests", function () {
    it("Should accept redeem request", async function () {
      // First give user Kash via simulated mint
      await kashToken.mint(user1.address, ethers.parseEther("1000"));

      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

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
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("2") });

      // User2 deposits 1000 USDC
      const usdcAmount = ethers.parseUnits("1000", 6);
      await mockUsdc.connect(user2).approve(kashYield.target, usdcAmount);
      await kashYield.connect(user2).requestMint(await mockUsdc.getAddress(), usdcAmount);

      // User1 redeems 500 Kash (simulate prior mint)
      await kashToken.mint(user1.address, ethers.parseEther("1000"));
      await kashToken.connect(user1).approve(kashYield.target, ethers.parseEther("500"));
      await kashYield.connect(user1).requestRedeem(ethers.parseEther("500"), ethers.ZeroAddress);

      // Move to processing window (next day)
      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest() + 86400));
      await time.mine();

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

      // User1 should have less Kash (burned on redeem) + received ETH back (need contract ETH)
      await owner.sendTransaction({ to: kashYield.target, value: ethers.parseEther("10") });
      // Re-run batch if needed — but in one batch, redeem gets pushed

      // Verify burn
      expect(await kashToken.totalSupply()).to.be.lt(ethers.parseEther("2000"));
    });

    it("Should support Chainlink Automation checkUpkeep", async function () {
      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest()));
      await time.mine();

      const [upkeepNeeded] = await kashYield.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
    });
  });

  describe("Fees", function () {
    it("Should apply 3 bps fee on mint and redeem", async function () {
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      const deposit = ethers.parseUnits("10000", 6);
      await mockUsdc.connect(user1).approve(kashYield.target, deposit);
      await kashYield.connect(user1).requestMint(await mockUsdc.getAddress(), deposit);

      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest() + 86400));
      await time.mine();

      await kashYield.processBatch();

      const expectedKash = ethers.parseEther("10000") * 9997n / 10000n; // 0.03% fee
      expect(await kashToken.balanceOf(user1.address)).to.equal(expectedKash);
    });
  });

  describe("Pause & Emergency Withdraw", function () {
    it("Should pause and allow emergency withdraw", async function () {
      await kashYield.connect(owner).pause();

      // User deposits during pause → should fail
      await expect(
        kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Contract paused");

      // But emergency withdraw works for unprocessed mint
      const deposit = ethers.parseEther("1");
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();
      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: deposit });

      await kashYield.connect(owner).pause();

      const balanceBefore = await ethers.provider.getBalance(user1.address);
      await kashYield.connect(user1).emergencyWithdrawMint(await kashYield.getCurrentBatchCycle());

      const balanceAfter = await ethers.provider.getBalance(user1.address);
      expect(balanceAfter - balanceBefore).to.be.closeTo(deposit, ethers.parseEther("0.01")); // gas diff
    });
  });

  describe("Hyperliquid Events (for off-chain bot)", function () {
    it("Should emit NET_MINT or NET_REDEEM for bot to act on Hyperliquid", async function () {
      await time.setNextBlockTimestamp(getTimestampInUserWindow(await time.latest()));
      await time.mine();

      await kashYield.connect(user1).requestMint(ethers.ZeroAddress, 0, { value: ethers.parseEther("5") });

      await time.setNextBlockTimestamp(getTimestampInProcessingWindow(await time.latest() + 86400));
      await time.mine();

      await expect(kashYield.processBatch())
        .to.emit(kashYield, "ProtocolInteraction")
        .withArgs("NET_MINT", ethers.ZeroAddress, anyValue);
    });
  });
});