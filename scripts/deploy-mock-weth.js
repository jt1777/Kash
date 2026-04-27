/**
 * Deploy MockWETH - WETH9-compatible contract for testnet
 *
 * Optional env vars:
 *   KASH_YIELD_ETH_ADDRESS  - KashYieldETH address → calls setWethAddress
 *   AAVE_POOL_ADDRESS       - MockAaveV3 address   → calls setWethAddress
 *
 * Usage:
 *   npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia
 *
 *   # With auto-configuration:
 *   KASH_YIELD_ETH_ADDRESS=0x... AAVE_POOL_ADDRESS=0x... \
 *   npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nNetwork: ${network}`);
  console.log(`Deployer: ${deployer.address}`);

  // --- Deploy MockWETH ---
  console.log("\n1. Deploying MockWETH...");
  const MockWETH = await hre.ethers.getContractFactory("MockWETH");
  const mockWeth = await MockWETH.deploy();
  await mockWeth.waitForDeployment();
  const mockWethAddress = await mockWeth.getAddress();
  console.log("✅ MockWETH deployed:", mockWethAddress);

  // --- Optional: update KashYieldETH ---
  const kashYieldAddress = process.env.KASH_YIELD_ETH_ADDRESS || process.env.KASH_YIELD_ADDRESS || "";
  if (kashYieldAddress) {
    console.log("\n2. Calling setWethAddress on KashYieldETH...");
    const kashYieldAbi = ["function setWethAddress(address _weth) external"];
    const kashYield = new hre.ethers.Contract(kashYieldAddress, kashYieldAbi, deployer);
    const tx1 = await kashYield.setWethAddress(mockWethAddress);
    await tx1.wait();
    console.log("✅ KashYieldETH wethAddress →", mockWethAddress);
  }

  // --- Optional: update MockAaveV3 ---
  const aavePoolAddress = process.env.AAVE_POOL_ADDRESS || "";
  if (aavePoolAddress) {
    console.log("\n3. Calling setWethAddress on MockAaveV3...");
    const mockAaveAbi = ["function setWethAddress(address _wethAddress) external"];
    const mockAave = new hre.ethers.Contract(aavePoolAddress, mockAaveAbi, deployer);
    const tx2 = await mockAave.setWethAddress(mockWethAddress);
    await tx2.wait();
    console.log("✅ MockAaveV3 wethAddress →", mockWethAddress);
  }

  // --- Summary ---
  console.log("\n========================================");
  console.log("MockWETH deployed successfully!");
  console.log("========================================");
  console.log(`MOCK_WETH_ADDRESS=${mockWethAddress}`);
  console.log("\nNext steps:");
  console.log("1. Add to your .env files:");
  console.log(`   WETH_ADDRESS=${mockWethAddress}`);
  console.log("   (update both root .env and bot/.env)");
  if (!kashYieldAddress) {
    console.log("\n2. Update KashYieldETH:");
    console.log(`   KASH_YIELD_ETH_ADDRESS=<your-kashyieldeth> \\\n   WETH_ADDRESS=${mockWethAddress} \\\n   npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia`);
    console.log("   (or call setWethAddress manually via setWethAddress.js)");
  }
  if (!aavePoolAddress) {
    console.log("\n3. Update MockAaveV3:");
    console.log(`   KASH_YIELD_ETH_ADDRESS=<your-kashyieldeth> AAVE_POOL_ADDRESS=<your-mock-aave> \\\n   WETH_ADDRESS=${mockWethAddress} \\\n   npx hardhat run scripts/deploy-mock-weth.js --network arbitrumSepolia`);
    console.log("   (or call setWethAddress manually on MockAaveV3)");
  }
  console.log("\n4. If you use MockSpotDex, refresh its rates (e.g. scripts/update-mock-spot-dex-price.js) so they match your mock oracle/Aave/HL prices.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
