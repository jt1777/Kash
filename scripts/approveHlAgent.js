/**
 * Hyperliquid approveAgent helper + verification for KashYield adapters.
 *
 * With directDepositMode=false the HL master account is the **adapter contract**.
 * approveAgent must register agents on that master (query extraAgents(adapter)).
 * Owner-signed approveAgent registers agents on the **owner EOA**, not the adapter —
 * that does not satisfy the bot relay (vaultAddress=adapter) unless HL accepts EIP-1271
 * via HyperliquidAdapter.isValidSignature (owner signature over the HL payload hash).
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
 *   SIGNER=owner|bot|adapter
 *     adapter — owner signs payloads but SDK reports adapter address (EIP-1271 path
 *               when Hyperliquid verifies via HyperliquidAdapter.isValidSignature)
 *   VERIFY_EIP1271=true — on-chain check that owner sigs validate on adapter (no HL API)
 *   BOT_ADDRESS / AGENT_ADDRESS — agent to authorize (must not be an existing HL user)
 */
require("dotenv").config();
require("dotenv").config({ path: "./bot/.env", override: false });

const hre = require("hardhat");
const { ethers } = hre;

const ERC1271_MAGIC = "0x1626ba7e";
const ADAPTER_EIP1271_ABI = [
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function owner() view returns (address)",
];

