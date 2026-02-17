// scripts/deploy.js
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  // Deploy Mock contracts first (for testing)
  console.log("\n--- Deploying Mocks ---");
  
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy();
  await mockUSDC.waitForDeployment();
  console.log("MockUSDC deployed to:", await mockUSDC.getAddress());

  const MockWETH = await hre.ethers.getContractFactory("MockWETH");
  const mockWETH = await MockWETH.deploy();
  await mockWETH.waitForDeployment();
  console.log("MockWETH deployed to:", await mockWETH.getAddress());

  const MockAave = await hre.ethers.getContractFactory("MockAaveV3");
  const mockAave = await MockAave.deploy(await mockUSDC.getAddress());
  await mockAave.waitForDeployment();
  console.log("MockAaveV3 deployed to:", await mockAave.getAddress());

  const MockPriceFeed = await hre.ethers.getContractFactory("MockChainlinkPriceFeed");
  const mockPriceFeed = await MockPriceFeed.deploy(300000000000n); // $3000 ETH
  await mockPriceFeed.waitForDeployment();
  console.log("MockPriceFeed deployed to:", await mockPriceFeed.getAddress());

  const MockHyperliquid = await hre.ethers.getContractFactory("MockHyperliquid");
  const mockHyperliquid = await MockHyperliquid.deploy(
    await mockUSDC.getAddress(),
    await mockWETH.getAddress()
  );
  await mockHyperliquid.waitForDeployment();
  console.log("MockHyperliquid deployed to:", await mockHyperliquid.getAddress());

  // Deploy KashYield
  console.log("\n--- Deploying KashYield ---");
  
  const KashYield = await hre.ethers.getContractFactory("KashYield");
  const kashYield = await KashYield.deploy(
    await mockAave.getAddress(),
    await mockUSDC.getAddress(),
    await mockPriceFeed.getAddress(),
    await mockHyperliquid.getAddress(),
    await mockWETH.getAddress()
  );
  await kashYield.waitForDeployment();
  console.log("KashYield deployed to:", await kashYield.getAddress());

  // Get KashEth address
  const kashEthAddress = await kashYield.kashEth();
  console.log("KashEth token deployed to:", kashEthAddress);

  // Setup configuration
  console.log("\n--- Configuring KashYield ---");
  
  const tx = await kashYield.updateConfiguration(
    1,           // transactionsPerDay
    70,          // borrowPercentage
    170,         // leverage (1.7x)
    50,          // depositorsPerFeeBatch
    23 * 3600,   // processingDelaySeconds
    0, 15,       // startHour, startMinute (HKT)
    23, 45       // endHour, endMinute (HKT)
  );
  await tx.wait();
  console.log("Configuration updated");

  // Fund contracts for testing
  console.log("\n--- Funding Contracts ---");
  
  await mockUSDC.mint(await mockAave.getAddress(), hre.ethers.parseUnits("1000000", 6));
  console.log("Minted 1M USDC to MockAave");

  // Save deployment info
  const deploymentInfo = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    contracts: {
      MockUSDC: await mockUSDC.getAddress(),
      MockWETH: await mockWETH.getAddress(),
      MockAaveV3: await mockAave.getAddress(),
      MockPriceFeed: await mockPriceFeed.getAddress(),
      MockHyperliquid: await mockHyperliquid.getAddress(),
      KashYield: await kashYield.getAddress(),
      KashEth: kashEthAddress
    },
    timestamp: new Date().toISOString()
  };

  console.log("\n--- Deployment Complete ---");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  // Write to file
  const fs = require("fs");
  fs.writeFileSync(
    `deployment-${hre.network.name}-${Date.now()}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );

  return deploymentInfo;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
