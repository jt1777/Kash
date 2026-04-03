// test/KashYieldBtc.e2e.test.js
//
// End-to-end tests for the BTC yield product: full mint cycle, full redeem cycle,
// configuration guards, and address-mismatch failures.
//
// These tests run on the local Hardhat network — no testnet needed.
// Each test deploys a fresh stack of mocks so failures are isolated.
//
// Strategy constants (mirroring bot defaults):
//   aaveDepositPct  = 100%  (deposit full net mint to Aave)
//   borrowLtvPct    = 70%   (borrow 70% of collateral USD value as USDC)
//   shortLeverage   = 1.7x  (short notional = 1.7 * net mint USD)

const { expect } = require("chai");
const { ethers } = require("hardhat");

const BTC_PRICE_USD  = 45_000n;                      // $45,000
const BTC_FEED_PRICE = BTC_PRICE_USD * 10n ** 8n;    // Chainlink 8-dec answer: 4_500_000_000_000
const BTC_PRICE_18   = BTC_PRICE_USD * 10n ** 18n;   // 18-dec representation used internally
const CYCLE_SECS     = 3600n;                         // 1-hour cycles — wide enough that no test crosses a boundary
const NAV_1          = 10n ** 18n;                    // $1 NAV

// ── helpers ──────────────────────────────────────────────────────────────────

/** Deploy and fully configure the BTC product mock stack. */
async function deployBtcFixture() {
  const [owner, bot, user1, user2] = await ethers.getSigners();

  // ── 1. Mock tokens ────────────────────────────────────────────────────────
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy(0); // mint separately

  const MockWBTC = await ethers.getContractFactory("MockWBTC");
  const mockWbtc = await MockWBTC.deploy(0);

  // ── 2. Oracle ─────────────────────────────────────────────────────────────
  const MockPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockFeed = await MockPriceFeed.deploy(BTC_FEED_PRICE);

  // ── 3. Mock Aave ──────────────────────────────────────────────────────────
  const MockAave = await ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAave.deploy(await mockUsdc.getAddress());
  await mockAave.setWbtcAddress(await mockWbtc.getAddress());
  await mockAave.setBtcPrice(BTC_PRICE_18);

  // Pre-fund Aave with USDC so borrow() can transfer to the borrower.
  // $100k should be more than enough for all test scenarios.
  const AAVE_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockAave.getAddress(), AAVE_USDC_FUND);

  // ── 4. Mock Hyperliquid ───────────────────────────────────────────────────
  const MockHL = await ethers.getContractFactory("MockHyperliquid");
  const mockHl = await MockHL.deploy(
    await mockUsdc.getAddress(),
    await mockUsdc.getAddress(), // use USDC for USDT slot too (same token, fine for mock)
    await mockWbtc.getAddress()
  );
  await mockHl.setBtcPrice(BTC_PRICE_18);

  // Pre-fund MockHL with USDC (for USDC withdrawals during redeem).
  const HL_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockHl.getAddress(), HL_USDC_FUND);

  // Pre-fund MockHL with wBTC for withdrawBtcFromSpotWallet during redeem.
  const HL_WBTC_FUND = 5n * 10n ** 8n; // 5 BTC
  await mockWbtc.mint(owner.address, HL_WBTC_FUND);
  await mockWbtc.approve(await mockHl.getAddress(), HL_WBTC_FUND);
  await mockHl.fundWithWbtc(HL_WBTC_FUND);

  // ── 5. Mock Spot DEX ──────────────────────────────────────────────────────
  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const mockSpotDex = await MockSpotDex.deploy();
  await mockSpotDex.setBtcRates(
    await mockWbtc.getAddress(),
    await mockUsdc.getAddress(),
    BTC_PRICE_USD
  );
  // Fund spot dex with both tokens so swaps can settle.
  const DEX_USDC_FUND = 100_000n * 10n ** 6n;
  const DEX_WBTC_FUND = 5n * 10n ** 8n;
  await mockUsdc.mint(owner.address, DEX_USDC_FUND);
  await mockUsdc.approve(await mockSpotDex.getAddress(), DEX_USDC_FUND);
  await mockSpotDex.fund(await mockUsdc.getAddress(), DEX_USDC_FUND);
  await mockWbtc.mint(owner.address, DEX_WBTC_FUND);
  await mockWbtc.approve(await mockSpotDex.getAddress(), DEX_WBTC_FUND);
  await mockSpotDex.fund(await mockWbtc.getAddress(), DEX_WBTC_FUND);

  // ── 6. KashYieldBtc ──────────────────────────────────────────────────────
  // Deploy KashYieldBtc first so its address can be passed to the adapter.
  const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
  const kashYield = await KashYieldBtc.deploy(
    bot.address,
    await mockWbtc.getAddress(),
    await mockUsdc.getAddress(),
    await mockAave.getAddress()
  );

  await kashYield.setBtcOracle(await mockFeed.getAddress());
  await kashYield.setAllowedSpotDexRouter(await mockSpotDex.getAddress(), true);
  await kashYield.setSpotDex(await mockSpotDex.getAddress());
  await kashYield.setCycleDurationSeconds(CYCLE_SECS);
  // Disable time windows for tests: users and bot can operate at any point in the cycle.
  await kashYield.setUserWindowEnd(CYCLE_SECS);
  await kashYield.setProcessingWindowStart(0n);

  // ── 7. Hyperliquid Adapter ────────────────────────────────────────────────
  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(),
    await mockUsdc.getAddress(),
    await mockWbtc.getAddress(),
    false,                       // isEthAsset = false (BTC product)
    await kashYield.getAddress() // kashYieldAddress for onlyAuthorized guard
  );

  // Register HL adapter: first-time bypass (no timelock).
  await kashYield.setExchangeSwitchDelay(0);
  await kashYield.setHyperliquid(await hlAdapter.getAddress());
  await kashYield.setActivePerpExchange("HL");

  // Get the KashToken contract.
  const kashTokenAddr = await kashYield.kashTokenBtc();
  const KashToken = await ethers.getContractFactory("KashTokenBtc");
  const kashToken = KashToken.attach(kashTokenAddr);

  return {
    owner, bot, user1, user2,
    kashYield, kashToken,
    mockUsdc, mockWbtc, mockAave, mockHl, mockSpotDex, hlAdapter, mockFeed,
  };
}

