// test/advanced-scenarios.e2e.test.js
//
// Advanced end-to-end scenarios NOT covered in the existing e2e test files:
//
//   1. Multi-user simultaneous REDEEM (both users redeem in the same cycle)
//   2. Cumulative mint — second mint cycle adds to existing Aave/HL positions
//   3. Partial redeem — one user redeems while the other's position stays open
//   4. Items 2 & 3 combined with BTC price increase and decrease
//   5. ETH price increase scenario
//   6. Multiple simultaneous perp-exchange adapters (HL + GMX + ASTER registered at once,
//      positions opened on different adapters by switching the active exchange)
//
// Key mock behaviors confirmed before writing these tests:
//   - MockHyperliquid.openPerpPosition ACCUMULATES into an existing position (VWAP entry).
//   - MockPerpExchange.openPerpPosition REPLACES the position for the same symbol.
//   - closeShort(symbol, size) does a proportional partial close.
//   - All exchange operations (openShort, closeShort, deposit, withdraw, spotBuy, spotSell)
//     use _activePerpAdapter() — i.e., whatever exchange is currently "active".
//   - getHyperliquidPosition() also queries the ACTIVE exchange's adapter.
//     To inspect a non-active exchange's position you must switch first.

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── constants ─────────────────────────────────────────────────────────────────

const ETH_PRICE    = 3_000n;
const ETH_FEED     = ETH_PRICE * 10n ** 8n;
const ETH_PRICE_18 = ETH_PRICE * 10n ** 18n;

const BTC_PRICE    = 45_000n;
const BTC_FEED     = BTC_PRICE * 10n ** 8n;
const BTC_PRICE_18 = BTC_PRICE * 10n ** 18n;

const NAV_1      = 10n ** 18n;
const CYCLE_SECS = 3600n;

// ── fixtures ──────────────────────────────────────────────────────────────────

async function deployEthFixture() {
  const [owner, bot, user1, user2, user3] = await ethers.getSigners();

  const MockUSDC  = await ethers.getContractFactory("MockUSDC");
  const mockUsdc  = await MockUSDC.deploy(0);

  const MockWETH  = await ethers.getContractFactory("MockWETH");
  const mockWeth  = await MockWETH.deploy();

  const MockFeed  = await ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockFeed  = await MockFeed.deploy(ETH_FEED);

  const MockAave  = await ethers.getContractFactory("MockAaveV3");
  const mockAave  = await MockAave.deploy(await mockUsdc.getAddress());
  await mockAave.setWethAddress(await mockWeth.getAddress());
  await mockAave.setEthPrice(ETH_PRICE_18);
  await mockUsdc.mint(await mockAave.getAddress(), 500_000n * 10n ** 6n);

  const MockHL = await ethers.getContractFactory("MockHyperliquid");
  const mockHl = await MockHL.deploy(
    await mockUsdc.getAddress(),
    await mockUsdc.getAddress(),
    ethers.ZeroAddress
  );
  await mockHl.setEthPrice(ETH_PRICE_18);
  await mockUsdc.mint(await mockHl.getAddress(), 500_000n * 10n ** 6n);
  await owner.sendTransaction({ to: await mockHl.getAddress(), value: ethers.parseEther("20") });

  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const mockSpotDex = await MockSpotDex.deploy();
  await mockSpotDex.setEthRates(await mockUsdc.getAddress(), ETH_PRICE);
  await mockUsdc.mint(owner.address, 200_000n * 10n ** 6n);
  await mockUsdc.approve(await mockSpotDex.getAddress(), 200_000n * 10n ** 6n);
  await mockSpotDex.fund(await mockUsdc.getAddress(), 200_000n * 10n ** 6n);
  await mockSpotDex.fundEth({ value: ethers.parseEther("20") });

  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(), await mockUsdc.getAddress(), ethers.ZeroAddress, true
  );

  const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
  const kashYield    = await KashYieldETH.deploy(bot.address);
  await kashYield.setAavePool(await mockAave.getAddress());
  await kashYield.setUsdcAddress(await mockUsdc.getAddress());
  await kashYield.setWethAddress(await mockWeth.getAddress());
  await kashYield.setEthOracle(await mockFeed.getAddress());
  await kashYield.setSpotDex(await mockSpotDex.getAddress());
  await kashYield.setCycleDurationSeconds(CYCLE_SECS);
  await kashYield.setUserWindowEnd(CYCLE_SECS);
  await kashYield.setProcessingWindowStart(0n);
  await kashYield.setExchangeSwitchDelay(0);
  await kashYield.setHyperliquid(await hlAdapter.getAddress());
  await kashYield.setActivePerpExchange("HL");

  const kashToken = await (await ethers.getContractFactory("KashTokenEth"))
    .attach(await kashYield.kashTokenEth());

  return { owner, bot, user1, user2, user3, kashYield, kashToken,
           mockUsdc, mockWeth, mockAave, mockHl, mockSpotDex, hlAdapter, mockFeed };
}

