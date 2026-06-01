# Redeeming

Redeeming converts your KASH tokens back into ETH or wBTC, capturing any yield that has accrued since you deposited.

---

## How redemptions work

Like deposits, redemptions go through the **daily batch**:

1. You submit a redemption request, specifying how many KASH tokens to redeem
2. Your KASH tokens are locked in the contract until the batch runs
3. At the next batch (around **23:59 UTC**), your KASH is burned and your assets are sent back to your wallet automatically

There is no separate claim step — your ETH or wBTC arrives in your wallet after the batch completes.

---

## Your yield on exit

When you redeem, you receive assets based on the **current NAV** at the time of the batch. Because NAV increases as the protocol earns yield, you receive more value than you originally deposited.

**Example:**
- You deposited 1 ETH when KASH-ETH NAV = $1.00 → received 1,800 KASH
- You redeem when KASH-ETH NAV = $1.06 → you receive 1,800 × $1.06 / ETH price worth of ETH

Your yield is the difference in NAV between entry and exit.

---

## Step-by-step: redeem

1. Open the app and select the correct tab (ETH or BTC)
2. In the **Redeem** form, enter the amount of KASH tokens you want to redeem
3. If prompted, **Approve** the contract to spend your KASH tokens
4. Click **Redeem** and confirm the transaction
5. Wait for the daily batch (by 23:59 UTC)
6. Your ETH or wBTC will arrive in your wallet automatically

---

## Partial redemptions

You can redeem any portion of your KASH balance. You don't have to exit your entire position at once.

---

## Timing

Redemption requests submitted **after the batch starts** (~23:45 UTC) will be queued for the **following day's batch**. Submit your request before 23:45 UTC to have it included in the current day's batch.

---

## Fees

The same **0.05% fee (5 basis points)** applies to redemptions. This is deducted during batch processing.

---

## Can I cancel a redemption request?

Yes — you can cancel a pending redemption request as long as the batch for that day **has not yet been processed**. Your KASH tokens are returned to your wallet immediately on cancellation.

To cancel, click the **Cancel Redeem Request** button in the app (visible when you have a pending request), or find the pending transaction in the Recent Activity panel and click **Cancel redeem**.

Once the daily batch has run (~23:59 UTC), the request can no longer be cancelled.
