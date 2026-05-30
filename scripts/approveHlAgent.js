/**
 * Hyperliquid approveAgent helper + verification for KashYield adapters.
 *
 * With directDepositMode=false the HL master account is the **adapter contract**.
 * approveAgent must register agents on that master (query extraAgents(adapter)).
 * Owner-signed approveAgent registers agents on the **owner EOA**, not the adapter —
 * that does not satisfy the bot relay (vaultAddress=adapter) unless HL adds contract signing.
 *
 * Works out of the box when the HL master is an EOA (directDepositMode=true / hlAccount=bot):
 *   SIGNER=bot, USE_VAULT_ADDRESS=false, AGENT_ADDRESS=<fresh key used only for HL API>
 *
 * Usage (repo root):
 *   HL_ADAPTER_ADDRESS=0x... AGENT_ADDRESS=0x... \
 *   npx hardhat run scripts/approveHlAgent.js --network arbitrumOne
 *
 * Optional:
 *   AGENT_NAME=kash-bot
 *   AGENT_VALID_DAYS=90
 *   USE_VAULT_ADDRESS=false
 *   SIGNER=owner|bot
 *   BOT_ADDRESS / AGENT_ADDRESS — agent to authorize (must not be an existing HL user)
 */
require("dotenv").config();
require("dotenv").config({ path: "./bot/.env", override: false });

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const adapterAddress =
    process.env.HL_ADAPTER_ADDRESS ||
    process.env.HL_ADAPTER_ADDRESS_BTC ||
    process.env.HL_ADAPTER_ADDRESS_ETH;
  if (!adapterAddress || !ethers.isAddress(adapterAddress)) {
    throw new Error("Set HL_ADAPTER_ADDRESS (or HL_ADAPTER_ADDRESS_BTC / HL_ADAPTER_ADDRESS_ETH).");
  }

  let agentAddress =
    process.env.AGENT_ADDRESS ||
    process.env.BOT_ADDRESS ||
    process.env.HL_ADAPTER_OPERATOR_ADDRESS ||
    "";
  const botPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || process.env.BOT_PRIVATE_KEY || "";
  if ((!agentAddress || !ethers.isAddress(agentAddress)) && botPk) {
    agentAddress = new ethers.Wallet(botPk).address;
  }
  if (!agentAddress || !ethers.isAddress(agentAddress)) {
    throw new Error("Set AGENT_ADDRESS, BOT_ADDRESS, or HYPERLIQUID_API_PRIVATE_KEY.");
  }

  const signerMode = (process.env.SIGNER || "owner").toLowerCase();
  let wallet;
  if (signerMode === "bot") {
    if (!botPk) throw new Error("SIGNER=bot requires bot HYPERLIQUID_API_PRIVATE_KEY.");
    wallet = new ethers.Wallet(botPk);
  } else {
    const [hardhatSigner] = await ethers.getSigners();
    if (hardhatSigner) {
      wallet = hardhatSigner;
    } else if (process.env.PRIVATE_KEY) {
      wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
    } else {
      throw new Error("SIGNER=owner requires root .env PRIVATE_KEY (Hardhat network accounts).");
    }
  }
  const useVaultAddress = (process.env.USE_VAULT_ADDRESS || "false").toLowerCase() === "true";
  const agentNameBase = (process.env.AGENT_NAME || "kash-bot").slice(0, 16);
  const validDays = Math.max(1, parseInt(process.env.AGENT_VALID_DAYS || "90", 10));
  const validUntil = Date.now() + validDays * 24 * 60 * 60 * 1000;
  const agentName = `${agentNameBase} valid_until ${validUntil}`;

  const hlApiUrl = (process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz").replace(/\/+$/, "");
  const { ExchangeClient, InfoClient, HttpTransport } = await import("@nktkas/hyperliquid");

  const info = new InfoClient({ transport: new HttpTransport({ apiUrl: hlApiUrl }) });
  const before = await info.extraAgents({ user: adapterAddress }).catch(() => []);
  console.log("\napproveHlAgent");
  console.log(`  adapter (HL user): ${adapterAddress}`);
  console.log(`  agent:             ${agentAddress}`);
  console.log(`  signer:            ${wallet.address} (${signerMode})`);
  console.log(`  vaultAddress:      ${useVaultAddress ? adapterAddress : "(none)"}`);
  console.log(`  agents before:     ${JSON.stringify(before)}`);

  const exchange = new ExchangeClient({
    transport: new HttpTransport({ apiUrl: hlApiUrl }),
    wallet,
    signatureChainId: "0xa4b1",
  });

  const opts = useVaultAddress ? { vaultAddress: adapterAddress } : undefined;
  const result = await exchange.approveAgent(
    { agentAddress, agentName },
    opts,
  );
  console.log("  approveAgent response:", JSON.stringify(result));

  await new Promise((r) => setTimeout(r, 1500));
  const after = await info.extraAgents({ user: adapterAddress }).catch(() => []);
  console.log(`  agents after (adapter): ${JSON.stringify(after)}`);

  const onSigner = await info.extraAgents({ user: wallet.address }).catch(() => []);
  if (onSigner.length) {
    console.log(`  agents after (signer):  ${JSON.stringify(onSigner)}`);
  }

  const listedOnAdapter = after.some(
    (a) => a.address.toLowerCase() === agentAddress.toLowerCase(),
  );
  const listedOnSigner = onSigner.some(
    (a) => a.address.toLowerCase() === agentAddress.toLowerCase(),
  );
  if (listedOnAdapter) {
    console.log("\n✅ Agent listed on adapter HL account (directDepositMode=false path).");
  } else if (listedOnSigner) {
    console.warn(
      "\n⚠️  Agent approved on signer EOA only. For directDepositMode=false, extraAgents(adapter) must list the agent — adapter (contract) must sign approveAgent (EIP-1271) or use directDepositMode=true bootstrap.",
    );
    process.exitCode = 1;
  } else {
    console.warn("\n⚠️  Agent not listed on adapter or signer extraAgents.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