async function deployBtcFixture() {
  const [owner, bot, user1, user2, user3] = await ethers.getSigners();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy(0);

  const MockWBTC = await ethers.getContractFactory("MockWBTC");
  const mockWbtc = await MockWBTC.deploy(0);

  const MockFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockFeed = await MockFeed.deploy(BTC_FEED);

  const MockAave = await ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAave.deploy(await mockUsdc.getAddress());
  await mockAave.setWbtcAddress(await mockWbtc.getAddress());
  await mockAave.setBtcPrice(BTC_PRICE_18);
  await mockUsdc.mint(await mockAave.getAddress(), 500_000n * 10n ** 6n);

  const MockHL = await ethers.getContractFactory("MockHyperliquid");
  const mockHl = await MockHL.deploy(
    await mockUsdc.getAddress(), await mockUsdc.getAddress(), await mockWbtc.getAddress()
  );
  await mockHl.setBtcPrice(BTC_PRICE_18);
  await mockUsdc.mint(await mockHl.getAddress(), 500_000n * 10n ** 6n);
  await mockWbtc.mint(owner.address, 20n * 10n ** 8n);
  await mockWbtc.approve(await mockHl.getAddress(), 20n * 10n ** 8n);
  await mockHl.fundWithWbtc(20n * 10n ** 8n);

  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const mockSpotDex = await MockSpotDex.deploy();
  await mockSpotDex.setBtcRates(await mockWbtc.getAddress(), await mockUsdc.getAddress(), BTC_PRICE);
  await mockUsdc.mint(owner.address, 200_000n * 10n ** 6n);
  await mockUsdc.approve(await mockSpotDex.getAddress(), 200_000n * 10n ** 6n);
  await mockSpotDex.fund(await mockUsdc.getAddress(), 200_000n * 10n ** 6n);
  await mockWbtc.mint(owner.address, 10n * 10n ** 8n);
  await mockWbtc.approve(await mockSpotDex.getAddress(), 10n * 10n ** 8n);
  await mockSpotDex.fund(await mockWbtc.getAddress(), 10n * 10n ** 8n);

  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(), await mockUsdc.getAddress(), await mockWbtc.getAddress(), false
  );

  const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
  const kashYield    = await KashYieldBtc.deploy(bot.address);
  await kashYield.setAavePool(await mockAave.getAddress());
  await kashYield.setWbtcAddress(await mockWbtc.getAddress());
  await kashYield.setUsdcAddress(await mockUsdc.getAddress());
  await kashYield.setBtcOracle(await mockFeed.getAddress());
  await kashYield.setSpotDex(await mockSpotDex.getAddress());
  await kashYield.setCycleDurationSeconds(CYCLE_SECS);
  await kashYield.setUserWindowEnd(CYCLE_SECS);
  await kashYield.setProcessingWindowStart(0n);
  await kashYield.setExchangeSwitchDelay(0);
  await kashYield.setHyperliquid(await hlAdapter.getAddress());
  await kashYield.setActivePerpExchange("HL");

  const kashToken = await (await ethers.getContractFactory("KashTokenBtc"))
    .attach(await kashYield.kashTokenBtc());

  return { owner, bot, user1, user2, user3, kashYield, kashToken,
           mockUsdc, mockWbtc, mockAave, mockHl, mockSpotDex, hlAdapter, mockFeed };
}

// ── shared helpers ────────────────────────────────────────────────────────────

/** Run a full ETH mint batch cycle for a given net ETH amount. */
async function runEthMintCycle(ctx, batchCycle, mintEth) {
  const { owner, bot, kashYield, mockUsdc, mockAave, mockHl } = ctx;

  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  await kashYield.connect(owner).depositToAave(mintEth);

  const ethUsd     = mintEth * ETH_PRICE_18 / (10n ** 18n);
  const borrowUsdc = ethUsd * 70n / 100n / (10n ** 12n);
  await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
  await kashYield.connect(owner).depositToHyperliquid(borrowUsdc);
  await kashYield.connect(owner).spotBuyOnHyperliquid(borrowUsdc);

  const shortSize = ethUsd * 170n / 100n * (10n ** 18n) / ETH_PRICE_18;
  await kashYield.connect(owner).openShort("ETH", shortSize);

  await kashYield.connect(owner).updateNAV(NAV_1);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;

  return { borrowUsdc, shortSize };
}

/** Run a full BTC mint batch cycle for a given net wBTC amount (8-dec). */
async function runBtcMintCycle(ctx, batchCycle, mintBtc) {
  const { owner, bot, kashYield, mockUsdc, mockAave, mockHl } = ctx;

  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchPhase(batchCycle)).to.equal(1);

  await kashYield.connect(owner).depositToAave(mintBtc);

  const btcUsd     = mintBtc * BTC_PRICE_18 / (10n ** 8n);
  const borrowUsdc = btcUsd * 70n / 100n / (10n ** 12n);
  await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
  await kashYield.connect(owner).depositToHyperliquid(borrowUsdc);
  await kashYield.connect(owner).spotBuyOnHyperliquid(borrowUsdc);

  const shortSize = btcUsd * 170n / 100n * (10n ** 18n) / BTC_PRICE_18;
  await kashYield.connect(owner).openShort("BTC", shortSize);

  await kashYield.connect(owner).updateNAV(NAV_1);
  await kashYield.connect(owner).markBatchOpsDone(batchCycle);
  await kashYield.connect(bot).performUpkeep("0x");
  expect(await kashYield.batchProcessed(batchCycle)).to.be.true;

  return { borrowUsdc, shortSize };
}

/** Fully unwind all ETH positions (close short, sell HL ETH, repay Aave, withdraw Aave). */
async function unwindAllEthPositions(ctx, totalMintEth, currentEthPrice18) {
  const { owner, kashYield, mockUsdc, mockAave, mockHl, hlAdapter } = ctx;

  await kashYield.connect(owner)["closeShort(string)"]("ETH");

  const hlEth = await mockHl.ethBalance(await hlAdapter.getAddress());
  if (hlEth > 0n) await kashYield.connect(owner).spotSellOnHyperliquid(hlEth);

  const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
  if (hlSpot > 0n) await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

  const debt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  const contractUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());

  if (contractUsdc < debt) {
    // Short-fall: need to sell some ETH from Aave for USDC.
    const shortfall = debt - contractUsdc;
    const ethToSell = shortfall * (10n ** 18n) / currentEthPrice18 + 1n;
    await kashYield.connect(owner).withdrawFromAave(ethToSell);
    await kashYield.connect(owner).swapForUsdc(ethToSell);
  }

  const debtNow = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (debtNow > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), debtNow);
  const dustDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (dustDebt > 0n) {
    await mockUsdc.mint(await kashYield.getAddress(), dustDebt);
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dustDebt);
  }

  const remaining = await mockAave.suppliedAmounts(await kashYield.getAddress());
  if (remaining > 0n) await kashYield.connect(owner).withdrawFromAave(remaining);

  // Convert any surplus USDC → ETH.
  const surplusUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());
  if (surplusUsdc > 0n) await kashYield.connect(owner).swapFromUsdc(surplusUsdc);
}

