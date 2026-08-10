/**
 * Fork test: UniswapV3Adapter.quoteExactIn uses slot0 spot math (view-safe).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

describe("UniswapV3Adapter.quoteExactIn (slot0 fix)", function () {
  before(function () {
    if (!process.env.ARBITRUM_MAINNET_RPC_URL) {
      this.skip();
    }
  });

  it("returns a sane USDC→wBTC quote within ~1% of QuoterV2 eth_call", async function () {
    const amountIn = 31_800_000n; // 31.8 USDC

    const quoterIface = new ethers.Interface([
      "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256,uint160,uint32,uint256)",
    ]);
    const quoterData = quoterIface.encodeFunctionData("quoteExactInputSingle", [
      { tokenIn: USDC, tokenOut: WBTC, amountIn, fee: 500, sqrtPriceLimitX96: 0 },
    ]);
    const quoterRaw = await ethers.provider.call({ to: QUOTER, data: quoterData });
    const quoterOut = quoterIface.decodeFunctionResult("quoteExactInputSingle", quoterRaw)[0];

    const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
    const adapter = await UniswapV3Adapter.deploy(ROUTER, WETH);
    await adapter.waitForDeployment();

    const adapterOut = await adapter.quoteExactIn.staticCall(USDC, WBTC, amountIn);
    expect(adapterOut).to.be.gt(0n);

    const diffBps =
      adapterOut >= quoterOut
        ? Number(((adapterOut - quoterOut) * 10_000n) / quoterOut)
        : Number(((quoterOut - adapterOut) * 10_000n) / quoterOut);

    console.log("  QuoterV2 eth_call :", quoterOut.toString(), "wBTC satoshis");
    console.log("  adapter slot0     :", adapterOut.toString(), "wBTC satoshis");
    console.log("  diff bps          :", diffBps);

    expect(diffBps).to.be.lte(100);
  });

  it("returns a sane wBTC→USDC quote", async function () {
    const amountIn = 50_000n; // 0.0005 wBTC

    const UniswapV3Adapter = await ethers.getContractFactory("UniswapV3Adapter");
    const adapter = await UniswapV3Adapter.deploy(ROUTER, WETH);
    await adapter.waitForDeployment();

    const adapterOut = await adapter.quoteExactIn.staticCall(WBTC, USDC, amountIn);
    expect(adapterOut).to.be.gt(30_000_000n);
    console.log("  0.0005 wBTC → USDC:", adapterOut.toString(), "micro-USDC");
  });
});
