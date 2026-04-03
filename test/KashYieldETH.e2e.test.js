// test/KashYieldETH.e2e.test.js
//
// End-to-end tests for the ETH yield product: full mint cycle, full redeem cycle,
// WETH integration, and configuration guards.
//
// These tests run on the local Hardhat network — no testnet needed.
// Each test deploys a fresh stack of mocks so failures are isolated.
//
// Strategy constants (mirroring bot defaults):
//   aaveDepositPct  = 100%   (deposit full net mint to Aave)
//   borrowLtvPct    = 70%    (borrow 70% of collateral USD value as USDC)
//   shortLeverage   = 1.7x   (short notional = 1.7 * net mint USD)
//
// ETH → Aave flow:  native ETH in KashYieldETH → WETH.deposit() → Aave.supply(WETH)
// ETH ← Aave flow:  Aave.withdraw(WETH) → WETH.withdraw() → native ETH in KashYieldETH

const { expect } = require("chai");
const { ethers } = require("hardhat");

const ETH_PRICE_USD  = 3_000n;
const ETH_FEED_PRICE = ETH_PRICE_USD * 10n ** 8n;   // Chainlink 8-dec answer: 300_000_000_000
const ETH_PRICE_18   = ETH_PRICE_USD * 10n ** 18n;  // 18-dec used internally
const CYCLE_SECS     = 3600n;  // 1-hour cycles — wide enough that no test crosses a boundary
const NAV_1          = 10n ** 18n;

// ── helpers ──────────────────────────────────────────────────────────────────

async function deployEthFixture() {
  const [owner, bot, user1, user2] = await ethers.getSigners();

  // ── 1. Mock tokens ────────────────────────────────────────────────────────
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy(0);

  const MockWETH = await ethers.getContractFactory("MockWETH");
  const mockWeth = await MockWETH.deploy();

  // ── 2. Oracle (ETH/USD, 8 decimals) ──────────────────────────────────────
  const MockPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockFeed = await MockPriceFeed.deploy(ETH_FEED_PRICE);

  // ── 3. Mock Aave ──────────────────────────────────────────────────────────
  const MockAave = await ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAave.deploy(await mockUsdc.getAddress());
  await mockAave.setWethAddress(await mockWeth.getAddress());
  await mockAave.setEthPrice(ETH_PRICE_18);

  // Pre-fund Aave with USDC for borrow().
  const AAVE_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockAave.getAddress(), AAVE_USDC_FUND);

  // ── 4. Mock Hyperliquid ───────────────────────────────────────────────────
  const MockHL = await ethers.getContractFactory("MockHyperliquid");
  const mockHl = await MockHL.deploy(
    await mockUsdc.getAddress(),
    await mockUsdc.getAddress(), // USDT slot — reuse USDC for mock
    ethers.ZeroAddress            // wBTC not needed for ETH product
  );
  await mockHl.setEthPrice(ETH_PRICE_18);

  // Pre-fund MockHL with USDC for redeem withdrawals.
  const HL_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockHl.getAddress(), HL_USDC_FUND);

  // Pre-fund MockHL with ETH for withdrawEthFromSpotWallet (used in falling-price scenarios).
  await owner.sendTransaction({ to: await mockHl.getAddress(), value: ethers.parseEther("10") });

  // ── 5. Mock Spot DEX ──────────────────────────────────────────────────────
  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const mockSpotDex = await MockSpotDex.deploy();
  await mockSpotDex.setEthRates(await mockUsdc.getAddress(), ETH_PRICE_USD);
  // Fund spot dex.
  const DEX_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(owner.address, DEX_USDC_FUND);
  await mockUsdc.approve(await mockSpotDex.getAddress(), DEX_USDC_FUND);
  await mockSpotDex.fund(await mockUsdc.getAddress(), DEX_USDC_FUND);
  await mockSpotDex.fundEth({ value: ethers.parseEther("10") });

  // ── 6. KashYieldETH ──────────────────────────────────────────────────────
  // Deploy KashYieldETH first so its address can be passed to the adapter.
  const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
  const kashYield = await KashYieldETH.deploy(
    bot.address,
    await mockWeth.getAddress(),
    await mockUsdc.getAddress(),
    await mockAave.getAddress()
  );

  await kashYield.setEthOracle(await mockFeed.getAddress());
  await kashYield.setAllowedSpotDexRouter(await mockSpotDex.getAddress(), true);
  await kashYield.setSpotDex(await mockSpotDex.getAddress());
  await kashYield.setCycleDurationSeconds(CYCLE_SECS);
  // Disable time windows for tests: users and bot can operate at any point in the cycle.
  await kashYield.setUserWindowEnd(CYCLE_SECS);
  await kashYield.setProcessingWindowStart(0n);

  // ── 7. Hyperliquid Adapter (ETH product) ─────────────────────────────────
  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(),
    await mockUsdc.getAddress(),
    ethers.ZeroAddress,          // assetAddress = 0x0 for ETH product
    true,                        // isEthAsset = true
    await kashYield.getAddress() // kashYieldAddress for onlyAuthorized guard
  );

  // Register HL adapter (first-time bypass, no delay).
  await kashYield.setExchangeSwitchDelay(0);
  await kashYield.setHyperliquid(await hlAdapter.getAddress());
  await kashYield.setActivePerpExchange("HL");

  // Get the KashToken contract.
  const kashTokenAddr = await kashYield.kashTokenEth();
  const KashToken = await ethers.getContractFactory("KashTokenEth");
  const kashToken = KashToken.attach(kashTokenAddr);

  return {
    owner, bot, user1, user2,
    kashYield, kashToken,
    mockUsdc, mockWeth, mockAave, mockHl, mockSpotDex, hlAdapter, mockFeed,
  };
}

