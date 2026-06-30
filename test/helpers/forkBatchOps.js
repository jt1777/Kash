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
 * depositToPerpExchange the contract's ERC-20 USDC is 0, so pass 0n not borrowUsdc.
 */

const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const BTC_ORACLE = "0x6ce185860a4963106506C203335A2910413708e9";
const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";

async function predictContractAddress(deployer, offset = 0) {
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  return ethers.getCreateAddress({ from: deployer.address, nonce: nonce + offset });
}

async function deployAndWireExchangeFacade({
  kashYield,
  owner,
  bot,
  usdcAddress,
  primaryAsset,
  hlAdapter,
  exchangeName = "HL",
  keeperRegistry = ethers.ZeroAddress,
}) {
  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    bot.address,
    keeperRegistry,
    usdcAddress,
    primaryAsset,
    await kashYield.getAddress(),
    exchangeName,
    await hlAdapter.getAddress(),
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();
  if (typeof kashYield.setExchangeFacade === "function") {
    const current = await kashYield.exchangeFacade();
    if (current === ethers.ZeroAddress) {
      await kashYield.setExchangeFacade(facadeAddr);
    }
  }
  if (typeof hlAdapter.setAuthorizedCaller === "function") {
    await hlAdapter.connect(owner).setAuthorizedCaller(facadeAddr);
  }
  return facade;
}

/**
 * Deploy KashYieldBtc V3 stack: facade + HL adapter + vault with immutable wiring.
 * uniAdapter must already be deployed.
 */
