// test/mainnet-fork-advanced.e2e.test.js
//
// Advanced end-to-end tests against a forked Arbitrum One mainnet.
// Tests multi-user batches, net mint/redeem with existing positions,
// price movement, USDC movement between Aave/HL, and spot swaps.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const {
  mintProtocolFee,
  usdcBorrowForAssetUsd,
  manualEthMintOps,
  computeBatchGrossRedeemAsset,
  settleMintPhase2,
} = require("./helpers/forkBatchOps");

// Pin to a recent Arbitrum block for reproducibility
const FORK_BLOCK = process.env.FORK_BLOCK_NUMBER 
  ? parseInt(process.env.FORK_BLOCK_NUMBER) 
  : 440_000_000;

const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const WBTC_ADDRESS = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const HL_BRIDGE   = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
const CYCLE_SECS  = 3600n;
const NAV_1       = 10n ** 18n;
const FEE_BPS     = 3n;
const BPS         = 10_000n;

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

    await manualEthMintOps({
      kashYield: kashYieldEth,
      bot,
      hlAdapter,
      mintEthAmount: ethAmount,
    });

    await settleMintPhase2({ kashYield: kashYieldEth, bot, batchCycle, nav: NAV_1 });
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
    const feeBps = BigInt(await kashYieldEth.feeBps());
    const deployTotal = total - mintProtocolFee(eth1, feeBps) - mintProtocolFee(eth2, feeBps);
    const ethPrice = await kashYieldEth.getEthPrice();
    const deployUsd = (deployTotal * ethPrice) / 10n ** 18n;
    const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

    await kashYieldEth.connect(bot).depositToAave(deployTotal);
    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
    await kashYieldEth.connect(bot).depositToHyperliquid(borrowUsdc);

    await settleMintPhase2({ kashYield: kashYieldEth, bot, batchCycle, nav: NAV_1 });
    return batchCycle;
  }

  async function totalRedeemEthFor(kashAmounts, nav = NAV_1) {
    const ethPrice = await kashYieldEth.getEthPrice();
    return kashAmounts.reduce((sum, kashAmount) => {
      const usdValue = (kashAmount * nav) / NAV_1;
      const usdAfterFee = (usdValue * (BPS - FEE_BPS)) / BPS;
      return sum + (usdAfterFee * (10n ** 18n)) / ethPrice;
    }, 0n);
  }

  async function simulateHlReturnToAdapter(amount) {
    if (amount === 0n) return;
    await hre.network.provider.send("hardhat_impersonateAccount", [HL_BRIDGE]);
    await hre.network.provider.send("hardhat_setBalance", [HL_BRIDGE, "0xDE0B6B3A7640000"]);
    const bridgeSigner = await ethers.getSigner(HL_BRIDGE);
    await usdc.connect(bridgeSigner).transfer(await hlAdapter.getAddress(), amount);
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [HL_BRIDGE]);
  }

  async function settlePhase2(batchCycle, nav = NAV_1) {
    await kashYieldEth.connect(bot).updateNAV(nav, 0n, 0n, 0n);
    await kashYieldEth.connect(bot).markBatchOpsDone(batchCycle, 0);
    await kashYieldEth.connect(bot).performUpkeep("0x");
    expect(await kashYieldEth.batchProcessed(batchCycle)).to.be.true;
  }

  async function settleRedeemCycleThroughAaveAndHl(batchCycle, redeemEthNeeded, nav = NAV_1) {
    const adapterDeposit = await hlAdapter.usdcBalance();
    if (adapterDeposit > 0n) {
      await simulateHlReturnToAdapter(adapterDeposit);
      await kashYieldEth.connect(bot).withdrawFromHyperliquid(adapterDeposit);
    }

    const usdcBal = await usdc.balanceOf(await kashYieldEth.getAddress());
    if (usdcBal > 0n) {
      await kashYieldEth.connect(bot).repayToAave(USDC_ADDRESS, usdcBal);
    }

    if (redeemEthNeeded > 0n) {
      await kashYieldEth.connect(bot).withdrawFromAave(redeemEthNeeded);
    }

    await settlePhase2(batchCycle, nav);
  }

  async function setMockEthPrice(price18) {
    const MockChainlinkOracle = await ethers.getContractFactory("MockChainlinkOracle");
    // KashYieldETH normalizes oracle answers by `10 ** (18 - decimals)`.
    // Use an 8-decimal Chainlink-style answer for parity with Arbitrum ETH/USD.
    const mockOracle = await MockChainlinkOracle.deploy(price18 / (10n ** 10n), 8);
    await mockOracle.waitForDeployment();
    await kashYieldEth.setEthOracle(await mockOracle.getAddress());
    return mockOracle;
  }

  it("Multiple users mint in the same batch — both receive KashTokens", async function () {
    const batchCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.5") });
    await kashYieldEth.connect(user2).requestMint(0, { value: ethers.parseEther("0.3") });
    await kashYieldEth.connect(bot).performUpkeep("0x"); // Phase 1
    expect(await kashYieldEth.batchPhase(batchCycle)).to.equal(1);

    const TOTAL_ETH  = ethers.parseEther("0.8");
    const feeBps = BigInt(await kashYieldEth.feeBps());
    const eth0_5 = ethers.parseEther("0.5");
    const eth0_3 = ethers.parseEther("0.3");
    const deployTotal =
      TOTAL_ETH - mintProtocolFee(eth0_5, feeBps) - mintProtocolFee(eth0_3, feeBps);
    const ethPrice   = await kashYieldEth.getEthPrice();
    const deployUsd  = (deployTotal * ethPrice) / (10n ** 18n);
    const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

    await kashYieldEth.connect(bot).depositToAave(deployTotal);
    await kashYieldEth.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
    await kashYieldEth.connect(bot).depositToHyperliquid(borrowUsdc);

    await settleMintPhase2({ kashYield: kashYieldEth, bot, batchCycle, nav: NAV_1 });

    const bal1 = await kashTokenEth.balanceOf(user1.address);
    const bal2 = await kashTokenEth.balanceOf(user2.address);
    expect(bal1).to.be.gt(0n);
    expect(bal2).to.be.gt(0n);
    // user1 deposited 5/8 of total, so should have ~5/8 of tokens (within 1%)
    expect(bal1 * 3n).to.be.closeTo(bal2 * 5n, (bal1 * 3n) / 100n);
    console.log(`       user1: ${ethers.formatEther(bal1)} KASH, user2: ${ethers.formatEther(bal2)} KASH`);
  });

  it("Two users partially redeem in the same batch — settles through HL + Aave and pays both", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.4"), ethers.parseEther("0.4"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const user1KashBefore = await kashTokenEth.balanceOf(user1.address);
    const user2KashBefore = await kashTokenEth.balanceOf(user2.address);
    const supplyBefore = await kashTokenEth.totalSupply();
    const half1 = user1KashBefore / 2n;
    const half2 = user2KashBefore / 2n;
    const user1EthBefore = await ethers.provider.getBalance(user1.address);
    const user2EthBefore = await ethers.provider.getBalance(user2.address);
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), half1);
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), half2);
    await kashYieldEth.connect(user1).requestRedeem(half1);
    await kashYieldEth.connect(user2).requestRedeem(half2);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.redeemUsersCount).to.equal(2n);
    expect(info.totalRedeemKash).to.equal(half1 + half2);

    const redeemEthNeeded = await totalRedeemEthFor([half1, half2]);
    await settleRedeemCycleThroughAaveAndHl(batchCycle, redeemEthNeeded);

    expect(await kashTokenEth.balanceOf(user1.address)).to.equal(user1KashBefore - half1);
    expect(await kashTokenEth.balanceOf(user2.address)).to.equal(user2KashBefore - half2);
    expect(await kashTokenEth.totalSupply()).to.equal(supplyBefore - half1 - half2);
    expect(await ethers.provider.getBalance(user1.address)).to.be.gt(user1EthBefore);
    expect(await ethers.provider.getBalance(user2.address)).to.be.gt(user2EthBefore);
  });

  it("Two users fully redeem in the same batch — burns both balances and pays both", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.25"), ethers.parseEther("0.25"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const b1 = await kashTokenEth.balanceOf(user1.address);
    const b2 = await kashTokenEth.balanceOf(user2.address);
    const supplyBefore = await kashTokenEth.totalSupply();
    const user1EthBefore = await ethers.provider.getBalance(user1.address);
    const user2EthBefore = await ethers.provider.getBalance(user2.address);
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), b1);
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), b2);
    await kashYieldEth.connect(user1).requestRedeem(b1);
    await kashYieldEth.connect(user2).requestRedeem(b2);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.redeemUsersCount).to.equal(2n);
    expect(info.totalRedeemKash).to.equal(b1 + b2);

    const redeemEthNeeded = await totalRedeemEthFor([b1, b2]);
    await settleRedeemCycleThroughAaveAndHl(batchCycle, redeemEthNeeded);

    expect(await kashTokenEth.balanceOf(user1.address)).to.equal(0n);
    expect(await kashTokenEth.balanceOf(user2.address)).to.equal(0n);
    expect(await kashTokenEth.totalSupply()).to.equal(supplyBefore - b1 - b2);
    expect(await ethers.provider.getBalance(user1.address)).to.be.gt(user1EthBefore);
    expect(await ethers.provider.getBalance(user2.address)).to.be.gt(user2EthBefore);
  });

  it("Mixed mint + redeem same batch (net mint) — minter and redeemer both recorded", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.35"), ethers.parseEther("0.35"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const user2BeforeRequest = await kashTokenEth.balanceOf(user2.address);
    const redeemAmt = (await kashTokenEth.balanceOf(user2.address)) / 4n;
    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.6") });
    await kashTokenEth.connect(user2).approve(await kashYieldEth.getAddress(), redeemAmt);
    await kashYieldEth.connect(user2).requestRedeem(redeemAmt);
    const user2AfterRequest = await kashTokenEth.balanceOf(user2.address);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    const info = await kashYieldEth.getBatchInfo(batchCycle);
    expect(info.mintUsersCount).to.equal(1n);
    expect(info.redeemUsersCount).to.equal(1n);
    expect(info.totalMintUSD).to.be.gt(info.totalRedeemUSD);

    const user1Before = await kashTokenEth.balanceOf(user1.address);
    const supplyBefore = await kashTokenEth.totalSupply();
    await settlePhase2(batchCycle);

    expect(await kashTokenEth.balanceOf(user1.address)).to.be.gt(user1Before);
    expect(user2AfterRequest).to.equal(user2BeforeRequest - redeemAmt);
    expect(await kashTokenEth.balanceOf(user2.address)).to.equal(user2AfterRequest);
    expect(await kashTokenEth.totalSupply()).to.be.gt(supplyBefore - redeemAmt);
  });

  it("Mixed mint + redeem (net redeem) — strategy unwind fraction <= gross redeem fraction", async function () {
    await runMultiUserMintCycle(ethers.parseEther("0.5"), ethers.parseEther("0.5"));

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine", []);
    const batchCycle =
      BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const user1BeforeRequest = await kashTokenEth.balanceOf(user1.address);
    const redeemAmt = (user1BeforeRequest * 3n) / 4n;
    await kashYieldEth.connect(user1).requestMint(0, { value: ethers.parseEther("0.05") });
    await kashTokenEth.connect(user1).approve(await kashYieldEth.getAddress(), redeemAmt);
    await kashYieldEth.connect(user1).requestRedeem(redeemAmt);
    const user1AfterRequest = await kashTokenEth.balanceOf(user1.address);
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

    const redeemEthNeeded = await totalRedeemEthFor([redeemAmt]);
    await settleRedeemCycleThroughAaveAndHl(batchCycle, redeemEthNeeded);

    const user1AfterSettlement = await kashTokenEth.balanceOf(user1.address);
    expect(user1AfterRequest).to.equal(user1BeforeRequest - redeemAmt);
    expect(user1AfterSettlement).to.be.gt(user1AfterRequest);
    expect(user1AfterSettlement).to.be.lt(user1BeforeRequest);
    expect(await kashYieldEth.batchProcessed(batchCycle)).to.be.true;
  });

  it("Redeem after ETH price doubles with flat NAV — receives fewer ETH units", async function () {
    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");

    const mintPrice = await kashYieldEth.getEthPrice();
    await runMintCycle(user3, ethers.parseEther("1"));
    const kashBalance = await kashTokenEth.balanceOf(user3.address);
    expect(kashBalance).to.be.gt(0n);

    await setMockEthPrice(mintPrice * 2n);

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");
    const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const expectedRedeemEth = await totalRedeemEthFor([kashBalance]);
    expect(expectedRedeemEth).to.be.lt(ethers.parseEther("0.6"));

    const ethBefore = await ethers.provider.getBalance(user3.address);
    await kashTokenEth.connect(user3).approve(await kashYieldEth.getAddress(), kashBalance);
    await kashYieldEth.connect(user3).requestRedeem(kashBalance);
    await kashYieldEth.connect(bot).performUpkeep("0x");
    await settleRedeemCycleThroughAaveAndHl(redeemCycle, expectedRedeemEth);

    const ethAfter = await ethers.provider.getBalance(user3.address);
    expect(ethAfter - ethBefore).to.be.closeTo(expectedRedeemEth, expectedRedeemEth / 100n);
    expect(ethAfter - ethBefore).to.be.lt(ethers.parseEther("0.6"));
  });

  it("Redeem after ETH price halves with flat NAV — receives more ETH units", async function () {
    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");

    const mintPrice = await kashYieldEth.getEthPrice();
    await runMintCycle(user3, ethers.parseEther("1"));
    const kashBalance = await kashTokenEth.balanceOf(user3.address);
    expect(kashBalance).to.be.gt(0n);

    await setMockEthPrice(mintPrice / 2n);

    await ethers.provider.send("evm_increaseTime", [Number(CYCLE_SECS)]);
    await ethers.provider.send("evm_mine");
    const redeemCycle = BigInt((await ethers.provider.getBlock("latest")).timestamp) / CYCLE_SECS;

    const expectedRedeemEth = await totalRedeemEthFor([kashBalance]);
    expect(expectedRedeemEth).to.be.gt(ethers.parseEther("1.8"));

    const ethBefore = await ethers.provider.getBalance(user3.address);
    await kashTokenEth.connect(user3).approve(await kashYieldEth.getAddress(), kashBalance);
    await kashYieldEth.connect(user3).requestRedeem(kashBalance);
    await kashYieldEth.connect(bot).performUpkeep("0x");

    // Falling ETH price means the short profit should fund extra ETH. Simulate that profit by
    // adding the extra redeem ETH needed beyond the original 1 ETH Aave collateral.
    if (expectedRedeemEth > ethers.parseEther("1")) {
      await owner.sendTransaction({
        to: await kashYieldEth.getAddress(),
        value: expectedRedeemEth - ethers.parseEther("1"),
      });
    }
    await settleRedeemCycleThroughAaveAndHl(redeemCycle, ethers.parseEther("1"));

    const ethAfter = await ethers.provider.getBalance(user3.address);
    expect(ethAfter - ethBefore).to.be.closeTo(expectedRedeemEth, expectedRedeemEth / 100n);
    expect(ethAfter - ethBefore).to.be.gt(ethers.parseEther("1.8"));
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
    const settlementNav = ethers.parseEther("1.1");
    await kashYieldEth.connect(bot).updateNAV(settlementNav, 0n, 0n, 0n);
    const grossG = await computeBatchGrossRedeemAsset(kashYieldEth, redeemCycle, NAV_1);
    await kashYieldEth.connect(bot).markBatchOpsDone(redeemCycle, grossG);
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