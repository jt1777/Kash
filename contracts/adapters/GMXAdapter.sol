// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPerpExchange.sol";

// ─── GMX V2 interfaces ────────────────────────────────────────────────────────

interface IGMXExchangeRouter {
    struct CreateOrderParams {
        CreateOrderParamsAddresses addresses;
        CreateOrderParamsNumbers numbers;
        OrderType orderType;
        DecreasePositionSwapType decreasePositionSwapType;
        bool isLong;
        bool shouldUnwrapNativeToken;
        bytes32 referralCode;
    }
    struct CreateOrderParamsAddresses {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialCollateralToken;
        address[] swapPath;
    }
    struct CreateOrderParamsNumbers {
        uint256 sizeDeltaUsd;
        uint256 initialCollateralDeltaAmount;
        uint256 triggerPrice;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 callbackGasLimit;
        uint256 minOutputAmount;
    }
    enum OrderType { MarketSwap, LimitSwap, MarketIncrease, LimitIncrease, MarketDecrease, LimitDecrease, StopLossDecrease, Liquidation }
    enum DecreasePositionSwapType { NoSwap, SwapPnlTokenToCollateralToken, SwapCollateralTokenToPnlToken }

    function createOrder(CreateOrderParams calldata params) external payable returns (bytes32 key);
    function cancelOrder(bytes32 key) external;
    function sendTokens(address token, address receiver, uint256 amount) external;
}

interface IGMXReader {
    function getPositions(
        address dataStore,
        address account,
        address[] memory markets,
        address[] memory collateralTokens,
        bool[] memory isLong
    ) external view returns (Position[] memory);

    struct Position {
        PositionProps props;
    }
    struct PositionProps {
        PositionAddresses addresses;
        PositionNumbers numbers;
        PositionFlags flags;
    }
    struct PositionAddresses {
        address account;
        address market;
        address collateralToken;
    }
    struct PositionNumbers {
        uint256 sizeInUsd;
        uint256 sizeInTokens;
        uint256 collateralAmount;
        uint256 borrowingFactor;
        uint256 fundingFeeAmountPerSize;
        uint256 longTokenClaimableFundingAmountPerSize;
        uint256 shortTokenClaimableFundingAmountPerSize;
        uint256 increasedAtBlock;
        uint256 decreasedAtBlock;
    }
    struct PositionFlags {
        bool isLong;
    }
}

/**
 * @title GMXAdapter
 * @notice IPerpExchange adapter for GMX V2 (Arbitrum).
 *
 * GMX V2 uses an asynchronous order model: orders are submitted via ExchangeRouter,
 * fulfilled by a price keeper in a subsequent transaction, then a callback fires.
 * This means openPerpPosition / closePerpPosition submit orders and return immediately.
 * The bot must wait for keeper fulfillment before reading the updated position.
 *
 * SPOT TRADING: GMX does not have a native spot trading interface like Hyperliquid.
 * tradeSpot and withdrawAsset are no-ops here — use the Uniswap adapter (ISpotDex)
 * for wBTC/ETH ↔ USDC conversions.
 *
 * TESTNET: Deploy with mock addresses or use MockPerpExchange instead.
 * MAINNET: Requires GMX V2 ExchangeRouter + Reader + Datastore addresses on Arbitrum.
 *          Market addresses and collateral token addresses vary per trading pair.
 */
