# KashYield Deployment Guide (Arbitrum One)

This guide covers production deployment of **KashYieldETH** and **KashYieldBtc** (`contracts/KashYieldBtc.sol`) on **Arbitrum One**. All protocol dependencies are live mainnet contracts (Aave V3, Chainlink, Uniswap V3, Hyperliquid bridge).

---

## Prerequisites

1. **Node.js and npm** — use a Node version compatible with Hardhat (Hardhat may warn on Node 25+).
2. **Hardhat** — configured in this repo (`hardhat.config.js` includes the `arbitrumOne` network).
3. **dotenv** — `npm install dotenv` at repo root if needed; scripts load the **root** `.env`.

---

## Two wallets on mainnet (required)

Use **two different Arbitrum addresses**. Do not reuse the deployer key for batch ops or Hyperliquid API signing.

| Role | Wallet | Keys / env | On-chain identity |
|------|--------|------------|-------------------|
| **Owner** | Cold / multisig (high security) | Root `.env` → **`PRIVATE_KEY`** only for **owner** scripts | `KashYield*.owner()` — config, reserves, `setSpotDex`, `setHyperliquid`, timelocks, `ownerWithdraw*` |
| **Bot / keeper** | Hot operator (limited funds) | **`bot/.env` → `PRIVATE_KEY`** and **`HYPERLIQUID_API_PRIVATE_KEY`** (same bot address) | `KashYield*.botAddress()` — `performUpkeep`, batch ops, `markBatchOpsDone`, Aave/HL moves via vault |

**Deploy wiring**

- **`scripts/deploy-arbitrum-sepolia.js`** and **`scripts/deploy-kashyieldbtc.js`** set **`owner = msg.sender`** (whoever signs the deploy tx with root `PRIVATE_KEY`).
- Pass **`BOT_ADDRESS=<bot_wallet>`** on the deploy command so the vault’s **`botAddress`** is the bot, **not** the owner.

```bash
# Example — owner signs deploy; bot is a different address
BOT_ADDRESS=0xYourBotWalletOnly \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
```

**After deploy, verify (Hardhat console or Arbiscan “Read contract”)**

```javascript
const ky = await ethers.getContractAt("KashYieldETH", "<KASH_YIELD_ETH_ADDRESS>")
console.log("owner:", await ky.owner())
console.log("botAddress:", await ky.botAddress())
// owner !== botAddress
```

**Optional third address:** `keeperRegistry` via `setKeeperRegistry(bot)` if you use Chainlink Automation with a dedicated keeper; otherwise leave **`0x0`** and the **bot** alone calls batch functions.

**Hyperliquid (this deployment: no direct deposit mode)**

- Set **`directDepositMode = false`** on each **HyperliquidAdapter** (Steps 4a / B3). The HL account is the **adapter contract address**, not the bot EOA.
- The **bot** still signs HL API trades (`HYPERLIQUID_API_PRIVATE_KEY`) after **HL agent approval** for that adapter account — see **Hyperliquid adapter setup (production)** below.
- Do **not** set `directDepositMode = true` unless you accept bot-EOA custody risk (Option B in Step 4a is documented for reference only).

---

## Critical rules — read before deploying

1. **`WETH_ADDRESS` must be canonical WETH9** on Arbitrum (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`) — it must support `deposit()` / `withdraw()`.

2. **Use native USDC** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`), not USDC.e (`0xff970a...`). Aave and Hyperliquid expect native USDC on Arbitrum.

3. **`AAVE_POOL_ADDRESS` in env is informational for scripts** — `KashYieldETH` / `KashYieldBtc` embed the Arbitrum One Aave V3 pool (`0x794a61358D6845594F94dc1DB02A252b5b4814aD`) in the implementation; deploy scripts do not override it.

4. **`exchangeSwitchDelay`** on a fresh vault defaults to **24 hours**. The **first** perp adapter registration is immediate; the delay applies when you **later** propose **another** adapter. On mainnet, do **not** set the delay to `0` unless you explicitly accept no timelock for future adapter changes.

5. **Owner / treasury reserves** (`ownerUsdcReserve`, asset-specific owner buffers). These balances are **not** part of user NAV. The bot may call `coverUsdcShortfall` to move reserved USDC into the working float. Batch phase 2 credits protocol fees to owner asset reserves; `ownerWithdraw*` pulls only from those reserves. Ops and `snapshotOpsContext` use **adjusted** balances (raw minus reserves) as the deployable float.

   **Crediting owner reserves (one transaction each; cannot re-label existing user NAV float):**

   | Function | Contract | How tokens move |
   |----------|----------|-----------------|
   | `markOwnerEthDeposit()` | KashYieldETH | Payable — send ETH as **`msg.value`** in the same call (no separate transfer). |
   | `markOwnerUsdcDeposit(amount)` | KashYieldETH, KashYieldBtc | **`transferFrom`** owner → vault in the same call. Owner must **`approve` the vault** for USDC first (separate tx unless using a batch wallet). |
   | `markOwnerWbtcDeposit(amount)` | KashYieldBtc | Same as USDC — **`approve` wBTC** on the vault, then call `markOwnerWbtcDeposit` (pulls and credits in one tx). |

   Example (Hardhat console or script), after approval:

   ```javascript
   // USDC — KashYieldETH or KashYieldBtc
   await usdc.approve(kashYieldAddress, amount)
   await kashYield.markOwnerUsdcDeposit(amount)

   // wBTC — KashYieldBtc only
   await wbtc.approve(kashYieldAddress, amount)
   await kashYield.markOwnerWbtcDeposit(amount)

   // ETH — KashYieldETH only (single tx)
   await kashYield.markOwnerEthDeposit({ value: amount })
   ```