/**
 * Run Phase 1 (performUpkeep), simulate bot Aave+HL ops for a net mint,
 * update NAV, mark done, then run Phase 2.
 *
 * Mirrors what batchProcessor.ts does for handleNetMint.
 *
 * @param {*} ctx  fixture object (owner, bot, kashYield, mockAave, mockHl …)
 * @param {bigint} batchCycle  the cycle ID being processed
 * @param {bigint} mintBtc     gross wBTC deposited this cycle (8-dec)
 */
async function runFullMintCycle(ctx, batchCycle, mintBtc) {
  const { owner, bot, kashYield, mockUsdc, mockWbtc, mockAave, mockHl, hlAdapter } = ctx;

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  // ── Bot Aave ops ──────────────────────────────────────────────────────────
  // Deposit 100% of wBTC to Aave.
  await kashYield.connect(owner).depositToAave(mintBtc);
  const aaveWbtc = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());
  expect(aaveWbtc).to.equal(mintBtc);

  // Borrow 70% of collateral value as USDC.
  const btcUsdValue = mintBtc * BTC_PRICE_18 / (10n ** 8n); // 18-dec USD
  const borrowAmountUsd18 = btcUsdValue * 70n / 100n;
  const borrowUsdc = borrowAmountUsd18 / (10n ** 12n); // 6-dec USDC
  await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
  const aaveDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  expect(aaveDebt).to.equal(borrowUsdc);

  // ── Bot Hyperliquid ops ───────────────────────────────────────────────────
  // Deposit USDC → HL.
  await kashYield.connect(owner).depositToHyperliquid(borrowUsdc);
  const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
  expect(hlSpot).to.equal(borrowUsdc);

  // Spot buy BTC (USDC → BTC).
  await kashYield.connect(owner).spotBuyOnHyperliquid(borrowUsdc);
  const hlBtc = await mockHl.btcBalance(await hlAdapter.getAddress());
  // Expected: borrowUsdc * 1e12 * 1e18 / BTC_PRICE_18
  const expectedBtcInternal = borrowUsdc * 10n ** 12n * 10n ** 18n / BTC_PRICE_18;
  expect(hlBtc).to.be.closeTo(expectedBtcInternal, expectedBtcInternal / 100n); // within 1%

  // Open 1.7x BTC short (size in 18-dec asset units).
  const shortSizeUSD = btcUsdValue * 170n / 100n; // 1.7x leverage on full BTC value
  const shortSizeAsset = shortSizeUSD * 10n ** 18n / BTC_PRICE_18; // convert to BTC units
  await kashYield.connect(owner).openShort("BTC", shortSizeAsset);
  const [posSize, , , , posActive] = await kashYield.getHyperliquidPosition("BTC");
  expect(posActive).to.be.true;
  expect(posSize).to.equal(shortSizeAsset);

  // ── NAV + mark done + Phase 2 ─────────────────────────────────────────────
  await kashYield.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  expect(await kashYield.batchPhase(batchCycle)).to.equal(2);

  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(3);
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;
}