contract GMXAdapter is IPerpExchange {
    using SafeERC20 for IERC20;

    address public immutable exchangeRouter;
    address public immutable orderVault;
    address public immutable reader;
    address public immutable dataStore;
    address public immutable usdcAddress;
    address public immutable marketAddress;   // GMX market for BTC or ETH perps
    address public immutable collateralToken; // USDC or wBTC depending on margin mode

    address public owner;
    address public pendingOwner;

    /// @notice Execution fee forwarded to the GMX keeper (owner-configurable).
    uint256 public executionFee = 0.0005 ether;

    /// @notice Tracks the last order key submitted — for cancellation.
    bytes32 public lastOrderKey;

    event AdapterCall(string action, uint256 amount);
    event OrderSubmitted(bytes32 indexed key, string action);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(
        address _exchangeRouter,
        address _orderVault,
        address _reader,
        address _dataStore,
        address _usdcAddress,
        address _marketAddress,
        address _collateralToken
    ) {
        exchangeRouter = _exchangeRouter;
        orderVault     = _orderVault;
        reader         = _reader;
        dataStore      = _dataStore;
        usdcAddress    = _usdcAddress;
        marketAddress  = _marketAddress;
        collateralToken = _collateralToken;
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        owner = pendingOwner;
        pendingOwner = address(0);
    }
    function setExecutionFee(uint256 fee) external onlyOwner {
        executionFee = fee;
    }

    // ── Capital movement ──────────────────────────────────────────────────
    // For GMX, collateral is sent to the OrderVault alongside createOrder.
    // depositCollateral stores USDC in this adapter; it is sent to OrderVault
    // at openPerpPosition time.

    function depositCollateral(address token, uint256 amount) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit AdapterCall("depositCollateral", amount);
    }

    function withdrawCollateral(address token, uint256 amount) external override {
        IERC20(token).safeTransfer(msg.sender, amount);
        emit AdapterCall("withdrawCollateral", amount);
    }

    // ── Spot trading (not supported on GMX — use ISpotDex / UniswapV3Adapter) ──

    function tradeSpot(address, address, uint256) external payable override returns (uint256) {
        revert("GMXAdapter: use ISpotDex for spot swaps");
    }

    function withdrawAsset(uint256) external pure override {
        revert("GMXAdapter: use ISpotDex for asset withdrawals");
    }

    // ── Perp positions ────────────────────────────────────────────────────

    /// @notice Submits a GMX V2 market-increase order (async — keeper fulfills it).
    function openPerpPosition(string calldata /* symbol */, uint256 size, bool isLong) external override {
        uint256 collateralBalance = IERC20(collateralToken).balanceOf(address(this));
        require(collateralBalance > 0, "GMXAdapter: no collateral deposited");

        // Send collateral to OrderVault before createOrder
        IERC20(collateralToken).forceApprove(exchangeRouter, collateralBalance);
        IGMXExchangeRouter(exchangeRouter).sendTokens(collateralToken, orderVault, collateralBalance);

        IGMXExchangeRouter.CreateOrderParams memory params = IGMXExchangeRouter.CreateOrderParams({
            addresses: IGMXExchangeRouter.CreateOrderParamsAddresses({
                receiver: address(this),
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: marketAddress,
                initialCollateralToken: collateralToken,
                swapPath: new address[](0)
            }),
            numbers: IGMXExchangeRouter.CreateOrderParamsNumbers({
                sizeDeltaUsd: size,
                initialCollateralDeltaAmount: collateralBalance,
                triggerPrice: 0,
                acceptablePrice: isLong ? type(uint256).max : 0,
                executionFee: executionFee,
                callbackGasLimit: 0,
                minOutputAmount: 0
            }),
            orderType: IGMXExchangeRouter.OrderType.MarketIncrease,
            decreasePositionSwapType: IGMXExchangeRouter.DecreasePositionSwapType.NoSwap,
            isLong: isLong,
            shouldUnwrapNativeToken: false,
            referralCode: bytes32(0)
        });

        bytes32 key = IGMXExchangeRouter(exchangeRouter).createOrder{value: executionFee}(params);
        lastOrderKey = key;
        emit OrderSubmitted(key, "openPerpPosition");
    }

    /// @notice Submits a full GMX V2 market-decrease order (async).
    function closePerpPosition(string calldata symbol) external override {
        // Read current position size to close fully
        (uint256 size,,,, bool isActive) = this.getPosition(symbol);
        require(isActive, "GMXAdapter: no active position");
        _submitDecreaseOrder(size, isActive ? false : true);
    }

    /// @notice Submits a partial GMX V2 market-decrease order (async).
    function closePerpPosition(string calldata /* symbol */, uint256 closeSize) external override {
        _submitDecreaseOrder(closeSize, false);
    }

    function _submitDecreaseOrder(uint256 sizeDelta, bool isLong) internal {
        IGMXExchangeRouter.CreateOrderParams memory params = IGMXExchangeRouter.CreateOrderParams({
            addresses: IGMXExchangeRouter.CreateOrderParamsAddresses({
                receiver: address(this),
                callbackContract: address(0),
                uiFeeReceiver: address(0),
                market: marketAddress,
                initialCollateralToken: collateralToken,
                swapPath: new address[](0)
            }),
            numbers: IGMXExchangeRouter.CreateOrderParamsNumbers({
                sizeDeltaUsd: sizeDelta,
                initialCollateralDeltaAmount: 0,
                triggerPrice: 0,
                acceptablePrice: isLong ? 0 : type(uint256).max,
                executionFee: executionFee,
                callbackGasLimit: 0,
                minOutputAmount: 0
            }),
            orderType: IGMXExchangeRouter.OrderType.MarketDecrease,
            decreasePositionSwapType: IGMXExchangeRouter.DecreasePositionSwapType.NoSwap,
            isLong: isLong,
            shouldUnwrapNativeToken: false,
            referralCode: bytes32(0)
        });

        bytes32 key = IGMXExchangeRouter(exchangeRouter).createOrder{value: executionFee}(params);
        lastOrderKey = key;
        emit OrderSubmitted(key, "closePerpPosition");
    }

    function cancelOrder(bytes32 orderId) external override {
        IGMXExchangeRouter(exchangeRouter).cancelOrder(orderId);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function getSpotBalance() external view override returns (uint256) {
        return IERC20(usdcAddress).balanceOf(address(this));
    }

    /// @notice Not applicable for GMX (no internal asset ledger). Returns 0.
    function getAssetBalance() external pure override returns (uint256) {
        return 0;
    }

    /// @notice Read position from GMX Reader. symbol is ignored — market is set at construction.
    function getPosition(string calldata /* symbol */) external view override returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        address[] memory markets = new address[](1);
        address[] memory collaterals = new address[](1);
        bool[] memory longs = new bool[](1);
        markets[0] = marketAddress;
        collaterals[0] = collateralToken;
        longs[0] = false; // short position

        try IGMXReader(reader).getPositions(dataStore, address(this), markets, collaterals, longs) returns (
            IGMXReader.Position[] memory positions
        ) {
            if (positions.length > 0) {
                IGMXReader.PositionProps memory p = positions[0].props;
                size       = p.numbers.sizeInUsd;
                collateral = p.numbers.collateralAmount;
                entryPrice = size > 0 ? size / p.numbers.sizeInTokens : 0;
                isLong     = p.flags.isLong;
                isActive   = size > 0;
            }
        } catch {
            // Return zeros if read fails
        }
    }

    function getOpenOrderIds() external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    receive() external payable {}
}
