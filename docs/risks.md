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

Yield comes primarily from earning the funding rate on short positions held on the perp DEX. Funding rates are not guaranteed and can go negative — meaning the protocol would **pay** funding instead of earning it. During extended bear markets or periods of low speculative activity, yield could be zero or negative.

The protocol does not promise a fixed APY. Yield is variable and reflects current market conditions.

---

## Liquidation risk

The protocol borrows USDC from a lending protocol against your deposited ETH or wBTC as collateral. In isolation, a sharp drop in collateral value could cause the lending protocol to liquidate some of that collateral. However, this is not a significant risk in practice for two reasons:

1. **The positions offset each other.** The protocol holds a short ETH/BTC position on the perp DEX of equal size to the lending collateral. If the asset price falls, the lending collateral loses value — but the short position gains an equivalent amount. If the asset price rises, the short position loses value — but the collateral in the lending protocol gains. The two sides of the trade naturally hedge each other.

2. **The protocol actively manages collateral.** When needed, the protocol transfers gains from the perp DEX back to the lending protocol (or vice versa) to keep the loan-to-value ratio at a safe level (targeting around 65%). This active rebalancing prevents the lending position from approaching liquidation thresholds under normal market conditions.

---

## Exchange and counterparty risk

The yield strategy depends on the lending protocol and perp DEX continuing to function correctly. Risks include:

- Exchange downtime or insolvency
- Smart contract vulnerabilities in third-party protocols
- Regulatory actions affecting either platform

---

## Centralisation risk

Protocol operations — batch processing, capital deployment, and NAV updates — are currently performed by a single operator. A compromised or unavailable operator key could delay batch processing or, in a worst case, mismanage capital.

**Planned improvements:** Multi-signature control and decentralised batch triggering are on the roadmap.

---

## Oracle risk

The value of your deposit at batch time is calculated using on-chain price feeds. If a price feed provides incorrect data, you could receive fewer KASH tokens than expected when depositing, or fewer assets when redeeming. Industry-standard oracle providers are used, but no price feed is entirely risk-free.

---

## No insurance

Funds deposited in KASH are not insured. There is no protocol-level insurance fund at this stage. Do not deposit more than you are willing to lose.

---

## Summary

| Risk | Severity | Mitigation |
|------|----------|------------|
| Smart contract bug | High | Audit planned; reentrancy guards; emergency pause |
| Negative funding rates | Medium | Conservative LTV; strategy designed for bull cycles |
| Lending protocol liquidation | Medium | LTV capped at ~65%; positions naturally hedge; daily monitoring |
| Exchange failure | Medium | Emergency withdrawal path exists |
| Operator key compromise | Medium | 48h timelock on adapter changes; two-step ownership |
| Oracle failure | Low | Staleness checks on price feeds |
