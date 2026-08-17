const { ethers } = require("hardhat");
const { impersonateAccount, setBalance, time } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const CYCLE_DURATION = 3600n;
const USER_WINDOW_END = 3000n;
const PROCESSING_WINDOW_START = 3000n;
const ETH_USD_8 = 3000n * 10n ** 8n;

/**
 * Deploy a minimal KashYieldETH (Aster) fixture for local batch unit tests.
 * Uses dummy WETH/USDC/facade/spot addresses — only redeem + Phase 1 paths are exercised.
 */
async function deployKashYieldAsterFixture() {
  const [bot, user, attacker, feeReceiver] = await ethers.getSigners();
  const dummy = ethers.Wallet.createRandom().address;

  const MockOracle = await ethers.getContractFactory("MockChainlinkOracle");
  const oracle = await MockOracle.deploy(ETH_USD_8, 8);

  const redeemPayoutBufferBps = 50n;

  const KashYieldETH = await ethers.getContractFactory("KashYieldETH");
  const vault = await KashYieldETH.deploy(
    bot.address,
    dummy,
    dummy,
    dummy,
    dummy,
    await oracle.getAddress(),
    ethers.ZeroAddress,
    feeReceiver.address,
    CYCLE_DURATION,
    USER_WINDOW_END,
    PROCESSING_WINDOW_START,
    100n,
    3n,
    10_000n,
    10_000n,
    redeemPayoutBufferBps,
  );

  const kashTokenAddress = await vault.kashTokenEth();
  const kashToken = await ethers.getContractAt("KashTokenEth", kashTokenAddress);

  await startAtUserWindow(CYCLE_DURATION);

  return {
    bot,
    user,
    attacker,
    feeReceiver,
    vault,
    kashToken,
    oracle,
    CYCLE_DURATION,
    USER_WINDOW_END,
    PROCESSING_WINDOW_START,
    WAD,
  };
}

async function mintKashToUser(vault, kashToken, user, amount) {
  const vaultAddress = await vault.getAddress();
  await impersonateAccount(vaultAddress);
  await setBalance(vaultAddress, ethers.parseEther("1"));
  const vaultSigner = await ethers.getSigner(vaultAddress);
  await kashToken.connect(vaultSigner).mint(user.address, amount);
}

/** Advance to the user window at the start of a batch cycle (fork-safe). */
async function startAtUserWindow(cycleDuration = CYCLE_DURATION) {
  const latest = BigInt(await time.latest());
  const cycle = latest / cycleDuration;
  let target = cycle * cycleDuration + 100n;
  if (target <= latest) {
    target = (cycle + 1n) * cycleDuration + 100n;
  }
  await time.increaseTo(Number(target));
}

/** Set block time to `offset` seconds into the given batch cycle. */
async function jumpToCycleOffset(cycle, offset, cycleDuration = CYCLE_DURATION) {
  const target = cycle * cycleDuration + BigInt(offset);
  await time.increaseTo(Number(target));
}

module.exports = {
  WAD,
  CYCLE_DURATION,
  USER_WINDOW_END,
  PROCESSING_WINDOW_START,
  deployKashYieldAsterFixture,
  mintKashToUser,
  jumpToCycleOffset,
  startAtUserWindow,
};
