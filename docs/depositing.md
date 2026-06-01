# Depositing

Depositing into KASH gives you KASH tokens that earn yield over time.

---

## Before you deposit

- Ensure your wallet is connected to the app on **Arbitrum One** (chain ID 42161)
- You have ETH (for KASH-ETH) or wBTC (for KASH-BTC) in your wallet
- You have a small amount of ETH for gas fees

---

## How deposits work

KASH uses a **batch system**. Deposits are not processed instantly. Instead:

1. You submit a deposit request — this queues your funds for the next batch
2. Once per day, the batch is processed (around **23:45 UTC**)
3. After processing completes, KASH tokens are sent to your wallet automatically — no claim step needed

This means there is a **waiting period** between when you submit your deposit and when you receive your KASH tokens. The wait is at most 24 hours.
**Minimum Deposit** the minimum deposit size is 10 USDC worth of ETH or wBTC.

---

## Step-by-step: deposit ETH

1. Open the app and make sure the **ETH** tab is selected
2. Enter the amount of ETH you want to deposit in the **Deposit** form
3. Click **Deposit ETH**
4. Confirm the transaction in your wallet
5. Wait for the daily batch to process (by 23:59 UTC)
6. Click the "Add to wallet" link in the "Your KASH Balance" box to see the KASH-ETH tokens in your wallet.
7. You may choose to cancel the mint request at any time prior to the batch process run time and your Eth will be returned to your wallet.

---

## Step-by-step: deposit wBTC

1. Open the app and select the **BTC** tab
2. Enter the amount of wBTC you want to deposit
3. If this is your first time, you will first be asked to **Approve** the contract to spend your wBTC — confirm this transaction
4. Click **Deposit wBTC** and confirm the deposit transaction
5. Wait for the daily batch
6. Click the "Add to wallet" link in the "Your KASH Balance" box to see the KASH-BTC tokens in your wallet.
7. You may choose to cancel the mint request at any time prior to the batch process run time and your wBTC will be returned to your wallet.

---

## What happens to my funds during the batch?

Your deposited ETH or wBTC is held in the smart contract until the batch runs. The protocol deploys the Eth or wBTC it has received in a yield strategy, then KASH tokens are minted at the latest NAV and sent to your wallet.

---

## Fees

There is a **0.05% fee (5 basis points)** on deposits and redemptions. This is deducted from the amount processed in each batch.

---

## Checking your position

After your KASH tokens arrive, you can see:
- Your **KASH balance** in the stats panel
- The current **NAV** — the USD value of each KASH token
- Your total deposits in the **Deposits** card

---

## Minimum holding period

The minimum time you can hold KASH is **one day** — you can deposit in one batch and redeem in the next.

However, depositing for just one day is likely to result in a small **net loss**. Each time the protocol puts on or takes off its yield strategy (opening and closing positions across the lending and trading protocols), it incurs transaction fees. Over a single day, those costs will typically outweigh any funding rate income earned.

KASH is designed for **medium to long-term holding**. The longer you hold, the more yield accrues relative to the one-time cost of entering and exiting the strategy.

---

## Next step

When you're ready to exit, see [Redeeming](redeeming.md).
