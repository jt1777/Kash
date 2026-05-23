# Roadmap

KASH is being rolled out in three phases. Each phase adds new **Plays** to the ops **Playbook** — the off-chain logic that deploys capital, manages hedges, and settles daily batches. User-facing deposit and redeem flows stay batch-based throughout; what changes is how much strategy flexibility the operator has.

---

## Phase 1 — Positive funding (live testing now)

**Status:** Deployed on Arbitrum One (KASH-ETH and KASH-BTC).

Phase 1 implements a single Play designed for **positive funding rates** — the common case in bull markets where longs pay shorts on perpetuals exchanges.

**The Play (delta-neutral short):**

1. User deposits **ETH** or **wBTC** into the vault during the daily user window
2. At batch time, the bot deposits collateral to **Aave**, borrows **USDC**, posts margin on **Hyperliquid**, and opens a **short** perp position sized to hedge the collateral
3. Yield accrues primarily from **positive funding** on the short, plus lending interest on collateral
4. NAV is updated once per day; KASH tokens are minted or redeemed in Phase 2 of the batch

**Automation:** Batch processing is **fully automated** — a deterministic bot runs the Playbook end-to-end, with no manual ops required for routine mints and redemptions. An AI agent is deployed to monitor and assess performance and funding rate dynamics.

**Scope:** Two vault products (ETH and BTC), fixed strategy parameters, and a single Play. The on-chain **KashYield** contracts define deposits, batch phases, NAV, and protocol integrations.

---

## Phase 2 — Negative funding Play + AI agent discretion

**Status:** Planned.

Phase 2 keeps the **same core smart contracts** as Phase 1. Deposits, redemptions, batch phases, and NAV mechanics on-chain do not change. What changes is the **batch process off-chain**.

**New Play — negative funding:** A second Play optimized for **negative funding rates**, when shorts pay longs. Instead of relying on a short-only delta-neutral posture, this Play adjusts how collateral, borrow, and perp exposure are managed so the protocol can still earn when funding flips.

**AI agent management:** An **AI Agent** replaces the fixed, rule-based bot as the batch orchestrator. Each day the agent is given discretion to:

- Manage contract/user assets by running either the **positive funding Play** (Phase 1 strategy) or thhe **negative funding Play** (new strategy).
- Choose timing and sizing within guardrails defined by the Playbook and contract constraints

The agent reads market signals (funding rates, portfolio state, batch net mint/redeem) and selects the appropriate Play — human operators no longer pick the strategy by hand for each batch.  By this phase, the agent ideally will have built up enough skill and experience to manage contract assets.

---

## Phase 3 — Stablecoin vault, multi-asset universe, cross-exchange arb

**Status:** Future.

Phase 3 introduces a **new vault contract** alongside the existing KashYield products. This vault accepts **stablecoin deposits only** (e.g. USDC), lowering friction for users who do not want to deposit ETH or wBTC directly.

**Broader investible universe:** Capital is no longer limited to ETH/wBTC. The Playbook can allocate across a wider set of assets and venues subject to risk limits configured for the new product.

**Third Play — cross-exchange funding arbitrage:** A new Play captures yield by **arbitrating funding rates between exchanges** — e.g. earning the spread when the same asset funds differently on two perp DEX's. This Play is structurally distinct from the delta-neutral short Plays in Phases 1 and 2.

**AI agent–first operation:** Phase 3 relies **heavily on AI Agent management and discretion**. Multi-protocol routing, asset selection, and Play switching are too dynamic for a fixed script; the agent orchestrates the expanded Playbook within on-chain and off-chain guardrails.

---

## Summary

| Phase | Contracts | Deposits | Plays | Batch operator |
|-------|-----------|----------|-------|----------------|
| **1** (now) | KashYield (ETH / BTC) | ETH, wBTC | Positive funding (delta-neutral short) | Automated bot |
| **2** | Same as Phase 1 | ETH, wBTC | + Negative funding | AI Agent chooses Play |
| **3** | New stablecoin vault + existing | Stablecoins | + Cross-exchange funding arb | AI Agent (primary) |

For current behavior, risks, and how yield is generated today, see [How Yield Works](how-yield-works.md) and [Risks & Safeguards](risks.md). For programmatic access to the live vaults, see [Agent Quickstart](agent-quickstart.md).
