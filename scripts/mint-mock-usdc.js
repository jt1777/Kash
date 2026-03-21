/**
 * Mint MockUSDC to an address. Owner only.
 *
 * Usage:
 *   npx hardhat run scripts/mint-mock-usdc.js --network arbitrumSepolia
 *   AMOUNT=500000 TO=0x... npx hardhat run scripts/mint-mock-usdc.js --network arbitrumSepolia
 *
 * Env:
 *   USDC_ADDRESS  - MockUSDC contract (default from .env)
 *   AMOUNT       - Amount to mint, whole units (default: 500000)
 *   TO           - Recipient address (default: signer)
 */
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const usdcAddress = process.env.USDC_ADDRESS || "0xc1BFb02a5df26932C8ec51346f5142944a9bdD3b";
  const amount = process.env.AMOUNT ? parseFloat(process.env.AMOUNT) : 500000;
  const to = process.env.TO || signer.address;

  if (!hre.ethers.isAddress(usdcAddress)) throw new Error("Invalid USDC_ADDRESS");
  if (!hre.ethers.isAddress(to)) throw new Error("Invalid TO address");

  const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
  const amountWei = hre.ethers.parseUnits(String(amount), 6);
  const tx = await usdc.mint(to, amountWei);
  await tx.wait();
  console.log(`Minted ${amount} USDC to ${to}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
