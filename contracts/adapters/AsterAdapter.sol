// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPerpExchange.sol";

// ─── Aster (formerly APX Finance) interfaces ─────────────────────────────────
// Aster uses a Clearing House + vAMM architecture.
// Mainnet Clearing House on Arbitrum: 0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5

interface IAsterClearingHouse {
    struct OpenPositionParams {
        address baseToken;          // e.g. virtual BTC token
        bool isBaseToQuote;         // true = short (sell base), false = long (buy base)
        bool isExactInput;          // whether amountIn is the exact input
        uint256 amount;             // position size in base token units
        uint256 oppositeAmountBound;// slippage bound
        uint256 deadline;
        uint160 sqrtPriceLimitX96;
        bytes32 referralCode;
    }

    function openPosition(OpenPositionParams calldata params) external returns (
        uint256 base, uint256 quote
    );

    function closePosition(
        address baseToken,
        uint160 sqrtPriceLimitX96,
        uint256 oppositeAmountBound,
        uint256 deadline,
        bytes32 referralCode
    ) external returns (uint256 base, uint256 quote);

    function getAccountValue(address trader) external view returns (int256 accountValue);
}

interface IAsterVault {
    function deposit(address token, uint256 amount) external;
    function withdraw(address token, uint256 amount) external;
    function getBalance(address trader) external view returns (int256 balance);
    function getFreeCollateral(address trader) external view returns (int256 freeCollateral);
}

interface IAsterAccountBalance {
    function getTotalPositionSize(address trader, address baseToken) external view returns (int256 takerPositionSize);
    function getOpenNotional(address trader, address baseToken) external view returns (int256 openNotional);
}

/**
 * @title AsterAdapter
 * @notice IPerpExchange adapter for Aster DEX (formerly APX Finance) on Arbitrum.
 *
 * Aster uses a Clearing House / vAMM model where:
 *   - Capital is deposited into the AsterVault as USDC collateral.
 *   - Positions are opened/closed on the ClearingHouse against virtual markets.
 *   - PnL is settled in USDC and reflected in the vault balance.
 *
 * SPOT TRADING: Aster does not provide spot trading. tradeSpot and withdrawAsset are
 * not supported — use the UniswapV3Adapter (ISpotDex) for asset conversions.
 *
 * TESTNET: Use MockPerpExchange for testing. Deploy this adapter on Arbitrum Sepolia
 * once Aster testnet contracts are verified.
 *
 * MAINNET: Set clearingHouse, vault, and accountBalance to the verified Aster Arbitrum
 * contract addresses. Set baseToken to Aster's virtual BTC or ETH market address.
 */
contract AsterAdapter is IPerpExchange {
    using SafeERC20 for IERC20;

    address public immutable clearingHouse;
    address public immutable vault;
    address public immutable accountBalance;
    address public immutable usdcAddress;
    /// @notice Aster virtual market token (e.g. virtualBTC, virtualETH).
    address public immutable baseToken;

    address public owner;
    address public pendingOwner;

    uint256 public defaultDeadlineOffset = 60; // seconds added to block.timestamp

    event AdapterCall(string action, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(
        address _clearingHouse,
        address _vault,
        address _accountBalance,
        address _usdcAddress,
        address _baseToken
    ) {
        clearingHouse  = _clearingHouse;
        vault          = _vault;
        accountBalance = _accountBalance;
        usdcAddress    = _usdcAddress;
        baseToken      = _baseToken;
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

    // ── Capital movement ──────────────────────────────────────────────────

    function depositCollateral(address token, uint256 amount) external override {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(vault, amount);
        IAsterVault(vault).deposit(token, amount);
        emit AdapterCall("depositCollateral", amount);
    }

    function withdrawCollateral(address token, uint256 amount) external override returns (uint256 amountTransferred) {
        IAsterVault(vault).withdraw(token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        amountTransferred = amount;
        emit AdapterCall("withdrawCollateral", amountTransferred);
    }

    // ── Spot trading (not supported on Aster) ────────────────────────────

    function tradeSpot(address, address, uint256) external payable override returns (uint256) {
        revert("AsterAdapter: use ISpotDex for spot swaps");
    }

    function withdrawAsset(uint256) external pure override {
        revert("AsterAdapter: use ISpotDex for asset withdrawals");
    }

    // ── Perp positions ────────────────────────────────────────────────────

    /// @notice Opens a short position on Aster ClearingHouse.
    /// size is in base token units (18-dec). isLong is ignored — always opens short.
    function openPerpPosition(string calldata /* symbol */, uint256 size, bool /* isLong */) external override {
        IAsterClearingHouse.OpenPositionParams memory params = IAsterClearingHouse.OpenPositionParams({
            baseToken: baseToken,
            isBaseToQuote: true,   // short: sell base (BTC/ETH) for quote (USDC)
            isExactInput: true,
            amount: size,
            oppositeAmountBound: 0,
            deadline: block.timestamp + defaultDeadlineOffset,
            sqrtPriceLimitX96: 0,
            referralCode: bytes32(0)
        });
        IAsterClearingHouse(clearingHouse).openPosition(params);
        emit AdapterCall("openPerpPosition", size);
    }

    function closePerpPosition(string calldata /* symbol */) external override {
        IAsterClearingHouse(clearingHouse).closePosition(
            baseToken, 0, 0, block.timestamp + defaultDeadlineOffset, bytes32(0)
        );
        emit AdapterCall("closePerpPosition", 0);
    }

    /// @notice Partial close: opens a reverse (long) position of closeSize to reduce the short.
    function closePerpPosition(string calldata /* symbol */, uint256 closeSize) external override {
        IAsterClearingHouse.OpenPositionParams memory params = IAsterClearingHouse.OpenPositionParams({
            baseToken: baseToken,
            isBaseToQuote: false,  // buy base to reduce short
            isExactInput: false,
            amount: closeSize,
            oppositeAmountBound: type(uint256).max,
            deadline: block.timestamp + defaultDeadlineOffset,
            sqrtPriceLimitX96: 0,
            referralCode: bytes32(0)
        });
        IAsterClearingHouse(clearingHouse).openPosition(params);
        emit AdapterCall("closePerpPosition", closeSize);
    }

    function cancelOrder(bytes32 /* orderId */) external pure override {
        // Aster uses a vAMM — no order book, cancel is a no-op.
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function getSpotBalance() external view override returns (uint256) {
        int256 bal = IAsterVault(vault).getBalance(address(this));
        return bal > 0 ? uint256(bal) : 0;
    }

    /// @notice Not applicable for Aster (USDC-margined, no asset ledger). Returns 0.
    function getAssetBalance() external pure override returns (uint256) {
        return 0;
    }

    function getPosition(string calldata /* symbol */) external view override returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        int256 posSize = IAsterAccountBalance(accountBalance).getTotalPositionSize(address(this), baseToken);
        int256 openNotional = IAsterAccountBalance(accountBalance).getOpenNotional(address(this), baseToken);
        int256 vaultBal = IAsterVault(vault).getBalance(address(this));

        size = posSize < 0 ? uint256(-posSize) : uint256(posSize);
        collateral = vaultBal > 0 ? uint256(vaultBal) : 0;
        entryPrice = size > 0 ? uint256(openNotional < 0 ? -openNotional : openNotional) / size : 0;
        isLong = posSize > 0;
        isActive = size > 0;
    }

    function getOpenOrderIds() external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    receive() external payable {}
}