6. **Contract size (EIP-170, 24576 bytes).** `hardhat.config.js` enables the Solidity optimizer (`runs: 1`), `viaIR: true`, and `metadata.bytecodeHash: "none"`. `ProtocolInteraction` uses **`uint8` action codes** (see `contracts/libraries/ProtocolActionCodes.sol`). After `npx hardhat compile`, confirm there is no “contract code size exceeds 24576 bytes” warning before deploy.

7. **`BOT_ADDRESS` must differ from owner.** If you omit `BOT_ADDRESS`, deploy scripts default **`botAddress = deployer`**, which collapses owner and bot into one key — avoid on mainnet.

8. **Redeploy = new vault + new KASH token.** Each `KashYieldETH` / `KashYieldBtc` deploy creates a **new** `KashToken*` in the constructor. Update **`frontend/lib/contracts/addresses.ts`** fallbacks only after you intend to cut over; finish in-flight batches on **old** vaults before switching bot/frontend env. Latest bytecode includes **`markBatchOpsDone(batchCycle, grossRedeemAssetAmount)`** (locked redeem **G**), owner-reserve-only `ownerWithdraw*`, and removed `getReserved*` / stale `currentBatchCycle` storage — incompatible with older deployed vaults for mid-batch resume.

---

## Protocol contract addresses (Arbitrum One)

### Tokens

| Token | Address |
|-------|---------|
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| USDC (native) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| wBTC | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` |

### Aave V3

| Contract | Address |
|----------|---------|
| Pool | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| WrappedTokenGatewayV3 | `0x5283BEcEd7ADF6D003225C13896E536f2D4264FF` |

### Chainlink price feeds

| Feed | Address |
|------|---------|
| ETH / USD | `0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612` |
| BTC / USD | `0x6ce185860a4963106506C203335A2910413708e9` |

### Uniswap V3

| Contract | Address |
|----------|---------|
| SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` |
| QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |

Key pools (0.05% fee tier): WETH/USDC and wBTC/USDC via `factory.getPool(token0, token1, 500)`.

### Hyperliquid

| Contract | Address |
|----------|---------|
| Bridge 2 (Arbitrum → HL) | `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7` |

USDC only; minimum deposit 5 USDC.

---

## Architecture: Hyperliquid on mainnet

On mainnet, Hyperliquid is separate from Arbitrum execution. The **HyperliquidAdapter** on Arbitrum talks to the **bridge** for USDC deposits; spot and perp trades are **off-chain** via the HL API (bot), then synced on-chain with `syncBalances` / `syncPosition` as your deployment expects.

| Action | How it works |
|--------|----------------|
| Deposit USDC | On-chain: USDC to bridge `0x2Df1c51E...` |
| Spot / perp trades | Off-chain: HL API |
| Withdraw USDC | HL withdrawal settles back to Arbitrum (~minutes); **destination address is operator-chosen** |

Ops scripts `04`–`07` behave as API-driven steps on mainnet, not synchronous mock contract calls.

### Hyperliquid USDC withdrawals and custody

Hyperliquid bridges USDC to **whichever Arbitrum address you specify** (HL API `withdraw3` or the web app “withdraw”). KashYield then pulls USDC **from the HyperliquidAdapter** via `withdrawFromHyperliquid` → `withdrawCollateral`, so **on-chain float only moves if USDC actually sits on the adapter** after the bridge.

**Operational rules**

- **Always** set the HL withdrawal **destination** to your deployed **HyperliquidAdapter** address for protocol float—not the KashYield vault by default unless your runbook explicitly allows it, and **not** an operator EOA unless you intend temporary custody outside the adapter.
- Prefer **automated** withdrawals: bot `withdraw3` with `destination =` adapter (same pattern as `maybeInitiateHlOffchainWithdraw` in `bot/src/batch/opsExec.ts`). If you use the **HL web app**, open the destination field and **paste the adapter address**; do **not** assume the default “linked wallet” is correct.
- After USDC lands on Arbitrum, confirm **`USDC.balanceOf(adapter)`** (script `08-withdraw-usdc-from-perp.js` prints this) before expecting `08` to move meaningful balances.

**`directDepositMode` and why the bot EOA is risky**

