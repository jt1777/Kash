// test/mainnet-fork.e2e.test.js
//
// End-to-end tests against a forked Arbitrum One mainnet.
//
// Requires ARBITRUM_MAINNET_RPC_URL in .env (Alchemy / Infura / Ankr).
// Skip automatically if the env var is missing.
//
// What this tests (real protocols, no mocks):
//   - KashYieldETH: full mint cycle using real Aave V3 (WETH collateral, USDC borrow)
//   - KashYieldETH: full redeem cycle (repay Aave, unwrap WETH, return native ETH)
//   - KashYieldBtc: full mint cycle using real Aave V3 (wBTC collateral, USDC borrow)
//   - KashYieldBtc: full redeem cycle (repay Aave, return wBTC)
//   - Uniswap V3: USDC ↔ ETH swaps via SwapRouter02 (matches UniswapV3Adapter)
//   - HyperliquidAdapter deposit: USDC reaches real HL bridge on-chain
//   - HyperliquidAdapter withdrawal: simulated by impersonating bridge
//     (HL trading is off-chain via REST API — not testable on a fork)
//
// Run with:
//   ARBITRUM_MAINNET_RPC_URL=https://arb1.g.alchemy.com/v2/KEY \
//   npx hardhat test test/mainnet-fork.e2e.test.js
//
// ─────────────────────────────────────────────────────────────────────────────

const { expect } = require("chai");
const { ethers }  = require("hardhat");
const hre         = require("hardhat");
const {
  manualEthMintOps,
  manualBtcMintOps,
  computeBatchGrossRedeemAsset,
  settleMintPhase2,
  settleRedeemPhase2,
  claimRedeemForUser,
  claimMintForUser,
  deployKashYieldBtcStack,
  deployKashYieldEthStack,
  closeShortViaFacade,
  withdrawFromPerpExchangeViaFacade,
} = require("./helpers/forkBatchOps");

// Pin to a specific Arbitrum block for reproducibility and RPC cache hits.
// Hardhat caches all state for pinned forks in .cache/hardhat-network-fork/,
// so the second run is near-instant.  Override with FORK_BLOCK_NUMBER= in .env.
const FORK_BLOCK = process.env.FORK_BLOCK_NUMBER
  ? parseInt(process.env.FORK_BLOCK_NUMBER)
  : 440_000_000;

// ── Arbitrum One mainnet addresses ────────────────────────────────────────────
const USDC_ADDRESS   = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // native USDC
const WETH_ADDRESS   = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC_ADDRESS   = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const USDT_ADDRESS   = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
// Aave V3 Pool on Arbitrum One is hardcoded inside the KashYield contracts —
// no need to pass it at deploy time.
//
// UniswapV3Adapter targets SwapRouter02 `exactInputSingle` (no `deadline` in params).
const UNISWAP_ROUTER_V2 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02 — adapter + direct test swaps
const HL_BRIDGE      = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
// Chainlink oracles — already defaulted in the contracts, listed here for clarity.
const ETH_ORACLE     = "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612"; // ETH/USD Arbitrum One
const BTC_ORACLE     = "0x6ce185860a4963106506C203335A2910413708e9"; // BTC/USD Arbitrum One

const CYCLE_SECS = 3600n;
const NAV_1      = 10n ** 18n;

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

// ─────────────────────────────────────────────────────────────────────────────

