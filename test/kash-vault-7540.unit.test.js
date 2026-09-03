const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  WAD,
  CYCLE_DURATION,
  PROCESSING_WINDOW_START,
  FEE_BPS,
  CLAIM_HOLD_SECONDS,
  deployKashVaultEthFixture,
  jumpToCycleOffset,
  runBatchToClaimable,
  seedWeth,
} = require("./helpers/deployKashVaultEthFixture");

const BPS = 10_000n;

describe("KashVaultEth 4626/7540", function () {
  async function depositRequest(vault, weth, user, assets, controller) {
    await seedWeth(weth, user, assets);
    await weth.connect(user).approve(await vault.getAddress(), assets);
    return vault.connect(user).requestDeposit(assets, controller || user.address, user.address);
  }

  it("vault is the share token with 18 decimals and WETH asset", async function () {
    const { vault, weth } = await deployKashVaultEthFixture();
    expect(await vault.name()).to.equal("KASH-ETH");
    expect(await vault.symbol()).to.equal("KASH-ETH");
    expect(await vault.decimals()).to.equal(18);
    expect(await vault.asset()).to.equal(await weth.getAddress());
    expect(await vault.share()).to.equal(await vault.getAddress());
    expect(await vault.feeBps()).to.equal(FEE_BPS);
  });

  it("supports ERC-165 / 7540 / 7575 vault-side IDs", async function () {
    const { vault } = await deployKashVaultEthFixture();
    expect(await vault.supportsInterface("0x01ffc9a7")).to.equal(true);
    expect(await vault.supportsInterface("0xe3bc4e65")).to.equal(true);
    expect(await vault.supportsInterface("0xce3bbe50")).to.equal(true);
    expect(await vault.supportsInterface("0x620ee8e4")).to.equal(true);
    expect(await vault.supportsInterface("0x2f0a18c5")).to.equal(true);
    expect(await vault.supportsInterface("0xf815c03d")).to.equal(false);
    expect(await vault.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("preview* reverts for all inputs", async function () {
    const { vault } = await deployKashVaultEthFixture();
    await expect(vault.previewDeposit(1)).to.be.revertedWithCustomError(vault, "PreviewNotSupported");
    await expect(vault.previewMint(1)).to.be.revertedWithCustomError(vault, "PreviewNotSupported");
    await expect(vault.previewRedeem(1)).to.be.revertedWithCustomError(vault, "PreviewNotSupported");
    await expect(vault.previewWithdraw(1)).to.be.revertedWithCustomError(vault, "PreviewNotSupported");
  });

  it("requestId equals batch cycle and never returns 0 for a live cycle", async function () {
    const { vault, weth, user } = await deployKashVaultEthFixture();
    const cycle = await vault.getCurrentBatchCycle();
    expect(cycle).to.be.gt(0n);
    const assets = ethers.parseEther("1");
    await depositRequest(vault, weth, user, assets);
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(assets);
  });

  it("7540 deposit lifecycle: pending → claimable → claimed; deposit does not pull WETH", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("1");
    const userWethBefore = await weth.balanceOf(user.address);
    await depositRequest(vault, weth, user, assets);
    expect(await weth.balanceOf(user.address)).to.equal(userWethBefore); // seeded then pulled
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(assets);

    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);

    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(0n);
    const claimable = await vault.claimableDepositRequest(cycle, user.address);
    expect(claimable).to.equal(assets);

    const wethBeforeClaim = await weth.balanceOf(user.address);
    await vault.connect(user)["deposit(uint256,address)"](assets, user.address);
    expect(await weth.balanceOf(user.address)).to.equal(wethBeforeClaim);
    expect(await vault.balanceOf(user.address)).to.be.gt(0n);
    expect(await vault.claimableDepositRequest(cycle, user.address)).to.equal(0n);
    expect(await vault.lastMintCycle(user.address)).to.equal(await vault.getCurrentBatchCycle());
  });

  it("same-block request+claim still needs two calls; claim before hold reverts", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("1");
    await depositRequest(vault, weth, user, assets);
    const cycle = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(cycle);
    await vault.connect(bot).performUpkeep("0x");
    await expect(vault.connect(user)["deposit(uint256,address)"](assets, user.address)).to.be.revertedWithCustomError(
      vault,
      "ClaimsNotOpen",
    );
    await time.increase(Number(CLAIM_HOLD_SECONDS));
    await vault.connect(user)["deposit(uint256,address)"](assets, user.address);
    expect(await vault.balanceOf(user.address)).to.be.gt(0n);
  });

  it("generic deposit without a request reverts", async function () {
    const { vault, user } = await deployKashVaultEthFixture();
    await expect(vault.connect(user)["deposit(uint256,address)"](1n, user.address)).to.be.revertedWithCustomError(vault, "NoRequest");
  });

  it("requestDepositETH wraps native ETH", async function () {
    const { vault, weth, user } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("0.5");
    await vault.connect(user).requestDepositETH(user.address, { value: assets });
    expect(await weth.balanceOf(await vault.getAddress())).to.equal(assets);
    const cycle = await vault.getCurrentBatchCycle();
    expect(await vault.pendingDepositRequest(cycle, user.address)).to.equal(assets);
  });

  it("operators can request and claim for a controller", async function () {
    const { vault, weth, bot, user, user2 } = await deployKashVaultEthFixture();
    await vault.connect(user).setOperator(user2.address, true);
    expect(await vault.isOperator(user.address, user2.address)).to.equal(true);

    const assets = ethers.parseEther("1");
    await seedWeth(weth, user, assets);
    await weth.connect(user).approve(await vault.getAddress(), assets);
    await vault.connect(user2).requestDeposit(assets, user.address, user.address);

    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    await vault.connect(user2)["deposit(uint256,address,address)"](assets, user.address, user.address);
    expect(await vault.balanceOf(user.address)).to.be.gt(0n);
  });

  it("N+1: cannot requestRedeem in the mint cycle; can in the next cycle", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("1");
    await depositRequest(vault, weth, user, assets);
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    await vault.connect(user)["deposit(uint256,address)"](assets, user.address);
    const shares = await vault.balanceOf(user.address);
    expect(await vault.lastMintCycle(user.address)).to.equal(await vault.getCurrentBatchCycle());

    const next = (await vault.getCurrentBatchCycle()) + 1n;
    await jumpToCycleOffset(next, 100n);
    await vault.connect(user).requestRedeem(shares, user.address, user.address);
    expect(await vault.pendingRedeemRequest(next, user.address)).to.equal(shares);
  });

  it("redeem claim pays WETH and does not pull shares again", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("1");
    await depositRequest(vault, weth, user, assets);
    const c0 = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, c0);
    await vault.connect(user)["deposit(uint256,address)"](assets, user.address);

    const mintCycle = await vault.lastMintCycle(user.address);
    await jumpToCycleOffset(mintCycle + 1n, 100n);
    const shares = await vault.balanceOf(user.address);
    await vault.connect(user).requestRedeem(shares, user.address, user.address);
    const redeemCycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, redeemCycle);

    const before = await weth.balanceOf(user.address);
    const claimableShares = await vault.claimableRedeemRequest(redeemCycle, user.address);
    await vault.connect(user)["redeem(uint256,address,address)"](claimableShares, user.address, user.address);
    expect(await weth.balanceOf(user.address)).to.be.gt(before);
    expect(await vault.balanceOf(user.address)).to.equal(0n);
  });

  it("FIFO claim spans two cycles at different locked rates", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    const a1 = ethers.parseEther("1");
    await depositRequest(vault, weth, user, a1);
    const c1 = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, c1);
    const lockedShares1 = await vault.maxMint(user.address);

    await jumpToCycleOffset(c1 + 7n, 100n);
    const a2 = ethers.parseEther("2");
    await depositRequest(vault, weth, user, a2);
    const c2 = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, c2);
    const lockedShares2 = (await vault.maxMint(user.address)) - lockedShares1;

    expect(c2).to.be.gt(c1);
    expect(lockedShares2).to.equal(lockedShares1 * 2n);

    await vault.connect(user)["deposit(uint256,address)"](a1, user.address);
    expect(await vault.balanceOf(user.address)).to.equal(lockedShares1);
    expect(await vault.claimableDepositRequest(c1, user.address)).to.equal(0n);
    expect(await vault.claimableDepositRequest(c2, user.address)).to.equal(a2);

    await vault.connect(user)["deposit(uint256,address)"](a2, user.address);
    expect(await vault.balanceOf(user.address)).to.equal(lockedShares1 + lockedShares2);
    expect(await vault.maxMint(user.address)).to.equal(0n);
  });

  it("fee is applied at claimable and locked through later NAV change", async function () {
    const { vault, weth, bot, user, oracle } = await deployKashVaultEthFixture();
    const assets = ethers.parseEther("1");
    await depositRequest(vault, weth, user, assets);
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    const sharesLocked = await vault.maxMint(user.address);
    const price = await vault.getAssetPrice();
    const usd = (assets * price) / WAD;
    const expected = (usd * (BPS - FEE_BPS)) / BPS;
    expect(sharesLocked).to.equal(expected);

    await oracle.setAnswer(9000n * 10n ** 8n);
    await vault.connect(user)["deposit(uint256,address)"](assets, user.address);
    expect(await vault.balanceOf(user.address)).to.equal(sharesLocked);
  });

  it("full pause gates requests, claims, and bot ops; watcher cannot unpause", async function () {
    const { vault, weth, bot, owner, watcher, user } = await deployKashVaultEthFixture();
    await vault.connect(watcher).pause();
    await expect(depositRequest(vault, weth, user, ethers.parseEther("1"))).to.be.revertedWithCustomError(
      vault,
      "ContractPaused",
    );
    await expect(vault.connect(bot).depositToAave(1n)).to.be.revertedWithCustomError(vault, "ContractPaused");
    await expect(vault.connect(bot).markBatchOpsDone(1n)).to.be.revertedWithCustomError(vault, "ContractPaused");
    await expect(vault.connect(watcher).unpause()).to.be.revertedWithCustomError(vault, "OnlyOwner");
    await vault.connect(owner).unpause();
    await depositRequest(vault, weth, user, ethers.parseEther("1"));
  });

  it("anyone can unpause after PAUSE_TIMELOCK_SECONDS", async function () {
    const { vault, watcher, user } = await deployKashVaultEthFixture();
    await vault.connect(watcher).pause();
    await time.increase(7 * 24 * 3600);
    await vault.connect(user).unpause();
    expect(await vault.paused()).to.equal(false);
  });

  it("setBotAddress rotates the live bot; non-owner reverts", async function () {
    const { vault, owner, bot, user, facade } = await deployKashVaultEthFixture();
    await expect(vault.connect(user).setBotAddress(user.address)).to.be.revertedWithCustomError(vault, "OnlyOwner");
    await vault.connect(owner).setBotAddress(user.address);
    expect(await vault.botAddress()).to.equal(user.address);
    expect(await facade.botAddress()).to.equal(user.address);
    await expect(vault.connect(bot).depositToAave(1n)).to.be.revertedWithCustomError(vault, "OnlyBotOrKeeper");
  });

  it("correctNAV within ±5% of anchor succeeds; 6% reverts", async function () {
    const { vault, weth, bot, owner, user } = await deployKashVaultEthFixture();
    await depositRequest(vault, weth, user, ethers.parseEther("1"));
    const cycle = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(cycle, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    const anchor = await vault.cycleStartNAV(cycle);
    await vault.connect(owner).correctNAV((anchor * 10400n) / 10000n);
    await expect(vault.connect(owner).correctNAV((anchor * 10600n) / 10000n)).to.be.revertedWithCustomError(
      vault,
      "NAVDeviationTooLarge",
    );
    await expect(vault.connect(user).correctNAV(anchor)).to.be.revertedWithCustomError(vault, "OnlyOwner");
  });

  it("owner has no withdraw/mint/fee setters", async function () {
    const { vault } = await deployKashVaultEthFixture();
    expect(vault.interface.hasFunction("ownerWithdrawEth")).to.equal(false);
    expect(vault.interface.hasFunction("rescueERC20")).to.equal(false);
    expect(vault.interface.hasFunction("setFeeBps")).to.equal(false);
    expect(vault.interface.hasFunction("updateNAV")).to.equal(false);
    expect(vault.interface.hasFunction("markBatchOpsDone(uint256,uint256)")).to.equal(false);
  });

  it("markBatchOpsDone takes no redeem amount", async function () {
    const { vault } = await deployKashVaultEthFixture();
    const fn = vault.interface.getFunction("markBatchOpsDone");
    expect(fn.inputs.length).to.equal(1);
  });

  it("Phase 2 reverts when Aster equity deviation exceeds SETTLEMENT_DEVIATION_BPS", async function () {
    const { vault, weth, bot, user, aster, adapter } = await deployKashVaultEthFixture();
    await depositRequest(vault, weth, user, ethers.parseEther("10"));
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    await vault.connect(user)["deposit(uint256,address)"](ethers.parseEther("10"), user.address);

    const next = (await vault.getCurrentBatchCycle()) + 1n;
    await jumpToCycleOffset(next, 100n);
    await depositRequest(vault, weth, user, ethers.parseEther("0.1"));
    const c2 = await vault.getCurrentBatchCycle();
    await jumpToCycleOffset(c2, PROCESSING_WINDOW_START + 1n);
    await vault.connect(bot).performUpkeep("0x");
    await vault.connect(bot).markBatchOpsDone(c2);
    await aster.setAccountValue(await adapter.getAddress(), ethers.parseEther("1000000"));
    await expect(vault.connect(bot).performUpkeep("0x")).to.be.revertedWithCustomError(
      vault,
      "SettlementDeviationTooLarge",
    );
  });

  it("totalAssets and convert round-trip for 18-dec ETH", async function () {
    const { vault, weth, bot, user } = await deployKashVaultEthFixture();
    await depositRequest(vault, weth, user, ethers.parseEther("2"));
    const cycle = await vault.getCurrentBatchCycle();
    await runBatchToClaimable(vault, bot, cycle);
    await vault.connect(user)["deposit(uint256,address)"](ethers.parseEther("2"), user.address);
    const supply = await vault.totalSupply();
    const ta = await vault.totalAssets();
    expect(ta).to.be.gt(0n);
    const back = await vault.convertToAssets(supply);
    expect(back).to.be.closeTo(ta, 1000n);
  });

  it("donate-to-vault does not mint unsolicited shares", async function () {
    const { vault, weth, user } = await deployKashVaultEthFixture();
    await seedWeth(weth, user, ethers.parseEther("5"));
    await weth.connect(user).transfer(await vault.getAddress(), ethers.parseEther("5"));
    expect(await vault.totalSupply()).to.equal(0n);
    const shares = await vault.convertToShares(ethers.parseEther("1"));
    expect(shares).to.be.gt(0n);
  });

  it("4626 scanner views succeed without a deposit request", async function () {
    const { vault } = await deployKashVaultEthFixture();
    expect(await vault.asset()).to.not.equal(ethers.ZeroAddress);
    expect(await vault.share()).to.equal(await vault.getAddress());
    expect(await vault.totalAssets()).to.equal(0n);
    expect(await vault.convertToShares(0n)).to.equal(0n);
    expect(await vault.balanceOf(ethers.ZeroAddress)).to.equal(0n);
  });

  it("setWatcherAddress evicts a compromised watcher", async function () {
    const { vault, owner, watcher, user } = await deployKashVaultEthFixture();
    await vault.connect(owner).setWatcherAddress(user.address);
    await expect(vault.connect(watcher).pause()).to.be.revertedWithCustomError(vault, "Unauthorized");
    await vault.connect(user).pause();
    expect(await vault.paused()).to.equal(true);
  });
});