- **`directDepositMode = true`:** Deposits forward USDC to `hlAccount` (typically the **bot EOA**); that EOA is also the **Hyperliquid master account** in the simpler setup. HL’s UI often defaults withdrawals to **that same EOA**, so **user NAV can bridge to the hot wallet** by mistake. Treat that as **mis-routed protocol custody**, not owner treasury—recover by forwarding USDC on Arbitrum **EOA → adapter**, then run ops `14` (optional) and `08` as usual. **Do not** call `markOwnerUsdcDeposit` for this unless you are intentionally recording **owner/treasury** reserves (see owner reserves section above).
- **`directDepositMode = false` (production recommended):** The HL L1 account should be the **adapter contract’s Arbitrum address**; deposits go to the bridge as **adapter-as-account**. Custody lines up with on-chain bookkeeping and avoids “HL account == bot wallet” confusion. **Requires HL agent (and related) setup** so the bot key can sign HL API actions for that account—see `contracts/adapters/HyperliquidAdapter.sol` (file header), `bot/README.md` (“Mainnet Hyperliquid Setup”), and `docs/` / ops runbooks before going live.

---

## Architecture: Uniswap V3 spot adapter

The `UniswapV3Adapter` implements `ISpotDex` and wraps `SwapRouter02`. Typical routing: **0.05%** pools for WETH/USDC and wBTC/USDC. Use sane `amountOutMinimum` / slippage on mainnet — never `0`.

---

## Environment setup

### Root `.env` — owner / deployer only (Arbitrum One)

Used by Hardhat **deploy** and **owner** configuration scripts (`setSpotDex`, `setHyperliquid`, `setExchangeSwitchDelay`, adapter `setDirectDepositMode`, etc.). **Do not** put the bot hot key here unless you intentionally use one wallet for everything.

```env
# OWNER — signs deploy + owner-only txs (hardware wallet / multisig)
PRIVATE_KEY=0x...

ARBITRUM_ONE_RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY
ARBISCAN_API_KEY=your_arbiscan_api_key

# Canonical tokens (override only if you know what you are doing)
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
AAVE_POOL_ADDRESS=0x794a61358D6845594F94dc1DB02A252b5b4814aD
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9
HL_BRIDGE_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7

# Filled in as you deploy (examples):
# UNISWAP_ADAPTER_ADDRESS=
# KASH_YIELD_ETH_ADDRESS=
# KASH_TOKEN_ETH=
# HL_ADAPTER_ADDRESS_ETH=
# KASH_YIELD_BTC_ADDRESS=
# KASH_TOKEN_BTC=
# HL_ADAPTER_ADDRESS_BTC=
```

### `bot/.env` — bot operator only (Arbitrum One)

**Separate file, separate key.** Must match **`botAddress`** on the vault you operate. Never commit this file.

```env
# BOT — batch ops + HL API (hot wallet; not the owner)
PRIVATE_KEY=0x...
HYPERLIQUID_API_PRIVATE_KEY=0x...
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz

RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY
CHAIN_ID=42161

PRODUCT=eth
KASH_YIELD_ETH_ADDRESS=<KashYieldETH>
KASH_TOKEN_ETH=<KashTokenEth>

AAVE_POOL_ADDRESS=0x794a61358D6845594F94dc1DB02A252b5b4814aD
AAVE_USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9
```

Add **BTC product** lines when operating the BTC vault:

```env
# PRODUCT=btc
# KASH_YIELD_BTC_ADDRESS=<KashYieldBtc>
# KASH_TOKEN_BTC=<KashTokenBtc>
```

**Batch bot (`bot/package.json` → `npm run start`):** With **`PRODUCT=btc`** (or `product` / `Product` — same as in code), **`CHAIN_ID=42161`**, and **`KASH_YIELD_BTC_ADDRESS`** set, `node dist/index.js` loads **`KashYieldBtc`**, uses wBTC / **`getBtcPrice`**, HL short symbol **BTC**, and the same ops playbooks with 8-decimal asset math. Run **`npm run build`** after pulling changes, then **`npm run start`** from **`bot/`**. Ops scripts under `bot/scripts/ops/` also read **`PRODUCT`** (same variants) from **`bot/.env`**.

### `frontend/.env.local`

Use `NEXT_PUBLIC_` prefixes for any vault the UI exposes:

```env
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth>
NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS=<KashYieldBtc>
NEXT_PUBLIC_KASH_TOKEN_BTC=<KashTokenBtc>
```

---

## Pre-launch checklist

- [ ] `npx hardhat compile` — no EIP-170 size errors on `KashYieldETH` / `KashYieldBtc`.
- [ ] Smart contract audit completed (or accepted risk documented).
- [ ] **Two wallets:** owner `PRIVATE_KEY` (root `.env`) ≠ bot `PRIVATE_KEY` (`bot/.env`); on-chain `owner()` ≠ `botAddress()`.
- [ ] **`BOT_ADDRESS`** set on both vault deploy commands to the **bot** address (not omitted).
- [ ] **`directDepositMode = false`** on **both** HL adapters; HL withdrawals target **adapter** address.
- [ ] HL **agent** approved for bot on each adapter’s HL account; adapter **`operator`** = bot (deploy env or `setOperator`).
- [ ] `exchangeSwitchDelay` is **not** `0` on mainnet unless you deliberately want no timelock for **future** adapter proposals (default **86400** = 24h; optional **172800** = 48h via `setExchangeSwitchDelay`).
- [ ] Contracts verified on Arbiscan; `diagnose-eth.js` (and BTC ops smoke) clean.
- [ ] `bot/.env` + `frontend/.env.local` point at **new** vault/token addresses; `npm run build` in `bot/` before `npm start`.

