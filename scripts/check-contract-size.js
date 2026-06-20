/**
 * Fail if vault deployed bytecode exceeds EIP-170 limit (24,576 bytes).
 * Run after compile: npm run test:contract-size
 */

const fs = require("fs");
const path = require("path");

const EIP170_LIMIT = 24_576;
const CONTRACTS = ["KashYieldBtc", "KashYieldETH"];

let failed = false;

for (const name of CONTRACTS) {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    `${name}.sol`,
    `${name}.json`,
  );
  if (!fs.existsSync(artifactPath)) {
    console.error(`Missing artifact: ${artifactPath} — run npx hardhat compile first`);
    failed = true;
    continue;
  }
  const { deployedBytecode } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const size = (deployedBytecode.length - 2) / 2;
  const ok = size <= EIP170_LIMIT;
  const status = ok ? "OK" : "OVER LIMIT";
  console.log(`${name}: ${size} bytes (${status})`);
  if (!ok) failed = true;
}

if (failed) {
  process.exit(1);
}