/** Fully unwind all BTC positions (close short, sell HL BTC, repay Aave, withdraw Aave). */
async function unwindAllBtcPositions(ctx, totalMintBtc, currentBtcPrice18) {
  const { owner, kashYield, mockUsdc, mockWbtc, mockAave, mockHl, hlAdapter, mockSpotDex } = ctx;

  await kashYield.connect(owner)["closeShort(string)"]("BTC");

  const hlBtc = await mockHl.btcBalance(await hlAdapter.getAddress());
  if (hlBtc > 0n) await kashYield.connect(owner).spotSellOnHyperliquid(hlBtc);

  const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
  if (hlSpot > 0n) await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

  const debt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  const contractUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());

  if (contractUsdc < debt) {
    // Need to sell some wBTC from Aave to cover shortfall.
    const shortfall = debt - contractUsdc;
    const wbtcToSell = shortfall * (10n ** 8n) / (currentBtcPrice18 / (10n ** 12n)) + 1n;
    await kashYield.connect(owner).withdrawFromAave(wbtcToSell);
    await kashYield.connect(owner).swapForUsdc(wbtcToSell);
  }

  const debtNow = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (debtNow > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), debtNow);
  const dustDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
  if (dustDebt > 0n) {
    await mockUsdc.mint(await kashYield.getAddress(), dustDebt);
    await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dustDebt);
  }

  const remaining = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());
  if (remaining > 0n) await kashYield.connect(owner).withdrawFromAave(remaining);

  // Convert any surplus USDC → wBTC.
  const surplusUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());
  if (surplusUsdc > 0n) await kashYield.connect(owner).swapFromUsdc(surplusUsdc);
}

/** Update all mock prices in one call. */
async function setAllEthPrices(ctx, newEthPrice) {
  const { mockFeed, mockAave, mockHl, mockSpotDex, mockUsdc } = ctx;
  await mockFeed.setPrice(newEthPrice * 10n ** 8n);
  await mockAave.setEthPrice(newEthPrice * 10n ** 18n);
  await mockHl.setEthPrice(newEthPrice * 10n ** 18n);
  await mockSpotDex.setEthRates(await mockUsdc.getAddress(), newEthPrice);
}

async function setAllBtcPrices(ctx, newBtcPrice) {
  const { mockFeed, mockAave, mockHl, mockSpotDex, mockWbtc, mockUsdc } = ctx;
  await mockFeed.setPrice(newBtcPrice * 10n ** 8n);
  await mockAave.setBtcPrice(newBtcPrice * 10n ** 18n);
  await mockHl.setBtcPrice(newBtcPrice * 10n ** 18n);
  await mockSpotDex.setBtcRates(await mockWbtc.getAddress(), await mockUsdc.getAddress(), newBtcPrice);
}

async function nextCycle() {
  await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
  await ethers.provider.send("evm_mine");
}

// ══════════════════════════════════════════════════════════════════════════════

