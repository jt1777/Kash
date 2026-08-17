/**
 * FIX-6 — cancelMintRequest refunds via .call{value} (no 2300-gas .transfer brick).
 * A contract wallet with a gas-heavy receive() can cancel its mint and receive the refund.
 * Run: npx hardhat test test/smart-wallet-cancel.unit.test.js
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Smart-wallet cancel refund (FIX-6)", function () {
  async function deployEthFixture() {
    const [owner, bot, user, feeReceiver] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockERC20")).deploy("WETH", "WETH", 18);
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC", 6);
    const oracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(
      3000n * 10n ** 8n,
      8,
    );
    const kashYield = await (await ethers.getContractFactory("KashYieldETH")).deploy(
      bot.address,
      await weth.getAddress(),
      await usdc.getAddress(),
      feeReceiver.address,
    );
    await kashYield.setEthOracle(await oracle.getAddress());
    await kashYield.setProcessingWindowStart(0);
    await kashYield.setUserWindowEnd(86400);
    return { owner, bot, kashYield };
  }

  it("contract wallet can cancel its mint and receive the native-ETH refund", async function () {
    const { kashYield } = await deployEthFixture();
    const wallet = await (await ethers.getContractFactory("MockSmartWallet")).deploy();
    const cycle = await kashYield.getCurrentBatchCycle();

    await wallet.submitMint(await kashYield.getAddress(), { value: ethers.parseEther("0.01") });

    const balBefore = await ethers.provider.getBalance(await wallet.getAddress());
    await wallet.cancelMint(await kashYield.getAddress(), cycle);

    // receive() ran (storage write) — proves .call{value}, not a 2300-gas .transfer
    expect(await wallet.refunded()).to.equal(true);
    // refund landed (balance restored, gas absorbed by the caller not the refund)
    expect(await ethers.provider.getBalance(await wallet.getAddress())).to.be.gt(
      balBefore + ethers.parseEther("0.005"),
    );
  });
});
