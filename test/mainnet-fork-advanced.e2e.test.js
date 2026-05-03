// test/mainnet-fork-advanced.e2e.test.js
//
// Advanced end-to-end tests against a forked Arbitrum One mainnet.
// Tests multi-user batches, net mint/redeem with existing positions,
// price movement, USDC movement between Aave/HL, and spot swaps.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");

// Pin to a recent Arbitrum block for reproducibility
const FORK_BLOCK = process.env.FORK_BLOCK_NUMBER 
  ? parseInt(process.env.FORK_BLOCK_NUMBER) 
  : 440_000_000;

const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC_ADDRESS = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const HL_BRIDGE   = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const CYCLE_SECS  = 3600n;

describe("Mainnet fork — Advanced KashYield scenarios", function () {
  let owner, bot, user1, user2, user3;
  let kashYieldEth, kashTokenEth;
  let uniAdapter, hlAdapter;
  let usdc, weth, wbtc;

  before(async function () {
    const RPC_URL = process.env.ARBITRUM_MAINNET_RPC_URL;
    if (!RPC_URL) {
      console.log("    ⏭  ARBITRUM_MAINNET_RPC_URL not set — skipping.");
      this.skip();
    }

    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: RPC_URL, blockNumber: FORK_BLOCK } }],
    });

    [owner, bot, user1, user2, user3] = await ethers.getSigners();

    usdc = await ethers.getContractAt("IERC20", USDC_ADDRESS);
    weth = await ethers.getContractAt("IERC20", WETH_ADDRESS);
    wbtc = await ethers.getContractAt("IERC20", WBTC_ADDRESS);

    // Deploy UniswapV3Adapter
    const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
    uniAdapter = await UniswapV3Adapter.deploy(
      "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45", // SwapRouter02
      WETH_ADDRESS
    );
    await uniAdapter.waitForDeployment();

    // Deploy KashYieldETH
    const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
    kashYieldEth = await KashYieldETH.deploy(
      bot.address,
      WETH_ADDRESS,
      USDC_ADDRESS
    );
    await kashYieldEth.waitForDeployment();

    // Configure
    await kashYieldEth.setAllowedSpotDexRouter(await uniAdapter.getAddress(), true);
    await kashYieldEth.setSpotDex(await uniAdapter.getAddress());
    await kashYieldEth.setCycleDurationSeconds(CYCLE_SECS);
    await kashYieldEth.setUserWindowEnd(CYCLE_SECS);
    await kashYieldEth.setProcessingWindowStart(0n);

    // Deploy HyperliquidAdapter (ETH product)
    const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
    hlAdapter = await HyperliquidAdapter.deploy(
      HL_BRIDGE,
      USDC_ADDRESS,
      ethers.ZeroAddress,
      true,
      await kashYieldEth.getAddress()
    );
    await hlAdapter.waitForDeployment();

    await kashYieldEth.setExchangeSwitchDelay(0);
    await kashYieldEth.setHyperliquid(await hlAdapter.getAddress());
    await kashYieldEth.setActivePerpExchange("HL");

    const kashTokenAddr = await kashYieldEth.kashTokenEth();
    kashTokenEth = await ethers.getContractAt("IERC20", kashTokenAddr);

    console.log("    ✅ Advanced test setup complete");
  });

  // ── Helper: run a full mint cycle for `user` depositing `ethAmount` ──────────
  async function runMintCycle(user, ethAmount) {
    const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;
    await kashYieldEth.connect(user).requestMint(0, { value: ethAmount });
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 1

    const ethPrice   = await kashYieldEth.getEthPrice();
    const ethUsdVal  = ethAmount * ethPrice / (10n ** 18n);
    const borrowUsdc = ethUsdVal * 60n / 100n / (10n ** 12n);

    await kashYieldEth.connect(bot).depositToAave(ethAmount);
    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
    await kashYieldEth.connect(bot).depositToHyperliquid(borrowUsdc);

    await kashYieldEth.connect(bot).updateNAV(10n ** 18n, borrowUsdc, 0n, 0n);
    await kashYieldEth.connect(bot).markBatchOpsDone(batchCycle);
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 2
    return batchCycle;
  }

  /** Two minters, same batch; runs Phase 2 so both hold KASH. */
  async function runMultiUserMintCycle(eth1, eth2) {
    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    await kashYieldEth.connect(user1).requestMint(0, { value: eth1 });
    await kashYieldEth.connect(user2).requestMint(0, { value: eth2 });
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 1

    const total = eth1 + eth2;
    const ethPrice = await kashYieldEth.getEthPrice();
    const ethUsdVal = (total * ethPrice) / 10n ** 18n;
    const borrowUsdc = (ethUsdVal * 60n) / 100n / 10n ** 12n;

    await kashYieldEth.connect(bot).depositToAave(total);
    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
    await kashYieldEth.connect(bot).depositToHyperliquid(borrowUsdc);

    await kashYieldEth.connect(bot).updateNAV(10n ** 18n, borrowUsdc, 0n, 0n);
    await kashYieldEth.connect(bot).markBatchOpsDone(batchCycle);
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 2
    return batchCycle;
  }

  it("Multiple users mint in the same batch — both receive KashTokens", async function () {
    const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.5") });
    await kashYieldEth.connect(user2).requestMint(0, { value: ethers.parseEther("0.3") });
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 1
    expect(await kashYieldEth.batchPhase(batchCycle)).to.equal(1);

    const TOTAL_ETH  = ethers.parseEther("0.8");
    const ethPrice   = await kashYieldEth.getEthPrice();
    const ethUsdVal  = TOTAL_ETH * ethPrice / (10n ** 18n);
    const borrowUsdc = ethUsdVal * 60n / 100n / (10n ** 12n);

    await kashYieldEth.connect(bot).depositToAave(TOTAL_ETH);
    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
    await kashYieldEth.connect(bot).depositToHyperliquid(borrowUsdc);

    await kashYieldEth.connect(bot).updateNAV(10n ** 18n, borrowUsdc, 0n, 0n);
    await kashYieldEth.connect(bot).markBatchOpsDone(batchCycle);
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 2

    const bal1 = await kashTokenEth.balanceOf(user1.address);
    const bal2 = await kashTokenEth.balanceOf(user2.address);
    expect(bal1).to.be.gt(0n);
    expect(bal2).to.be.gt(0n);
    // user1 deposited 5/8 of total, so should have ~5/8 of tokens (within 1%)
    expect(bal1 * 3n).to.be.closeTo(bal2 * 5n, (bal1 * 3n) / 100n);
    console.log(`       user1: ${ethers.formatEther(bal1)} KASH, user2: ${ethers.formatEther(bal2)} KASH`);
  });

  it("Two users partially redeem in the same batch — batchTotalRedeemKash sums both", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.4"), ethers.parseEther("0.4"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const half1 = (await kashTokenEth.balanceOf(user1.address)) / 2n;
    const half2 = (await kashTokenEth.balanceOf(user2.address)) / 2n;
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), half1);
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), half2);
    await kashYieldEth.connect(user1).requestRedeem(half1);
    await kashYieldEth.connect(user2).requestRedeem(half2);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.redeemUsersCount).to.equal(2n);
    expect(info.totalRedeemKash).to.equal(half1 + half2);
  });

  it("Two users fully redeem in the same batch — aggregate equals both balances", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.25"), ethers.parseEther("0.25"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const b1 = await kashTokenEth.balanceOf(user1.address);
    const b2 = await kashTokenEth.balanceOf(user2.address);
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), b1);
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), b2);
    await kashYieldEth.connect(user1).requestRedeem(b1);
    await kashYieldEth.connect(user2).requestRedeem(b2);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.redeemUsersCount).to.equal(2n);
    expect(info.totalRedeemKash).to.equal(b1 + b2);
  });

  it("Mixed mint + redeem same batch (net mint) — minter and redeemer both recorded", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.35"), ethers.parseEther("0.35"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const redeemAmt = (await kashTokenEth.balanceOf(user2.address)) / 4n;
    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.6") });
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), redeemAmt);
    await kashYieldEth.connect(user2).requestRedeem(redeemAmt);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.mintUsersCount).to.equal(1n);
    expect(info.redeemUsersCount).to.equal(1n);
    expect(info.totalMintUSD).to.be.gt(info.totalRedeemUSD);
  });

  it("Mixed mint + redeem (net redeem) — strategy unwind fraction <= gross redeem fraction", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.5"), ethers.parseEther("0.5"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const redeemAmt = ((await kashTokenEth.balanceOf(user1.address)) * 3n) / 4n;
    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.05") });
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), redeemAmt);
    await kashYieldEth.connect(user1).requestRedeem(redeemAmt);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.mintUsersCount).to.equal(1n);
    expect(info.redeemUsersCount).to.equal(1n);
    expect(info.totalRedeemUSD).to.be.gt(info.totalMintUSD);

    const { strategyRedeemFractionPure, WAD } = require("./helpers/strategyRedeemFraction");
    const supply = await kashTokenEth.totalSupply();
    const nav = await kashYieldEth.batchIndicativeNAV(batchCycle);
    const feeBps = await kashYieldEth.feeBps();
    const gross = (info.totalRedeemKash * WAD) / supply;
    const strat = strategyRedeemFractionPure({
      totalSupply: supply,
      redeemKash: info.totalRedeemKash,
      mintUsersCount: info.mintUsersCount,
      totalMintUSD: info.totalMintUSD,
      feeBps,
      nav: nav === 0n ? 1n : nav,
    });
    expect(strat <= gross).to.be.true;
    expect(strat).to.be.lt(gross);
  });

  it("User redeems after price rise — receives more ETH back", async function () {
    // Give user3 some KashTokens first via a fresh mint.
    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");
    await runMintCycle(user3, ethers.parseEther("1"));

    const kashBefore = await kashTokenEth.balanceOf(user3.address);
    expect(kashBefore).to.be.gt(0n);

    // Simulate price rise: NAV increases to 1.1 (10% gain).
    await kashYieldEth.connect(bot).updateNAV(
      ethers.parseEther("1.1"), 0n, 0n, 0n
    );

    // Advance to next cycle and redeem.
    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");
    const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    await kashTokenEth.connect(user3).approve(await kashYieldEth.getAddress(), kashBefore);
    await kashYieldEth.connect(user3).requestRedeem(kashBefore);
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 1

    // Simulate HL returning principal + 30% profit (short position gained on ETH drop).
    // The 30% extra USDC: after repaying Aave debt, the remainder is swapped to ETH
    // so the contract holds more than 1 ETH — enough to pay out at NAV 1.1.
    const adapterDeposit = await hlAdapter.usdcBalance();
    const hlReturn = adapterDeposit * 13n / 10n; // principal + 30% profit
    await hre.network.provider.send("hardhat_impersonateAccount", [HL_BRIDGE]);
    await hre.network.provider.send("hardhat_setBalance", [HL_BRIDGE, "0xDE0B6B3A7640000"]);
    const bridgeSigner = await ethers.getSigner(HL_BRIDGE);
    await usdc.connect(bridgeSigner).transfer(await hlAdapter.getAddress(), hlReturn);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [HL_BRIDGE]);

    await kashYieldEth.connect(bot).withdrawFromHyperliquid(hlReturn);

    // Repay Aave — pool takes only the actual debt; profit USDC stays in contract.
    const usdcBal = await usdc.balanceOf(await kashYieldEth.getAddress());
    await kashYieldEth.connect(bot).repayToAave(USDC_ADDRESS, usdcBal);

    // In production, the USDC profit from HL would be swapped to ETH via swapFromUsdc.
    // UniswapV3Adapter doesn't handle native ETH as tokenOut (only WETH), so we skip
    // that call here and instead directly fund the contract with the equivalent ETH.
    // swapForUsdc (ETH→USDC) is tested separately and confirms the swap path works.
    await kashYieldEth.connect(bot).withdrawFromAave(ethers.parseEther("1"));

    // Send 0.15 ETH from owner to simulate the HL profit converted to ETH.
    await owner.sendTransaction({
      to: await kashYieldEth.getAddress(),
      value: ethers.parseEther("0.15"),
    });

    const ethBefore = await ethers.provider.getBalance(user3.address);
    await kashYieldEth.connect(bot).updateNAV(ethers.parseEther("1.1"), 0n, 0n, 0n);
    await kashYieldEth.connect(bot).markBatchOpsDone(redeemCycle);
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 2

    const ethAfter = await ethers.provider.getBalance(user3.address);
    expect(ethAfter).to.be.gt(ethBefore);
    expect(await kashTokenEth.balanceOf(user3.address)).to.equal(0n);
    console.log(`       user3 redeemed at NAV 1.1 — ETH received: ${ethers.formatEther(ethAfter - ethBefore)}`);
  });

  it("Moves USDC between Aave and Hyperliquid (margin call simulation)", async function () {
    // Borrow USDC from Aave (requires collateral already deposited from prior tests).
    // First deposit some ETH collateral.
    await owner.sendTransaction({ to: await kashYieldEth.getAddress(), value: ethers.parseEther("1") });
    await kashYieldEth.connect(bot).depositToAave(ethers.parseEther("1"));

    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, 500n * 10n ** 6n);
    await kashYieldEth.connect(bot).depositToHyperliquid(500n * 10n ** 6n);
    console.log(`       ✅ Moved 500 USDC from Aave → HL`);

    // Move USDC back: simulate HL returning 300 USDC.
    const RETURN = 300n * 10n ** 6n;
    await hre.network.provider.send("hardhat_impersonateAccount", [HL_BRIDGE]);
    await hre.network.provider.send("hardhat_setBalance", [HL_BRIDGE, "0xDE0B6B3A7640000"]);
    const bridgeSigner = await ethers.getSigner(HL_BRIDGE);
    await usdc.connect(bridgeSigner).transfer(await hlAdapter.getAddress(), RETURN);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [HL_BRIDGE]);

    await kashYieldEth.connect(bot).withdrawFromHyperliquid(RETURN);
    await kashYieldEth.connect(bot).repayToAave(USDC_ADDRESS, RETURN);
    console.log(`       ✅ Moved 300 USDC from HL → Aave repay`);
  });

  it("Spot swap: ETH → USDC via real Uniswap V3", async function () {
    const SWAP_ETH = ethers.parseEther("0.2");
    await owner.sendTransaction({ to: await kashYieldEth.getAddress(), value: SWAP_ETH });

    const usdcBefore = await usdc.balanceOf(await kashYieldEth.getAddress());
    await kashYieldEth.connect(bot).swapForUsdc(SWAP_ETH);
    const usdcAfter = await usdc.balanceOf(await kashYieldEth.getAddress());

    expect(usdcAfter).to.be.gt(usdcBefore);
    console.log(`       ✅ 0.2 ETH → ${ethers.formatUnits(usdcAfter - usdcBefore, 6)} USDC`);
  });
});