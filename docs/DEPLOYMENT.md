# KashYield Deployment Guide (Arbitrum One)

This guide covers production deployment of **KashYieldETH** and **KashYieldBtc** (`contracts/KashYieldBtc.sol`) on **Arbitrum One**. All protocol dependencies are live mainnet contracts (Aave V3, Chainlink, Uniswap V3, Hyperliquid bridge).

---

## Prerequisites

1. **Node.js and npm** — use a Node version compatible with Hardhat (Hardhat may warn on Node 25+).
2. **Hardhat** — configured in this repo (`hardhat.config.js` includes the `arbitrumOne` network).
3. **dotenv** — `npm install dotenv` at repo root if needed; scripts load the **root** `.env`.

---

## Critical rules — read before deploying

1. **`WETH_ADDRESS` must be canonical WETH9** on Arbitrum (`0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`) — it must support `deposit()` / `withdraw()`.

2. **Use native USDC** (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`), not USDC.e (`0xff970a...`). Aave and Hyperliquid expect native USDC on Arbitrum.

3. **`AAVE_POOL_ADDRESS` in env is informational for scripts** — `KashYieldETH` / `KashYieldBtc` embed the Arbitrum One Aave V3 pool (`0x794a61358D6845594F94dc1DB02A252b5b4814aD`) in the implementation; deploy scripts do not override it.

4. **`exchangeSwitchDelay`** on a fresh vault defaults to **24 hours**. The **first** perp adapter registration is immediate; the delay applies when you **later** propose **another** adapter. On mainnet, do **not** set the delay to `0` unless you explicitly accept no timelock for future adapter changes.

5. **Owner / treasury reserves** (`ownerUsdcReserve`, asset-specific owner buffers). The products credit on-chain balances that are **not** part of user NAV: call `markOwnerUsdcDeposit` after the owner sends USDC; on **KashYieldETH** use payable `markOwnerEthDeposit()` for ETH buffers; on **KashYieldBtc** use `markOwnerWbtcDeposit` for WBTC. The bot may call `coverUsdcShortfall` to move reserved USDC into the working float. Batch phase 2 and `ownerWithdraw*` enforce these cushions. Ops and `snapshotOpsContext` use **adjusted** balances (raw minus reserves) as the deployable float.

6. **Contract size (EIP-170, 24576 bytes).** `hardhat.config.js` enables the Solidity optimizer (`runs: 1`), `viaIR: true`, and `metadata.bytecodeHash: "none"`. `ProtocolInteraction` uses **`uint8` action codes** (see `contracts/libraries/ProtocolActionCodes.sol`). After `npx hardhat compile`, confirm there is no “contract code size exceeds 24576 bytes” warning before deploy.

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
- Prefer **automated** withdrawals: bot `withdraw3` with `destination =` adapter (same pattern as `maybeInitiateHlOffchainWithdraw` in `bot/src/batch/opsPlaybooks.ts`). If you use the **HL web app**, open the destination field and **paste the adapter address**; do **not** assume the default “linked wallet” is correct.
- After USDC lands on Arbitrum, confirm **`USDC.balanceOf(adapter)`** (script `08-withdraw-usdc-from-perp.js` prints this) before expecting `08` to move meaningful balances.

**`directDepositMode` and why the bot EOA is risky**

- **`directDepositMode = true`:** Deposits forward USDC to `hlAccount` (typically the **bot EOA**); that EOA is also the **Hyperliquid master account** in the simpler setup. HL’s UI often defaults withdrawals to **that same EOA**, so **user NAV can bridge to the hot wallet** by mistake. Treat that as **mis-routed protocol custody**, not owner treasury—recover by forwarding USDC on Arbitrum **EOA → adapter**, then run ops `14` (optional) and `08` as usual. **Do not** call `markOwnerUsdcDeposit` for this unless you are intentionally recording **owner/treasury** reserves (see owner reserves section above).
- **`directDepositMode = false` (production recommended):** The HL L1 account should be the **adapter contract’s Arbitrum address**; deposits go to the bridge as **adapter-as-account**. Custody lines up with on-chain bookkeeping and avoids “HL account == bot wallet” confusion. **Requires HL agent (and related) setup** so the bot key can sign HL API actions for that account—see `contracts/adapters/HyperliquidAdapter.sol` (file header), `bot/README.md` (“Mainnet Hyperliquid Setup”), and `docs/` / ops runbooks before going live.

---

## Architecture: Uniswap V3 spot adapter

The `UniswapV3Adapter` implements `ISpotDex` and wraps `SwapRouter02`. Typical routing: **0.05%** pools for WETH/USDC and wBTC/USDC. Use sane `amountOutMinimum` / slippage on mainnet — never `0`.

---

## Environment setup

### Root `.env` (Arbitrum One)

```env
PRIVATE_KEY=your_hardware_wallet_deployer_key

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

### `bot/.env` (Arbitrum One)

```env
PRIVATE_KEY=your_bot_operator_key
HYPERLIQUID_API_PRIVATE_KEY=your_bot_operator_key
HYPERLIQUID_API_URL=https://api.hyperliquid.xyz

RPC_URL=https://arb1.g.alchemy.com/v2/YOUR_API_KEY

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

- [ ] Smart contract audit completed (or accepted risk documented).
- [ ] `exchangeSwitchDelay` is **not** `0` on mainnet unless you deliberately want no timelock for **future** adapter proposals (default **86400** = 24h; optional **172800** = 48h via `setExchangeSwitchDelay`).
- [ ] Deployer is hardware wallet or multisig; **bot** key is separate.
- [ ] Contracts verified on Arbiscan.

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

Pass the **Bridge2** address as **`MOCK_HL_ADDRESS`** (the deploy script name is historical; on mainnet this is the live bridge).

```bash
MOCK_HL_ADDRESS=0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7 \
USDC_ADDRESS=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
IS_ETH_ASSET=true \
KASH_YIELD_ADDRESS=<KASH_YIELD_ETH_ADDRESS from step 3> \
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save to root `.env`:

```env
HL_ADAPTER_ADDRESS_ETH=<HyperliquidAdapter from output>
```

### Step 4a — Hyperliquid adapter custody mode (`directDepositMode`)

Pick **one** pattern and complete the matching HL setup **before** relying on mainnet ops.

**Option A — Production-style (recommended): adapter as Hyperliquid account**

- Set **`directDepositMode = false`** so USDC deposits use the **bridge → adapter-as-HL-account** path and HL ledger identity aligns with the adapter contract.
- Complete **HL agent authorisation** (and any other HL prerequisites) so the bot can execute API trades and **`withdraw3` with `destination =`** the adapter. If this is incomplete, deposits/sync/withdraw flows will not match this guide’s expectations.
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

**Readback:** `directDepositMode` is **`false`**.

**Option B — Bootstrap / simplified: bot EOA as Hyperliquid account**

- Set **`directDepositMode = true`** and **`hlAccount =`** bot EOA. This avoids adapter signing/agent work early on but **increases operational risk**: the HL web app often defaults withdrawals to the **bot wallet**, not the adapter (see **Hyperliquid USDC withdrawals and custody** above).
- From repo root:

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

**How to confirm success (both options)**

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
npx hardhat run scripts/deploy-hyperliquid-adapter.js --network arbitrumOne
```

Save:

```env
HL_ADAPTER_ADDRESS_BTC=<HyperliquidAdapter from output>
```

### Step B3 — Hyperliquid adapter custody mode (BTC adapter)

Same **Option A / Option B** choice as **Step 4a**, but target **`HL_ADAPTER_ADDRESS_BTC`**.

**Option A — `directDepositMode = false`**

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

**Option B — `directDepositMode = true`, `hlAccount =` bot EOA**

```javascript
const [signer] = await ethers.getSigners()
const adapter = await ethers.getContractAt("HyperliquidAdapter", "<HL_ADAPTER_ADDRESS_BTC>", signer)
const tx = await adapter.setDirectDepositMode(true, "<BOT_EOA_ADDRESS>")
const receipt = await tx.wait()
console.log("directDepositMode =", await adapter.directDepositMode())
console.log("hlAccount =", await adapter.hlAccount())
```

**How to confirm success** — same receipt checks as Step 4a: **`receipt.status === 1`**, **`receipt.to`** equals **`HL_ADAPTER_ADDRESS_BTC`**, **`contractAddress`** stays **`null`**, Arbiscan shows **Success** for **`receipt.hash`**, and readback matches the option you chose (`false` vs `true` + `hlAccount`).

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
- Use a dedicated high-security deployer on mainnet; separate bot keys.
- Audit contracts before significant TVL.
- Keep `exchangeSwitchDelay` non-zero on mainnet unless you explicitly accept operational risk on future adapter changes.
