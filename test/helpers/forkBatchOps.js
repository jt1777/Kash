const { ethers } = require("hardhat");

/**
 * Manual mint/redeem ops helpers for mainnet-fork e2e tests.
 *
 * Phase 2 `_processBatchPhase2` requires the vault to hold protocol fees in the
 * native asset (ETH/wBTC) on the contract. Depositing 100% of the mint to Aave
 * leaves zero balance and reverts with InsufficientEthForRedeems /
 * InsufficientWbtcForRedeems even on mint-only batches.
 *
 * Settlement `updateNAV` usdcBalance is a snapshot for events only — after
 * depositToHyperliquid the contract's ERC-20 USDC is 0, so pass 0n not borrowUsdc.
 */

const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

async function deployAndWireExchangeFacade({
  kashYield,
  owner,
  bot,
  usdcAddress,
  primaryAsset,
  hlAdapter,
}) {
  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    owner.address,
    bot.address,
    usdcAddress,
    primaryAsset,
    await kashYield.getAddress(),
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  await kashYield.setExchangeFacade(facadeAddr);
  await facade.setHyperliquid(await hlAdapter.getAddress());
  await facade.setActivePerpExchange("HL");
  if (typeof hlAdapter.setAuthorizedCaller === "function") {
    await hlAdapter.connect(owner).setAuthorizedCaller(facadeAddr);
  }
  return facade;
}

async function hlOpsTarget(kashYield, bot) {
  const facade = await kashYield.exchangeFacade().catch(() => null);
  if (facade && facade !== "0x0000000000000000000000000000000000000000") {
    const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
    return { target: ExchangeFacade.attach(facade).connect(bot), viaFacade: true };
  }
  throw new Error("exchangeFacade not set — deploy ExchangeFacade in test beforePhase");
}

function mintProtocolFee(amount, feeBps) {
  return (amount * feeBps) / 10_000n;
}

function usdcBorrowForAssetUsd(assetUsd18, ltvPct = 60n) {
  return (assetUsd18 * ltvPct) / 100n / (10n ** 12n);
}

/**
 * Manual ETH mint ops after Phase 1: deposit (mint − protocol fee) to Aave,
 * borrow, HL deposit, optional short sync.
 */
async function manualEthMintOps({
  kashYield,
  bot,
  hlAdapter,
  mintEthAmount,
  shortLeveragePct = 170n,
}) {
  const feeBps = BigInt(await kashYield.feeBps());
  const protocolFeeEth = mintProtocolFee(mintEthAmount, feeBps);
  const deployEth = mintEthAmount - protocolFeeEth;

  const ethPrice = await kashYield.getEthPrice();
  const deployUsd = (deployEth * ethPrice) / (10n ** 18n);
  const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

  await kashYield.connect(bot).depositToAave(deployEth);
  await kashYield.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
  const { target: ex, viaFacade } = await hlOpsTarget(kashYield, bot);
  if (viaFacade) await kashYield.connect(bot).approveExchangeFacadeUsdc(borrowUsdc);
  await ex.depositToHyperliquid(borrowUsdc);

  const shortSizeUSD = (deployUsd * shortLeveragePct) / 100n;
  const shortSizeAsset = (shortSizeUSD * 10n ** 18n) / ethPrice;
  await ex.openShort("ETH", shortSizeAsset);
  await hlAdapter.syncPosition("ETH", shortSizeAsset, ethPrice, true);

  return { protocolFeeEth, deployEth, borrowUsdc, ethPrice, deployUsd, shortSizeAsset };
}

/**
 * Manual wBTC mint ops after Phase 1 (same fee reserve + usdcBal=0 NAV rules).
 */
async function manualBtcMintOps({
  kashYield,
  bot,
  hlAdapter,
  mintBtcAmount,
  shortLeveragePct = 170n,
}) {
  const feeBps = BigInt(await kashYield.feeBps());
  const protocolFeeBtc = mintProtocolFee(mintBtcAmount, feeBps);
  const deployBtc = mintBtcAmount - protocolFeeBtc;

  const btcPrice = await kashYield.getBtcPrice();
  const deployUsd = (deployBtc * btcPrice) / (10n ** 8n);
  const borrowUsdc = usdcBorrowForAssetUsd(deployUsd);

  await kashYield.connect(bot).depositToAave(deployBtc);
  await kashYield.connect(bot).borrowFromAave(USDC_ADDRESS, borrowUsdc);
  const { target: ex, viaFacade } = await hlOpsTarget(kashYield, bot);
  if (viaFacade) await kashYield.connect(bot).approveExchangeFacadeUsdc(borrowUsdc);
  await ex.depositToHyperliquid(borrowUsdc);

  const shortSizeUSD = (deployUsd * shortLeveragePct) / 100n;
  const shortSizeAsset = (shortSizeUSD * 10n ** 18n) / btcPrice;
  await ex.openShort("BTC", shortSizeAsset);
  await hlAdapter.syncPosition("BTC", shortSizeAsset, btcPrice, true);

  return { protocolFeeBtc, deployBtc, borrowUsdc, btcPrice, deployUsd, shortSizeAsset };
}