describe("Mainnet fork — KashYield against real Aave V3 + Uniswap V3", function () {
  const RPC_URL = process.env.ARBITRUM_MAINNET_RPC_URL || process.env.ARBITRUM_ONE_RPC_URL;

  before(function () {
    if (!RPC_URL) {
      console.log("    ⏭  ARBITRUM_MAINNET_RPC_URL not set — skipping fork tests.");
      this.skip();
    }
  });

  this.timeout(300_000); // 5 min — real RPC calls can be slow

  // ── ETH product ─────────────────────────────────────────────────────────────

  describe("KashYieldETH — real Aave V3 + Uniswap V3", function () {
    let owner, bot, user1;
    let kashYieldEth, kashTokenEth;
    let uniAdapter, hlAdapter;
    let usdc, weth;
    let ethAaveDeploy;

    before(async function () {
      // ── Fork Arbitrum mainnet at pinned block ────────────────────────────
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: RPC_URL, blockNumber: FORK_BLOCK } }],
      });

      [owner, bot, user1] = await ethers.getSigners();

      usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, owner);
      weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, owner);

      // ── Deploy UniswapV3Adapter ──────────────────────────────────────────
      const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
      uniAdapter = await UniswapV3Adapter.deploy(UNISWAP_ROUTER_V2, WETH_ADDRESS);
      await uniAdapter.waitForDeployment();
      console.log("    ✅ UniswapV3Adapter:", await uniAdapter.getAddress());

      // ── Deploy KashYieldETH V3 stack (facade + HL adapter + vault) ────────
      // Aave pool address is hardcoded in the constructor to the real Arbitrum One
      // address (0x794a...), so no need to pass it — works perfectly on the fork.
      ({ kashYieldEth, hlAdapter } = await deployKashYieldEthStack({
        deployer: owner,
        bot,
        owner,
        wethAddress: WETH_ADDRESS,
        usdcAddress: USDC_ADDRESS,
        uniAdapter,
        feeReceiver: owner.address,
        cycleDurationSeconds: CYCLE_SECS,
        userWindowEnd: CYCLE_SECS,
        processingWindowStart: 0n,
      }));
      console.log("    ✅ KashYieldETH:", await kashYieldEth.getAddress());
      console.log("    ✅ HyperliquidAdapter (ETH):", await hlAdapter.getAddress());

      // ── Resolve KashTokenEth ─────────────────────────────────────────────
      const kashTokenAddr = await kashYieldEth.kashTokenEth();
      kashTokenEth = new ethers.Contract(
        kashTokenAddr,
        ["function balanceOf(address) view returns (uint256)",
         "function totalSupply() view returns (uint256)",
         "function approve(address,uint256) returns (bool)"],
        owner
      );

      console.log("    ✅ KashTokenEth:", kashTokenAddr);
    });

    it("reads a live ETH price from Chainlink", async function () {
      const price = await kashYieldEth.getEthPrice();
      const priceUsd = Number(ethers.formatEther(price));
      console.log(`       ETH price: $${priceUsd.toFixed(2)}`);
      expect(priceUsd).to.be.gt(500).and.lt(100_000); // sanity: between $500–$100k
    });

    it("full ETH mint cycle: user deposits ETH → KashToken minted via real Aave", async function () {
      const MINT_ETH = ethers.parseEther("1");

      // ── Mint request ──────────────────────────────────────────────────────
      await kashYieldEth.connect(user1).requestMint(0, { value: MINT_ETH });
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
      console.log(`       Batch cycle: ${batchCycle}`);

      // ── Phase 1 ───────────────────────────────────────────────────────────
      await kashYieldEth.connect(bot).performUpkeep("0x");
      expect(await kashYieldEth.batchPhase(batchCycle)).to.equal(1);

      // ── Aave + HL manual ops (reserve protocol fee on vault for Phase 2) ─
      const { deployEth, borrowUsdc } = await manualEthMintOps({
        kashYield: kashYieldEth,
        bot,
        hlAdapter,
        mintEthAmount: MINT_ETH,
      });
      ethAaveDeploy = deployEth;
      console.log(`       Aave: borrowing ${ethers.formatUnits(borrowUsdc, 6)} USDC`);

      const bridgeUsdc = await usdc.balanceOf(HL_BRIDGE);
      console.log(`       ✅ HL bridge USDC balance: ${ethers.formatUnits(bridgeUsdc, 6)} (includes prior deposits)`);
      const adapterUsdcBalance = await hlAdapter.usdcBalance();
      expect(adapterUsdcBalance).to.equal(borrowUsdc);
      console.log(`       ✅ HL adapter usdcBalance: ${ethers.formatUnits(adapterUsdcBalance, 6)}`);

      const [posSize, , , , posActive] = await kashYieldEth.getPerpExchangePosition("ETH");
      expect(posActive).to.be.true;
      expect(posSize).to.be.gt(0n);
      console.log(`       ✅ Short position synced: ${ethers.formatEther(posSize)} ETH`);

      const protocolFeeEth = MINT_ETH - deployEth;
      const vaultEth = await ethers.provider.getBalance(await kashYieldEth.getAddress());
      expect(vaultEth).to.be.gte(protocolFeeEth);

      // ── Settlement NAV + mark done + Phase 2 ───────────────────────────────
      await settleMintPhase2({ kashYield: kashYieldEth, bot, batchCycle, nav: NAV_1 });
      expect(await kashYieldEth.batchProcessed(batchCycle)).to.be.true;

      await claimMintForUser(kashYieldEth, user1, batchCycle, NAV_1);

      // ── Verify KashToken minted ───────────────────────────────────────────
      const kashBalance = await kashTokenEth.balanceOf(user1.address);
      const ethPrice = await kashYieldEth.getEthPrice();
      const expectedKash = ethPrice * 9997n / 10000n; // ≈ ETH value at $1 NAV minus 0.03% fee
      expect(kashBalance).to.be.closeTo(expectedKash, expectedKash / 20n); // within 5%
      console.log(`       ✅ Kash-ETH minted: ${ethers.formatEther(kashBalance)}`);
    });

    it("full ETH redeem cycle: burns KashToken → returns native ETH via real Aave", async function () {
      const kashBalance = await kashTokenEth.balanceOf(user1.address);
      if (kashBalance === 0n) this.skip(); // depends on mint test
      console.log(`       Redeeming ${ethers.formatEther(kashBalance)} Kash-ETH`);

      // ── Advance to next cycle ──────────────────────────────────────────────
      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      // ── Redeem request ────────────────────────────────────────────────────
      const kashToken = kashTokenEth.connect(user1);
      await kashToken.approve(await kashYieldEth.getAddress(), kashBalance);
      await kashYieldEth.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ───────────────────────────────────────────────────────────
      await kashYieldEth.connect(bot).performUpkeep("0x");

      // ── Close short (no-op — off-chain HL API) ────────────────────────────
      await closeShortViaFacade(kashYieldEth, bot, "ETH");

      // ── Simulate HL closing: sync position as inactive ────────────────────
      await hlAdapter.syncPosition("ETH", 0n, 0n, false);

      // ── Simulate HL withdrawal to adapter (impersonate HL bridge) ─────────
      // On mainnet: bot calls HL REST API → HL bridge sends USDC to adapter.
      // In fork test: impersonate the bridge to simulate the USDC arriving.
      const borrowUsdc = await usdc.balanceOf(HL_BRIDGE);
      // We only need what the adapter originally deposited.
      // Simulate HL returning principal + 10 USDC buffer.
      // In production any HL PnL covers the Aave interest; we model that here so
      // repayToAave receives enough to clear the full debt (principal + accrued interest).
      const adapterDeposit = await hlAdapter.usdcBalance();
      const hlReturnAmount = adapterDeposit + 10n * 10n ** 6n; // +10 USDC
      await hre.network.provider.send("hardhat_impersonateAccount", [HL_BRIDGE]);
      await hre.network.provider.send("hardhat_setBalance", [HL_BRIDGE, "0xDE0B6B3A7640000"]); // 1 ETH for gas
      const bridgeSigner = await ethers.getSigner(HL_BRIDGE);
      await usdc.connect(bridgeSigner).transfer(await hlAdapter.getAddress(), hlReturnAmount);
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [HL_BRIDGE]);

      // ── Withdraw USDC from adapter to KashYield ───────────────────────────
      await withdrawFromPerpExchangeViaFacade(kashYieldEth, bot, hlReturnAmount);
      const contractUsdc = await usdc.balanceOf(await kashYieldEth.getAddress());
      expect(contractUsdc).to.be.gte(adapterDeposit);
      console.log(`       ✅ USDC withdrawn from HL: ${ethers.formatUnits(contractUsdc, 6)}`);

      // ── Repay Aave USDC debt ─────────────────────────────────────────────────
      // Borrowing at 60% LTV means enough collateral headroom remains after 1 hour
      // of accrued interest, so no whale top-up is needed.
      const AAVE_POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
      const aavePool = new ethers.Contract(AAVE_POOL_ADDR, [
        "function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"
      ], owner);
      const [, debtBase] = await aavePool.getUserAccountData(await kashYieldEth.getAddress());
      console.log(`       Aave debt: $${(Number(debtBase) / 1e8).toFixed(2)}`);

      const usdcBal = await usdc.balanceOf(await kashYieldEth.getAddress());
      await kashYieldEth.connect(bot).repayToAave(USDC_ADDRESS, usdcBal);
      console.log(`       ✅ Aave USDC repaid`);

      // ── Withdraw WETH from Aave → native ETH ──────────────────────────────
      const ethBefore = await ethers.provider.getBalance(user1.address);
      await kashYieldEth.connect(bot).withdrawFromAave(ethAaveDeploy);
      const contractEth = await ethers.provider.getBalance(await kashYieldEth.getAddress());
      expect(contractEth).to.be.gte(ethAaveDeploy - ethers.parseEther("0.01")); // allow tiny interest delta

      // ── NAV + mark done + Phase 2 ─────────────────────────────────────────
      const grossG = await computeBatchGrossRedeemAsset(kashYieldEth, redeemCycle, NAV_1);
      await settleRedeemPhase2({ kashYield: kashYieldEth, bot, batchCycle: redeemCycle, nav: NAV_1, grossG });
      expect(await kashYieldEth.batchProcessed(redeemCycle)).to.be.true;
      await claimRedeemForUser(kashYieldEth, user1, redeemCycle);

      // ── Verify ETH returned ───────────────────────────────────────────────
      const ethAfter = await ethers.provider.getBalance(user1.address);
      expect(ethAfter).to.be.gt(ethBefore);
      console.log(`       ✅ ETH returned: ${ethers.formatEther(ethAfter - ethBefore)} ETH (net of gas)`);

      // ── Verify KashToken burned ───────────────────────────────────────────
      expect(await kashTokenEth.balanceOf(user1.address)).to.equal(0n);
      expect(await kashTokenEth.totalSupply()).to.equal(0n);
      console.log(`       ✅ Kash-ETH supply is 0`);
    });

    it("Uniswap V3: swapForUsdc (ETH → USDC) works with real router", async function () {
      // Fund contract with a bit of ETH for the swap.
      const SWAP_ETH = ethers.parseEther("0.1");
      await owner.sendTransaction({ to: await kashYieldEth.getAddress(), value: SWAP_ETH });

      const usdcBefore = await usdc.balanceOf(await kashYieldEth.getAddress());
      await kashYieldEth.connect(bot).swapForUsdc(SWAP_ETH, 0);
      const usdcAfter = await usdc.balanceOf(await kashYieldEth.getAddress());

      expect(usdcAfter).to.be.gt(usdcBefore);
      const received = ethers.formatUnits(usdcAfter - usdcBefore, 6);
      console.log(`       ✅ Swapped 0.1 ETH → ${received} USDC via Uniswap V3`);
    });
  });

  // ── BTC product ─────────────────────────────────────────────────────────────

  describe("KashYieldBtc — real Aave V3 + Uniswap V3", function () {
    let owner, bot, user1;
    let kashYieldBtc, kashTokenBtc;
    let uniAdapter, hlAdapter;
    let usdc, wbtc;
    let MINT_BTC;
    let btcAaveDeploy;

    before(async function () {
      // Fresh fork at the same pinned block for the BTC suite.
      await hre.network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: RPC_URL, blockNumber: FORK_BLOCK } }],
      });

      [owner, bot, user1] = await ethers.getSigners();

      usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, owner);
      wbtc = new ethers.Contract(WBTC_ADDRESS, ERC20_ABI, owner);

      // ── Acquire wBTC via Uniswap (swap ETH → WBTC) ──────────────────────
      // Use UniswapV3 directly to get wBTC for user1.
      const router = new ethers.Contract(UNISWAP_ROUTER_V2, [
        "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"
      ], owner);

      MINT_BTC = 1n * 10n ** 8n; // 1 wBTC (8 decimals)

      // Swap enough ETH to get ~1 wBTC (wBTC ≈ $40k–$70k, so ~20–25 ETH).
      // We swap 22 ETH to be safe.
      const SWAP_ETH_FOR_WBTC = ethers.parseEther("22");
      await router.exactInputSingle(
        [WETH_ADDRESS, WBTC_ADDRESS, 500, user1.address, SWAP_ETH_FOR_WBTC, 0, 0],
        { value: SWAP_ETH_FOR_WBTC }
      );

      const user1Wbtc = await wbtc.balanceOf(user1.address);
      if (user1Wbtc < MINT_BTC) {
        // Adjust MINT_BTC down to what we actually got if short.
        MINT_BTC = user1Wbtc;
      }
      console.log(`    ✅ Acquired wBTC for user1: ${Number(user1Wbtc) / 1e8} wBTC`);

      // ── Deploy UniswapV3Adapter + KashYieldBtc V3 stack ─────────────────
      const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
      uniAdapter = await UniswapV3Adapter.deploy(UNISWAP_ROUTER_V2, WETH_ADDRESS);
      await uniAdapter.waitForDeployment();

      ({ kashYieldBtc, hlAdapter } = await deployKashYieldBtcStack({
        deployer: owner,
        bot,
        owner,
        wbtcAddress: WBTC_ADDRESS,
        usdcAddress: USDC_ADDRESS,
        uniAdapter,
        feeReceiver: owner.address,
        cycleDurationSeconds: CYCLE_SECS,
        userWindowEnd: CYCLE_SECS,
        processingWindowStart: 0n,
      }));

      const kashTokenAddr = await kashYieldBtc.kashTokenBtc();
      kashTokenBtc = new ethers.Contract(
        kashTokenAddr,
        ["function balanceOf(address) view returns (uint256)",
         "function totalSupply() view returns (uint256)",
         "function approve(address,uint256) returns (bool)"],
        owner
      );
      console.log("    ✅ KashYieldBtc + adapters deployed");
    });

    it("reads a live BTC price from Chainlink", async function () {
      const price = await kashYieldBtc.getBtcPrice();
      const priceUsd = Number(ethers.formatEther(price));
      console.log(`       BTC price: $${priceUsd.toFixed(2)}`);
      expect(priceUsd).to.be.gt(5_000).and.lt(500_000); // sanity: $5k–$500k
    });

    it("full BTC mint cycle: user deposits wBTC → KashToken minted via real Aave", async function () {
      // ── Approve and request mint ──────────────────────────────────────────
      await wbtc.connect(user1).approve(await kashYieldBtc.getAddress(), MINT_BTC);
      await kashYieldBtc.connect(user1).requestMint(MINT_BTC);
      const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      // ── Phase 1 ───────────────────────────────────────────────────────────
      await kashYieldBtc.connect(bot).performUpkeep("0x");
      expect(await kashYieldBtc.batchPhase(batchCycle)).to.equal(1);

      // ── Aave + HL manual ops (reserve protocol fee on vault for Phase 2) ─
      const { deployBtc, borrowUsdc, btcPrice } = await manualBtcMintOps({
        kashYield: kashYieldBtc,
        bot,
        hlAdapter,
        mintBtcAmount: MINT_BTC,
      });
      btcAaveDeploy = deployBtc;
      console.log(`       Aave: borrowing ${ethers.formatUnits(borrowUsdc, 6)} USDC`);

      const adapterUsdcBalance = await hlAdapter.usdcBalance();
      expect(adapterUsdcBalance).to.equal(borrowUsdc);
      console.log(`       ✅ HL adapter usdcBalance: ${ethers.formatUnits(adapterUsdcBalance, 6)}`);

      const [posSize, , , , posActive] = await kashYieldBtc.getPerpExchangePosition("BTC");
      expect(posActive).to.be.true;
      console.log(`       ✅ Short position synced: ${ethers.formatEther(posSize)} BTC`);

      const protocolFeeBtc = MINT_BTC - deployBtc;
      const vaultBtc = await wbtc.balanceOf(await kashYieldBtc.getAddress());
      expect(vaultBtc).to.be.gte(protocolFeeBtc);

      await settleMintPhase2({ kashYield: kashYieldBtc, bot, batchCycle, nav: NAV_1 });
      expect(await kashYieldBtc.batchProcessed(batchCycle)).to.be.true;

      await claimMintForUser(kashYieldBtc, user1, batchCycle, NAV_1);

      const kashBalance = await kashTokenBtc.balanceOf(user1.address);
      // Expected = deposited_wbtc_satoshis * price_per_BTC / 1e8 decimals * (1 - fee)
      const expectedKash = MINT_BTC * btcPrice / (10n ** 8n) * 9997n / 10000n;
      expect(kashBalance).to.be.closeTo(expectedKash, expectedKash / 20n); // within 5%
      console.log(`       ✅ Kash-BTC minted: ${ethers.formatEther(kashBalance)}`);
    });

    it("full BTC redeem cycle: burns KashToken → returns wBTC via real Aave", async function () {
      const kashBalance = await kashTokenBtc.balanceOf(user1.address);
      if (kashBalance === 0n) this.skip();

      await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
      await ethers.provider.send("evm_mine");

      await kashTokenBtc.connect(user1).approve(await kashYieldBtc.getAddress(), kashBalance);
      await kashYieldBtc.connect(user1).requestRedeem(kashBalance);
      const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

      await kashYieldBtc.connect(bot).performUpkeep("0x");

      // Close short (no-op), sync position as inactive.
      await closeShortViaFacade(kashYieldBtc, bot, "BTC");
      await hlAdapter.syncPosition("BTC", 0n, 0n, false);

      // Simulate HL returning principal + 10 USDC (covers any Aave accrued interest).
      const adapterDeposit = await hlAdapter.usdcBalance();
      const hlReturnAmount = adapterDeposit + 10n * 10n ** 6n; // +10 USDC
      await hre.network.provider.send("hardhat_impersonateAccount", [HL_BRIDGE]);
      await hre.network.provider.send("hardhat_setBalance", [HL_BRIDGE, "0xDE0B6B3A7640000"]);
      const bridgeSigner = await ethers.getSigner(HL_BRIDGE);
      await usdc.connect(bridgeSigner).transfer(await hlAdapter.getAddress(), hlReturnAmount);
      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [HL_BRIDGE]);

      await withdrawFromPerpExchangeViaFacade(kashYieldBtc, bot, hlReturnAmount);
      console.log(`       ✅ USDC withdrawn from HL: ${ethers.formatUnits(await usdc.balanceOf(await kashYieldBtc.getAddress()), 6)}`);

      // Repay Aave — contract now has principal + 10 USDC, more than enough to clear full debt.
      const usdcBal = await usdc.balanceOf(await kashYieldBtc.getAddress());
      await kashYieldBtc.connect(bot).repayToAave(USDC_ADDRESS, usdcBal);

      // Withdraw wBTC from Aave.
      const wbtcBefore = await wbtc.balanceOf(user1.address);
      await kashYieldBtc.connect(bot).withdrawFromAave(btcAaveDeploy);
      const contractWbtc = await wbtc.balanceOf(await kashYieldBtc.getAddress());
      expect(contractWbtc).to.be.gte(btcAaveDeploy - 100n); // allow 100 satoshi dust
      console.log(`       ✅ wBTC in contract: ${Number(contractWbtc) / 1e8} wBTC`);

      const grossG = await computeBatchGrossRedeemAsset(kashYieldBtc, redeemCycle, NAV_1);
      await settleRedeemPhase2({ kashYield: kashYieldBtc, bot, batchCycle: redeemCycle, nav: NAV_1, grossG });
      expect(await kashYieldBtc.batchProcessed(redeemCycle)).to.be.true;
      await claimRedeemForUser(kashYieldBtc, user1, redeemCycle);

      const wbtcAfter = await wbtc.balanceOf(user1.address);
      expect(wbtcAfter).to.be.gt(wbtcBefore);
      console.log(`       ✅ wBTC returned: ${Number(wbtcAfter - wbtcBefore) / 1e8} wBTC`);
      expect(await kashTokenBtc.balanceOf(user1.address)).to.equal(0n);
    });
  });
});
