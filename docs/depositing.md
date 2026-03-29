# Depositing

Depositing into KASH gives you KASH tokens that earn yield over time.

---

## Before you deposit

- Your wallet is connected to the app on **Arbitrum Sepolia**
- You have ETH (for KASH-ETH) or wBTC (for KASH-BTC) in your wallet
- You have a small amount of ETH for gas fees

---

## How deposits work

KASH uses a **batch system**. Deposits are not processed instantly. Instead:

1. You submit a deposit request — this queues your funds for the next batch
2. Once per day, the batch is processed (around **23:50 UTC**)
3. After processing completes, KASH tokens are sent to your wallet automatically — no claim step needed

This means there is a **waiting period** between when you submit your deposit and when you receive your KASH tokens. The wait is at most 24 hours.

---

## Step-by-step: deposit ETH

1. Open the app and make sure the **ETH** tab is selected
2. Enter the amount of ETH you want to deposit in the **Deposit** form
3. Click **Deposit ETH**
4. Confirm the transaction in your wallet
5. Wait for the daily batch to process (by 23:59 UTC)
6. KASH-ETH tokens will appear in your wallet automatically

---

## Step-by-step: deposit wBTC

1. Open the app and select the **BTC** tab
2. Enter the amount of wBTC you want to deposit
3. If this is your first time, you will first be asked to **Approve** the contract to spend your wBTC — confirm this transaction
4. Click **Deposit wBTC** and confirm the deposit transaction
5. Wait for the daily batch
6. KASH-BTC tokens will appear in your wallet automatically

---

## What happens to my funds during the batch?

Your deposited ETH or wBTC is held in the smart contract until the batch runs. After Phase 1 of the batch (valuation), the protocol deploys capital into its yield strategy. After Phase 2 (distribution), KASH tokens are minted at the current NAV and sent to your wallet.

---

## Fees

There is a **0.03% fee (3 basis points)** on deposits and redemptions. This is deducted from the amount processed in each batch.

---

## Checking your position

After your KASH tokens arrive, you can see:
- Your **KASH balance** in the stats panel
- The current **NAV** — the USD value of each KASH token
- Your total deposits in the **Deposits** card

---

## Next step

When you're ready to exit, see [Redeeming](redeeming.md).