async function computeBatchGrossRedeemAsset(kashYield, batchCycle, nav) {
  const totalKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
  if (totalKash === 0n) return 0n;
  const info = await kashYield.getBatchInfo(batchCycle);
  const redeemCount = Number(info[4]);
  let isBtc = false;
  try {
    await kashYield.wbtcAddress();
    isBtc = true;
  } catch {
    isBtc = false;
  }
  const price = BigInt(
    (await (isBtc ? kashYield.getBtcPrice() : kashYield.getEthPrice())).toString(),
  );
  const factor = 10n ** BigInt(isBtc ? 8 : 18);
  const navDenom = 10n ** 18n;
  let total = 0n;
  for (let i = 0; i < redeemCount; i++) {
    const addr = await kashYield.batchRedeemUsers(batchCycle, i);
    const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
    const kashAmt = BigInt(req.kashAmount.toString());
    if (kashAmt === 0n) continue;
    const usdValue = (kashAmt * nav) / navDenom;
    total += (usdValue * factor) / price;
  }
  return total;
}

async function buildRedeemMerkleRoot(kashYield, batchCycle) {
  const { allocRedeemNetAmounts, buildRedeemMerkleTree } = require("../../bot/dist/batch/redeemMerkle");
  const redeemKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
  if (redeemKash === 0n) return `0x${"0".repeat(64)}`;
  const info = await kashYield.getBatchInfo(batchCycle);
  const redeemCount = Number(info[4]);
  const grossG = BigInt(info[1].toString());
  const feeBps = BigInt((await kashYield.feeBps()).toString());
  const redeemers = [];
  const kashAmounts = [];
  for (let i = 0; i < redeemCount; i++) {
    const addr = await kashYield.batchRedeemUsers(batchCycle, i);
    const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
    redeemers.push(addr);
    kashAmounts.push(BigInt(req.kashAmount.toString()));
  }
  const entries = allocRedeemNetAmounts(redeemers, kashAmounts, redeemKash, grossG, feeBps);
  return buildRedeemMerkleTree(batchCycle, entries).root;
}

async function settleMintPhase2({ kashYield, bot, batchCycle, nav }) {
  await kashYield.connect(bot).updateNAV(nav, 0n, 0n, 0n);
  await kashYield.connect(bot).markBatchOpsDone(batchCycle, 0);
  await kashYield.connect(bot).performUpkeep("0x");
}

async function settleRedeemPhase2({ kashYield, bot, batchCycle, nav, grossG }) {
  await kashYield.connect(bot).updateNAV(nav, 0n, 0n, 0n);
  await kashYield.connect(bot).markBatchOpsDone(batchCycle, grossG);
  const root = await buildRedeemMerkleRoot(kashYield, batchCycle);
  await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, root);
}

async function claimRedeemForUser(kashYield, user, batchCycle) {
  const { allocRedeemNetAmounts, buildRedeemMerkleTree } = require("../../bot/dist/batch/redeemMerkle");
  const redeemKash = BigInt((await kashYield.batchTotalRedeemKash(batchCycle)).toString());
  const info = await kashYield.getBatchInfo(batchCycle);
  const redeemCount = Number(info[4]);
  const grossG = BigInt(info[1].toString());
  const feeBps = BigInt((await kashYield.feeBps()).toString());
  const redeemers = [];
  const kashAmounts = [];
  for (let i = 0; i < redeemCount; i++) {
    const addr = await kashYield.batchRedeemUsers(batchCycle, i);
    const req = await kashYield.getPendingRedeemRequest(addr, batchCycle);
    redeemers.push(addr);
    kashAmounts.push(BigInt(req.kashAmount.toString()));
  }
  const entries = allocRedeemNetAmounts(redeemers, kashAmounts, redeemKash, grossG, feeBps);
  const { proofs } = buildRedeemMerkleTree(batchCycle, entries);
  const userAddr = await user.getAddress();
  const leaf = entries.find((e) => e.user.toLowerCase() === userAddr.toLowerCase());
  if (!leaf || leaf.amount === 0n) throw new Error("no claim leaf for user");
  const proof = proofs.get(userAddr.toLowerCase());
  await kashYield.connect(user).claimRedeem(batchCycle, leaf.amount, proof);
  return leaf.amount;
}

async function depositToHyperliquidViaFacade(kashYield, bot, amount) {
  const { target: ex, viaFacade } = await hlOpsTarget(kashYield, bot);
  if (viaFacade) await kashYield.connect(bot).approveExchangeFacadeUsdc(amount);
  await ex.depositToHyperliquid(amount);
}

async function withdrawFromHyperliquidViaFacade(kashYield, bot, amount) {
  const { target: ex } = await hlOpsTarget(kashYield, bot);
  await ex.withdrawFromHyperliquid(amount);
}

async function closeShortViaFacade(kashYield, bot, symbol) {
  const { target: ex } = await hlOpsTarget(kashYield, bot);
  await ex.getFunction("closeShort(string)").send(symbol);
}

module.exports = {
  USDC_ADDRESS,
  mintProtocolFee,
  usdcBorrowForAssetUsd,
  deployAndWireExchangeFacade,
  hlOpsTarget,
  depositToHyperliquidViaFacade,
  withdrawFromHyperliquidViaFacade,
  closeShortViaFacade,
  manualEthMintOps,
  manualBtcMintOps,
  computeBatchGrossRedeemAsset,
  settleMintPhase2,
  settleRedeemPhase2,
  buildRedeemMerkleRoot,
  claimRedeemForUser,
};
