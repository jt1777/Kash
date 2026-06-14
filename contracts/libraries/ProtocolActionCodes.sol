// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @dev Numeric codes for `ProtocolInteraction` events (uint8).
 *      Off-chain: mirror in `bot/src/contracts/protocolActionCodes.ts` and `bot/scripts/ops/protocolActionCodes.cjs`.
 */
library ProtocolActionCodes {
    uint8 internal constant CANCEL_MINT = 1;
    uint8 internal constant CANCEL_REDEEM = 2;
    uint8 internal constant NET_MINT = 3;
    uint8 internal constant NET_REDEEM = 4;
    uint8 internal constant REDEEM_TRANSFER_FAILED = 5;
    uint8 internal constant AAVE_DEPOSIT = 6;
    uint8 internal constant AAVE_WITHDRAW = 7;
    uint8 internal constant AAVE_BORROW = 8;
    uint8 internal constant AAVE_REPAY = 9;
    uint8 internal constant AAVE_ADD_COLLATERAL = 10;
    uint8 internal constant EXCHANGE_DEPOSIT = 11;
    uint8 internal constant EXCHANGE_WITHDRAW = 12;
    uint8 internal constant EXCHANGE_WITHDRAW_ASSET = 13;
    uint8 internal constant EXCHANGE_ADD_COLLATERAL = 14;
    uint8 internal constant EXCHANGE_OPEN_SHORT = 15;
    uint8 internal constant EXCHANGE_CLOSE_SHORT = 16;
    uint8 internal constant EXCHANGE_SPOT_BUY = 17;
    uint8 internal constant EXCHANGE_SPOT_SELL = 18;
    uint8 internal constant EXCHANGE_CANCEL_ORDER = 19;
    uint8 internal constant DEX_SWAP_FOR_USDC = 20;
    uint8 internal constant DEX_SWAP_FROM_USDC = 21;
    uint8 internal constant MINT_ETH_DEPLOYED = 22;
    uint8 internal constant MINT_BTC_DEPLOYED = 23;
    uint8 internal constant OWNER_WITHDRAW_ETH = 24;
    uint8 internal constant OWNER_WITHDRAW_WBTC = 25;
    uint8 internal constant RESCUE_ERC20 = 26;
    uint8 internal constant OWNER_USDC_DEPOSIT = 27;
    uint8 internal constant OWNER_ETH_DEPOSIT = 28;
    uint8 internal constant OWNER_WBTC_DEPOSIT = 29;
    uint8 internal constant OWNER_USDC_COVER_SHORTFALL = 30;
}