describe("Advanced scenarios — multi-user, cumulative positions, price changes, multi-exchange", function () {
  this.timeout(180_000);

  // ── 1. Multi-user simultaneous redeem ────────────────────────────────────────
  describe("Multi-user simultaneous redeem", function () {
    it("ETH: two users redeeming in the same batch cycle both receive ETH back", async function () {
      const ctx = await deployEthFixture();
      const { user1, user2, kashYield, kashToken } = ctx;

      const MINT1 = ethers.parseEther("1");
      const MINT2 = ethers.parseEther("2");

      // ── Cycle 1: both mint ────────────────────────────────────────────────
      await kashYield.connect(user1).requestMint(0, { value: MINT1 });
      await kashYield.connect(user2).requestMint(0, { value: MINT2 });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT1 + MINT2);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);
      expect(kash1).to.be.gt(0n);
      expect(kash2).to.be.gt(0n);

      // ── Cycle 2: both redeem in the same cycle ────────────────────────────
      await nextCycle();
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashToken.connect(user2).approve(await kashYield.getAddress(), kash2);
      await kashYield.connect(user1).requestRedeem(kash1);
      await kashYield.connect(user2).requestRedeem(kash2);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      const eth1Before = await ethers.provider.getBalance(user1.address);
      const eth2Before = await ethers.provider.getBalance(user2.address);

      // Bot unwinds all positions (both redeems in one go).
      const { owner, bot } = ctx;
      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllEthPositions(ctx, MINT1 + MINT2, ETH_PRICE_18);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // Both users should have received ETH.
      const eth1After = await ethers.provider.getBalance(user1.address);
      const eth2After = await ethers.provider.getBalance(user2.address);
      expect(eth1After).to.be.gt(eth1Before, "user1 should receive ETH");
      expect(eth2After).to.be.gt(eth2Before, "user2 should receive ETH");

      // user2 minted 2x so should receive ~2x the ETH.
      const gain1 = eth1After - eth1Before;
      const gain2 = eth2After - eth2Before;
      expect(gain2).to.be.closeTo(gain1 * 2n, gain1 / 5n); // within 20%

      // All Kash tokens burned.
      expect(await kashToken.totalSupply()).to.equal(0n);
    });

    it("BTC: two users redeeming in the same batch cycle both receive wBTC back", async function () {
      const ctx = await deployBtcFixture();
      const { user1, user2, owner, bot, kashYield, kashToken, mockWbtc } = ctx;

      const MINT1 = 1n * 10n ** 8n; // 1 BTC
      const MINT2 = 2n * 10n ** 8n; // 2 BTC

      // Cycle 1: both mint.
      await mockWbtc.mint(user1.address, MINT1);
      await mockWbtc.mint(user2.address, MINT2);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT1);
      await mockWbtc.connect(user2).approve(await kashYield.getAddress(), MINT2);
      await kashYield.connect(user1).requestMint(MINT1);
      await kashYield.connect(user2).requestMint(MINT2);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, mintCycle, MINT1 + MINT2);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);

      // Cycle 2: both redeem in the same cycle.
      await nextCycle();
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashToken.connect(user2).approve(await kashYield.getAddress(), kash2);
      await kashYield.connect(user1).requestRedeem(kash1);
      await kashYield.connect(user2).requestRedeem(kash2);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      const btc1Before = await mockWbtc.balanceOf(user1.address);
      const btc2Before = await mockWbtc.balanceOf(user2.address);

      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllBtcPositions(ctx, MINT1 + MINT2, BTC_PRICE_18);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      const btc1After = await mockWbtc.balanceOf(user1.address);
      const btc2After = await mockWbtc.balanceOf(user2.address);

      expect(btc1After).to.be.gt(btc1Before, "user1 should receive wBTC");
      expect(btc2After).to.be.gt(btc2Before, "user2 should receive wBTC");

      // user2 minted 2x → receives ~2x the wBTC.
      const gain1 = btc1After - btc1Before;
      const gain2 = btc2After - btc2Before;
      expect(gain2).to.be.closeTo(gain1 * 2n, gain1 / 5n);
      expect(await kashToken.totalSupply()).to.equal(0n);
    });
  });

  // ── 2. Cumulative mint — adding to existing Aave/HL positions ────────────────
  describe("Cumulative mint — adding to existing open positions", function () {
    it("ETH: second mint cycle increases Aave WETH balance and HL short size", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockAave, mockHl, hlAdapter } = ctx;

      const MINT_EACH = ethers.parseEther("1");

      // ── Cycle 1: user1 mints ──────────────────────────────────────────────
      await kashYield.connect(user1).requestMint(0, { value: MINT_EACH });
      const cycle1 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, cycle1, MINT_EACH);

      const aaveAfterCycle1 = await mockAave.suppliedAmounts(await kashYield.getAddress());
      const [shortAfterCycle1] = await kashYield.getHyperliquidPosition("ETH");
      expect(aaveAfterCycle1).to.equal(MINT_EACH);
      expect(shortAfterCycle1).to.be.gt(0n);

      // ── Cycle 2: user2 mints — positions should INCREASE, not be reset ───
      await nextCycle();
      await kashYield.connect(user2).requestMint(0, { value: MINT_EACH });
      const cycle2 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      // Deposit ONLY the new cycle's ETH to Aave (adds to cycle-1 deposit).
      await kashYield.connect(owner).depositToAave(MINT_EACH);

      const aaveAfterCycle2 = await mockAave.suppliedAmounts(await kashYield.getAddress());
      expect(aaveAfterCycle2).to.equal(MINT_EACH * 2n, "Aave should hold 2 ETH after two mint cycles");

      const ethUsd     = MINT_EACH * ETH_PRICE_18 / (10n ** 18n);
      const borrowUsdc = ethUsd * 70n / 100n / (10n ** 12n);
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
      await kashYield.connect(owner).depositToHyperliquid(borrowUsdc);
      await kashYield.connect(owner).spotBuyOnHyperliquid(borrowUsdc);

      // openShort a second time — MockHyperliquid ACCUMULATES (VWAP entry).
      const additionalShort = ethUsd * 170n / 100n * (10n ** 18n) / ETH_PRICE_18;
      await kashYield.connect(owner).openShort("ETH", additionalShort);

      const [shortAfterCycle2] = await kashYield.getHyperliquidPosition("ETH");
      expect(shortAfterCycle2).to.be.closeTo(shortAfterCycle1 * 2n, shortAfterCycle1 / 10n,
        "HL short should be approximately 2x after two equal mint cycles");

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(cycle2);
      await kashYield.connect(bot).performUpkeep("0x");

      // Both users hold Kash tokens.
      expect(await kashToken.balanceOf(user1.address)).to.be.gt(0n);
      expect(await kashToken.balanceOf(user2.address)).to.be.gt(0n);
    });

    it("BTC: second BTC mint cycle increases Aave wBTC balance and HL short size", async function () {
      const ctx = await deployBtcFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockAave, mockHl, hlAdapter, mockWbtc } = ctx;

      const MINT_EACH = 1n * 10n ** 8n; // 1 BTC

      // Cycle 1: user1 mints.
      await mockWbtc.mint(user1.address, MINT_EACH);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_EACH);
      await kashYield.connect(user1).requestMint(MINT_EACH);
      const cycle1 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, cycle1, MINT_EACH);

      const aaveAfterCycle1 = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());
      const [shortAfterCycle1] = await kashYield.getHyperliquidPosition("BTC");
      expect(aaveAfterCycle1).to.equal(MINT_EACH);

      // Cycle 2: user2 mints.
      await nextCycle();
      await mockWbtc.mint(user2.address, MINT_EACH);
      await mockWbtc.connect(user2).approve(await kashYield.getAddress(), MINT_EACH);
      await kashYield.connect(user2).requestMint(MINT_EACH);
      const cycle2 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_EACH);

      const aaveAfterCycle2 = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());
      expect(aaveAfterCycle2).to.equal(MINT_EACH * 2n, "Aave should hold 2 BTC after two cycles");

      const btcUsd    = MINT_EACH * BTC_PRICE_18 / (10n ** 8n);
      const borrow    = btcUsd * 70n / 100n / (10n ** 12n);
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrow);
      await kashYield.connect(owner).depositToHyperliquid(borrow);
      await kashYield.connect(owner).spotBuyOnHyperliquid(borrow);

      const additionalShort = btcUsd * 170n / 100n * (10n ** 18n) / BTC_PRICE_18;
      await kashYield.connect(owner).openShort("BTC", additionalShort);

      const [shortAfterCycle2] = await kashYield.getHyperliquidPosition("BTC");
      expect(shortAfterCycle2).to.be.closeTo(shortAfterCycle1 * 2n, shortAfterCycle1 / 10n,
        "HL short should be approximately 2x after two equal BTC mint cycles");

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(cycle2);
      await kashYield.connect(bot).performUpkeep("0x");

      expect(await kashToken.balanceOf(user1.address)).to.be.gt(0n);
      expect(await kashToken.balanceOf(user2.address)).to.be.gt(0n);
    });

    it("ETH: cumulative mint across two price levels (cycle1=$3k, cycle2=$4k)", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockAave } = ctx;

      const MINT_EACH = ethers.parseEther("1");

      // Cycle 1 at $3,000.
      await kashYield.connect(user1).requestMint(0, { value: MINT_EACH });
      const cycle1 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, cycle1, MINT_EACH);
      const kash1 = await kashToken.balanceOf(user1.address);

      // Price rises to $4,000 before cycle 2.
      await nextCycle();
      await setAllEthPrices(ctx, 4_000n);

      // Cycle 2 at $4,000: user2 mints 1 ETH.
      await kashYield.connect(user2).requestMint(0, { value: MINT_EACH });
      const cycle2 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // Bot processes cycle 2 at the new price.
      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_EACH);

      const NEW_ETH_PRICE_18 = 4_000n * 10n ** 18n;
      const ethUsd2   = MINT_EACH * NEW_ETH_PRICE_18 / (10n ** 18n);
      const borrow2   = ethUsd2 * 70n / 100n / (10n ** 12n);
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrow2);
      await kashYield.connect(owner).depositToHyperliquid(borrow2);
      await kashYield.connect(owner).spotBuyOnHyperliquid(borrow2);
      const short2 = ethUsd2 * 170n / 100n * (10n ** 18n) / NEW_ETH_PRICE_18;
      await kashYield.connect(owner).openShort("ETH", short2);

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(cycle2);
      await kashYield.connect(bot).performUpkeep("0x");

      const kash2 = await kashToken.balanceOf(user2.address);

      // At $4,000: user2 mints 1 ETH = $4,000 worth → more Kash than user1 ($3,000).
      expect(kash2).to.be.gt(kash1, "user2 at higher price should receive more Kash per ETH");

      // Aave holds 2 ETH total.
      const aaveTotal = await mockAave.suppliedAmounts(await kashYield.getAddress());
      expect(aaveTotal).to.equal(MINT_EACH * 2n);
    });
  });

  // ── 3. Partial redeem — leaving remaining positions open ─────────────────────
  describe("Partial redeem — remaining positions stay open", function () {
    it("ETH: user1 redeems while user2's position remains fully intact", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockAave, mockHl, hlAdapter } = ctx;

      const MINT_EACH = ethers.parseEther("1");

      // Cycle 1: both users mint.
      await kashYield.connect(user1).requestMint(0, { value: MINT_EACH });
      await kashYield.connect(user2).requestMint(0, { value: MINT_EACH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT_EACH * 2n);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);
      const [fullShortSize] = await kashYield.getHyperliquidPosition("ETH");
      const fullAave = await mockAave.suppliedAmounts(await kashYield.getAddress());

      // Cycle 2: only user1 redeems (50% of total Kash supply).
      await nextCycle();
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashYield.connect(user1).requestRedeem(kash1);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      const ethBefore = await ethers.provider.getBalance(user1.address);

      await kashYield.connect(bot).performUpkeep("0x");

      // Close exactly 50% of the short position (returns collateral ETH to hlAdapter's ethBalance).
      const halfShort = fullShortSize / 2n;
      await kashYield.connect(owner)["closeShort(string,uint256)"]("ETH", halfShort);

      // After spotBuyOnHyperliquid in the mint cycle, spotBalances=0 (USDC→ETH conversion).
      // We must sell enough HL ETH to obtain the USDC needed to repay 50% of Aave debt.
      const totalDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
      const halfDebt  = totalDebt / 2n;
      // ETH to sell: halfDebt (6-dec USDC) → 18-dec → divide by price → ETH amount.
      const ethToSell = halfDebt * 10n ** 12n * 10n ** 18n / ETH_PRICE_18;
      await kashYield.connect(owner).spotSellOnHyperliquid(ethToSell);

      // Withdraw exactly halfDebt USDC from HL.
      const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
      await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

      // Repay 50% of Aave debt.
      if (halfDebt > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), halfDebt);
      // Handle interest dust.
      const debtAfterRepay = await mockAave.borrowedAmounts(await kashYield.getAddress());
      const expectedDebtRemaining = totalDebt - halfDebt;
      if (debtAfterRepay > expectedDebtRemaining) {
        const dust = debtAfterRepay - expectedDebtRemaining;
        await mockUsdc.mint(await kashYield.getAddress(), dust);
        await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dust);
      }

      // Withdraw 50% of Aave ETH.
      const halfAave = fullAave / 2n;
      await kashYield.connect(owner).withdrawFromAave(halfAave);

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // user1 received ETH.
      const ethAfter = await ethers.provider.getBalance(user1.address);
      expect(ethAfter).to.be.gt(ethBefore);

      // user2's Kash tokens are untouched.
      expect(await kashToken.balanceOf(user2.address)).to.equal(kash2);

      // Roughly 50% of the Aave and HL short positions remain open.
      const aaveRemaining    = await mockAave.suppliedAmounts(await kashYield.getAddress());
      const [shortRemaining] = await kashYield.getHyperliquidPosition("ETH");
      expect(aaveRemaining).to.be.closeTo(halfAave, halfAave / 10n, "half Aave ETH should remain");
      expect(shortRemaining).to.be.closeTo(halfShort, halfShort / 10n, "half HL short should remain");
    });

    it("BTC: partial BTC redeem leaves remaining user's position intact", async function () {
      const ctx = await deployBtcFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockWbtc, mockAave, mockHl, hlAdapter } = ctx;

      const MINT_EACH = 1n * 10n ** 8n;

      await mockWbtc.mint(user1.address, MINT_EACH);
      await mockWbtc.mint(user2.address, MINT_EACH);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_EACH);
      await mockWbtc.connect(user2).approve(await kashYield.getAddress(), MINT_EACH);
      await kashYield.connect(user1).requestMint(MINT_EACH);
      await kashYield.connect(user2).requestMint(MINT_EACH);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, mintCycle, MINT_EACH * 2n);

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);
      const [fullShortSize] = await kashYield.getHyperliquidPosition("BTC");
      const fullAave = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());

      await nextCycle();
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashYield.connect(user1).requestRedeem(kash1);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");

      const halfShort = fullShortSize / 2n;
      await kashYield.connect(owner)["closeShort(string,uint256)"]("BTC", halfShort);

      // Same as ETH partial redeem: spotBalances=0 after spot buy, so sell BTC to get USDC.
      const totalDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
      const halfDebt  = totalDebt / 2n;
      // BTC to sell: halfDebt (6-dec USDC) → 18-dec → divide by BTC price → BTC (18-dec internal)
      const btcToSell = halfDebt * 10n ** 12n * 10n ** 18n / BTC_PRICE_18;
      await kashYield.connect(owner).spotSellOnHyperliquid(btcToSell);

      const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
      await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

      if (halfDebt > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), halfDebt);
      const remainingDebt = await mockAave.borrowedAmounts(await kashYield.getAddress());
      const expectedRemaining = totalDebt - halfDebt;
      if (remainingDebt > expectedRemaining) {
        const dust = remainingDebt - expectedRemaining;
        await mockUsdc.mint(await kashYield.getAddress(), dust);
        await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dust);
      }

      const halfAave = fullAave / 2n;
      await kashYield.connect(owner).withdrawFromAave(halfAave);

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      expect(await mockWbtc.balanceOf(user1.address)).to.be.gt(0n, "user1 should receive wBTC");
      expect(await kashToken.balanceOf(user2.address)).to.equal(kash2, "user2 Kash unchanged");

      const aaveRemaining   = await mockAave.suppliedWbtcAmounts(await kashYield.getAddress());
      const [shortRemaining] = await kashYield.getHyperliquidPosition("BTC");
      expect(aaveRemaining).to.be.closeTo(halfAave, halfAave / 10n);
      expect(shortRemaining).to.be.closeTo(halfShort, halfShort / 10n);
    });
  });

  // ── 4. Price change scenarios ─────────────────────────────────────────────────
  describe("Price change scenarios", function () {
    it("BTC price decrease ($45k→$40k): user receives MORE BTC (short profits offset lower price)", async function () {
      const ctx = await deployBtcFixture();
      const { owner, bot, user1, kashYield, kashToken, mockWbtc, mockFeed } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, mintCycle, MINT_BTC);

      const kashBalance = await kashToken.balanceOf(user1.address);

      // Drop BTC to $40,000.
      const NEW_BTC = 40_000n;
      await nextCycle();
      await setAllBtcPrices(ctx, NEW_BTC);
      expect(await kashYield.getBtcPrice()).to.equal(NEW_BTC * 10n ** 18n);

      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllBtcPositions(ctx, MINT_BTC, NEW_BTC * 10n ** 18n);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // At $40k, user's Kash (~$44,955) → $44,955/$40,000 ≈ 1.124 BTC.
      // User should receive MORE than the 1 BTC they deposited.
      const wbtcReceived = await mockWbtc.balanceOf(user1.address);
      expect(wbtcReceived).to.be.gt(MINT_BTC, "user should receive more BTC when price falls");
      // Within 5% of the expected 1.124 BTC.
      const expected = 44955n * 10n ** 8n / 40000n; // ≈ 1.124 BTC in 8-dec
      expect(wbtcReceived).to.be.closeTo(expected, expected / 20n);
    });

    it("BTC price increase ($45k→$48k): user receives LESS BTC (short loss, same USD value)", async function () {
      const ctx = await deployBtcFixture();
      const { owner, bot, user1, kashYield, kashToken, mockWbtc } = ctx;

      const MINT_BTC = 1n * 10n ** 8n;
      await mockWbtc.mint(user1.address, MINT_BTC);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_BTC);
      await kashYield.connect(user1).requestMint(MINT_BTC);
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, mintCycle, MINT_BTC);

      const kashBalance = await kashToken.balanceOf(user1.address);

      // Rise BTC to $48,000 (6.7% — safely below mock liquidation threshold).
      const NEW_BTC = 48_000n;
      await nextCycle();
      await setAllBtcPrices(ctx, NEW_BTC);

      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllBtcPositions(ctx, MINT_BTC, NEW_BTC * 10n ** 18n);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // At $48k, user's Kash (~$44,955) → $44,955/$48,000 ≈ 0.937 BTC.
      // User should receive LESS than the 1 BTC they deposited.
      const wbtcReceived = await mockWbtc.balanceOf(user1.address);
      expect(wbtcReceived).to.be.lt(MINT_BTC, "user should receive less BTC when price rises");
      const expected = 44955n * 10n ** 8n / 48000n; // ≈ 0.937 BTC in 8-dec
      expect(wbtcReceived).to.be.closeTo(expected, expected / 20n);
    });

    it("ETH price increase ($3k→$3.2k): user receives LESS ETH (short loss, same USD value)", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, kashYield, kashToken } = ctx;

      const MINT_ETH = ethers.parseEther("1");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT_ETH);

      const kashBalance = await kashToken.balanceOf(user1.address);

      // Rise ETH to $3,200 (6.7% — safely below mock liquidation threshold).
      const NEW_ETH = 3_200n;
      await nextCycle();
      await setAllEthPrices(ctx, NEW_ETH);

      await kashToken.connect(user1).approve(await kashYield.getAddress(), kashBalance);
      await kashYield.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      const ethBefore = await ethers.provider.getBalance(user1.address);
      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllEthPositions(ctx, MINT_ETH, NEW_ETH * 10n ** 18n);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // At $3,200, user's Kash (~$2,997) → $2,997/$3,200 ≈ 0.937 ETH.
      const ethAfter   = await ethers.provider.getBalance(user1.address);
      const ethGained  = ethAfter - ethBefore;
      // Should receive approximately 0.937 ETH (less than the 1 ETH deposited).
      expect(ethGained).to.be.lt(MINT_ETH, "user should receive less ETH when price rises");
      const expected = 2997n * 10n ** 18n / 3200n; // ≈ 0.937 ETH
      expect(ethGained).to.be.closeTo(expected, expected / 10n); // within 10%
    });

    it("BTC: cumulative mint then redeem with price drop — both users settle correctly", async function () {
      const ctx = await deployBtcFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockWbtc, mockAave, mockHl } = ctx;

      const MINT_EACH = 1n * 10n ** 8n;

      // Cycle 1: user1 mints at $45k.
      await mockWbtc.mint(user1.address, MINT_EACH);
      await mockWbtc.connect(user1).approve(await kashYield.getAddress(), MINT_EACH);
      await kashYield.connect(user1).requestMint(MINT_EACH);
      const cycle1 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runBtcMintCycle(ctx, cycle1, MINT_EACH);

      // Price drops to $42k before cycle 2.
      await nextCycle();
      await setAllBtcPrices(ctx, 42_000n);

      // Cycle 2: user2 mints 1 BTC at $42k.
      await mockWbtc.mint(user2.address, MINT_EACH);
      await mockWbtc.connect(user2).approve(await kashYield.getAddress(), MINT_EACH);
      await kashYield.connect(user2).requestMint(MINT_EACH);
      const cycle2 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      await kashYield.connect(owner).depositToAave(MINT_EACH);
      const NEW_BTC_PRICE_18 = 42_000n * 10n ** 18n;
      const btcUsd2   = MINT_EACH * NEW_BTC_PRICE_18 / (10n ** 8n);
      const borrow2   = btcUsd2 * 70n / 100n / (10n ** 12n);
      await kashYield.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrow2);
      await kashYield.connect(owner).depositToHyperliquid(borrow2);
      await kashYield.connect(owner).spotBuyOnHyperliquid(borrow2);
      const short2 = btcUsd2 * 170n / 100n * (10n ** 18n) / NEW_BTC_PRICE_18;
      await kashYield.connect(owner).openShort("BTC", short2);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(cycle2);
      await kashYield.connect(bot).performUpkeep("0x");

      const kash1 = await kashToken.balanceOf(user1.address);
      const kash2 = await kashToken.balanceOf(user2.address);
      // user2 minted at $42k → fewer Kash than user1 at $45k.
      expect(kash2).to.be.lt(kash1, "user2 at lower price should have fewer Kash tokens");

      // Both redeem in cycle 3 (price still at $42k).
      await nextCycle();
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashToken.connect(user2).approve(await kashYield.getAddress(), kash2);
      await kashYield.connect(user1).requestRedeem(kash1);
      await kashYield.connect(user2).requestRedeem(kash2);
      const cycle3 = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");
      await unwindAllBtcPositions(ctx, MINT_EACH * 2n, 42_000n * 10n ** 18n);
      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(cycle3);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(cycle3)).to.be.true;

      // Both users receive wBTC.
      expect(await mockWbtc.balanceOf(user1.address)).to.be.gt(0n);
      expect(await mockWbtc.balanceOf(user2.address)).to.be.gt(0n);
      expect(await kashToken.totalSupply()).to.equal(0n);
    });

    it("ETH: partial redeem after price increase — remaining position stays open", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, user2, kashYield, kashToken, mockUsdc, mockAave, mockHl, hlAdapter } = ctx;

      const MINT_EACH = ethers.parseEther("1");

      // Cycle 1: both users mint at $3k.
      await kashYield.connect(user1).requestMint(0, { value: MINT_EACH });
      await kashYield.connect(user2).requestMint(0, { value: MINT_EACH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT_EACH * 2n);

      const kash1 = await kashToken.balanceOf(user1.address);
      const [fullShort] = await kashYield.getHyperliquidPosition("ETH");

      // Price rises to $3,200 before cycle 2.
      await nextCycle();
      await setAllEthPrices(ctx, 3_200n);

      // Cycle 2: user1 only redeems.
      await kashToken.connect(user1).approve(await kashYield.getAddress(), kash1);
      await kashYield.connect(user1).requestRedeem(kash1);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYield.connect(bot).performUpkeep("0x");

      // Partially close 50% of HL short (collateral ETH returned to ethBalance at new price).
      const halfShort = fullShort / 2n;
      await kashYield.connect(owner)["closeShort(string,uint256)"]("ETH", halfShort);

      // spotBalances=0 after spot buy — sell enough HL ETH to cover 50% of Aave debt.
      const totalDebt   = await mockAave.borrowedAmounts(await kashYield.getAddress());
      const halfDebt    = totalDebt / 2n;
      const NEW_PRICE18 = 3_200n * 10n ** 18n;
      const ethToSell   = halfDebt * 10n ** 12n * 10n ** 18n / NEW_PRICE18;
      await kashYield.connect(owner).spotSellOnHyperliquid(ethToSell);

      const hlSpot = await mockHl.spotBalances(await hlAdapter.getAddress());
      if (hlSpot > 0n) await kashYield.connect(owner).withdrawFromHyperliquid(hlSpot);

      if (halfDebt > 0n) await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), halfDebt);
      const remaining = await mockAave.borrowedAmounts(await kashYield.getAddress());
      if (remaining > totalDebt - halfDebt) {
        const dust = remaining - (totalDebt - halfDebt);
        await mockUsdc.mint(await kashYield.getAddress(), dust);
        await kashYield.connect(owner).repayToAave(await mockUsdc.getAddress(), dust);
      }

      // Withdraw 50% of Aave ETH.
      const fullAave = await mockAave.suppliedAmounts(await kashYield.getAddress());
      await kashYield.connect(owner).withdrawFromAave(fullAave / 2n);

      // Convert any remaining surplus USDC to ETH for user1's redemption at new price.
      const surplusUsdc = await mockUsdc.balanceOf(await kashYield.getAddress());
      if (surplusUsdc > 0n) await kashYield.connect(owner).swapFromUsdc(surplusUsdc);

      await kashYield.connect(owner).updateNAV(NAV_1);
      await kashYield.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYield.connect(bot).performUpkeep("0x");
      expect(await kashYield.batchProcessed(redeemCycle)).to.be.true;

      // user2 still has their Kash tokens.
      const kash2 = await kashToken.balanceOf(user2.address);
      expect(kash2).to.be.gt(0n, "user2 Kash tokens should be unchanged");

      // Remaining HL short is approximately half.
      const [shortRemaining] = await kashYield.getHyperliquidPosition("ETH");
      expect(shortRemaining).to.be.closeTo(halfShort, halfShort / 10n);
    });
  });

  // ── 5. Multiple simultaneous perp exchange adapters ──────────────────────────
  describe("Multiple simultaneous perp exchange adapters", function () {
    it("three adapters (HL, GMX, ASTER) can be registered in the registry simultaneously", async function () {
      const ctx = await deployEthFixture();
      const { kashYield, mockUsdc } = ctx;

      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const gmxAdapter   = await MockPerpExchange.deploy(
        await mockUsdc.getAddress(), ethers.ZeroAddress, true, ETH_PRICE_18
      );
      const asterAdapter = await MockPerpExchange.deploy(
        await mockUsdc.getAddress(), ethers.ZeroAddress, true, ETH_PRICE_18
      );

      // HL is already registered (first-time bypass in fixture).
      // Subsequent adapters: setPerpExchange proposes, confirmPerpExchange makes live (delay=0 → immediate).
      await kashYield.setPerpExchange("GMX",   await gmxAdapter.getAddress());
      await kashYield.confirmPerpExchange("GMX");

      await kashYield.setPerpExchange("ASTER", await asterAdapter.getAddress());
      await kashYield.confirmPerpExchange("ASTER");

      expect(await kashYield.perpExchanges("HL"))
        .to.not.equal(ethers.ZeroAddress, "HL adapter should be registered");
      expect(await kashYield.perpExchanges("GMX"))
        .to.equal(await gmxAdapter.getAddress(),   "GMX adapter should be registered");
      expect(await kashYield.perpExchanges("ASTER"))
        .to.equal(await asterAdapter.getAddress(), "ASTER adapter should be registered");

      // All three can be set as the active exchange.
      await kashYield.setActivePerpExchange("GMX");
      expect(await kashYield.activePerpExchange()).to.equal("GMX");
      await kashYield.setActivePerpExchange("ASTER");
      expect(await kashYield.activePerpExchange()).to.equal("ASTER");
      await kashYield.setActivePerpExchange("HL");
      expect(await kashYield.activePerpExchange()).to.equal("HL");
    });

    it("positions on HL and GMX are tracked independently by their respective mock contracts", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, kashYield, kashToken, mockUsdc, mockHl, hlAdapter } = ctx;

      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const gmxMock = await MockPerpExchange.deploy(
        await mockUsdc.getAddress(), ethers.ZeroAddress, true, ETH_PRICE_18
      );
      // propose + confirm (delay=0 → immediate)
      await kashYield.setPerpExchange("GMX", await gmxMock.getAddress());
      await kashYield.confirmPerpExchange("GMX");

      // Mint 2 ETH and run full mint cycle on HL.
      const MINT_ETH = ethers.parseEther("2");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT_ETH);

      // ── HL position is now open ───────────────────────────────────────────
      const [hlSizeCheck, , , , hlActiveCheck] = await kashYield.getHyperliquidPosition("ETH");
      expect(hlActiveCheck).to.be.true;
      expect(hlSizeCheck).to.be.gt(0n);

      // ── Switch to GMX, build asset balance, open position ─────────────────
      await kashYield.setActivePerpExchange("GMX");
      expect(await kashYield.activePerpExchange()).to.equal("GMX");

      // Give KashYield USDC and do a spot buy on GMX to build assetBalances[gmxAdapter].
      // MockPerpExchange.tradeSpot(USDC→ETH) pulls USDC from KashYield and credits assetBalances.
      const gmxUsdc = 6_000n * 10n ** 6n; // $6,000 → 2 ETH at $3,000
      await mockUsdc.mint(await kashYield.getAddress(), gmxUsdc);
      await kashYield.connect(owner).spotBuyOnHyperliquid(gmxUsdc);
      // assetBalances[gmxAdapter] = 2e18 (2 ETH)

      // Open a 0.85 ETH short on GMX (collateral = 0.085 ETH, requires assetBalances >= 0.085e18).
      const gmxShortSize = ethers.parseEther("0.85");
      await kashYield.connect(owner).openShort("ETH", gmxShortSize);

      // GMX mock shows the position.
      const [gmxSize, , , , gmxActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(gmxActive).to.be.true;
      expect(gmxSize).to.equal(gmxShortSize);

      // ── Switch back to HL and verify its position is still intact ──────────
      await kashYield.setActivePerpExchange("HL");
      const [hlSize, , , , hlActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(hlActive).to.be.true;
      expect(hlSize).to.equal(hlSizeCheck, "HL position unchanged after GMX operations");
    });

    it("switching back to HL and closing position works after having opened on GMX", async function () {
      const ctx = await deployEthFixture();
      const { owner, bot, user1, kashYield, mockUsdc } = ctx;

      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const gmxMock = await MockPerpExchange.deploy(
        await mockUsdc.getAddress(), ethers.ZeroAddress, true, ETH_PRICE_18
      );
      await kashYield.setPerpExchange("GMX", await gmxMock.getAddress());
      await kashYield.confirmPerpExchange("GMX");

      // Full mint cycle on HL → HL has an open short.
      const MINT_ETH = ethers.parseEther("2");
      await kashYield.connect(user1).requestMint(0, { value: MINT_ETH });
      const mintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      await runEthMintCycle(ctx, mintCycle, MINT_ETH);

      // Switch to GMX, build asset balance, open short on GMX.
      await kashYield.setActivePerpExchange("GMX");
      const gmxUsdc = 3_000n * 10n ** 6n;
      await mockUsdc.mint(await kashYield.getAddress(), gmxUsdc);
      await kashYield.connect(owner).spotBuyOnHyperliquid(gmxUsdc); // builds assetBalances
      await kashYield.connect(owner).openShort("ETH", ethers.parseEther("0.85"));

      // GMX position is active.
      let [, , , , gmxActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(gmxActive).to.be.true;

      // Close GMX position.
      await kashYield.connect(owner)["closeShort(string)"]("ETH");
      [, , , , gmxActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(gmxActive).to.be.false;

      // Switch back to HL — HL short is still open.
      await kashYield.setActivePerpExchange("HL");
      let [, , , , hlActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(hlActive).to.be.true;

      // Close HL short.
      await kashYield.connect(owner)["closeShort(string)"]("ETH");
      [, , , , hlActive] = await kashYield.getHyperliquidPosition("ETH");
      expect(hlActive).to.be.false;
    });

    it("partial close on GMX leaves correct residual size", async function () {
      const ctx = await deployEthFixture();
      const { owner, kashYield, mockUsdc } = ctx;

      const MockPerpExchange = await ethers.getContractFactory("MockPerpExchange");
      const gmxMock = await MockPerpExchange.deploy(
        await mockUsdc.getAddress(), ethers.ZeroAddress, true, ETH_PRICE_18
      );
      // propose + confirm + activate
      await kashYield.setPerpExchange("GMX", await gmxMock.getAddress());
      await kashYield.confirmPerpExchange("GMX");
      await kashYield.setActivePerpExchange("GMX");

      // Build assetBalances via spot buy (MockPerpExchange.tradeSpot USDC→ETH).
      const usdc = 60_000n * 10n ** 6n; // $60,000 → 20 ETH at $3,000
      await mockUsdc.mint(await kashYield.getAddress(), usdc);
      await kashYield.connect(owner).spotBuyOnHyperliquid(usdc); // assetBalances[gmxAdapter] += 20 ETH

      // Open a 2 ETH short on GMX (collateral = 0.2 ETH, well within 20 ETH assetBalances).
      const fullSize = ethers.parseEther("2");
      await kashYield.connect(owner).openShort("ETH", fullSize);
      let [size] = await kashYield.getHyperliquidPosition("ETH");
      expect(size).to.equal(fullSize);

      // Partially close 50%.
      const halfSize = fullSize / 2n;
      await kashYield.connect(owner)["closeShort(string,uint256)"]("ETH", halfSize);
      [size] = await kashYield.getHyperliquidPosition("ETH");
      expect(size).to.equal(halfSize, "residual GMX position should be half the original");
    });
  });
});