/**
 * Run Phase 1 + bot unwind ops for a net redeem, then Phase 2.
 * Assumes price is unchanged from mint (zero P&L on short).
 */
async function runFullRedeemCycle(ctx, batchCycle, mintBtc, borrowUsdc) {
  const { owner, bot, kashYield, mockUsdc, mockWbtc, mockAave, mockHl, hlAdapter } = ctx;

  // ── Phase 1 ───────────────────────────────────────────────────────────────
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  // ── Bot HL unwind ─────────────────────────────────────────────────────────
  // Close the entire short.
  await kashYield.connect(owner)["closeShort(string)"]("BTC");
  const [, , , , posActive] = await kashYield.getHyperliquidPosition("BTC");
  expect(posActive).to.be.false;

  // Sell all internal BTC for USDC (btcBalance after close = original spot BTC).
  const hlBtcAfterClose = await mockHl.btcBalance(await hlAdapter.getAddress());
  if (hlBtcAfterClose > 0n) {
    await kashYield.connect(owner).spotSellOnHyperliquid(hlBtcAfterClose);
  }

  // Withdraw all USDC from HL back to KashYieldBtc.
  const hlSpotAfterSell = await mockHl.spotBalances(await hlAdapter.getAddress());
  if (hlSpotAfterSell > 0n) {
    await kashYield.connect(owner).withdrawFromHyperliquid(hlSpotAfterSell);
  }

  // ── Bot Aave unwind ───────────────────────────────────────────────────────
  // Repay USDC debt. MockAave.repay calls updateInterest internally which may
  // add a tiny amount of interest to the debt before subtracting the repaid amount.
  // Read the current debt, repay it, then handle any dust left from interest accrual.
  const debt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (debt > 0n) {
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), debt);
  }
  const remainingDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (remainingDebt > 0n) {
    // Accrue a tiny bit of USDC to cover the interest dust and repay it.
    await mockUsdc.mint(await kashYield.getAddress(), remainingDebt);
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), remainingDebt);
  }
  expect(await mockAave.borrowedAmounts(await kashYield.getAddress())).to.equal(0n);

  // Withdraw wBTC from Aave.
  await kashYield.connect(owner).withdrawFromAave(mintBtc);
  const contractWbtc = await mockWbtc.balanceOf(await kashYield.getAddress());
  expect(contractWbtc).to.be.gte(mintBtc - 1n); // may be slightly less due to interest accrual

  // ── NAV + mark done + Phase 2 ─────────────────────────────────────────────
  await kashYield.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;
}

