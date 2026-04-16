/**
 * 15-rescue-usdc-from-contract — Owner sends KashYield's on-chain USDC to a recipient via rescueERC20.
 *
 * Default: full USDC balance. Override with AMOUNT (human USDC, e.g. 8.5).
 * Default recipient: Hardhat signer (owner). Override: RESCUE_TO=0x...
 *
 * Usage (repo root):
 *   PRODUCT=eth npx hardhat run bot/scripts/ops/15-rescue-usdc-from-contract.js --network arbitrumOne
 *   PRODUCT=eth AMOUNT=1 RESCUE_TO=0xYourWallet npx hardhat run bot/scripts/ops/15-rescue-usdc-from-contract.js --network arbitrumOne
 */
const { ethers } = require("hardhat");
const { getContract, getSigner, fmtUsdc, parseUsdc, exec, PRODUCT } = require("./_utils");

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  console.log(`\n15 — Rescue USDC from KashYield contract  [product=${PRODUCT.toUpperCase()}]`);

  const contract = await getContract();
  const signer = await getSigner();
  const owner = await contract.owner();
  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${signer.address} is not contract owner (${owner}).`);
  }

  const usdcAddr = await contract.usdcAddress();
  if (!usdcAddr || usdcAddr === ethers.ZeroAddress) {
    throw new Error("usdcAddress not set on contract.");
  }

  const usdc = new ethers.Contract(usdcAddr, ERC20_ABI, signer.provider);
  const vault = await contract.getAddress();
  const bal = BigInt((await usdc.balanceOf(vault)).toString());

  const amount = process.env.AMOUNT ? parseUsdc(process.env.AMOUNT) : bal;
  if (amount === 0n) {
    console.log("\nNothing to rescue — USDC balance is zero.");
    return;
  }
  if (amount > bal) {
    throw new Error(`AMOUNT ${fmtUsdc(amount)} exceeds contract USDC ${fmtUsdc(bal)}`);
  }

  const recipient =
    process.env.RESCUE_TO && ethers.isAddress(process.env.RESCUE_TO)
      ? process.env.RESCUE_TO
      : signer.address;

  console.log(`  Contract USDC: ${fmtUsdc(bal)}`);
  console.log(`  Rescuing:      ${fmtUsdc(amount)} → ${recipient}`);

  await exec(
    `rescueERC20(USDC, ${amount.toString()}, ${recipient})`,
    contract.rescueERC20(usdcAddr, amount, recipient),
  );

  const balAfter = BigInt((await usdc.balanceOf(vault)).toString());
  console.log(`  Contract USDC after: ${fmtUsdc(balAfter)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