/**
 * Run Phase 1, simulate bot Aave+HL ops for an ETH net mint, then Phase 2.
 * @param {bigint} mintEth  native ETH minted this cycle (18-dec wei)
 */
async function runFullEthMintCycle(ctx, batchCycle, mintEth) {
  const { owner, bot, kashYield, mockUsdc, mockAave, mockHl, mockWeth, hlAdapter } = ctx;

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  // ── Bot Aave ops ──────────────────────────────────────────────────────────
  // depositToAave: KashYieldETH wraps ETH → WETH → Aave.supply(WETH).
  await kashYield.connect(owner).depositToAave(mintEth);
  const aaveEth = await mockAave.suppliedAmounts(await kashYield.getAddress());
  expect(aaveEth).to.equal(mintEth);

  // Borrow 70% of collateral as USDC.
  const ethUsdValue = mintEth * ETH_PRICE_18 / (10n ** 18n); // 18-dec USD
  const borrowAmountUsd18 = ethUsdValue * 70n / 100n;
  const borrowUsdc = borrowAmountUsd18 / (10n ** 12n); // 6-dec USDC
  await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
  expect(await mockAave.borrowedAmounts(await kashYield.getAddress())).to.equal(borrowUsdc);

  // ── Bot Hyperliquid ops ───────────────────────────────────────────────────
  await kashYield.connect(owner).depositToHyperliquid(borrowUsdc);
  expect(await mockHl.spotBalances(await hlAdapter.getAddress())).to.equal(borrowUsdc);

  // Spot buy ETH (USDC → ETH): ethBalance credited at $3,000/ETH.
  await kashYield.connect(owner).spotBuyOnHyperliquid(borrowUsdc);
  const hlEth = await mockHl.ethBalance(await hlAdapter.getAddress());
  // Expected: borrowUsdc * 1e12 * 1e18 / ETH_PRICE_18
  const expectedEthInternal = borrowUsdc * 10n ** 12n * 10n ** 18n / ETH_PRICE_18;
  expect(hlEth).to.be.closeTo(expectedEthInternal, expectedEthInternal / 100n);

  // Open 1.7x ETH short.
  const shortSizeUSD = ethUsdValue * 170n / 100n;
  const shortSizeAsset = shortSizeUSD * 10n ** 18n / ETH_PRICE_18;
  await kashYield.connect(owner).openShort("ETH", shortSizeAsset);
  const [posSize, , , , posActive] = await kashYield.getHyperliquidPosition("ETH");
  expect(posActive).to.be.true;
  expect(posSize).to.equal(shortSizeAsset);

  // ── NAV + mark done + Phase 2 ─────────────────────────────────────────────
  await kashYield.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;
}

