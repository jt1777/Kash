const { ethers } = require("hardhat");
const { deployKashVaultEthFixture } = require("./deployKashVaultEthFixture");

const DEFAULT_ASSET_OUT = ethers.parseEther("1");
const DEFAULT_STABLE_IN = 1_000000n; // 1 USDC (6 dec)
const MAX_SLIPPAGE_BPS = 50n;

async function fundSpotWithWeth(weth, spot, deployer, amount) {
  await weth.connect(deployer).deposit({ value: amount });
  await weth.connect(deployer).transfer(await spot.getAddress(), amount);
}

async function deployKashPipeEthFixture(opts = {}) {
  const ctx = await deployKashVaultEthFixture();
  const assetOut = opts.assetOut ?? DEFAULT_ASSET_OUT;
  const maxSlippageBps = opts.maxSlippageBps ?? MAX_SLIPPAGE_BPS;

  await ctx.spot.setQuoteOut(assetOut);
  await fundSpotWithWeth(ctx.weth, ctx.spot, ctx.deployer, assetOut * 20n);

  const KashPipe = await ethers.getContractFactory("KashPipe");
  const pipe = await KashPipe.deploy(
    await ctx.vault.getAddress(),
    await ctx.usdc.getAddress(),
    await ctx.weth.getAddress(),
    await ctx.spot.getAddress(),
    maxSlippageBps,
  );

  return { ...ctx, pipe, assetOut, maxSlippageBps };
}

async function approveAndRequest(pipe, stable, user, amount, minAssetOut, controller) {
  await stable.connect(user).approve(await pipe.getAddress(), amount);
  return pipe.connect(user).requestDepositStable(amount, minAssetOut, controller || user.address);
}

module.exports = {
  DEFAULT_ASSET_OUT,
  DEFAULT_STABLE_IN,
  MAX_SLIPPAGE_BPS,
  deployKashPipeEthFixture,
  fundSpotWithWeth,
  approveAndRequest,
};
