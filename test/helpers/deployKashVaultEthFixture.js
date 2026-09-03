const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { getLinkedVaultFactory } = require("./linkKashVault");

const WAD = 10n ** 18n;
const CYCLE_DURATION = 3600n;
const USER_WINDOW_END = 3000n;
const PROCESSING_WINDOW_START = 3000n;
const ETH_USD_8 = 3000n * 10n ** 8n;
const FEE_BPS = 5n;
const CLAIM_HOLD_SECONDS = 6n * 3600n;

async function deployKashVaultEthFixture() {
  const [deployer, owner, bot, watcher, user, user2, feeReceiver] = await ethers.getSigners();

  const MockWETH = await ethers.getContractFactory("MockWETH");
  const weth = await MockWETH.deploy();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  const aWeth = await MockERC20.deploy("aWETH", "aWETH", 18);
  const debtUsdc = await MockERC20.deploy("variableDebtUSDC", "vdUSDC", 6);

  const MockOracle = await ethers.getContractFactory("MockChainlinkOracle");
  const oracle = await MockOracle.deploy(ETH_USD_8, 8);

  const MockAavePool = await ethers.getContractFactory("MockAavePool");
  const aave = await MockAavePool.deploy();
  await aave.setReserve(await weth.getAddress(), await aWeth.getAddress(), await debtUsdc.getAddress());

  const MockSpotDex = await ethers.getContractFactory("MockSpotDex");
  const spot = await MockSpotDex.deploy();

  const MockPerpAdapter = await ethers.getContractFactory("MockPerpAdapter");
  const adapter = await MockPerpAdapter.deploy();

  const MockAster = await ethers.getContractFactory("MockAsterClearingHouse");
  const aster = await MockAster.deploy();

  const KashVaultEth = await getLinkedVaultFactory("KashVaultEth");
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedVault = ethers.getCreateAddress({
    from: deployer.address,
    nonce: nonce + 1,
  });

  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    bot.address,
    ethers.ZeroAddress,
    await usdc.getAddress(),
    await weth.getAddress(),
    predictedVault,
    "ASTER",
    await adapter.getAddress(),
  );

  const vault = await KashVaultEth.deploy({
    owner: owner.address,
    bot: bot.address,
    watcher: watcher.address,
    asset: await weth.getAddress(),
    usdc: await usdc.getAddress(),
    exchangeFacade: await facade.getAddress(),
    spotDex: await spot.getAddress(),
    assetOracle: await oracle.getAddress(),
    keeperRegistry: ethers.ZeroAddress,
    feeReceiver: feeReceiver.address,
    aavePool: await aave.getAddress(),
    aToken: await aWeth.getAddress(),
    variableDebtUsdc: await debtUsdc.getAddress(),
    asterClearingHouse: await aster.getAddress(),
    cycleDurationSeconds: CYCLE_DURATION,
    userWindowEnd: USER_WINDOW_END,
    processingWindowStart: PROCESSING_WINDOW_START,
    maxSwapSlippageBps: 50n,
    feeBps: FEE_BPS,
    maxDepositUsers: 100n,
    maxRedeemUsers: 100n,
    redeemPayoutBufferBps: 50n,
  });

  if ((await vault.getAddress()).toLowerCase() !== predictedVault.toLowerCase()) {
    throw new Error("vault address mismatch vs facade wiring");
  }

  await startAtUserWindow(CYCLE_DURATION);

  return {
    deployer,
    owner,
    bot,
    watcher,
    user,
    user2,
    feeReceiver,
    weth,
    usdc,
    aWeth,
    debtUsdc,
    oracle,
    aave,
    spot,
    adapter,
    aster,
    facade,
    vault,
  };
}

async function startAtUserWindow(cycleDuration = CYCLE_DURATION) {
  const latest = BigInt(await time.latest());
  const cycle = latest / cycleDuration;
  let target = cycle * cycleDuration + 100n;
  if (target <= latest) target = (cycle + 1n) * cycleDuration + 100n;
  await time.increaseTo(Number(target));
}

async function jumpToCycleOffset(cycle, offset, cycleDuration = CYCLE_DURATION) {
  await time.increaseTo(Number(cycle * cycleDuration + BigInt(offset)));
}

async function runBatchToClaimable(vault, bot, cycle) {
  await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
  await vault.connect(bot).performUpkeep("0x");
  await vault.connect(bot).markBatchOpsDone(cycle);
  await vault.connect(bot).performUpkeep("0x");
  await time.increase(Number(CLAIM_HOLD_SECONDS));
}

async function seedWeth(weth, user, amount) {
  await weth.connect(user).deposit({ value: amount });
}

module.exports = {
  WAD,
  CYCLE_DURATION,
  USER_WINDOW_END,
  PROCESSING_WINDOW_START,
  ETH_USD_8,
  FEE_BPS,
  CLAIM_HOLD_SECONDS,
  deployKashVaultEthFixture,
  startAtUserWindow,
  jumpToCycleOffset,
  runBatchToClaimable,
  seedWeth,
};
