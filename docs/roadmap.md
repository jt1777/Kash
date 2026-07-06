# Roadmap

KASH is rolled out in phases. Each phase adds **Plays** to the off-chain **Playbook** (capital deployment, hedging, batch settlement). User-facing deposit and redeem flows stay **batch-based** throughout.

On the **`aster` branch**, **Phase 1** targets **V3 ownerless vaults** with **Aster** on Arbitrum. The legacy **`main`** branch deployment uses **Hyperliquid** and owner-gated V2 contracts — a separate operational track.

---

## Phase 1 — Positive funding (V3 Aster)

**Status:** V3 contracts + Aster integration on **`aster` branch**; production deploy pending operator sign-off.

**The Play (delta-neutral short on Aster):**

1. User deposits **ETH/wETH** or **wBTC** during the user window
2. At batch time, the bot supplies collateral to **Aave**, borrows **USDC**, deposits margin to **Aster**, and opens/maintains a **short** sized to hedge collateral
3. Yield accrues from **positive funding** on the short plus Aave supply interest
4. NAV is updated twice per batch (pre-ops + settlement); KASH is minted/redeemed via **Merkle pull claims** in Phase 2

**On-chain (V3):**

- Ownerless vaults — immutable bot, facade, Aster adapter, fees, timing
- Batch overlap guard — no Phase 1 for cycle N+1 while cycle N is still in Phase 1

**Automation:** Deterministic bot (+ optional Chainlink keeper) runs the Playbook. Monitoring and funding analytics continue to evolve.

**Scope:** KASH-ETH and KASH-BTC vaults, fixed strategy parameters at deploy, single positive-funding Play.

---

## Phase 2 — Negative funding Play + AI agent discretion

**Status:** Planned.

Same **V3** contracts; off-chain Playbook gains a **negative funding** Play and an **AI agent** orchestrator that selects Plays within guardrails (funding sign, batch net flow, portfolio health).

---

## Phase 3 — Stablecoin vault, multi-asset, cross-exchange arb

**Status:** Future.

New vault product (stablecoin deposits), broader asset universe, third Play for **cross-exchange funding arbitrage**, agent-first operations.

---

## Summary

| Phase | Contracts | Perp DEX | Deposits | Batch operator |
|-------|-----------|----------|----------|----------------|
| **1** (aster branch) | V3 ownerless KashYield | **Aster** (Arbitrum) | ETH, wETH, wBTC | Automated bot |
| **1** (main branch legacy) | V2 owner-gated KashYield | **Hyperliquid** | ETH, wBTC | Automated bot |
| **2** | V3 (same) | Aster | ETH, wBTC | AI Agent chooses Play |
| **3** | New stablecoin vault + existing | Multi-venue | Stablecoins | AI Agent |

See [How Yield Works](how-yield-works.md), [Risks & Safeguards](risks.md), and [Agent Quickstart](agent-quickstart.md).
