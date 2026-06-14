// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title IPerpExchange
 * @notice Shared interface for perpetual exchange adapters (e.g. HyperliquidAdapter).
 *
 * Each adapter is a standalone contract that translates these standardised calls into the
 * underlying exchange's native API.  The main KashYield contracts hold an exchange registry
 * (mapping(string => address) perpExchanges) and route all calls through this interface,
 * making them completely exchange-agnostic.
 *
 * Adding a new exchange in the future requires only:
 *   1. Deploying a new adapter that implements this interface.
 *   2. Calling setPerpExchange("NAME", adapterAddress) on the main contract.
 *   3. (After the adapter-registration timelock) Calling confirmPerpExchange().
 *   No changes to the main contracts are needed.
 *
 * The adapter IS the on-exchange account: all positions and balances are tracked against
 * the adapter's own address on the underlying exchange.
 */
interface IPerpExchange {

    // ── Capital movement ──────────────────────────────────────────────────

    /// @notice Deposit stable collateral (USDC) into the exchange spot wallet.
    /// Caller must approve this adapter for `amount` of `token` beforehand.
    function depositCollateral(address token, uint256 amount) external;

    /// @notice Withdraw stable collateral (USDC) from the exchange spot wallet to msg.sender.
    /// @return amountTransferred USDC actually transferred (may be less than `amount` if the adapter caps to balance).
    function withdrawCollateral(address token, uint256 amount) external returns (uint256 amountTransferred);

    // ── Spot trading ──────────────────────────────────────────────────────

    /// @notice Swap tokenIn for tokenOut on the exchange spot market.
    /// For ETH-in swaps msg.value must equal amountIn and tokenIn must be address(0).
    /// For ERC-20 inputs, caller must approve this adapter for `amountIn` beforehand.
    /// @return amountOut Amount of tokenOut received (0 if credited to internal ledger).
    function tradeSpot(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external payable returns (uint256 amountOut);

    /// @notice Withdraw the held asset (BTC or ETH) from the exchange back to msg.sender
    /// as a real token/ETH.  amount is in 18-dec internal units.
    /// For wBTC this is converted to 8-dec on transfer (amount / 1e10).
    function withdrawAsset(uint256 amount) external;

    // ── Perp positions ────────────────────────────────────────────────────

    function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external;
    function closePerpPosition(string calldata symbol) external;
    function closePerpPosition(string calldata symbol, uint256 closeSize) external;
    function cancelOrder(bytes32 orderId) external;

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice USDC balance held in the exchange spot wallet by this adapter (6-dec).
    function getSpotBalance() external view returns (uint256);

    /// @notice BTC or ETH balance held in the exchange spot wallet by this adapter
    /// (18-dec internal units, matching the mock ledger scale).
    function getAssetBalance() external view returns (uint256);

    /// @notice Active perp position for `symbol` held by this adapter.
    function getPosition(string calldata symbol) external view returns (
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        bool isLong,
        bool isActive
    );

    function getOpenOrderIds() external view returns (bytes32[] memory);
}
