/**
 * Recovery script: withdraws stranded WETH from an old MockAaveV3 back into KashYieldETH
 * (converting it to ETH via WETH.withdraw), then restores the active Aave pool.
 *
 * Usage:
 *   OLD_AAVE_ADDRESS=<MockAaveV3 that holds the deposit> \
 *   npx hardhat run scripts/recover-eth-from-aave.js --network arbitrumSepolia
 *
 * Optional:
 *   KASH_YIELD_ADDRESS   - defaults to 0x8da4FC6A0EAEC834c88f1543Aeb91e25aFDE4BDF
 *   WITHDRAW_AMOUNT_ETH  - amount to withdraw in ETH (default: reads suppliedAmounts)
 */
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;

  const kashYieldAddress = process.env.KASH_YIELD_ADDRESS || "0x8da4FC6A0EAEC834c88f1543Aeb91e25aFDE4BDF";
  const oldAaveAddress   = process.env.OLD_AAVE_ADDRESS;
  if (!oldAaveAddress) throw new Error("Set OLD_AAVE_ADDRESS to the MockAaveV3 that holds the deposit");

  const kashYieldAbi = [
    "function aavePoolAddress() view returns (address)",
    "function wethAddress() view returns (address)",
    "function setAavePool(address) external",
    "function withdrawFromAave(uint256) external",
  ];
  const aaveAbi = [
    "function suppliedAmounts(address) view returns (uint256)",
    "function wethAddress() view returns (address)",
  ];

  const kashYield = new hre.ethers.Contract(kashYieldAddress, kashYieldAbi, deployer);
  const oldAave   = new hre.ethers.Contract(oldAaveAddress,   aaveAbi,       provider);

  // --- Diagnostics ---
  const currentAavePool = await kashYield.aavePoolAddress();
  const wethAddr        = await kashYield.wethAddress();
  const supplied        = await oldAave.suppliedAmounts(kashYieldAddress);
  const ethBalBefore    = await provider.getBalance(kashYieldAddress);

  console.log("\nKashYieldETH:      ", kashYieldAddress);
  console.log("Current aavePool:  ", currentAavePool);
  console.log("wethAddress:       ", wethAddr);
  console.log("ETH balance before:", hre.ethers.formatEther(ethBalBefore), "ETH");
  console.log("\nOld MockAaveV3:    ", oldAaveAddress);
  console.log("suppliedAmounts:   ", hre.ethers.formatEther(supplied), "WETH");

  if (supplied === 0n) {
    console.log("\n⚠️  No deposit found in the old MockAaveV3. Nothing to recover.");
    return;
  }

  const withdrawAmount = process.env.WITHDRAW_AMOUNT_ETH
    ? hre.ethers.parseEther(process.env.WITHDRAW_AMOUNT_ETH)
    : supplied;

  console.log("\nWithdrawing", hre.ethers.formatEther(withdrawAmount), "WETH → ETH...");

  // Step 1: temporarily point KashYieldETH at the old MockAaveV3
  if (currentAavePool.toLowerCase() !== oldAaveAddress.toLowerCase()) {
    console.log("\n1. setAavePool →", oldAaveAddress);
    await (await kashYield.setAavePool(oldAaveAddress)).wait();
    console.log("   ✅ done");
  } else {
    console.log("\n1. aavePool already pointing at old MockAaveV3 ✓");
  }

  // Step 2: withdraw — MockAaveV3.withdraw() sends WETH back, then WETH.withdraw() gives ETH
  console.log("2. withdrawFromAave(", hre.ethers.formatEther(withdrawAmount), "WETH)");
  await (await kashYield.withdrawFromAave(withdrawAmount)).wait();
  console.log("   ✅ done");

  // Step 3: restore the active Aave pool
  const restoreAave = process.env.AAVE_POOL_ADDRESS || currentAavePool;
  if (restoreAave.toLowerCase() !== oldAaveAddress.toLowerCase()) {
    console.log("3. Restoring aavePool →", restoreAave);
    await (await kashYield.setAavePool(restoreAave)).wait();
    console.log("   ✅ done");
  }

  // --- Result ---
  const ethBalAfter = await provider.getBalance(kashYieldAddress);
  console.log("\n=== Recovery complete ===");
  console.log("ETH balance after: ", hre.ethers.formatEther(ethBalAfter), "ETH");
  console.log("Active aavePool:   ", await kashYield.aavePoolAddress());
  console.log("\nNext: re-run the bot — Stage 1 will deposit the recovered ETH.");
}

main().catch((e) => { console.error(e); process.exit(1); });