---

## Hyperliquid adapter setup (production, `directDepositMode = false`)

Complete **per product** (ETH adapter, then BTC adapter) **before** the first live `npm start` batch.

1. **Custody mode (owner key)** — Step 4a / B3: `setDirectDepositMode(false, 0x0)`.
2. **Adapter operator (owner key)** — allow the bot to call `syncBalances` / `syncPosition`:
   - At deploy: set `HL_ADAPTER_OPERATOR_ADDRESS=<bot_wallet>` in the environment when running `deploy-hyperliquid-adapter.js`, **or**
   - After deploy (owner console):

```javascript
await (await adapter.setOperator("<BOT_WALLET>")).wait()
```

3. **HL API agent (bot key)** — authorise the **bot EOA** to trade on the HL account tied to the **adapter address** via Hyperliquid’s `approveAgent` (REST `/exchange`). The adapter contract cannot sign HL payloads; the bot signs orders/`withdraw3` as agent. If agent setup is incomplete, `npm start` may emit on-chain intent without real HL fills.
4. **Withdrawals** — bot `withdraw3` and manual HL UI must use **`destination =` HyperliquidAdapter address** (see **Hyperliquid USDC withdrawals and custody** above).

> **Note:** `bot/README.md` “Mainnet Hyperliquid Setup” §1 historically described **`directDepositMode = true`** for simpler bootstrap. **This deployment uses the opposite (production) path.** Follow this guide and Step 4a / B3, not that subsection.

---

## Mainnet deployment overview

**All contracts and configuration steps are below** (ETH: Steps **1–11**, then BTC: Steps **B1–B9**). Use this table as a map; each step includes the exact `npx hardhat run …` command.

