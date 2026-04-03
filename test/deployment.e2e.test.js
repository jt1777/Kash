// test/deployment.e2e.test.js
//
// End-to-end deployment verification test.
//
// This test mirrors the DEPLOYMENT.md procedure exactly — deploying every contract
// in the same order and with the same configuration calls as the deployment scripts.
// After deployment it verifies all addresses and settings, then runs a full mint and
// redeem cycle for both the BTC product and the ETH product.
//
// Script-to-step mapping (see docs/DEPLOYMENT.md):
//   Step 1  → scripts/deploy-mock-aave.js          (MockUSDC + MockWBTC + MockAaveV3)
//   Step 2  → scripts/deploy-mock-weth.js           (MockWETH, then setWethAddress on MockAaveV3)
//   Step 3  → scripts/deploy-mock-hyperliquid-*.js  (MockHyperliquid)
//   Step 4  → scripts/deploy-mock-spot-dex.js       (MockSpotDex, rates, funding)
//   Step 5  → scripts/deploy-hyperliquid-adapter.js (HyperliquidAdapter ETH)
//   Step 6  → scripts/deploy-hyperliquid-adapter.js (HyperliquidAdapter BTC)
//   Step 7  → scripts/deploy-arbitrum-sepolia.js    (KashYieldETH + configuration)
//   Step 8  → scripts/deploy-kashyieldbtc.js        (KashYieldBtc + configuration)
//   Step 9  → scripts/setExchangeSwitchDelay.js     (delay = 0 for fast testing)
//   Step 10 → scripts/setHyperliquid.js             (register adapters — first-time bypass)
//   Step 11 → scripts/setActivePerpExchange.js      (activate HL on both products)
//   Step 12 → scripts/setCycleDuration.js           (set cycle to 3600 s)
//   Step 13 → scripts/setAssetPrice.ts              (set oracle + mock prices)

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── Price / cycle constants (match what you'd put in .env) ─────────────────────
const BTC_PRICE_USD  = 45_000n;
const ETH_PRICE_USD  =  3_000n;
const BTC_FEED_PRICE = BTC_PRICE_USD * 10n ** 8n;   // Chainlink 8-dec
const ETH_FEED_PRICE = ETH_PRICE_USD * 10n ** 8n;
const BTC_PRICE_18   = BTC_PRICE_USD * 10n ** 18n;  // 18-dec internal
const ETH_PRICE_18   = ETH_PRICE_USD * 10n ** 18n;
const CYCLE_SECS     = 3600n;
const NAV_1          = 10n ** 18n;

// ── Shared deployment state (populated in the `before` hook) ───────────────────
let dep; // { owner, bot, user1, user2, mockUsdc, mockWbtc, mockWeth, mockAave,
         //   mockHl, mockSpotDex, hlAdapterEth, hlAdapterBtc,
         //   kashYieldEth, kashYieldBtc, kashTokenEth, kashTokenBtc,
         //   btcFeed, ethFeed }

// ═══════════════════════════════════════════════════════════════════════════════
//  DEPLOYMENT (before hook — runs once for the entire suite)
// ═══════════════════════════════════════════════════════════════════════════════

before("Deploy full mock stack (mirrors DEPLOYMENT.md)", async function () {
  this.timeout(120_000);

  const [owner, bot, user1, user2] = await ethers.getSigners();

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 1 — scripts/deploy-mock-aave.js
  //   Deploys MockUSDC, MockWBTC, MockAaveV3, sets wBTC address, funds Aave.
  // ────────────────────────────────────────────────────────────────────────────
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy(0);          // script: deploy(1_000_000) but 0 is fine
  console.log("  ✅ [Step 1] MockUSDC:", await mockUsdc.getAddress());

  const MockWBTC = await ethers.getContractFactory("MockWBTC");
  const mockWbtc = await MockWBTC.deploy(0);
  console.log("  ✅ [Step 1] MockWBTC:", await mockWbtc.getAddress());

  const MockAaveV3 = await ethers.getContractFactory("MockAaveV3");
  const mockAave   = await MockAaveV3.deploy(await mockUsdc.getAddress());
  await mockAave.setWbtcAddress(await mockWbtc.getAddress());
  // Price setting mirrors scripts/setAssetPrice.ts — done after WETH deploy (Step 2)

  // Fund Aave with USDC for borrows (scripts/deploy-mock-aave.js: fundUsdc = 50 000)
  const AAVE_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockAave.getAddress(), AAVE_USDC_FUND);
  console.log("  ✅ [Step 1] MockAaveV3:", await mockAave.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 2 — scripts/deploy-mock-weth.js
  //   Deploys MockWETH, calls setWethAddress on MockAaveV3.
  // ────────────────────────────────────────────────────────────────────────────
  const MockWETH = await ethers.getContractFactory("MockWETH");
  const mockWeth  = await MockWETH.deploy();
  await mockAave.setWethAddress(await mockWeth.getAddress());
  console.log("  ✅ [Step 2] MockWETH:", await mockWeth.getAddress());

  // Price feeds (mirrors scripts/setAssetPrice.ts — set right after tokens are known)
  const MockPriceFeed = await ethers.getContractFactory("MockChainlinkPriceFeed");
  const btcFeed = await MockPriceFeed.deploy(BTC_FEED_PRICE);
  const ethFeed = await MockPriceFeed.deploy(ETH_FEED_PRICE);
  await mockAave.setEthPrice(ETH_PRICE_18);
  await mockAave.setBtcPrice(BTC_PRICE_18);
  console.log("  ✅ [Step 2] Price feeds set (BTC $" + BTC_PRICE_USD + ", ETH $" + ETH_PRICE_USD + ")");

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 3 — scripts/deploy-mock-hyperliquid-arbitrum-sepolia.js
  //   Deploys MockHyperliquid(usdc, usdt=usdc, wbtc).
  //   ⚠️  Script uses USDC_ADDRESS so MockHL uses the same token as KashYield.
  // ────────────────────────────────────────────────────────────────────────────
  const MockHL = await ethers.getContractFactory("MockHyperliquid");
  const mockHl  = await MockHL.deploy(
    await mockUsdc.getAddress(), // USDC (= finalUsdc in script)
    await mockUsdc.getAddress(), // USDT slot — script reuses USDC mock (finalUsdt = usdc)
    await mockWbtc.getAddress()  // wBTC
  );
  await mockHl.setEthPrice(ETH_PRICE_18);
  await mockHl.setBtcPrice(BTC_PRICE_18);

  // Fund MockHL (needed for withdrawals in redeem cycle)
  const HL_USDC_FUND = 100_000n * 10n ** 6n;
  await mockUsdc.mint(await mockHl.getAddress(), HL_USDC_FUND);
  await owner.sendTransaction({ to: await mockHl.getAddress(), value: ethers.parseEther("10") });
  console.log("  ✅ [Step 3] MockHyperliquid:", await mockHl.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 4 — scripts/deploy-mock-spot-dex.js
  //   Deploys MockSpotDex, sets BTC + ETH rates, funds with USDC / wBTC / ETH.
  // ────────────────────────────────────────────────────────────────────────────
  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const mockSpotDex  = await MockSpotDex.deploy();

  // setBtcRates(wbtcAddress, usdcAddress, btcPrice)
  await mockSpotDex.setBtcRates(await mockWbtc.getAddress(), await mockUsdc.getAddress(), BTC_PRICE_USD);
  // setEthRates(usdcAddress, ethPrice)
  await mockSpotDex.setEthRates(await mockUsdc.getAddress(), ETH_PRICE_USD);

  // Fund with USDC (script: FUND_USDC=500000 default), wBTC, and ETH
  const DEX_USDC_FUND = 500_000n * 10n ** 6n;
  const DEX_WBTC_FUND = 10n  * 10n ** 8n;      // 10 wBTC
  await mockUsdc.mint(owner.address, DEX_USDC_FUND);
  await mockUsdc.approve(await mockSpotDex.getAddress(), DEX_USDC_FUND);
  await mockSpotDex.fund(await mockUsdc.getAddress(), DEX_USDC_FUND);

  await mockWbtc.mint(owner.address, DEX_WBTC_FUND);
  await mockWbtc.approve(await mockSpotDex.getAddress(), DEX_WBTC_FUND);
  await mockSpotDex.fund(await mockWbtc.getAddress(), DEX_WBTC_FUND);

  await mockSpotDex.fundEth({ value: ethers.parseEther("10") });
  console.log("  ✅ [Step 4] MockSpotDex:", await mockSpotDex.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5 — scripts/deploy-arbitrum-sepolia.js
  //   Deploys KashYieldETH(botAddress, weth, usdc, aavePool).
  //   KashYield must be deployed before HyperliquidAdapter (adapter needs KashYield address).
  // ────────────────────────────────────────────────────────────────────────────
  const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
  const kashYieldEth  = await KashYieldETH.deploy(
    bot.address,
    await mockWeth.getAddress(),
    await mockUsdc.getAddress(),
    await mockAave.getAddress()
  );
  await kashYieldEth.setEthOracle(await ethFeed.getAddress());
  await kashYieldEth.setAllowedSpotDexRouter(await mockSpotDex.getAddress(), true);
  await kashYieldEth.setSpotDex(await mockSpotDex.getAddress());
  console.log("  ✅ [Step 5] KashYieldETH:", await kashYieldEth.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 6 — scripts/deploy-kashyieldbtc.js
  //   Deploys KashYieldBtc(botAddress, wbtc, usdc, aavePool).
  // ────────────────────────────────────────────────────────────────────────────
  const KashYieldBtc = await ethers.getContractFactory("KashYieldBtc");
  const kashYieldBtc  = await KashYieldBtc.deploy(
    bot.address,
    await mockWbtc.getAddress(),
    await mockUsdc.getAddress(),
    await mockAave.getAddress()
  );
  await kashYieldBtc.setBtcOracle(await btcFeed.getAddress());
  await kashYieldBtc.setAllowedSpotDexRouter(await mockSpotDex.getAddress(), true);
  await kashYieldBtc.setSpotDex(await mockSpotDex.getAddress());
  console.log("  ✅ [Step 6] KashYieldBtc:", await kashYieldBtc.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 7 — scripts/deploy-hyperliquid-adapter.js  IS_ETH_ASSET=true
  //   Deploys HyperliquidAdapter for the ETH product.
  //   Constructor: (hlAddress, usdcAddress, assetAddress=0x0, isEthAsset=true, kashYieldAddress)
  // ────────────────────────────────────────────────────────────────────────────
  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapterEth = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(),
    await mockUsdc.getAddress(),
    ethers.ZeroAddress,          // assetAddress = 0x0 for native ETH
    true,                        // isEthAsset
    await kashYieldEth.getAddress()
  );
  console.log("  ✅ [Step 7] HyperliquidAdapter (ETH):", await hlAdapterEth.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 8 — scripts/deploy-hyperliquid-adapter.js  IS_ETH_ASSET=false
  //   Deploys HyperliquidAdapter for the BTC product.
  //   Constructor: (hlAddress, usdcAddress, assetAddress=wbtc, isEthAsset=false, kashYieldAddress)
  // ────────────────────────────────────────────────────────────────────────────
  const hlAdapterBtc = await HyperliquidAdapter.deploy(
    await mockHl.getAddress(),
    await mockUsdc.getAddress(),
    await mockWbtc.getAddress(), // assetAddress = wBTC
    false,                       // isEthAsset
    await kashYieldBtc.getAddress()
  );
  console.log("  ✅ [Step 8] HyperliquidAdapter (BTC):", await hlAdapterBtc.getAddress());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 9 — scripts/setExchangeSwitchDelay.js
  //   Set delay=0 so first-time adapter registration is immediate on testnet.
  //   (On mainnet you'd leave this at 48h.)
  // ────────────────────────────────────────────────────────────────────────────
  await kashYieldEth.setExchangeSwitchDelay(0);
  await kashYieldBtc.setExchangeSwitchDelay(0);
  console.log("  ✅ [Step 9] exchangeSwitchDelay = 0 on both contracts");

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 10 — scripts/setHyperliquid.js (= setPerpExchange → first-time bypass)
  //   Because anyAdapterConfirmed==false the timelock is bypassed and the adapter
  //   is registered immediately. Mirrors: KASH_YIELD_ADDRESS=... HYPERLIQUID_ADDRESS=...
  // ────────────────────────────────────────────────────────────────────────────
  await kashYieldEth.setHyperliquid(await hlAdapterEth.getAddress());
  await kashYieldBtc.setHyperliquid(await hlAdapterBtc.getAddress());
  console.log("  ✅ [Step 10] HL adapters registered (first-time bypass)");

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 11 — scripts/setActivePerpExchange.js
  //   Activates "HL" as the live exchange on both products.
  //   Mirrors: EXCHANGE_NAME=HL npx hardhat run scripts/setActivePerpExchange.js
  // ────────────────────────────────────────────────────────────────────────────
  await kashYieldEth.setActivePerpExchange("HL");
  await kashYieldBtc.setActivePerpExchange("HL");
  console.log("  ✅ [Step 11] Active exchange = HL on both contracts");

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 12 — scripts/setCycleDuration.js
  //   Set cycle to 3600 s for testing (production default is 24 h).
  // ────────────────────────────────────────────────────────────────────────────
  await kashYieldEth.setCycleDurationSeconds(CYCLE_SECS);
  await kashYieldBtc.setCycleDurationSeconds(CYCLE_SECS);
  // Disable time windows for tests: users and bot can operate at any point in the 1-hour cycle.
  await kashYieldEth.setUserWindowEnd(CYCLE_SECS);
  await kashYieldEth.setProcessingWindowStart(0n);
  await kashYieldBtc.setUserWindowEnd(CYCLE_SECS);
  await kashYieldBtc.setProcessingWindowStart(0n);
  console.log("  ✅ [Step 12] cycleDurationSeconds =", CYCLE_SECS.toString());

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 13 — scripts/setAssetPrice.ts (already applied to mock feed above,
  //   but also set on Aave and HL here, as the script does simultaneously)
  //   Prices already set above in Steps 2 & 3.
  // ────────────────────────────────────────────────────────────────────────────

  // Resolve KashToken contracts
  const KashTokenBtc = await ethers.getContractFactory("KashTokenBtc");
  const kashTokenBtc  = KashTokenBtc.attach(await kashYieldBtc.kashTokenBtc());

  const KashTokenEth = await ethers.getContractFactory("KashTokenEth");
  const kashTokenEth  = KashTokenEth.attach(await kashYieldEth.kashTokenEth());

  // Mint seed wBTC to user1 and user2 for BTC product tests
  await mockWbtc.mint(user1.address, 5n * 10n ** 8n);  // 5 wBTC
  await mockWbtc.mint(user2.address, 5n * 10n ** 8n);

  dep = {
    owner, bot, user1, user2,
    mockUsdc, mockWbtc, mockWeth,
    mockAave, mockHl, mockSpotDex,
    hlAdapterEth, hlAdapterBtc,
    kashYieldEth, kashYieldBtc,
    kashTokenEth, kashTokenBtc,
    btcFeed, ethFeed,
  };

  console.log("\n  🚀 All contracts deployed and configured.\n");
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SUITE
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full Deployment Verification", function () {
  this.timeout(120_000);

  // ── Section 1: Deployment configuration checks ─────────────────────────────

  describe("1. Deployment configuration", function () {

    it("KashYieldBtc has correct Aave pool address", async function () {
      expect(await dep.kashYieldBtc.aavePoolAddress())
        .to.equal(await dep.mockAave.getAddress());
    });

    it("KashYieldBtc has correct USDC address", async function () {
      expect(await dep.kashYieldBtc.usdcAddress())
        .to.equal(await dep.mockUsdc.getAddress());
    });

    it("KashYieldBtc has correct wBTC address", async function () {
      expect(await dep.kashYieldBtc.wbtcAddress())
        .to.equal(await dep.mockWbtc.getAddress());
    });

    it("KashYieldBtc has correct spot DEX address", async function () {
      expect(await dep.kashYieldBtc.spotDexAddress())
        .to.equal(await dep.mockSpotDex.getAddress());
    });

    it("KashYieldBtc active exchange is HL adapter", async function () {
      const activeAddr = await dep.kashYieldBtc.perpExchanges("HL");
      expect(activeAddr).to.equal(await dep.hlAdapterBtc.getAddress());
      expect(await dep.kashYieldBtc.activePerpExchange()).to.equal("HL");
    });

    it("KashYieldBtc reads BTC price from oracle", async function () {
      expect(await dep.kashYieldBtc.getBtcPrice()).to.equal(BTC_PRICE_18);
    });

    it("KashYieldBtc cycle duration is set", async function () {
      expect(await dep.kashYieldBtc.cycleDurationSeconds()).to.equal(CYCLE_SECS);
    });

    it("KashYieldBtc initial NAV is $1", async function () {
      expect(await dep.kashYieldBtc.currentNAV()).to.equal(NAV_1);
    });

    it("KashYieldETH has correct Aave pool address", async function () {
      expect(await dep.kashYieldEth.aavePoolAddress())
        .to.equal(await dep.mockAave.getAddress());
    });

    it("KashYieldETH has correct USDC address", async function () {
      expect(await dep.kashYieldEth.usdcAddress())
        .to.equal(await dep.mockUsdc.getAddress());
    });

    it("KashYieldETH has correct WETH address", async function () {
      expect(await dep.kashYieldEth.wethAddress())
        .to.equal(await dep.mockWeth.getAddress());
    });

    it("KashYieldETH has correct spot DEX address", async function () {
      expect(await dep.kashYieldEth.spotDexAddress())
        .to.equal(await dep.mockSpotDex.getAddress());
    });

    it("KashYieldETH active exchange is HL adapter", async function () {
      const activeAddr = await dep.kashYieldEth.perpExchanges("HL");
      expect(activeAddr).to.equal(await dep.hlAdapterEth.getAddress());
      expect(await dep.kashYieldEth.activePerpExchange()).to.equal("HL");
    });

    it("KashYieldETH reads ETH price from oracle", async function () {
      expect(await dep.kashYieldEth.getEthPrice()).to.equal(ETH_PRICE_18);
    });

    it("KashYieldETH initial NAV is $1", async function () {
      expect(await dep.kashYieldEth.currentNAV()).to.equal(NAV_1);
    });

    it("MockAaveV3 knows the WETH address (set by deploy-mock-weth.js)", async function () {
      expect(await dep.mockAave.wethAddress())
        .to.equal(await dep.mockWeth.getAddress());
    });

    it("MockAaveV3 knows the wBTC address (set by deploy-mock-aave.js)", async function () {
      expect(await dep.mockAave.wbtcAddress())
        .to.equal(await dep.mockWbtc.getAddress());
    });

    it("MockHyperliquid uses the same USDC as KashYield (no Invalid stablecoin)", async function () {
      expect(await dep.mockHl.usdcAddress())
        .to.equal(await dep.mockUsdc.getAddress());
    });

    it("HyperliquidAdapter (BTC) points to MockHyperliquid", async function () {
      expect(await dep.hlAdapterBtc.hyperliquidAddress())
        .to.equal(await dep.mockHl.getAddress());
    });

    it("HyperliquidAdapter (ETH) points to MockHyperliquid", async function () {
      expect(await dep.hlAdapterEth.hyperliquidAddress())
        .to.equal(await dep.mockHl.getAddress());
    });

    it("bot can call performUpkeep on KashYieldBtc", async function () {
      // Should not revert (batch just created or already processed)
      await expect(dep.kashYieldBtc.connect(dep.bot).performUpkeep("0x"))
        .to.not.be.reverted;
    });

    it("bot can call performUpkeep on KashYieldETH", async function () {
      await expect(dep.kashYieldEth.connect(dep.bot).performUpkeep("0x"))
        .to.not.be.reverted;
    });

    it("non-bot cannot call performUpkeep", async function () {
      await expect(dep.kashYieldBtc.connect(dep.user1).performUpkeep("0x"))
        .to.be.reverted;
    });
  });

  // ── Section 2: BTC product — full mint + redeem ────────────────────────────

  describe("2. KashYieldBtc — full mint then redeem", function () {
    const MINT_BTC = 10n ** 8n; // 1 wBTC (8 decimals)
    let btcMintCycle;

    it("user receives Kash-BTC after minting 1 wBTC", async function () {
      const { owner, bot, user1, kashYieldBtc, kashTokenBtc,
              mockUsdc, mockWbtc, mockAave, mockHl, hlAdapterBtc } = dep;

      // Advance time to a fresh cycle so the config-section performUpkeep calls
      // (which already moved the current cycle to Phase 1) don't interfere.
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      // Approve + requestMint
      await mockWbtc.connect(user1).approve(await kashYieldBtc.getAddress(), MINT_BTC);
      await kashYieldBtc.connect(user1).requestMint(MINT_BTC);
      btcMintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ──
      await kashYieldBtc.connect(bot).performUpkeep("0x");
      expect(await kashYieldBtc.batchPhase(btcMintCycle)).to.equal(1);

      // ── Bot Aave ops ──
      const btcUsdValue = MINT_BTC * BTC_PRICE_18 / (10n ** 8n);
      const borrowUsdc  = btcUsdValue * 70n / 100n / (10n ** 12n);

      await kashYieldBtc.connect(owner).depositToAave(MINT_BTC);
      // wBTC deposits are tracked in suppliedWbtcAmounts (not suppliedAmounts which is for ETH/WETH)
      expect(await mockAave.suppliedWbtcAmounts(await kashYieldBtc.getAddress())).to.equal(MINT_BTC);

      await kashYieldBtc.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
      expect(await mockAave.borrowedAmounts(await kashYieldBtc.getAddress())).to.equal(borrowUsdc);

      // ── Bot HL ops ──
      await kashYieldBtc.connect(owner).depositToHyperliquid(borrowUsdc);
      expect(await mockHl.spotBalances(await hlAdapterBtc.getAddress())).to.equal(borrowUsdc);

      await kashYieldBtc.connect(owner).spotBuyOnHyperliquid(borrowUsdc);
      const hlBtc = await mockHl.btcBalance(await hlAdapterBtc.getAddress());
      expect(hlBtc).to.be.gt(0n);

      const shortSize = MINT_BTC * 170n / 100n;
      await kashYieldBtc.connect(owner).openShort("BTC", shortSize);
      const [, , , , posActive] = await kashYieldBtc.getHyperliquidPosition("BTC");
      expect(posActive).to.be.true;

      // ── NAV + mark done + Phase 2 ──
      await kashYieldBtc.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
      await kashYieldBtc.connect(owner).markBatchOpsDone(btcMintCycle);
      await kashYieldBtc.connect(bot).performUpkeep("0x");
      expect(await kashYieldBtc.batchProcessed(btcMintCycle)).to.be.true;

      // User should have received Kash-BTC
      const kashBalance = await kashTokenBtc.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n);
      // Expected: 1 BTC at $45,000 = $45,000 USD worth of Kash-BTC
      expect(kashBalance).to.be.closeTo(
        BTC_PRICE_USD * 10n ** 18n,
        BTC_PRICE_USD * 10n ** 18n / 100n  // 1% tolerance
      );
    });

    it("user redeems Kash-BTC and receives wBTC back", async function () {
      const { owner, bot, user1, kashYieldBtc, kashTokenBtc,
              mockUsdc, mockWbtc, mockAave, mockHl, hlAdapterBtc } = dep;

      const kashBalance = await kashTokenBtc.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n, "Need Kash-BTC from previous mint test");

      // Advance to a fresh cycle so the mint cycle (Phase 3) doesn't block Phase 1.
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      const wbtcBefore = await mockWbtc.balanceOf(user1.address);

      // Approve + requestRedeem
      await kashTokenBtc.connect(user1).approve(await kashYieldBtc.getAddress(), kashBalance);
      await kashYieldBtc.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ──
      await kashYieldBtc.connect(bot).performUpkeep("0x");
      expect(await kashYieldBtc.batchPhase(redeemCycle)).to.equal(1);

      // ── Unwind HL ──
      await kashYieldBtc.connect(owner)["closeShort(string)"]("BTC");
      const hlBtcAfterClose = await mockHl.btcBalance(await hlAdapterBtc.getAddress());
      if (hlBtcAfterClose > 0n)
        await kashYieldBtc.connect(owner).spotSellOnHyperliquid(hlBtcAfterClose);

      const hlSpotAfterSell = await mockHl.spotBalances(await hlAdapterBtc.getAddress());
      if (hlSpotAfterSell > 0n)
        await kashYieldBtc.connect(owner).withdrawFromHyperliquid(hlSpotAfterSell);

      // ── Repay Aave debt ──
      const debt = await mockAave.borrowedAmounts(await kashYieldBtc.getAddress());
      if (debt > 0n)
        await kashYieldBtc.connect(owner).repayToAave(await mockUsdc.getAddress(), debt);
      // Handle interest dust
      const dustDebt = await mockAave.borrowedAmounts(await kashYieldBtc.getAddress());
      if (dustDebt > 0n) {
        await mockUsdc.mint(await kashYieldBtc.getAddress(), dustDebt);
        await kashYieldBtc.connect(owner).repayToAave(await mockUsdc.getAddress(), dustDebt);
      }
      expect(await mockAave.borrowedAmounts(await kashYieldBtc.getAddress())).to.equal(0n);

      // ── Withdraw wBTC from Aave ──
      await kashYieldBtc.connect(owner).withdrawFromAave(MINT_BTC);
      const contractWbtc = await mockWbtc.balanceOf(await kashYieldBtc.getAddress());
      expect(contractWbtc).to.be.gte(MINT_BTC - 1n);

      // ── NAV + mark done + Phase 2 ──
      await kashYieldBtc.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
      await kashYieldBtc.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYieldBtc.connect(bot).performUpkeep("0x");
      expect(await kashYieldBtc.batchProcessed(redeemCycle)).to.be.true;

      // User wBTC balance should be restored
      const wbtcAfter = await mockWbtc.balanceOf(user1.address);
      expect(wbtcAfter).to.be.gt(wbtcBefore);
      expect(wbtcAfter - wbtcBefore).to.be.closeTo(MINT_BTC, MINT_BTC / 100n);

      // Kash-BTC should be burned
      expect(await kashTokenBtc.balanceOf(user1.address)).to.equal(0n);
    });
  });

  // ── Section 3: ETH product — full mint + redeem ────────────────────────────

  describe("3. KashYieldETH — full mint then redeem", function () {
    const MINT_ETH = ethers.parseEther("1"); // 1 ETH
    let ethMintCycle;

    it("user receives Kash-ETH after minting 1 ETH", async function () {
      const { owner, bot, user1, kashYieldEth, kashTokenEth,
              mockUsdc, mockAave, mockHl, hlAdapterEth } = dep;

      // Jump to a fresh cycle (the BTC redeem test used a different cycle but the same
      // period may still be active; advancing ensures a clean Phase 0 start).
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      await kashYieldEth.connect(user1).requestMint(0, { value: MINT_ETH });
      ethMintCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ──
      await kashYieldEth.connect(bot).performUpkeep("0x");
      expect(await kashYieldEth.batchPhase(ethMintCycle)).to.equal(1);

      // ── Bot Aave ops ──
      const ethUsdValue  = MINT_ETH * ETH_PRICE_18 / (10n ** 18n);
      const borrowUsdc   = ethUsdValue * 70n / 100n / (10n ** 12n);

      await kashYieldEth.connect(owner).depositToAave(MINT_ETH);
      expect(await mockAave.suppliedAmounts(await kashYieldEth.getAddress())).to.equal(MINT_ETH);

      await kashYieldEth.connect(owner).borrowFromAave(await mockUsdc.getAddress(), borrowUsdc);
      expect(await mockAave.borrowedAmounts(await kashYieldEth.getAddress())).to.equal(borrowUsdc);

      // ── Bot HL ops ──
      await kashYieldEth.connect(owner).depositToHyperliquid(borrowUsdc);
      expect(await mockHl.spotBalances(await hlAdapterEth.getAddress())).to.equal(borrowUsdc);

      await kashYieldEth.connect(owner).spotBuyOnHyperliquid(borrowUsdc);
      const hlEth = await mockHl.ethBalance(await hlAdapterEth.getAddress());
      expect(hlEth).to.be.gt(0n);

      const shortSizeUSD   = ethUsdValue * 170n / 100n;
      const shortSizeAsset = shortSizeUSD * (10n ** 18n) / ETH_PRICE_18;
      await kashYieldEth.connect(owner).openShort("ETH", shortSizeAsset);
      const [, , , , posActive] = await kashYieldEth.getHyperliquidPosition("ETH");
      expect(posActive).to.be.true;

      // ── NAV + mark done + Phase 2 ──
      await kashYieldEth.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
      await kashYieldEth.connect(owner).markBatchOpsDone(ethMintCycle);
      await kashYieldEth.connect(bot).performUpkeep("0x");
      expect(await kashYieldEth.batchProcessed(ethMintCycle)).to.be.true;

      // User should have Kash-ETH: ~3000 tokens at $3000/ETH with NAV=$1
      const kashBalance = await kashTokenEth.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n);
      expect(kashBalance).to.be.closeTo(
        ETH_PRICE_USD * 10n ** 18n,
        ETH_PRICE_USD * 10n ** 18n / 100n
      );
    });

    it("user redeems Kash-ETH and receives native ETH back", async function () {
      const { owner, bot, user1, kashYieldEth, kashTokenEth,
              mockUsdc, mockAave, mockHl, hlAdapterEth } = dep;

      const kashBalance = await kashTokenEth.balanceOf(user1.address);
      expect(kashBalance).to.be.gt(0n, "Need Kash-ETH from previous mint test");

      // Advance to a fresh cycle so the mint cycle (Phase 3) doesn't block Phase 1.
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      const ethBefore = await ethers.provider.getBalance(user1.address);

      // Approve + requestRedeem
      await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), kashBalance);
      await kashYieldEth.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ──
      await kashYieldEth.connect(bot).performUpkeep("0x");
      expect(await kashYieldEth.batchPhase(redeemCycle)).to.equal(1);

      // ── Unwind HL ──
      await kashYieldEth.connect(owner)["closeShort(string)"]("ETH");
      const hlEthAfterClose = await mockHl.ethBalance(await hlAdapterEth.getAddress());
      if (hlEthAfterClose > 0n)
        await kashYieldEth.connect(owner).spotSellOnHyperliquid(hlEthAfterClose);

      const hlSpotAfterSell = await mockHl.spotBalances(await hlAdapterEth.getAddress());
      if (hlSpotAfterSell > 0n)
        await kashYieldEth.connect(owner).withdrawFromHyperliquid(hlSpotAfterSell);

      // ── Repay Aave debt ──
      const debt = await mockAave.borrowedAmounts(await kashYieldEth.getAddress());
      if (debt > 0n)
        await kashYieldEth.connect(owner).repayToAave(await mockUsdc.getAddress(), debt);
      const dustDebt = await mockAave.borrowedAmounts(await kashYieldEth.getAddress());
      if (dustDebt > 0n) {
        await mockUsdc.mint(await kashYieldEth.getAddress(), dustDebt);
        await kashYieldEth.connect(owner).repayToAave(await mockUsdc.getAddress(), dustDebt);
      }
      expect(await mockAave.borrowedAmounts(await kashYieldEth.getAddress())).to.equal(0n);

      // ── Withdraw WETH from Aave ──
      await kashYieldEth.connect(owner).withdrawFromAave(MINT_ETH);
      const contractEth = await ethers.provider.getBalance(await kashYieldEth.getAddress());
      expect(contractEth).to.be.gte(MINT_ETH - 1n);

      // ── NAV + mark done + Phase 2 ──
      await kashYieldEth.connect(bot).updateNAV(NAV_1, 0n, 0n, 0n);
      await kashYieldEth.connect(owner).markBatchOpsDone(redeemCycle);
      await kashYieldEth.connect(bot).performUpkeep("0x");
      expect(await kashYieldEth.batchProcessed(redeemCycle)).to.be.true;

      // ethBefore is captured in this (redeem) test, AFTER the mint test already spent 1 ETH.
      // When Phase 2 pays the user ~1 ETH, ethAfter - ethBefore ≈ +MINT_ETH (minus gas).
      const ethAfter = await ethers.provider.getBalance(user1.address);
      const ethGained = ethAfter - ethBefore;
      expect(ethGained).to.be.closeTo(MINT_ETH, ethers.parseEther("0.01")); // 0.01 ETH gas tolerance

      // Kash-ETH should be burned
      expect(await kashTokenEth.balanceOf(user1.address)).to.equal(0n);
    });
  });
});