async function deployKashYieldBtcStack({
  deployer,
  bot,
  owner,
  wbtcAddress,
  usdcAddress,
  uniAdapter,
  cycleDurationSeconds = 3600n,
  userWindowEnd = 3600n,
  processingWindowStart = 0n,
  btcOracle = BTC_ORACLE,
  keeperRegistry = ethers.ZeroAddress,
  feeReceiver,
  feeBps = 3n,
  maxSwapSlippageBps = 100n,
  maxMintUsers = 10_000n,
  maxRedeemUsers = 10_000n,
  useBenchmark = false,
}) {
  if (!feeReceiver) throw new Error("feeReceiver required");
  const predictedKashYield = await predictContractAddress(deployer, 2);

  const HyperliquidAdapter = await ethers.getContractFactory("HyperliquidAdapter");
  const hlAdapter = await HyperliquidAdapter.deploy(
    HL_BRIDGE,
    usdcAddress,
    wbtcAddress,
    false,
    predictedKashYield,
  );
  await hlAdapter.waitForDeployment();

  const ExchangeFacade = await ethers.getContractFactory("ExchangeFacade");
  const facade = await ExchangeFacade.deploy(
    bot.address,
    keeperRegistry,
    usdcAddress,
    wbtcAddress,
    predictedKashYield,
    "HL",
    await hlAdapter.getAddress(),
  );
  await facade.waitForDeployment();
  const facadeAddr = await facade.getAddress();

  const factoryName = useBenchmark ? "BenchmarkKashYieldBtc" : "KashYieldBtc";
  const KashYieldBtc = await ethers.getContractFactory(factoryName);
  const kashYieldBtc = await KashYieldBtc.deploy(
    bot.address,
    wbtcAddress,
    usdcAddress,
    facadeAddr,
    await uniAdapter.getAddress(),
    btcOracle,
    keeperRegistry,
    feeReceiver,
    cycleDurationSeconds,
    userWindowEnd,
    processingWindowStart,
    maxSwapSlippageBps,
    feeBps,
    maxMintUsers,
    maxRedeemUsers,
  );
  await kashYieldBtc.waitForDeployment();

  if ((await kashYieldBtc.getAddress()).toLowerCase() !== predictedKashYield.toLowerCase()) {
    throw new Error("KashYieldBtc address prediction mismatch");
  }

  if (typeof hlAdapter.setAuthorizedCaller === "function") {
    await hlAdapter.connect(owner).setAuthorizedCaller(facadeAddr);
  }

  return { kashYieldBtc, hlAdapter, facade, uniAdapter };
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
  await ex.depositToPerpExchange(borrowUsdc);

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
  await ex.depositToPerpExchange(borrowUsdc);

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

async function buildMintMerkleRoot(kashYield, batchCycle, nav) {
  const { allocMintKashAmounts, buildMintMerkleTree } = require("./mintMerkle");
  const totalMintUSD = BigInt((await kashYield.batchTotalMintValueUSD(batchCycle)).toString());
  if (totalMintUSD === 0n) return `0x${"0".repeat(64)}`;
  const feeBps = BigInt((await kashYield.feeBps()).toString());
  const amountAfterFeeTotal = (totalMintUSD * (10000n - feeBps)) / 10000n;
  const totalMintKash = (amountAfterFeeTotal * nav) / (10n ** 18n);
  const info = await kashYield.getBatchInfo(batchCycle);
  const mintCount = Number(info[3]);
  const rows = await Promise.all(
    Array.from({ length: mintCount }, async (_, i) => {
      const addr = await kashYield.batchMintUsers(batchCycle, i);
      const req = await kashYield.getPendingMintRequest(addr, batchCycle);
      return { addr, amountInUSD: BigInt(req.amountInUSD.toString()) };
    }),
  );
  const minters = rows.map((r) => r.addr);
  const amountInUSD = rows.map((r) => r.amountInUSD);
  const entries = allocMintKashAmounts(minters, amountInUSD, totalMintUSD, totalMintKash);
  return buildMintMerkleTree(batchCycle, entries).root;
}

async function buildRedeemMerkleRoot(kashYield, batchCycle) {
  const { allocRedeemNetAmounts, buildRedeemMerkleTree } = require("./redeemMerkle");
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
  const mintRoot = await buildMintMerkleRoot(kashYield, batchCycle, nav);
  await kashYield.connect(bot).processBatchPhase2ForCycle(
    batchCycle,
    `0x${"0".repeat(64)}`,
    mintRoot,
  );
}

async function settleRedeemPhase2({ kashYield, bot, batchCycle, nav, grossG }) {
  await kashYield.connect(bot).updateNAV(nav, 0n, 0n, 0n);
  await kashYield.connect(bot).markBatchOpsDone(batchCycle, grossG);
  const redeemRoot = await buildRedeemMerkleRoot(kashYield, batchCycle);
  const mintRoot = await buildMintMerkleRoot(kashYield, batchCycle, nav);
  await kashYield.connect(bot).processBatchPhase2ForCycle(batchCycle, redeemRoot, mintRoot);
}

async function claimMintForUser(kashYield, user, batchCycle, nav) {
  const { allocMintKashAmounts, buildMintMerkleTree } = require("./mintMerkle");
  const totalMintUSD = BigInt((await kashYield.batchTotalMintValueUSD(batchCycle)).toString());
  const feeBps = BigInt((await kashYield.feeBps()).toString());
  const amountAfterFeeTotal = (totalMintUSD * (10000n - feeBps)) / 10000n;
  const totalMintKash = (amountAfterFeeTotal * nav) / (10n ** 18n);
  const info = await kashYield.getBatchInfo(batchCycle);
  const mintCount = Number(info[3]);
  const minters = [];
  const amountInUSD = [];
  for (let i = 0; i < mintCount; i++) {
    const addr = await kashYield.batchMintUsers(batchCycle, i);
    const req = await kashYield.getPendingMintRequest(addr, batchCycle);
    minters.push(addr);
    amountInUSD.push(BigInt(req.amountInUSD.toString()));
  }
  const entries = allocMintKashAmounts(minters, amountInUSD, totalMintUSD, totalMintKash);
  const { proofs } = buildMintMerkleTree(batchCycle, entries);
  const userAddr = await user.getAddress();
  const leaf = entries.find((e) => e.user.toLowerCase() === userAddr.toLowerCase());
  if (!leaf || leaf.amount === 0n) throw new Error("no mint claim leaf for user");
  const proof = proofs.get(userAddr.toLowerCase());
  await kashYield.connect(user).claimMint(batchCycle, leaf.amount, proof);
  return leaf.amount;
}

async function claimRedeemForUser(kashYield, user, batchCycle) {
  const { allocRedeemNetAmounts, buildRedeemMerkleTree } = require("./redeemMerkle");
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

async function depositToPerpExchangeViaFacade(kashYield, bot, amount) {
  const { target: ex, viaFacade } = await hlOpsTarget(kashYield, bot);
  if (viaFacade) await kashYield.connect(bot).approveExchangeFacadeUsdc(amount);
  await ex.depositToPerpExchange(amount);
}

async function withdrawFromPerpExchangeViaFacade(kashYield, bot, amount) {
  const { target: ex } = await hlOpsTarget(kashYield, bot);
  await ex.withdrawFromPerpExchange(amount);
}

async function closeShortViaFacade(kashYield, bot, symbol) {
  const { target: ex } = await hlOpsTarget(kashYield, bot);
  await ex.getFunction("closeShort(string)").send(symbol);
}

module.exports = {
  USDC_ADDRESS,
  BTC_ORACLE,
  mintProtocolFee,
  usdcBorrowForAssetUsd,
  deployAndWireExchangeFacade,
  deployKashYieldBtcStack,
  predictContractAddress,
  hlOpsTarget,
  depositToPerpExchangeViaFacade,
  withdrawFromPerpExchangeViaFacade,
  closeShortViaFacade,
  manualEthMintOps,
  manualBtcMintOps,
  computeBatchGrossRedeemAsset,
  settleMintPhase2,
  settleRedeemPhase2,
  buildRedeemMerkleRoot,
  buildMintMerkleRoot,
  claimRedeemForUser,
  claimMintForUser,
};
