# Risks

KASH is an experimental protocol on testnet. Before using it with real funds on mainnet, you should understand the risks involved.

> **Important:** KASH has not been audited. Do not use with real funds until a full audit is completed.

---

## Smart contract risk

The protocol is governed entirely by smart contracts. If there is a bug in the code, funds could be lost or locked. Mitigations in place:

- All user-facing functions are protected against reentrancy attacks
- Ownership transfer requires two steps — the new owner must explicitly accept
- New exchange adapters require a 48-hour waiting period before they can be activated (preventing a compromised key from instantly routing funds to a malicious contract)
- An emergency pause function exists that can halt all user activity

**What you can do:** Review the contract addresses on Arbiscan and verify they match what is displayed in the app footer.

---

## Funding rate risk

Yield comes primarily from earning the funding rate on Hyperliquid short positions. Funding rates are not guaranteed and can go negative — meaning the protocol would **pay** funding instead of earning it. During extended bear markets or periods of low speculative activity, yield could be zero or briefly negative.

The protocol does not promise a fixed APY. Yield is variable and reflects current market conditions.

---

## Liquidation risk

The protocol borrows USDC from Aave against your deposited ETH or wBTC as collateral. If collateral value drops sharply relative to the borrowed amount, Aave could liquidate some of the collateral. The protocol manages its loan-to-value ratio conservatively (targeting around 65%), leaving a significant buffer before liquidation could occur.

---

## Exchange and counterparty risk

The yield strategy depends on Hyperliquid and Aave continuing to function correctly. Risks include:

- Exchange downtime or insolvency
- Aave smart contract vulnerabilities
- Regulatory actions affecting either platform

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are currently performed by a single operator. A compromised or unavailable operator key could delay batch processing or, in a worst case, mismanage capital.

**Planned improvements:** Multi-signature control and decentralised batch triggering via Chainlink Automation are on the roadmap.

---

## Oracle risk

The value of your deposit at batch time is calculated using Chainlink price feeds. If a price feed provides incorrect data, you could receive fewer KASH tokens than expected when depositing, or fewer assets when redeeming. Chainlink is the industry-standard oracle provider, but no price feed is entirely risk-free.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund at this stage. Do not deposit more than you are willing to lose.

---

## Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Smart contract bug | High | Audit planned; reentrancy guards; emergency pause |
| Negative funding rates | Medium | Conservative LTV; strategy designed for bull cycles |
| Aave liquidation | Medium | LTV capped at ~65%; daily monitoring |
| Exchange failure | Medium | Emergency withdrawal path exists |
| Operator key compromise | Medium | 48h timelock on adapter changes; two-step ownership |
| Oracle failure | Low | Chainlink with staleness checks |