// ═════════════════════════════════════════════════════════════════════════════

describe("KashYieldBtc — end-to-end", function () {
  // Compilation + deployment can be slow on first run.
  this.timeout(120_000);

  // ── Deployment ──────────────────────────────────────────────────────────────
  describe("Deployment & configuration", function () {
    it("deploys with correct initial state", async function () {
      const { kashYield, mockAave, mockWbtc, mockUsdc, mockFeed, bot } = await deployBtcFixture();
      expect(await kashYield.aavePoolAddress()).to.equal(await mockAave.getAddress());
      expect(await kashYield.wbtcAddress()).to.equal(await mockWbtc.getAddress());
      expect(await kashYield.usdcAddress()).to.equal(await mockUsdc.getAddress());
      expect(await kashYield.btcOracle()).to.equal(await mockFeed.getAddress());
      expect(await kashYield.botAddress()).to.equal(bot.address);
      expect(await kashYield.currentNAV()).to.equal(NAV_1);
      expect(await kashYield.activePerpExchange()).to.equal("HL");
    });

    it("reads BTC price correctly from oracle", async function () {
      const { kashYield } = await deployBtcFixture();
      const price = await kashYield.getBtcPrice();
      expect(price).to.equal(BTC_PRICE_18);
    });

    it("rejects non-owner configuration changes", async function () {
      const { kashYield, user1 } = await deployBtcFixture();
      await expect(kashYield.connect(user1).setBtcOracle(user1.address))
        .to.be.revertedWithCustomError(kashYield, "OnlyOwner");
    });

    it("rejects performUpkeep from non-bot/non-keeper address", async function () {
      const { kashYield, user1 } = await deployBtcFixture();
      await expect(kashYield.connect(user1).performUpkeep("0x"))
        .to.be.revertedWithCustomError(kashYield, "OnlyBotOrKeeper");
    });

    it("fails with 'Invalid stablecoin' when MockHL uses wrong USDC", async function () {
      const { owner, bot, mockWbtc, mockAave, mockFeed, mockSpotDex } = await deployBtcFixture();

      // Deploy a second MockUSDC — this will be used for KashYield but NOT for MockHL.
      const MockUSDC2 = await ethers.getContractFactory("MockUSDC");
      const wrongUsdc = await MockUSDC2.deploy(0);

      // Deploy MockHL with the ORIGINAL (correct) usdc address internally.
      const MockHL2 = await ethers.getContractFactory("MockHyperliquid");
      const mockHl2 = await MockHL2.deploy(
        await wrongUsdc.getAddress(), // ← mismatch: HL accepts wrongUsdc
        await wrongUsdc.getAddress(),
        await mockWbtc.getAddress()
      );
      await mockHl2.setBtcPrice(BTC_PRICE_18);

      // Build a *fresh* KashYieldBtc that uses a *different* USDC than MockHL expects.
      const MockUSDC3 = await ethers.getContractFactory("MockUSDC");
      const rightUsdc = await MockUSDC3.deploy(0);
      // Fund Aave for the borrow step.
      const mockAave2 = await (await ethers.getContractFactory("MockAaveV3")).deploy(await rightUsdc.getAddress());
      await mockAave2.setWbtcAddress(await mockWbtc.getAddress());
      await mockAave2.setBtcPrice(BTC_PRICE_18);
      await rightUsdc.mint(await mockAave2.getAddress(), 100_000n * 10n ** 6n);

      const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
      const ky2 = await KashYieldBtc.deploy(
        bot.address,
        await mockWbtc.getAddress(),
        await rightUsdc.getAddress(),
        await mockAave2.getAddress()
      );
      await ky2.setBtcOracle(await mockFeed.getAddress());
      await ky2.setCycleDurationSeconds(CYCLE_SECS);
      await ky2.setUserWindowEnd(CYCLE_SECS);
      await ky2.setProcessingWindowStart(0n);
      await ky2.setExchangeSwitchDelay(0);

      const hlAdapter2 = await (await ethers.getContractFactory("HyperliquidAdapter")).deploy(
        await mockHl2.getAddress(),
        await rightUsdc.getAddress(), // ← adapter uses rightUsdc
        await mockWbtc.getAddress(),
        false,
        await ky2.getAddress()
      );

      await ky2.setHyperliquid(await hlAdapter2.getAddress());
      await ky2.setActivePerpExchange("HL");

      // Mint wBTC and submit a mint request.
      await mockWbtc.mint(owner.address, 1n * 10n ** 8n);
      await mockWbtc.approve(await ky2.getAddress(), 1n * 10n ** 8n);
      await ky2.requestMint(1n * 10n ** 8n);
      const cycle = (await ethers.provider.getBlock("latest")).timestamp / Number(CYCLE_SECS);
      await ky2.connect(bot).performUpkeep("0x");
      await ky2.connect(owner).depositToAave(1n * 10n ** 8n);
      await ky2.connect(owner).borrowFromAave(await rightUsdc.getAddress(), 31_500n * 10n ** 6n);

      // depositToHyperliquid should revert with "Invalid stablecoin" because
      // MockHL was configured with wrongUsdc but receives rightUsdc.
      await expect(ky2.connect(owner).depositToHyperliquid(31_500n * 10n ** 6n))
        .to.be.revertedWith("Invalid stablecoin");
    });
  });

  // ── Full mint cycle ──────────────────────────────────────────────────────────
  describe("Full mint cycle", function () {
    it("user receives Kash-BTC after minting 1 BTC", async function () {
      const ctx = await deployBtcFixture();
      const { user1, kashYield, kashToken, mockWbtc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n; // 1 BTC (8-dec wBTC)

      // Fund user and approve.
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);

      // Submit mint request.
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // Verify request recorded.
      expect(await kashYield.batchTotalMintBtc(batchCycle)).to.equal(MINT_BTC);

      // Run the full cycle.
      await runFullMintCycle(ctx, batchCycle, MINT_BTC);

      // User should have Kash-BTC: $45,000 worth at NAV=$1 minus 0.03% fee.
      const kashBalance = await kashToken.balanceOf(user1.address);
      const expectedKash = (BTC_PRICE_18 * 9997n / 10000n); // ≈ 44986.5 * 1e18
      expect(kashBalance).to.be.closeTo(expectedKash, expectedKash / 100n); // within 1%
    });

    it("two users get proportional Kash-BTC shares", async function () {
      const ctx = await deployBtcFixture();
      const { user1, user2, kashYield, kashToken, mockWbtc } = ctx;

      const MINT1 = 1n * 10n ** 8n;  // 1 BTC
      const MINT2 = 2n * 10n ** 8n;  // 2 BTC

      await mockWbtc.mint(user1.address, MINT1);
      await mockWbtc.mint(user2.address, MINT2);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT1);
      await mockWbtc.connect(user2).approve(await kashYield.getAddress(), MINT2);

      await kashYield.connect(user1).requestMint(MINT1);
      await kashYield.connect(user2).requestMint(MINT2);
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await runFullMintCycle(ctx, batchCycle, MINT1 + MINT2);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);

      // User2 deposited 2x, should have ~2x the Kash tokens.
      expect(kash2).to.be.closeTo(kash1 * 2n, kash1 / 20n); // within 5%
    });

    it("Phase 1 correctly sets batch totals", async function () {
      const ctx = await deployBtcFixture();
      const { user1, bot, kashYield, mockWbtc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");

      const info = await kashYield.getBatchInfo(batchCycle);
      // totalMintUSD should be 1 BTC * $45,000 = $45,000 in 18-dec
      const expectedUSD = BTC_PRICE_18;
      expect(info[0]).to.be.closeTo(expectedUSD, expectedUSD / 100n); // totalMintUSD within 1%
    });

    it("rejects mint request with zero amount", async function () {
      const { user1, kashYield } = await deployBtcFixture();
      await expect(kashYield.connect(user1).requestMint(0n))
        .to.be.revertedWithCustomError(kashYield, "ZeroAmount");
    });

    it("rejects mint without wBTC approval", async function () {
      const { user1, kashYield, mockWbtc } = await deployBtcFixture();
      await mockWbtc.mint(user1.address, 1n * 10n ** 8n);
      // No approve() call — should revert.
      await expect(kashYield.connect(user1).requestMint(1n * 10n ** 8n))
        .to.be.reverted;
    });
  });

  // ── Full redeem cycle ────────────────────────────────────────────────────────
  describe("Full redeem cycle", function () {
    it("user gets wBTC back after full redeem at same price", async function () {
      const ctx = await deployBtcFixture();
      const { user1, kashYield, kashToken, mockWbtc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;

      // ── Cycle 1: mint ──────────────────────────────────────────────────────
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullMintCycle(ctx, mintCycle, MINT_BTC);

      const kashBalance = await kashToken.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n);

      // Advance to next cycle.
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      // ── Cycle 2: redeem ────────────────────────────────────────────────────
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      expect(redeemCycle).to.be.gt(mintCycle, "Should be in a new cycle");

      const btcUsdValue = MINT_BTC * BTC_PRICE_18 / (10n ** 8n);
      const borrowUsdc  = btcUsdValue * 70n / 100n / (10n ** 12n);
      await runFullRedeemCycle(ctx, redeemCycle, MINT_BTC, borrowUsdc);

      // User should receive wBTC back (slightly less than 1 BTC due to 0.03% fee on redeem).
      const wbtcAfter = await mockWbtc.balanceOf(user1.address);
      expect(wbtcAfter).to.be.gt(0n);
      expect(wbtcAfter).to.be.closeTo(MINT_BTC, MINT_BTC / 100n); // within 1% of original
    });

    it("Kash-BTC is burned after redemption", async function () {
      const ctx = await deployBtcFixture();
      const { user1, kashYield, kashToken, mockWbtc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runFullMintCycle(ctx, mintCycle, MINT_BTC);

      const kashBalance = await kashToken.balanceOf(user1.address);
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      const btcUsdValue = MINT_BTC * BTC_PRICE_18 / (10n ** 8n);
      const borrowUsdc  = btcUsdValue * 70n / 100n / (10n ** 12n);
      await runFullRedeemCycle(ctx, redeemCycle, MINT_BTC, borrowUsdc);

      // After redeem, user's Kash balance should be zero.
      expect(await kashToken.balanceOf(user1.address)).to.equal(0n);
      // Total supply should be zero too.
      expect(await kashToken.totalSupply()).to.equal(0n);
    });

    it("rejects redeem request with insufficient Kash balance", async function () {
      const { user1, kashYield } = await deployBtcFixture();
      await expect(kashYield.connect(user1).requestRedeem(1n))
        .to.be.revertedWithCustomError(kashYield, "InsufficientKashBtc");
    });
  });

  // ── Aave integration ─────────────────────────────────────────────────────────
  describe("Aave integration", function () {
    it("wBTC is tracked in Aave after depositToAave", async function () {
      const ctx = await deployBtcFixture();
      const { owner, user1, bot, kashYield, mockWbtc, mockAave } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      await kashYield.connect(bot).performUpkeep("0x");

      await kashYield.connect(owner).depositToAave(MINT_BTC);

      expect(await mockAave.suppliedWbtcAmounts(await kashYield.getAddress()))
        .to.equal(MINT_BTC);
    });

    it("borrow exceeds LTV reverts", async function () {
      const ctx = await deployBtcFixture();
      const { owner, user1, bot, kashYield, mockWbtc, mockUsdc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n; // 1 BTC = $45,000
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_BTC);

      // Max borrow at 75% LTV = $33,750. Try to borrow $40,000 — should fail.
      const tooMuch = 40_000n * 10n ** 6n;
      await expect(kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), tooMuch))
        .to.be.revertedWith("Borrow amount exceeds LTV limit");
    });
  });

  // ── Hyperliquid integration ───────────────────────────────────────────────────
  describe("Hyperliquid integration", function () {
    it("USDC spot balance in HL after deposit", async function () {
      const ctx = await deployBtcFixture();
      const { owner, user1, bot, kashYield, mockWbtc, mockUsdc, mockHl, hlAdapter } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_BTC);
      const BORROW_USDC = 31_500n * 10n ** 6n;
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), BORROW_USDC);
      await kashYield.connect(owner).depositToHyperliquid(BORROW_USDC);

      expect(await mockHl.spotBalances(await hlAdapter.getAddress()))
        .to.equal(BORROW_USDC);
    });

    it("short position is active after openShort", async function () {
      const ctx = await deployBtcFixture();
      const { owner, user1, bot, kashYield, mockWbtc, mockUsdc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_BTC);
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), 31_500n * 10n ** 6n);
      await kashYield.connect(owner).depositToHyperliquid(31_500n * 10n ** 6n);
      await kashYield.connect(owner).spotBuyOnHyperliquid(31_500n * 10n ** 6n);

      const SHORT_SIZE = 1_700_000_000_000_000_000n; // 1.7e18 (1.7 BTC)
      await kashYield.connect(owner).openShort("BTC", SHORT_SIZE);

      const [size, , , isLong, isActive] = await kashYield.getHyperliquidPosition("BTC");
      expect(isActive).to.be.true;
      expect(isLong).to.be.false;
      expect(size).to.equal(SHORT_SIZE);
    });
  });

  // ── Exchange adapter registry ─────────────────────────────────────────────────
  describe("Exchange adapter registry", function () {
    it("setActivePerpExchange fails for unregistered exchange", async function () {
      const { kashYield } = await deployBtcFixture();
      await expect(kashYield.setActivePerpExchange("UNKNOWN"))
        .to.be.revertedWithCustomError(kashYield, "ExchangeNotRegistered");
    });

    it("second adapter registration starts timelock when delay > 0", async function () {
      const { kashYield, owner } = await deployBtcFixture();

      // Set a non-zero delay.
      await kashYield.setExchangeSwitchDelay(48 * 3600);

      // Attempt to register a second adapter — should enter timelock, not immediate.
      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const mock = await MockPerpExchange.deploy(ethers.ZeroAddress, ethers.ZeroAddress, false, 0n);
      await kashYield.setPerpExchange("GMX", await mock.getAddress());

      // Not yet registered — pending.
      expect(await kashYield.perpExchanges("GMX")).to.equal(ethers.ZeroAddress);
      expect(await kashYield.adapterReadyAt("GMX")).to.be.gt(0n);
    });

    it("first adapter bypasses timelock regardless of delay", async function () {
      const { owner, bot, mockAave, mockWbtc, mockUsdc, mockFeed, mockSpotDex } = await deployBtcFixture();

      // Deploy a *fresh* KashYieldBtc with a 48h delay.
      const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
      const ky2 = await KashYieldBtc.deploy(
        bot.address,
        await mockWbtc.getAddress(),
        await mockUsdc.getAddress(),
        await mockAave.getAddress()
      );
      await ky2.setExchangeSwitchDelay(48 * 3600);

      const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
      const adapter2 = await HyperliquidAdapter.deploy(
        ethers.ZeroAddress, // HL address not needed for this test
        await mockUsdc.getAddress(),
        await mockWbtc.getAddress(),
        false,
        await ky2.getAddress()
      );

      // First-time registration — should be immediate (bypass).
      await ky2.setHyperliquid(await adapter2.getAddress());
      expect(await ky2.perpExchanges("HL")).to.equal(await adapter2.getAddress());
    });
  });
});
