const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { getLinkedVaultFactory } = require("./helpers/linkKashVault");

const WAD = 10n ** 18n;
const CYCLE = 3600n;

describe("KashVaultBtc decimals + 8-dec wBTC", function () {
  it("totalAssets scales 18-dec shares to 8-dec wBTC", async function () {
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
      cycleDurationSeconds: CYCLE,
      userWindowEnd: 3000n,
      processingWindowStart: 3000n,
      maxSwapSlippageBps: 50n,
      feeBps: 5n,
      maxDepositUsers: 100n,
      maxRedeemUsers: 100n,
      redeemPayoutBufferBps: 50n,
    });

    expect(await vault.name()).to.equal("KASH-BTC");
    expect(await vault.decimals()).to.equal(18);
    expect(await vault.assetDecimals()).to.equal(8);

    const latest = BigInt(await time.latest());
    const cycle = latest / CYCLE;
    let target = cycle * CYCLE + 100n;
    if (target <= latest) target = (cycle + 1n) * CYCLE + 100n;
    await time.increaseTo(Number(target));

    const amount = 1_00000000n; // 1 wBTC
    await wbtc.mint(user.address, amount);
    await wbtc.connect(user).approve(await vault.getAddress(), amount);
    await vault.connect(user).requestDeposit(amount, user.address, user.address);

    const c = await vault.getCurrentBatchCycle();
    await time.increaseTo(Number(c * CYCLE + 3001n));
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(c);
    await vault.connect(bot).performUpkeep("0x");
    await time.increase(6 * 3600);

    await vault.connect(user)["deposit(uint256,address)"](amount, user.address);
    const ta = await vault.totalAssets();
    expect(ta).to.be.closeTo((amount * 9995n) / 10000n, 1000n);
    const shares = await vault.balanceOf(user.address);
    expect(shares).to.be.gt(WAD);
  });
});