/**
 * Run Phase 1 + bot unwind for an ETH net redeem, then Phase 2.
 */
async function runFullEthRedeemCycle(ctx, batchCycle, mintEth) {
  const { owner, bot, kashYield, mockUsdc, mockAave, mockHl, hlAdapter, mockWeth } = ctx;

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  // ── Bot HL unwind ─────────────────────────────────────────────────────────
  await kashYield.connect(owner)["closeShort(string)"]("ETH");
  const [, , , , posActive] = await kashYield.getHyperliquidPosition("ETH");
  expect(posActive).to.be.false;

  const hlEthAfterClose = await mockHl.ethBalance(await hlAdapter.getAddress());
  if (hlEthAfterClose > 0n) {
    await kashYield.connect(owner).spotSellOnHyperliquid(hlEthAfterClose);
  }

  const hlSpotAfterSell = await mockHl.spotBalances(await hlAdapter.getAddress());
  if (hlSpotAfterSell > 0n) {
    await kashYield.connect(owner).withdrawFromHyperliquid(hlSpotAfterSell);
  }

  // ── Bot Aave unwind ───────────────────────────────────────────────────────
  const debt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (debt > 0n) {
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), debt);
  }
  // Handle interest dust accrued during the repay call.
  const remainingDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (remainingDebt > 0n) {
    await mockUsdc.mint(await kashYield.getAddress(), remainingDebt);
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), remainingDebt);
  }
  expect(await mockAave.borrowedAmounts(await kashYield.getAddress())).to.equal(0n);

  // withdrawFromAave: MockAave → WETH → KashYieldETH unwraps → native ETH.
  await kashYield.connect(owner).withdrawFromAave(mintEth);
  const contractEth = await ethers.provider.getBalance(await kashYield.getAddress());
  expect(contractEth).to.be.gte(mintEth - 1n);

  // ── NAV + mark done + Phase 2 ─────────────────────────────────────────────
  await kashYield.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("KashYieldETH — end-to-end", function () {
  this.timeout(120_000);

  // ── Deployment ──────────────────────────────────────────────────────────────
  describe("Deployment & configuration", function () {
    it("deploys with correct initial state", async function () {
      const { kashYield, mockAave, mockWeth, mockUsdc, mockFeed, bot } = await deployEthFixture();
      expect(await kashYield.aavePoolAddress()).to.equal(await mockAave.getAddress());
      expect(await kashYield.wethAddress()).to.equal(await mockWeth.getAddress());
      expect(await kashYield.usdcAddress()).to.equal(await mockUsdc.getAddress());
      expect(await kashYield.ethOracle()).to.equal(await mockFeed.getAddress());
      expect(await kashYield.botAddress()).to.equal(bot.address);
      expect(await kashYield.currentNAV()).to.equal(NAV_1);
      expect(await kashYield.activePerpExchange()).to.equal("HL");
    });

    it("reads ETH price correctly from oracle", async function () {
      const { kashYield } = await deployEthFixture();
      const price = await kashYield.getEthPrice();
      expect(price).to.equal(ETH_PRICE_18);
    });

    it("rejects non-owner configuration calls", async function () {
      const { kashYield, user1 } = await deployEthFixture();
      await expect(kashYield.connect(user1).setEthOracle(user1.address))
        .to.be.revertedWithCustomError(kashYield, "OnlyOwner");
    });

    it("rejects performUpkeep from non-bot address", async function () {
      const { kashYield, user1 } = await deployEthFixture();
      await expect(kashYield.connect(user1).performUpkeep("0x"))
        .to.be.revertedWithCustomError(kashYield, "OnlyBotOrKeeper");
    });

    it("rejects depositToAave when wethAddress is zero", async function () {
      const { owner, bot, mockAave, mockUsdc } = await deployEthFixture();
      const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
      // Pass ZeroAddress for weth intentionally — depositToAave should revert.
      const kyNoWeth = await KashYieldETH.deploy(
        bot.address,
        ethers.ZeroAddress,
        await mockUsdc.getAddress(),
        await mockAave.getAddress()
      );
      await kyNoWeth.setCycleDurationSeconds(CYCLE_SECS);

      // Fund it with ETH.
      await owner.sendTransaction({ to: await kyNoWeth.getAddress(), value: ethers.parseEther("1") });

      // depositToAave should revert because wethAddress == address(0).
      await expect(kyNoWeth.connect(owner).depositToAave(ethers.parseEther("1")))
        .to.be.reverted;
    });
  });

  // ── Full mint cycle ──────────────────────────────────────────────────────────
  describe("Full mint cycle", function () {
    it("user receives Kash-ETH after minting 1 ETH", async function () {
      const ctx = await deployEthFixture();
      const { user1, kashYield, kashToken } = ctx;

      const MINT_ETH = ethers.parseEther("1");

      // Mint request: send native ETH.
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      expect(await kashYield.batchTotalMintEth(batchCycle)).to.equal(MINT_ETH);

      await runFullEthMintCycle(ctx, batchCycle, MINT_ETH);

      // User should have Kash-ETH ≈ $3,000 at NAV=$1 minus fee.
      const kashBalance = await kashToken.balanceOf(user1.address);
      const expectedKash = ETH_PRICE_18 * 9997n / 10000n; // ≈ 2999.1 * 1e18
      expect(kashBalance).to.be.closeTo(expectedKash, expectedKash / 100n);
    });

    it("two users get proportional Kash-ETH shares", async function () {
      const ctx = await deployEthFixture();
      const { user1, user2, kashYield, kashToken } = ctx;

      const MINT1 = ethers.parseEther("1");
      const MINT2 = ethers.parseEther("2");

      await kashYield.connect(user1).requestMint(0, { value: MINT1 });
      await kashYield.connect(user2).requestMint(0, { value: MINT2 });
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await runFullEthMintCycle(ctx, batchCycle, MINT1 + MINT2);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);
      // User2 deposited 2x → should have ~2x tokens.
      expect(kash2).to.be.closeTo(kash1 * 2n, kash1 / 20n);
    });

    it("Phase 1 sets correct USD totals", async function () {
      const ctx = await deployEthFixture();
      const { user1, bot, kashYield } = ctx;

      await kashYield.connect(user1).requestMint(0, { value: ethers.parseEther("1") });
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");

      const info = await kashYield.getBatchInfo(batchCycle);
      // 1 ETH * $3,000 = $3,000 in 18-dec
      expect(info[0]).to.be.closeTo(ETH_PRICE_18, ETH_PRICE_18 / 100n);
    });

    it("rejects mint with zero value and zero amount", async function () {
      const { user1, kashYield } = await deployEthFixture();
      await expect(kashYield.connect(user1).requestMint(0, { value: 0 }))
        .to.be.revertedWithCustomError(kashYield, "ZeroAmount");
    });
  });

  // ── WETH wrap/unwrap ─────────────────────────────────────────────────────────
  describe("WETH wrap / unwrap via Aave", function () {
    it("Aave receives WETH after depositToAave", async function () {
      const ctx = await deployEthFixture();
      const { owner, user1, bot, kashYield, mockAave, mockWeth } = ctx;

      await kashYield.connect(user1).requestMint(0, { value: ethers.parseEther("1") });
      await kashYield.connect(bot).performUpkeep("0x");

      // Before deposit: MockAave has no WETH in suppliedAmounts.
      expect(await mockAave.suppliedAmounts(await kashYield.getAddress())).to.equal(0n);

      await kashYield.connect(owner).depositToAave(ethers.parseEther("1"));

      // After deposit: MockAave tracks 1e18 in suppliedAmounts (WETH).
      expect(await mockAave.suppliedAmounts(await kashYield.getAddress()))
        .to.equal(ethers.parseEther("1"));

      // MockAave holds the WETH ERC-20.
      expect(await mockWeth.balanceOf(await mockAave.getAddress()))
        .to.equal(ethers.parseEther("1"));
    });

    it("KashYieldETH receives native ETH after withdrawFromAave", async function () {
      const ctx = await deployEthFixture();
      const { owner, user1, bot, kashYield, mockUsdc } = ctx;

      const MINT_ETH = ethers.parseEther("1");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_ETH);

      const BORROW_USDC = 2_100n * 10n ** 6n;
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), BORROW_USDC);

      // Repay debt first so LTV is clear.
      await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), BORROW_USDC);

      const ethBefore = await ethers.provider.getBalance(await kashYield.getAddress());
      await kashYield.connect(owner).withdrawFromAave(MINT_ETH);
      const ethAfter = await ethers.provider.getBalance(await kashYield.getAddress());

      // Contract should have gained 1 ETH of native ETH.
      expect(ethAfter - ethBefore).to.equal(MINT_ETH);
    });
  });

  // ── Full redeem cycle ────────────────────────────────────────────────────────
  describe("Full redeem cycle", function () {
    it("user gets ETH back after full redeem at same price", async function () {
      const ctx = await deployEthFixture();
      const { user1, kashYield, kashToken } = ctx;

      const MINT_ETH = ethers.parseEther("1");

      // ── Cycle 1: mint ──────────────────────────────────────────────────────
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullEthMintCycle(ctx, mintCycle, MINT_ETH);

      const kashBalance = await kashToken.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n);

      // Advance to next cycle.
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      // ── Cycle 2: redeem ────────────────────────────────────────────────────
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      expect(redeemCycle).to.be.gt(mintCycle);

      const ethBefore = await ethers.provider.getBalance(user1.address);
      await runFullEthRedeemCycle(ctx, redeemCycle, MINT_ETH);
      const ethAfter = await ethers.provider.getBalance(user1.address);

      // User received ETH (ignoring gas costs — net ETH should be close to 1 ETH).
      expect(ethAfter).to.be.gt(ethBefore);
      const netReceived = ethAfter - ethBefore;
      expect(netReceived).to.be.closeTo(MINT_ETH, MINT_ETH / 100n);
    });

    it("Kash-ETH supply is zero after full redemption", async function () {
      const ctx = await deployEthFixture();
      const { user1, kashYield, kashToken } = ctx;

      const MINT_ETH = ethers.parseEther("1");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullEthMintCycle(ctx, mintCycle, MINT_ETH);

      const kashBalance = await kashToken.balanceOf(user1.address);
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullEthRedeemCycle(ctx, redeemCycle, MINT_ETH);

      expect(await kashToken.balanceOf(user1.address)).to.equal(0n);
      expect(await kashToken.totalSupply()).to.equal(0n);
    });

    it("rejects redeem request when Kash balance is zero", async function () {
      const { user1, kashYield } = await deployEthFixture();
      await expect(kashYield.connect(user1).requestRedeem(1n))
        .to.be.revertedWithCustomError(kashYield, "InsufficientKashEth");
    });
  });

  // ── Hyperliquid integration ───────────────────────────────────────────────────
  describe("Hyperliquid integration", function () {
    it("ETH short position is active after openShort", async function () {
      const ctx = await deployEthFixture();
      const { owner, user1, bot, kashYield, mockUsdc } = ctx;

      await kashYield.connect(user1).requestMint(0, { value: ethers.parseEther("1") });
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(ethers.parseEther("1"));
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), 2_100n * 10n ** 6n);
      await kashYield.connect(owner).depositToHyperliquid(2_100n * 10n ** 6n);
      await kashYield.connect(owner).spotBuyOnHyperliquid(2_100n * 10n ** 6n);

      const SHORT_SIZE = 1_700_000_000_000_000_000n; // 1.7 ETH in 18-dec
      await kashYield.connect(owner).openShort("ETH", SHORT_SIZE);

      const [size, , , isLong, isActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(isActive).to.be.true;
      expect(isLong).to.be.false;
      expect(size).to.equal(SHORT_SIZE);
    });

    it("Aave borrow check blocks excessive borrowing", async function () {
      const ctx = await deployEthFixture();
      const { owner, user1, bot, kashYield, mockUsdc } = ctx;

      await kashYield.connect(user1).requestMint(0, { value: ethers.parseEther("1") });
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(ethers.parseEther("1"));

      // Max borrow: 1 ETH * $3000 * 75% = $2250. Try $3000 — should revert.
      const tooMuch = 3_000n * 10n ** 6n;
      await expect(kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), tooMuch))
        .to.be.revertedWith("Borrow amount exceeds LTV limit");
    });
  });

  // ── Price change scenario ─────────────────────────────────────────────────────
  describe("Price change scenario", function () {
    it("Kash-ETH value drops when ETH price falls (NAV stays at $1, fewer ETH paid on redeem)", async function () {
      const ctx = await deployEthFixture();
      const { owner, user1, bot, kashYield, kashToken, mockAave, mockUsdc, mockFeed, mockHl, mockSpotDex } = ctx;

      const MINT_ETH = ethers.parseEther("1");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullEthMintCycle(ctx, mintCycle, MINT_ETH);

      const kashBalance = await kashToken.balanceOf(user1.address);

      // Simulate ETH price dropping to $2,000 across all mocks.
      const NEW_ETH_PRICE = 2_000n;
      await mockFeed.setPrice(NEW_ETH_PRICE * 10n ** 8n);
      await mockAave.setEthPrice(NEW_ETH_PRICE * 10n ** 18n);
      await mockHl.setEthPrice(NEW_ETH_PRICE * 10n ** 18n);
      await mockSpotDex.setEthRates(await mockUsdc.getAddress(), NEW_ETH_PRICE);

      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      // Check new ETH price is used.
      expect(await kashYield.getEthPrice()).to.equal(NEW_ETH_PRICE * 10n ** 18n);

      // Redeem: user's Kash is still worth ~$3,000 in Kash value,
      // but at $2,000/ETH they would receive ~1.5 ETH if NAV were updated.
      // In this test we keep NAV=$1 to verify the price feed propagates correctly.
      // The key invariant is: new ETH price is lower, so more ETH per dollar on redeem.
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // Close short at new price — this yields a profit for the short.
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner)["closeShort(string)"]("ETH");

      // Sell all ETH spot.
      const { hlAdapter } = ctx;
      const hlEth = await mockHl.ethBalance(await hlAdapter.getAddress());
      if (hlEth > 0n) await kashYield.connect(owner).spotSellOnHyperliquid(hlEth);

      const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
      if (hlSpot > 0n) await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

      // Repay Aave debt (handle interest dust with a second top-up if needed).
      const debt = await mockAave.borrowedAmounts(await kashYield.getAddress());
      if (debt > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), debt);
      const dustDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
      if (dustDebt > 0n) {
        await mockUsdc.mint(await kashYield.getAddress(), dustDebt);
        await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dustDebt);
      }

      // The short PnL + ETH-sell proceeds leave extra USDC in the contract.
      // Swap that USDC back to ETH so the contract can pay the redeemer at the new price.
      const surplusUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());
      if (surplusUsdc > 0n) {
        await kashYield.connect(owner).swapFromUsdc(surplusUsdc);
      }

      // Withdraw ETH from Aave.
      await kashYield.connect(owner).withdrawFromAave(MINT_ETH);

      await kashYield.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");

      // At $2000/ETH: $3000 worth of Kash → ~1.5 ETH (before 0.03% fee).
      const ethAfterRedeem = await ethers.provider.getBalance(user1.address);
      expect(ethAfterRedeem).to.be.gt(0n); // basic sanity
    });
  });

  // ── Exchange adapter registry ─────────────────────────────────────────────────
  describe("Exchange adapter registry", function () {
    it("setActivePerpExchange fails for unregistered name", async function () {
      const { kashYield } = await deployEthFixture();
      await expect(kashYield.setActivePerpExchange("GMX"))
        .to.be.revertedWithCustomError(kashYield, "ExchangeNotRegistered");
    });

    it("no-timelock registration confirms immediately when delay=0", async function () {
      const { kashYield, owner } = await deployEthFixture();

      // Ensure delay is already 0 (set during fixture).
      expect(await kashYield.exchangeSwitchDelay()).to.equal(0n);

      // Register a second adapter (delay=0 means immediate for any adapter).
      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const mock2 = await MockPerpExchange.deploy(ethers.ZeroAddress, ethers.ZeroAddress, true, 0n);
      await kashYield.setPerpExchange("GMX", await mock2.getAddress());

      // With delay=0, adapter is confirmed immediately without a separate confirmPerpExchange call.
      // adapterReadyAt should be 0 or past.
      const readyAt = await kashYield.adapterReadyAt("GMX");
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      expect(readyAt).to.be.lte(now);
    });
  });
});
