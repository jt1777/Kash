// scripts/deploy-sepolia.js
// Deploys KASH contracts to Arbitrum Sepolia with REAL Hyperliquid integration

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  
  console.log("Deploying KASH to Arbitrum Sepolia with real Hyperliquid");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  // REAL Hyperliquid contract addresses on Arbitrum Sepolia
  // TODO: Fill these in from your AI trading bot project
  const HYPERLIQUID_ADDRESSES = {
    // The main clearinghouse/bridge contract
    clearinghouse: process.env.HYPERLIQUID_CLEARINGHOUSE || "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
    // USDC contract on Arbitrum Sepolia
    usdc: process.env.HYPERLIQUID_USDC || "0xd9CBEC81df392A88AEff575E962d149d57F4d6bc",
    // ETH perp market ID or contract (if applicable)
    ethPerp: process.env.HYPERLIQUID_ETH_PERP || "0x..."
  };

  console.log("\n--- Hyperliquid Configuration ---");
  console.log("Clearinghouse:", HYPERLIQUID_ADDRESSES.clearinghouse);
  console.log("USDC:", HYPERLIQUID_ADDRESSES.usdc);
  console.log("ETH Perp:", HYPERLIQUID_ADDRESSES.ethPerp);

  // Deploy Mock Aave (since Aave might not be on Sepolia or we want isolated testing)
  console.log("\n--- Deploying Mock Aave ---");
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy();
  await mockUSDC.waitForDeployment();
  console.log("MockUSDC:", await mockUSDC.getAddress());

  const MockWETH = await hre.ethers.getContractFactory("MockWETH");
  const mockWETH = await MockWETH.deploy();
  await mockWETH.waitForDeployment();
  console.log("MockWETH:", await mockWETH.getAddress());

  const MockAave = await hre.ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAave.deploy(await mockUSDC.getAddress());
  await mockAave.waitForDeployment();
  console.log("MockAaveV3:", await mockAave.getAddress());

  // Deploy Price Feed
  const MockPriceFeed = await hre.ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockPriceFeed = await MockPriceFeed.deploy(300000000000n); // $3000 ETH
  await mockPriceFeed.waitForDeployment();
  console.log("MockPriceFeed:", await mockPriceFeed.getAddress());

  // Deploy KashYield with REAL Hyperliquid address
  console.log("\n--- Deploying KashYield ---");
  const KashYield = await hre.ethers.getContractFactory("KashYield");
  
  // For real Hyperliquid integration, we'd need to adapt the interface
  // For now, using the mock Hyperliquid interface as a placeholder
  // TODO: Replace with real Hyperliquid interface once verified
  const kashYield = await KashYield.deploy(
    await mockAave.getAddress(),      // Aave pool
    await mockUSDC.getAddress(),      // USDC (or HYPERLIQUID_ADDRESSES.usdc)
    await mockPriceFeed.getAddress(), // Price feed
    HYPERLIQUID_ADDRESSES.clearinghouse, // REAL Hyperliquid clearinghouse
    await mockWETH.getAddress()       // WETH
  );
  await kashYield.waitForDeployment();
  console.log("KashYield:", await kashYield.getAddress());

  const kashEthAddress = await kashYield.kashEth();
  console.log("KashEth:", kashEthAddress);

  // Configure
  console.log("\n--- Configuring ---");
  await (await kashYield.updateConfiguration(
    1, 70, 170, 50, 23 * 3600, 0, 15, 23, 45
  )).wait();
  console.log("Configuration set");

  // Fund
  await mockUSDC.mint(await mockAave.getAddress(), hre.ethers.parseUnits("1000000", 6));
  console.log("Funded with 1M USDC");

  // Save deployment
  const deploymentInfo = {
    network: "arbitrumSepolia",
    chainId: 421614,
    deployer: deployer.address,
    hyperliquid: {
      clearinghouse: HYPERLIQUID_ADDRESSES.clearinghouse,
      usdc: HYPERLIQUID_ADDRESSES.usdc,
      ethPerp: HYPERLIQUID_ADDRESSES.ethPerp
    },
    contracts: {
      MockUSDC: await mockUSDC.getAddress(),
      MockWETH: await mockWETH.getAddress(),
      MockAaveV3: await mockAave.getAddress(),
      MockPriceFeed: await mockPriceFeed.getAddress(),
      KashYield: await kashYield.getAddress(),
      KashEth: kashEthAddress
    },
    timestamp: new Date().toISOString()
  };

  console.log("\n--- Deployment Complete ---");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  const fs = require("fs");
  fs.writeFileSync(
    `deployment-sepolia-${Date.now()}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );

  console.log("\n--- Next Steps ---");
  console.log("1. Get testnet USDC from Hyperliquid faucet:");
  console.log("   https://app.hyperliquid-testnet.xyz/drip");
  console.log("2. Update frontend/src/config.js with contract addresses");
  console.log("3. Test deposits and verify Hyperliquid integration");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
