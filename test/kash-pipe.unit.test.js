const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { getLinkedVaultFactory } = require("./helpers/linkKashVault");
const {
  WAD,
  CYCLE_DURATION,
  PROCESSING_WINDOW_START,
  FEE_BPS,
  jumpToCycleOffset,
  runBatchToClaimable,
  seedWeth,
} = require("./helpers/deployKashVaultEthFixture");
const {
  DEFAULT_STABLE_IN,
  deployKashPipeEthFixture,
  approveAndRequest,
} = require("./helpers/deployKashPipeEthFixture");

const BPS = 10_000n;
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARB_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

describe("KashPipe ERC-7575 stable entry", function () {
  async function mintStable(stable, user, amount) {
    await stable.mint(user.address, amount);
  }

  it("asset is the stable, share is the vault, ERC-165/7575 only", async function () {
    const { pipe, vault, usdc } = await deployKashPipeEthFixture();
    expect(await pipe.asset()).to.equal(await usdc.getAddress());
    expect(await pipe.share()).to.equal(await vault.getAddress());
    expect(await pipe.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await pipe.supportsInterface("0x2f0a18c5")).to.equal(true);
    expect(await pipe.supportsInterface("0xf815c03d")).to.equal(false);
    expect(await pipe.supportsInterface("0xe3bc4e65")).to.equal(false);
  });

  it("handoff: controller=user, owner=pipe; user can claim and pipe cannot", async function () {
    const { pipe, vault, usdc, weth, bot, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    const tx = await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);

    const cycle = await vault.getCurrentBatchCycle();
    await expect(tx)
      .to.emit(vault, "DepositRequest")
      .withArgs(user.address, await pipe.getAddress(), cycle, await pipe.getAddress(), assetOut);

    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(assetOut);
    expect(await vault.pendingDepositRequest(cycle, await pipe.getAddress())).to.equal(0n);

    await runBatchToClaimable(vault, bot, cycle);

    await ethers.provider.send("hardhat_impersonateAccount", [await pipe.getAddress()]);
    await ethers.provider.send("hardhat_setBalance", [await pipe.getAddress(), "0x56BC75E2D63100000"]);
    const pipeSigner = await ethers.getSigner(await pipe.getAddress());
    await expect(
      vault.connect(pipeSigner)["deposit(uint256,address,address)"](assetOut, user.address, user.address),
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [await pipe.getAddress()]);

    await vault.connect(user)["deposit(uint256,address)"](assetOut, user.address);
    expect(await vault.balanceOf(user.address)).to.be.gt(0n);
    expect(await weth.balanceOf(user.address)).to.equal(0n);
  });

  it("pipe is not credited: pending is on the user in asset units", async function () {
    const { pipe, vault, usdc, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, await pipe.getAddress())).to.equal(0n);
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(assetOut);
  });

  it("minAssetOut too high reverts and user keeps the stable", async function () {
    const { pipe, usdc, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await usdc.connect(user).approve(await pipe.getAddress(), DEFAULT_STABLE_IN);
    const before = await usdc.balanceOf(user.address);
    await expect(
      pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, assetOut + 1n, user.address),
    ).to.be.revertedWith("MockSpotDex: minOut");
    expect(await usdc.balanceOf(user.address)).to.equal(before);
    expect(await usdc.balanceOf(await pipe.getAddress())).to.equal(0n);
  });

  it("minAssetOut == 0 reverts MinOutRequired", async function () {
    const { pipe, usdc, user } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await usdc.connect(user).approve(await pipe.getAddress(), DEFAULT_STABLE_IN);
    await expect(
      pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, 0n, user.address),
    ).to.be.revertedWithCustomError(pipe, "MinOutRequired");
  });

  it("vault paused: whole tx reverts atomically; pipe retains no stable", async function () {
    const { pipe, vault, usdc, watcher, user } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await usdc.connect(user).approve(await pipe.getAddress(), DEFAULT_STABLE_IN);
    await vault.connect(watcher).pause();
    const before = await usdc.balanceOf(user.address);
    await expect(
      pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, 1n, user.address),
    ).to.be.revertedWithCustomError(vault, "ContractPaused");
    expect(await usdc.balanceOf(user.address)).to.equal(before);
    expect(await usdc.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await ethers.provider.getCode(await pipe.getAddress())).to.not.equal("0x");
  });

  it("outside the user window reverts", async function () {
    const { pipe, vault, usdc, user } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await usdc.connect(user).approve(await pipe.getAddress(), DEFAULT_STABLE_IN);
    const cycle = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await expect(
      pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, 1n, user.address),
    ).to.be.revertedWithCustomError(vault, "UserWindowClosed");
  });

  it("credits 18-dec WETH from a 6-dec stable swap", async function () {
    const { pipe, vault, usdc, user, assetOut } = await deployKashPipeEthFixture();
    expect(assetOut).to.equal(ethers.parseEther("1"));
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(10n ** 18n);
  });

  it("mixed cycle: pipe user and direct WETH user share the batch rate", async function () {
    const { pipe, vault, usdc, weth, bot, user, user2, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);

    await seedWeth(weth, user2, assetOut);
    await weth.connect(user2).approve(await vault.getAddress(), assetOut);
    await vault.connect(user2).requestDeposit(assetOut, user2.address, user2.address);

    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(assetOut);
    expect(await vault.pendingDepositRequest(cycle, user2.address)).to.equal(assetOut);

    await runBatchToClaimable(vault, bot, cycle);
    expect(await vault.maxMint(user.address)).to.equal(await vault.maxMint(user2.address));
    expect(await vault.maxMint(user.address)).to.be.gt(0n);

    await vault.connect(user)["deposit(uint256,address)"](assetOut, user.address);
    await vault.connect(user2)["deposit(uint256,address)"](assetOut, user2.address);
    expect(await vault.balanceOf(user.address)).to.equal(await vault.balanceOf(user2.address));
  });

  it("N+1 applies to pipe-funded shares", async function () {
    const { pipe, vault, usdc, bot, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    await vault.connect(user)["deposit(uint256,address)"](assetOut, user.address);
    const shares = await vault.balanceOf(user.address);
    const mintCycle = await vault.lastMintCycle(user.address);
    expect(mintCycle).to.equal(await vault.getCurrentBatchCycle());

    if (await vault.isUserWindow()) {
      await expect(
        vault.connect(user).requestRedeem(shares, user.address, user.address),
      ).to.be.revertedWithCustomError(vault, "NPlusOneHoldNotMet");
    }

    const next = mintCycle + 1n;
    await jumpToCycleOffset(next, 100n);
    await vault.connect(user).requestRedeem(shares, user.address, user.address);
    expect(await vault.pendingRedeemRequest(next, user.address)).to.equal(shares);
  });

  it("fee is applied at claimable for pipe deposits", async function () {
    const { pipe, vault, usdc, bot, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    const sharesLocked = await vault.maxMint(user.address);
    const price = await vault.getAssetPrice();
    const usd = (assetOut * price) / WAD;
    expect(sharesLocked).to.equal((usd * (BPS - FEE_BPS)) / BPS);
  });

  it("USDT forceApprove works against a non-standard approve token", async function () {
    const ctx = await deployKashPipeEthFixture();
    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy();
    const KashPipe = await ethers.getContractFactory("KashPipe");
    const usdtPipe = await KashPipe.deploy(
      await ctx.vault.getAddress(),
      await usdt.getAddress(),
      await ctx.weth.getAddress(),
      await ctx.spot.getAddress(),
      50n,
    );
    await usdt.setAllowance(await usdtPipe.getAddress(), await ctx.spot.getAddress(), 1n);
    await usdt.mint(ctx.user.address, DEFAULT_STABLE_IN);
    await usdt.connect(ctx.user).approve(await usdtPipe.getAddress(), DEFAULT_STABLE_IN);
    await usdtPipe.connect(ctx.user).requestDepositStable(DEFAULT_STABLE_IN, 1n, ctx.user.address);
    const cycle = await ctx.vault.getCurrentBatchCycle();
    expect(await ctx.vault.pendingDepositRequest(cycle, ctx.user.address)).to.equal(ctx.assetOut);
    expect(await usdt.balanceOf(await usdtPipe.getAddress())).to.equal(0n);
  });

  it("pipe token balances are zero after the call", async function () {
    const { pipe, vault, usdc, weth, user, assetOut } = await deployKashPipeEthFixture();
    await mintStable(usdc, user, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    expect(await usdc.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(assetOut);
  });

  it("arbitrary token has no route (DAI cannot fund a request)", async function () {
    const { pipe, vault, usdc, user } = await deployKashPipeEthFixture();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const dai = await MockERC20.deploy("DAI", "DAI", 18);
    await dai.mint(user.address, ethers.parseEther("1000"));
    await dai.connect(user).approve(await pipe.getAddress(), ethers.parseEther("1000"));
    await expect(
      pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, 1n, user.address),
    ).to.be.reverted;
    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(0n);
    expect(await dai.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await pipe.getAddress())).to.equal(0n);
  });

  it("6-dec stable → 8-dec wBTC conversion on KashVaultBtc", async function () {
    const [deployer, owner, bot, user, feeReceiver] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const wbtc = await MockERC20.deploy("WBTC", "WBTC", 8);
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);
    const MockOracle = await ethers.getContractFactory("MockChainlinkOracle");
    const oracle = await MockOracle.deploy(100_000n * 10n ** 8n, 8);
    const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
    const spot = await MockSpotDex.deploy();
    const MockPerpAdapter = await ethers.getContractFactory("MockPerpAdapter");
    const adapter = await MockPerpAdapter.deploy();

    const KashVaultBtc = await getLinkedVaultFactory("KashVaultBtc");
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predictedVault = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
    const facade = await ExchangeFacade.deploy(
      bot.address,
      ethers.ZeroAddress,
      await usdc.getAddress(),
      await wbtc.getAddress(),
      predictedVault,
      "ASTER",
      await adapter.getAddress(),
    );
    const vault = await KashVaultBtc.deploy({
      owner: owner.address,
      bot: bot.address,
      watcher: ethers.ZeroAddress,
      asset: await wbtc.getAddress(),
      usdc: await usdc.getAddress(),
      exchangeFacade: await facade.getAddress(),
      spotDex: await spot.getAddress(),
      assetOracle: await oracle.getAddress(),
      keeperRegistry: ethers.ZeroAddress,
      feeReceiver: feeReceiver.address,
      aavePool: ethers.ZeroAddress,
      aToken: ethers.ZeroAddress,
      variableDebtUsdc: ethers.ZeroAddress,
      asterClearingHouse: ethers.ZeroAddress,
      cycleDurationSeconds: CYCLE_DURATION,
      userWindowEnd: 3000n,
      processingWindowStart: 3000n,
      maxSwapSlippageBps: 50n,
      feeBps: 5n,
      maxDepositUsers: 100n,
      maxRedeemUsers: 100n,
      redeemPayoutBufferBps: 50n,
    });

    const latest = BigInt(await time.latest());
    const cycle0 = latest / CYCLE_DURATION;
    let target = cycle0 * CYCLE_DURATION + 100n;
    if (target <= latest) target = (cycle0 + 1n) * CYCLE_DURATION + 100n;
    await time.increaseTo(Number(target));

    const wbtcOut = 1000n; // 0.00001 wBTC (8 dec)
    await spot.setQuoteOut(wbtcOut);
    await wbtc.mint(await spot.getAddress(), wbtcOut * 10n);

    const KashPipe = await ethers.getContractFactory("KashPipe");
    const pipe = await KashPipe.deploy(
      await vault.getAddress(),
      await usdc.getAddress(),
      await wbtc.getAddress(),
      await spot.getAddress(),
      50n,
    );
    await usdc.mint(user.address, DEFAULT_STABLE_IN);
    await usdc.connect(user).approve(await pipe.getAddress(), DEFAULT_STABLE_IN);
    await pipe.connect(user).requestDepositStable(DEFAULT_STABLE_IN, 1n, user.address);
    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(wbtcOut);
    expect(await wbtc.balanceOf(await pipe.getAddress())).to.equal(0n);
  });

  it("named USDC/USDT wrappers bake Arbitrum stable addresses", async function () {
    const { vault, weth, spot } = await deployKashPipeEthFixture();
    const Usdc = await ethers.getContractFactory("KashPipeUsdc");
    const usdcPipe = await Usdc.deploy(
      await vault.getAddress(),
      await weth.getAddress(),
      await spot.getAddress(),
      50n,
    );
    expect(await usdcPipe.asset()).to.equal(ethers.getAddress(ARB_USDC));
    expect(await usdcPipe.share()).to.equal(await vault.getAddress());

    const Usdt = await ethers.getContractFactory("KashPipeUsdt");
    const usdtPipe = await Usdt.deploy(
      await vault.getAddress(),
      await weth.getAddress(),
      await spot.getAddress(),
      100n,
    );
    expect(await usdtPipe.asset()).to.equal(ethers.getAddress(ARB_USDT));
  });

  it("constructor rejects a vault/asset mismatch", async function () {
    const { vault, usdc, spot } = await deployKashPipeEthFixture();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const other = await MockERC20.deploy("OTHER", "OTH", 18);
    const KashPipe = await ethers.getContractFactory("KashPipe");
    await expect(
      KashPipe.deploy(
        await vault.getAddress(),
        await usdc.getAddress(),
        await other.getAddress(),
        await spot.getAddress(),
        50n,
      ),
    ).to.be.revertedWithCustomError(KashPipe, "InvalidAddress");
  });
});