| Order | What | Script / action | Step |
|------:|------|-----------------|------|
| 0 | Compile | `npx hardhat compile` | [1](#step-1--compile) |
| 1 | **UniswapV3Adapter** (shared ETH + BTC spot) | `scripts/deploy-uniswap-adapter.js` | [2](#step-2--deploy-uniswapv3adapter) |
| 2 | **KashYieldETH** + **KashTokenEth** | `scripts/deploy-arbitrum-sepolia.js` | [3](#step-3--deploy-kashyieldeth) |
| 3 | **HyperliquidAdapter** (ETH) | `scripts/deploy-hyperliquid-adapter.js` (`IS_ETH_ASSET=true`) | [4](#step-4--deploy-hyperliquidadapter-eth) |
| 4 | HL custody `directDepositMode=false` | Hardhat console / `setDirectDepositMode` | [4a](#step-4a--hyperliquid-adapter-custody-mode-required-directdepositmode--false) |
| 5 | ETH oracle (explicit) | `scripts/setEthOracle.js` | [5](#step-5--set-chainlink-eth-oracle-recommended) |
| 6 | Exchange switch delay (optional) | `scripts/setExchangeSwitchDelay.js` | [6](#step-6--exchange-switch-delay-optional) |
| 7 | Register + activate HL on ETH vault | `setHyperliquid.js`, `setActivePerpExchange.js` | [7](#step-7--register-and-activate-hl-eth) |
| 8 | Whitelist Uniswap + set spot DEX (ETH) | `setAllowedSpotDexRouter.js`, `setSpotDex.js` | [8](#step-8--whitelist-uniswap-adapter-and-set-spot-dex-eth) |
| 9 | Cycle duration (ETH) | `scripts/setCycleDuration.js` | [9](#step-9--set-cycle-duration-eth) |
| 10 | Verify on Arbiscan | `npx hardhat verify …` | [10](#step-10--verify-on-arbiscan) |
| 11 | Smoke test | `scripts/diagnose-eth.js` | [11](#step-11--post-deployment-verification-eth) |
| 12 | **KashYieldBtc** + **KashTokenBtc** | `scripts/deploy-kashyieldbtc.js` | [B1](#step-b1--deploy-kashyieldbtc) |
| 13 | **HyperliquidAdapter** (BTC) | `scripts/deploy-hyperliquid-adapter.js` (`IS_ETH_ASSET=false`) | [B2](#step-b2--deploy-hyperliquidadapter-btc) |
| 14 | HL custody (BTC adapter) | Hardhat console / `setDirectDepositMode` | [B3](#step-b3--hyperliquid-adapter-custody-mode-btc-adapter) |
| 15 | Register + activate HL on BTC vault | `setHyperliquid.js`, `setActivePerpExchange.js` (`PRODUCT=btc`) | [B6](#step-b6--register-and-activate-hl-btc) |
| 16 | Whitelist Uniswap + set spot DEX (BTC) | same adapter as ETH; `PRODUCT=btc` | [B7](#step-b7--whitelist-uniswap-adapter-and-set-spot-dex-btc) |
| 17 | Cycle duration (BTC) | `setCycleDuration.js` (`PRODUCT=btc`) | [B8](#step-b8--set-cycle-duration-btc) |
| 18 | Verify BTC contracts | `npx hardhat verify …` | [B9](#step-b9--verify-on-arbiscan-btc) |

**Scripts named `deploy-arbitrum-sepolia.js` and `MOCK_HL_ADDRESS` are historical** — on mainnet use `--network arbitrumOne` and the live HL Bridge2 address (`0x2Df1…`).

---

## Deployment — ETH product (`KashYieldETH`)

> **Order matters.** Deploy **UniswapV3Adapter** first, then **KashYieldETH**, then **HyperliquidAdapter** (the adapter constructor needs the KashYield address). Do **not** set `HL_ADAPTER_ADDRESS_ETH` in `.env` when running `deploy-arbitrum-sepolia.js` for the first time, or the vault may bind an old adapter at deploy time.

### Step 1 — Compile

```bash
npx hardhat compile
```

### Step 2 — Deploy UniswapV3Adapter

Constructor is **`(swapRouter, weth)`** — defaults match Arbitrum One when using `--network arbitrumOne`.

```bash
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

(Optional explicit overrides:)

```bash
UNISWAP_ROUTER_ADDRESS=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
npx hardhat run scripts/deploy-uniswap-adapter.js --network arbitrumOne
```

Save to root `.env`:

```env
UNISWAP_ADAPTER_ADDRESS=<UniswapV3Adapter from output>
```

### Step 3 — Deploy KashYieldETH

```bash
BOT_ADDRESS=<your_bot_wallet> \
WETH_ADDRESS=0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
npx hardhat run scripts/deploy-arbitrum-sepolia.js --network arbitrumOne
```

Save to root `.env`, `bot/.env`, and `frontend/.env.local`:

```env
KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
KASH_TOKEN_ETH=<KashTokenEth from output>
```

```env
# frontend/.env.local
NEXT_PUBLIC_KASH_YIELD_ETH_ADDRESS=<KashYieldETH from output>
NEXT_PUBLIC_KASH_TOKEN_ETH=<KashTokenEth from output>
```

### Step 4 — Deploy HyperliquidAdapter (ETH)

Pass the **Bridge2** address as **`HL_BRIDGE_ADDRESS`**, **`MOCK_HL_ADDRESS`**, or **`HYPERLIQUID_ADDRESS`** (same value; pick one).

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
IS_ETH_ASSET=true \
KASH_YIELD_ADDRESS=<KASH_YIELD_ETH_ADDRESS from step 3> \
HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET from bot/.env> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save to root `.env`:

```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

### Step 4a — Hyperliquid adapter custody mode (required: `directDepositMode = false`)

**Use this for your deployment.** Sign with the **owner** key (root `.env` `PRIVATE_KEY`). Then complete **Hyperliquid adapter setup (production)** (agent + operator).

- Set **`directDepositMode = false`** so USDC uses **bridge → adapter-as-HL-account** and HL ledger identity matches the adapter contract.
- From repo root:

```bash
npx hardhat console --network arbitrumOne
```

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_ETH>", signer)
const tx = await adapter.setDirectDepositMode(false, "0x0000000000000000000000000000000000000000")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

**Readback:** `directDepositMode` is **`false`**; `hlAccount` is zero / unused for deposits.

**Deploy-time operator (recommended):** when running Step 4, set `HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET>` so `setOperator` runs in `deploy-hyperliquid-adapter.js`.

<details>
<summary>Reference only — Option B (`directDepositMode = true`, not for this deployment)</summary>

Bootstrap mode sets **`directDepositMode = true`** and **`hlAccount =` bot EOA**. Simpler HL agent setup but **high risk**: HL UI often withdraws to the **bot wallet**, not the adapter. Do **not** use for production vaults described in this guide.

```bash
npx hardhat console --network arbitrumOne
```

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_ETH>", signer)
const tx = await adapter.setDirectDepositMode(true, "<BOT_EOA_ADDRESS>")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

**Readback:** `directDepositMode` is **`true`** and **`hlAccount`** matches your bot EOA (may be checksummed).

</details>

**How to confirm success**

- **`receipt.status === 1`** — transaction succeeded (in Hardhat/ethers v6 this appears as `status: 1n` or `1` on the receipt object). **`status: 0`** means the call reverted.
- **`receipt.contractAddress === null`** — normal for this step: you are calling an existing adapter, not deploying a new contract.
- **`receipt.to`** — must match your **`HL_ADAPTER_ADDRESS_ETH`** (the adapter you configured).
- **On-chain check:** paste **`receipt.hash`** into Arbiscan; the UI should show **Success**.

### Step 5 — Set Chainlink ETH oracle (recommended)

`KashYieldETH` defaults to the Arbitrum ETH/USD feed; calling `setEthOracle` makes configuration explicit.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ETH_ORACLE_ADDRESS=0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612 \
npx hardhat run scripts/setEthOracle.js --network arbitrumOne
```

### Step 6 — Exchange switch delay (optional)

Skip if the default **24h** is acceptable. To use **48h** for **future** adapter proposals:

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> DELAY_SECONDS=172800 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumOne
```

### Step 7 — Register and activate HL (ETH)

First deploy: register then activate — no `confirmPerpExchange`.

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
HYPERLIQUID_ADDRESS=<HL_ADAPTER_ADDRESS_ETH> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumOne
```

**Later**, if you propose a **new** adapter: wait for `exchangeSwitchDelay`, then `confirmPerpExchange.js`, then `setActivePerpExchange.js` as needed.

### Step 8 — Whitelist Uniswap adapter and set spot DEX (ETH)

The deployed **UniswapV3Adapter** must be whitelisted before `setSpotDex`:

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
ROUTER_ADDRESS=<UNISWAP_ADAPTER_ADDRESS from step 2> \
npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS from step 2> \
npx hardhat run scripts/setSpotDex.js --network arbitrumOne
```

If the script reports a spot-DEX timelock, wait and run `confirmSpotDex.js` as printed.

### Step 9 — Set cycle duration (ETH)

```bash
CYCLE_SECONDS=86400 PRODUCT=eth KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumOne
```

### Step 10 — Verify on Arbiscan

```bash
npx hardhat verify --network arbitrumOne <KASH_YIELD_ETH_ADDRESS> <BOT_ADDRESS> \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831

npx hardhat verify --network arbitrumOne <UNISWAP_ADAPTER_ADDRESS> \
  0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
  0x82aF49447D8a07e3bd95BD0d56f35241523fBab1

npx hardhat verify --network arbitrumOne <HL_ADAPTER_ADDRESS_ETH> \
  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  "0x0000000000000000000000000000000000000000" true \
  <KASH_YIELD_ETH_ADDRESS>
```

### Step 11 — Post-deployment verification (ETH)

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
```

### ETH deployment — summary checklist

- [ ] UniswapV3Adapter deployed; `UNISWAP_ADAPTER_ADDRESS` saved
- [ ] KashYieldETH deployed; `KASH_YIELD_ETH_ADDRESS` / `KASH_TOKEN_ETH` saved
- [ ] HyperliquidAdapter (ETH) deployed; `HL_ADAPTER_ADDRESS_ETH` saved; **Hyperliquid custody mode** set per Step 4a (**`directDepositMode`** / HL agent alignment)
- [ ] `setEthOracle.js` run (recommended)
- [ ] _(Optional)_ `setExchangeSwitchDelay.js` for 48h future proposals
- [ ] `setHyperliquid.js` + `setActivePerpExchange.js` — HL active
- [ ] `setAllowedSpotDexRouter.js` + `setSpotDex.js` — spot DEX live (confirm timelock if applicable)
- [ ] `setCycleDuration.js` for ETH
- [ ] Contracts verified; `diagnose-eth.js` clean
- [ ] `bot/.env` and `frontend/.env.local` updated

---

## Deployment — BTC product (`KashYieldBtc.sol`)

Deploy the BTC vault **after** the ETH flow above is complete so you can reuse the same **UniswapV3Adapter** (`UNISWAP_ADAPTER_ADDRESS`) for spot swaps on **KashYieldBtc**. The Aave pool and tokens are the same canonical Arbitrum One addresses.

> **Do not** pass `SPOT_DEX_ADDRESS` / `MOCK_SPOT_DEX_ADDRESS` into `deploy-kashyieldbtc.js` on first deploy unless you have already whitelisted that adapter on the new vault (you cannot whitelist before the vault exists). Prefer: deploy BTC vault, then whitelist + `setSpotDex` as in Step B7.

### Step B1 — Deploy KashYieldBtc

[`scripts/deploy-kashyieldbtc.js`](../scripts/deploy-kashyieldbtc.js) deploys `KashYieldBtc` and `KashTokenBtc`, and calls **`setBtcOracle`** with `BTC_ORACLE_ADDRESS` (Chainlink BTC/USD).

```bash
BOT_ADDRESS=<your_bot_wallet> \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
BTC_ORACLE_ADDRESS=0x6ce185860a4963106506C203335A2910413708e9 \
npx hardhat run scripts/deploy-kashyieldbtc.js --network arbitrumOne
```

Save to root `.env`, `bot/.env`, and `frontend/.env.local`:

```env
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from output>
KASH_TOKEN_BTC=<KashTokenBtc from output>
```

```env
# frontend/.env.local
NEXT_PUBLIC_KASH_YIELD_BTC_ADDRESS=<KashYieldBtc from output>
NEXT_PUBLIC_KASH_TOKEN_BTC=<KashTokenBtc from output>
```

### Step B2 — Deploy HyperliquidAdapter (BTC)

Use **`IS_ETH_ASSET=false`** (recommended if root `.env` also sets `KASH_YIELD_ETH_ADDRESS` — the deploy script picks the vault from the product flag) and supply **`WBTC_ADDRESS`**. `KASH_YIELD_BTC_ADDRESS` identifies the vault.

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
WBTC_ADDRESS=0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
IS_ETH_ASSET=false \
KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC_ADDRESS from step B1> \
HL_ADAPTER_OPERATOR_ADDRESS=<BOT_WALLET from bot/.env> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save:

```env
HL_ADAPTER_ADDRESS_BTC=<HyperliquidAdapter from output>
```

### Step B3 — Hyperliquid adapter custody mode (BTC adapter)

Same as **Step 4a**: owner key, **`directDepositMode = false`**, then **Hyperliquid adapter setup (production)** for **`HL_ADAPTER_ADDRESS_BTC`**.

```bash
npx hardhat console --network arbitrumOne
```

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_BTC>", signer)
const tx = await adapter.setDirectDepositMode(false, "0x0000000000000000000000000000000000000000")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "0xf055D8c8496f3B18807A74701E64d7a4cBEce016", signer)
const tx = await adapter.setDirectDepositMode(false, "0x0000000000000000000000000000000000000000")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())



Confirm **`operator`** is the bot (see deploy `HL_ADAPTER_OPERATOR_ADDRESS` or `setOperator`).

**How to confirm success** — same receipt checks as Step 4a:

- **`receipt.status === 1`** — transaction succeeded (in Hardhat/ethers v6 this appears as `status: 1n` or `1` on the receipt object). **`status: 0`** means the call reverted.
- **`receipt.contractAddress === null`** — normal for this step: you are calling an existing adapter, not deploying a new contract.
- **`receipt.to`** — must match your **`HL_ADAPTER_ADDRESS_BTC`** (the adapter you configured).
- **On-chain check:** paste **`receipt.hash`** into Arbiscan; the UI should show **Success**.
- **Readback:** `directDepositMode` is **`false`**; `hlAccount` is zero / unused for deposits.

<details>
<summary>Reference only — Option B (`directDepositMode = true`, not for this deployment)</summary>

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_BTC>", signer)
const tx = await adapter.setDirectDepositMode(true, "<BOT_EOA_ADDRESS>")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

</details>

### Step B4 — BTC oracle

Already applied in **Step B1** via `setBtcOracle`. Re-run only if you need to change the feed later (owner script / contract method per your process).

### Step B5 — Exchange switch delay (optional)

```bash
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> DELAY_SECONDS=172800 \
npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumOne
```

(Omit or use defaults if 24h is enough.)

### Step B6 — Register and activate HL (BTC)

If root `.env` already has a **valid** `KASH_YIELD_ETH_ADDRESS`, add **`PRODUCT=btc`** so the script targets the BTC vault (same rule as other `scripts/*.js` that support both products).

```bash
PRODUCT=btc \
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
HYPERLIQUID_ADDRESS=<HL_ADAPTER_ADDRESS_BTC> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumOne

PRODUCT=btc \
KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> EXCHANGE_NAME=HL \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumOne
```

### Step B7 — Whitelist Uniswap adapter and set spot DEX (BTC)

Reuse **`UNISWAP_ADAPTER_ADDRESS`** from the ETH deployment (same router-backed adapter handles wBTC/USDC routing in the adapter implementation).

```bash
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
ROUTER_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setAllowedSpotDexRouter.js --network arbitrumOne

PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
SPOT_DEX_ADDRESS=<UNISWAP_ADAPTER_ADDRESS> \
npx hardhat run scripts/setSpotDex.js --network arbitrumOne
```

Confirm any spot-DEX timelock with `confirmSpotDex.js` if the script instructs you to.

### Step B8 — Set cycle duration (BTC)

```bash
CYCLE_SECONDS=86400 PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KashYieldBtc> \
npx hardhat run scripts/setCycleDuration.js --network arbitrumOne
```

### Step B9 — Verify on Arbiscan (BTC)

Constructor args for `KashYieldBtc` are **`(botAddress, wbtc, usdc)`**:

```bash
npx hardhat verify --network arbitrumOne <KASH_YIELD_BTC_ADDRESS> <BOT_ADDRESS> \
  0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831

npx hardhat verify --network arbitrumOne <HL_ADAPTER_ADDRESS_BTC> \
  0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
  0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f false \
  <KASH_YIELD_BTC_ADDRESS>
```

### BTC deployment — summary checklist

- [ ] `deploy-kashyieldbtc.js` — `KASH_YIELD_BTC_ADDRESS`, `KASH_TOKEN_BTC`, Chainlink BTC oracle wired
- [ ] HyperliquidAdapter (BTC) deployed; `HL_ADAPTER_ADDRESS_BTC` saved; **Hyperliquid custody mode** set per Step B3 (**`directDepositMode`** / HL agent alignment)
- [ ] _(Optional)_ `setExchangeSwitchDelay.js` on BTC vault
- [ ] `setHyperliquid.js` + `setActivePerpExchange.js` — HL active for BTC
- [ ] `setAllowedSpotDexRouter.js` + `setSpotDex.js` with `PRODUCT=btc` — same UniswapV3Adapter as ETH
- [ ] `setCycleDuration.js` with `PRODUCT=btc`
- [ ] Contracts verified; bot/frontend envs updated for **PRODUCT=btc** when operating BTC

---

## Adding a second perp exchange (GMX, Aster, etc.)

Use **`arbitrumOne`**. Example for ETH vault (use `KASH_YIELD_BTC_ADDRESS` and `PRODUCT=btc` patterns for BTC):

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
GMX_ADAPTER_ADDRESS=<adapter> \
npx hardhat run scripts/setHyperliquid.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
npx hardhat run scripts/confirmPerpExchange.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<KashYieldETH> EXCHANGE_NAME=GMX \
npx hardhat run scripts/setActivePerpExchange.js --network arbitrumOne
```

With non-zero `exchangeSwitchDelay`, wait for the timelock between proposal and confirmation.

---

## Diagnosing stuck batches (ETH)

```bash
KASH_YIELD_ETH_ADDRESS=<KashYieldETH> \
npx hardhat run scripts/diagnose-eth.js --network arbitrumOne
```

---

## Useful scripts (Arbitrum One)

```bash
KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/diagnose-eth.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<addr> DELAY_SECONDS=86400 \
  npx hardhat run scripts/setExchangeSwitchDelay.js --network arbitrumOne

KASH_YIELD_ETH_ADDRESS=<addr> npx hardhat run scripts/check-contract-config.js --network arbitrumOne

npx hardhat run scripts/checkBalance.js --network arbitrumOne
```

---

## Ops scripts on mainnet

Use **`--network arbitrumOne`**. Set **`PRODUCT=btc`** (in the shell or **`bot/.env`**) when targeting **`KashYieldBtc`** so scripts resolve **`KASH_YIELD_BTC_ADDRESS`** and wBTC decimals.

HL trading steps (`04`–`07`) use the **Hyperliquid API** on mainnet; deposit/withdraw and Aave steps remain on-chain on Arbitrum. **HL → Arbitrum USDC withdrawals must target the HyperliquidAdapter** (see **Hyperliquid USDC withdrawals and custody** above); script `08-withdraw-usdc-from-perp.js` only forwards USDC that has **already** landed on the adapter. See `bot/scripts/ops/README.md` for per-script usage.

---

## Network reference

| Network | Chain ID | RPC | Explorer |
|---------|----------|-----|----------|
| Arbitrum One | 42161 | `https://arb1.arbitrum.io/rpc` | https://arbiscan.io |

---

## Security

- Never commit `.env` or private keys.
- **Owner** (root `.env`) and **bot** (`bot/.env`) are different wallets with different key material.
- Owner holds governance/config; bot holds only enough ETH for gas and never owns the vault `owner()` role.
- Audit contracts before significant TVL.
- Keep `exchangeSwitchDelay` non-zero on mainnet unless you explicitly accept operational risk on future adapter changes.
- **`directDepositMode = false`** on mainnet so user NAV USDC is not routed to the bot EOA via HL defaults.

---

## Post-deploy operational notes

Items called out elsewhere in this guide but easy to miss during cutover:

### Hyperliquid `approveAgent` (per adapter)

Step **Hyperliquid adapter setup (production)** describes **`directDepositMode = false`** and **`setOperator`**, but **HL agent approval is not a single Hardhat tx**. For each **HyperliquidAdapter** (ETH and BTC), the **bot EOA** must be authorised to sign API actions (`order`, `withdraw3`, etc.) on the HL account tied to the **adapter contract address**. Use your Hyperliquid runbook or REST **`/exchange`** **`approveAgent`** flow. Until that is done, `npm start` may record on-chain intent without real HL fills.

External reference: [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/).

### Wrong `botAddress` after deploy

Deploy scripts set **`botAddress`** from **`BOT_ADDRESS`**. If you omitted it or used the wrong address, fix with the **owner** key (root `.env`):

```bash
# ETH vault
KASH_YIELD_ETH_ADDRESS=<KASH_YIELD_ETH> BOT_ADDRESS=<bot_wallet> \
  npx hardhat run scripts/setBotAddress.js --network arbitrumOne

# BTC vault
PRODUCT=btc KASH_YIELD_BTC_ADDRESS=<KASH_YIELD_BTC> BOT_ADDRESS=<bot_wallet> \
  npx hardhat run scripts/setBotAddress.js --network arbitrumOne
```

Verify on-chain: `owner() ≠ botAddress()` and `botAddress()` matches **`bot/.env`** `PRIVATE_KEY`.

### `rescueERC20` and USDC on the vault

**`rescueERC20`** lets the **owner** transfer arbitrary ERC-20 balances held by the vault. **wBTC and ETH (deposit assets) are blocked**; **USDC is not**. That means owner can pull **all on-vault USDC**, including float that backs user NAV — not only **`ownerUsdcReserve`**. Use only for mis-sent tokens, wind-down, or other cases you accept the risk for.

- Policy and trust model: [SECURITY.md](SECURITY.md)
- Ops script (owner key, repo root): `bot/scripts/ops/15-rescue-usdc-from-contract.js`

```bash
PRODUCT=btc npx hardhat run bot/scripts/ops/15-rescue-usdc-from-contract.js --network arbitrumOne
# Optional: AMOUNT=8.5 RESCUE_TO=0x...
```

Prefer **`markOwnerUsdcDeposit`** / **`coverUsdcShortfall`** / batch ops for normal treasury and working-float USDC.
