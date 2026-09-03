/**
 * Write one ABI per vault into frontend/lib/contracts (no ETH+BTC merge).
 * Run after compile: node scripts/export-kash-vault-abi.js
 */
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "frontend", "lib", "contracts");

function exportAbi(solName, exportName) {
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    `${solName}.sol`,
    `${solName}.json`,
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact ${artifactPath} — run npx hardhat compile first`);
  }
  const { abi } = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const body =
    `// Auto-generated from artifacts/contracts/${solName}.sol/${solName}.json — do not edit by hand.\n` +
    `// Regenerate: npx hardhat compile && node scripts/export-kash-vault-abi.js\n` +
    `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`;
  const outPath = path.join(OUT_DIR, `${exportName}.ts`);
  fs.writeFileSync(outPath, body);
  console.log(`Wrote ${outPath} (${abi.length} ABI items)`);
}

exportAbi("KashVaultEth", "kashVaultEthABI");
exportAbi("KashVaultBtc", "kashVaultBtcABI");