describe("KashPipe stable redeem", function () {
  async function userWithShares() {
    const ctx = await deployKashPipeEthFixture();
    const { pipe, vault, usdc, bot, user, assetOut } = ctx;
    await usdc.mint(user.address, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const depositCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, depositCycle);
    await vault.connect(user)["deposit(uint256,address)"](assetOut, user.address);
    const mintCycle = await vault.lastMintCycle(user.address);
    await jumpToCycleOffset(mintCycle + 1n, 100n);
    const shares = await vault.balanceOf(user.address);
    return { ...ctx, shares };
  }

  it("requestRedeemStable without operator reverts Unauthorized", async function () {
    const { pipe, vault, user, shares } = await userWithShares();
    await expect(pipe.connect(user).requestRedeemStable(shares, user.address)).to.be.revertedWithCustomError(
      vault,
      "Unauthorized",
    );
  });

  it("N+1 still applies when redeeming via the pipe", async function () {
    const { pipe, vault, usdc, bot, user, assetOut } = await deployKashPipeEthFixture();
    await usdc.mint(user.address, DEFAULT_STABLE_IN);
    await approveAndRequest(pipe, usdc, user, DEFAULT_STABLE_IN, 1n);
    const depositCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, depositCycle);
    await vault.connect(user)["deposit(uint256,address)"](assetOut, user.address);
    const shares = await vault.balanceOf(user.address);
    await vault.connect(user).setOperator(await pipe.getAddress(), true);
    if (await vault.isUserWindow()) {
      await expect(pipe.connect(user).requestRedeemStable(shares, user.address)).to.be.revertedWithCustomError(
        vault,
        "NPlusOneHoldNotMet",
      );
    }
    const next = (await vault.lastMintCycle(user.address)) + 1n;
    await jumpToCycleOffset(next, 100n);
    await pipe.connect(user).requestRedeemStable(shares, user.address);
    expect(await vault.pendingRedeemRequest(next, user.address)).to.equal(shares);
    expect(await vault.pendingRedeemRequest(next, await pipe.getAddress())).to.equal(0n);
  });

  it("claimRedeemStable pays USDC to the user and leaves the pipe empty", async function () {
    const { pipe, vault, usdc, weth, bot, user, shares, spot } = await userWithShares();
    await vault.connect(user).setOperator(await pipe.getAddress(), true);
    await pipe.connect(user).requestRedeemStable(shares, user.address);
    const redeemCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, redeemCycle);

    const claimableShares = await vault.claimableRedeemRequest(redeemCycle, user.address);
    await spot.setQuoteOut(DEFAULT_STABLE_IN);
    const usdcBefore = await usdc.balanceOf(user.address);
    await pipe.connect(user).claimRedeemStable(claimableShares, 1n, user.address);

    expect(await usdc.balanceOf(user.address)).to.equal(usdcBefore + DEFAULT_STABLE_IN);
    expect(await weth.balanceOf(user.address)).to.equal(0n);
    expect(await usdc.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await pipe.getAddress())).to.equal(0n);
    expect(await vault.claimableRedeemRequest(redeemCycle, user.address)).to.equal(0n);
  });

  it("claimRedeemStable without operator reverts; minStableOut == 0 reverts MinOutRequired", async function () {
    const { pipe, vault, bot, user, shares, spot } = await userWithShares();
    await vault.connect(user).setOperator(await pipe.getAddress(), true);
    await pipe.connect(user).requestRedeemStable(shares, user.address);
    const redeemCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, redeemCycle);
    const claimableShares = await vault.claimableRedeemRequest(redeemCycle, user.address);

    await vault.connect(user).setOperator(await pipe.getAddress(), false);
    await expect(
      pipe.connect(user).claimRedeemStable(claimableShares, 1n, user.address),
    ).to.be.revertedWithCustomError(vault, "Unauthorized");

    await vault.connect(user).setOperator(await pipe.getAddress(), true);
    await expect(pipe.connect(user).claimRedeemStable(claimableShares, 0n, user.address)).to.be.revertedWithCustomError(
      pipe,
      "MinOutRequired",
    );

    await spot.setQuoteOut(DEFAULT_STABLE_IN);
    await expect(
      pipe.connect(user).claimRedeemStable(claimableShares, DEFAULT_STABLE_IN + 1n, user.address),
    ).to.be.revertedWith("MockSpotDex: minOut");
    expect(await vault.claimableRedeemRequest(redeemCycle, user.address)).to.equal(claimableShares);
  });

  it("vault redeem still pays WETH; pipe claim is optional", async function () {
    const { vault, weth, bot, user, shares } = await userWithShares();
    await vault.connect(user).requestRedeem(shares, user.address, user.address);
    const redeemCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, redeemCycle);
    const claimableShares = await vault.claimableRedeemRequest(redeemCycle, user.address);
    const before = await weth.balanceOf(user.address);
    await vault.connect(user)["redeem(uint256,address,address)"](claimableShares, user.address, user.address);
    expect(await weth.balanceOf(user.address)).to.be.gt(before);
  });

  it("cancel after pipe request returns shares to the user", async function () {
    const { pipe, vault, user, shares } = await userWithShares();
    await vault.connect(user).setOperator(await pipe.getAddress(), true);
    await pipe.connect(user).requestRedeemStable(shares, user.address);
    const cycle = await vault.getCurrentBatchCycle();
    await vault.connect(user).cancelRedeemRequest(cycle, user.address);
    expect(await vault.balanceOf(user.address)).to.equal(shares);
    expect(await vault.pendingRedeemRequest(cycle, user.address)).to.equal(0n);
  });
});