/** Owner signs; HL SDK uses adapter address as master account (EIP-1271). */
function createEip1271AdapterWallet(adapterAddress, ownerWallet) {
  return new Proxy(ownerWallet, {
    get(target, prop, receiver) {
      if (prop === "address") return adapterAddress;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** JsonRpcSigner (hardhat --network) has no signingKey; EIP-1271 needs raw hash sig from PRIVATE_KEY. */
function walletForLocalSign(signerOrWallet) {
  if (signerOrWallet.signingKey) return signerOrWallet;
  const pk = process.env.PRIVATE_KEY;
  if (pk) return new ethers.Wallet(pk);
  throw new Error(
    "EIP-1271 probe requires root .env PRIVATE_KEY (remote network signers cannot sign raw hashes).",
  );
}

async function verifyAdapterEip1271(adapterAddress, ownerWallet) {
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_EIP1271_ABI, ethers.provider);
  const signingWallet = walletForLocalSign(ownerWallet);
  const onChainOwner = await adapter.owner();
  if (onChainOwner.toLowerCase() !== signingWallet.address.toLowerCase()) {
    console.warn(
      `  ⚠️  Signer ${signingWallet.address} != adapter.owner() ${onChainOwner} — EIP-1271 may reject`,
    );
  }
  const hash = ethers.hexlify(ethers.randomBytes(32));
  const sig = signingWallet.signingKey.sign(hash).serialized;
  const magic = await adapter.isValidSignature(hash, sig);
  const ok = magic === ERC1271_MAGIC;
  console.log(`  EIP-1271 probe: ${ok ? "✅ owner sig valid on adapter" : "❌ failed"} (${magic})`);
  return ok;
}

async function main() {
  const adapterAddress =
    process.env.HL_ADAPTER_ADDRESS ||
    process.env.HL_ADAPTER_ADDRESS_BTC ||
    process.env.HL_ADAPTER_ADDRESS_ETH;
  if (!adapterAddress || !ethers.isAddress(adapterAddress)) {
    throw new Error("Set HL_ADAPTER_ADDRESS (or HL_ADAPTER_ADDRESS_BTC / HL_ADAPTER_ADDRESS_ETH).");
  }

  const hlApiPk = process.env.HYPERLIQUID_API_PRIVATE_KEY || process.env.BOT_PRIVATE_KEY || "";
  // Prefer dedicated HL API key over root BOT_ADDRESS (on-chain bot is often an existing HL user).
  let agentAddress = process.env.AGENT_ADDRESS || "";
  if (!agentAddress || !ethers.isAddress(agentAddress)) {
    if (hlApiPk) {
      agentAddress = new ethers.Wallet(hlApiPk).address;
    } else {
      agentAddress =
        process.env.BOT_ADDRESS || process.env.HL_ADAPTER_OPERATOR_ADDRESS || "";
    }
  }
  if (!agentAddress || !ethers.isAddress(agentAddress)) {
    throw new Error(
      "Set AGENT_ADDRESS or bot/.env HYPERLIQUID_API_PRIVATE_KEY (fresh HL agent key, not on-chain BOT_ADDRESS).",
    );
  }

  const signerMode = (process.env.SIGNER || "owner").toLowerCase();
  let ownerWallet;
  if (signerMode === "bot") {
    if (!hlApiPk) throw new Error("SIGNER=bot requires bot HYPERLIQUID_API_PRIVATE_KEY.");
    ownerWallet = new ethers.Wallet(hlApiPk);
  } else {
    if (process.env.PRIVATE_KEY) {
      ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY);
    } else {
      const [hardhatSigner] = await ethers.getSigners();
      if (!hardhatSigner) {
        throw new Error("SIGNER=owner|adapter requires root .env PRIVATE_KEY.");
      }
      ownerWallet = hardhatSigner;
    }
  }

  const verifyOnly = (process.env.VERIFY_EIP1271 || "false").toLowerCase() === "true";
  if (verifyOnly || signerMode === "adapter") {
    const ok = await verifyAdapterEip1271(adapterAddress, ownerWallet);
    if (verifyOnly) {
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (!ok) {
      console.warn("  Continuing approveAgent despite failed EIP-1271 probe — HL may still reject.");
    }
  }

  const signingWallet =
    signerMode === "adapter" ? walletForLocalSign(ownerWallet) : ownerWallet;
  const wallet = signerMode === "adapter"
    ? createEip1271AdapterWallet(adapterAddress, signingWallet)
    : ownerWallet;
  const useVaultAddress = (process.env.USE_VAULT_ADDRESS || "false").toLowerCase() === "true";
  const agentNameBase = (process.env.AGENT_NAME || "kash-bot").slice(0, 16);
  const validDays = Math.max(1, parseInt(process.env.AGENT_VALID_DAYS || "90", 10));
  const validUntil = Date.now() + validDays * 24 * 60 * 60 * 1000;
  const agentName = `${agentNameBase} valid_until ${validUntil}`;

  const hlApiUrl = (process.env.HYPERLIQUID_API_URL || "https://api.hyperliquid.xyz").replace(/\/+$/, "");
  const { ExchangeClient, InfoClient, HttpTransport } = await import("@nktkas/hyperliquid");

  const info = new InfoClient({ transport: new HttpTransport({ apiUrl: hlApiUrl }) });
  const ownerAddr = ownerWallet?.address;
  const beforeAdapter = await info.extraAgents({ user: adapterAddress }).catch(() => []);
  const beforeOwner =
    ownerAddr && ownerAddr.toLowerCase() !== adapterAddress.toLowerCase()
      ? await info.extraAgents({ user: ownerAddr }).catch(() => [])
      : [];

  console.log("\napproveHlAgent");
  console.log(`  adapter (HL user): ${adapterAddress}`);
  console.log(`  agent:             ${agentAddress}`);
  console.log(`  signer:            ${wallet.address} (${signerMode})`);
  if (signerMode === "adapter") {
    console.log(`  owner (EIP-1271):  ${ownerWallet.address}`);
  }
  console.log(`  vaultAddress:      ${useVaultAddress ? adapterAddress : "(none)"}`);
  console.log(`  agents (adapter):  ${JSON.stringify(beforeAdapter)}`);
  if (beforeOwner.length) {
    console.log(`  agents (owner):    ${JSON.stringify(beforeOwner)}`);
  }

  const agentLower = agentAddress.toLowerCase();
  const alreadyOnAdapter = beforeAdapter.some((a) => a.address.toLowerCase() === agentLower);
  const alreadyOnOwner = beforeOwner.some((a) => a.address.toLowerCase() === agentLower);

  if (alreadyOnAdapter) {
    console.log("\n✅ Agent already listed on adapter HL account — nothing to do.");
    return;
  }

  if (alreadyOnOwner) {
    console.warn("\n⚠️  Agent already registered on adapter.owner() HL account, not on adapter.");
    console.warn("    HL will reject re-approval: 'Extra agent already used.'");
    console.warn("    Bot needs extraAgents(adapter) for directDepositMode=false.");
    console.warn("    Options:");
    console.warn("      1. Revoke agent on owner at https://app.hyperliquid.xyz/agents (owner wallet),");
    console.warn("         generate a NEW HYPERLIQUID_API_PRIVATE_KEY, retry SIGNER=adapter;");
    console.warn("      2. Contact Hyperliquid re: approveAgent for contract master accounts;");
    console.warn("      3. Last resort: directDepositMode=true bootstrap (see DEPLOYMENT.md).");
    process.exitCode = 1;
    return;
  }

  const exchange = new ExchangeClient({
    transport: new HttpTransport({ apiUrl: hlApiUrl }),
    wallet,
    signatureChainId: "0xa4b1",
  });

  const opts = useVaultAddress ? { vaultAddress: adapterAddress } : undefined;
  let result;
  try {
    result = await exchange.approveAgent({ agentAddress, agentName }, opts);
    console.log("  approveAgent response:", JSON.stringify(result));
  } catch (err) {
    const msg = String(err?.response?.response || err?.message || err);
    if (msg.includes("Extra agent already used")) {
      console.warn("\n⚠️  HL: Extra agent already used — this agent is bound to another HL master.");
      console.warn("    Revoke at https://app.hyperliquid.xyz/agents (owner wallet) or use a new agent key.");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  await new Promise((r) => setTimeout(r, 1500));
  const after = await info.extraAgents({ user: adapterAddress }).catch(() => []);
  console.log(`  agents after (adapter): ${JSON.stringify(after)}`);

  const onSigner = await info.extraAgents({ user: wallet.address }).catch(() => []);
  if (onSigner.length) {
    console.log(`  agents after (signer):  ${JSON.stringify(onSigner)}`);
  }

  const onOwner = await info.extraAgents({ user: ownerAddr }).catch(() => []);
  if (onOwner.length) {
    console.log(`  agents after (owner):   ${JSON.stringify(onOwner)}`);
  }

  const listedOnAdapter = after.some((a) => a.address.toLowerCase() === agentLower);
  const listedOnSigner = onSigner.some((a) => a.address.toLowerCase() === agentLower);
  const listedOnOwner = onOwner.some((a) => a.address.toLowerCase() === agentLower);
  if (listedOnAdapter) {
    console.log("\n✅ Agent listed on adapter HL account (directDepositMode=false path).");
  } else if (listedOnOwner) {
    console.warn(
      "\n⚠️  Agent listed on adapter.owner() HL account only, not extraAgents(adapter).",
    );
    console.warn(
      "    Bot relay needs extraAgents(adapter) for directDepositMode=false. HL likely attributed",
    );
    console.warn(
      "    SIGNER=adapter approval to the owner EOA (EIP-1271 user-signed path unverified on HL).",
    );
    console.warn("    Do not start live batches until extraAgents(adapter) lists the agent.");
    process.exitCode = 1;
  } else if (listedOnSigner) {
    console.warn(
      "\n⚠️  Agent approved on signer EOA only. For directDepositMode=false, extraAgents(adapter) must list the agent.",
    );
    process.exitCode = 1;
  } else {
    console.warn("\n⚠️  Agent not listed on adapter, owner, or signer extraAgents.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
