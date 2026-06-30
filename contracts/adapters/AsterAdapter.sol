// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPerpExchange.sol";

// ─── Aster (formerly APX Finance) interfaces ─────────────────────────────────
// Aster uses a Clearing House + vAMM architecture.
// Mainnet Clearing House on Arbitrum: 0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5

interface IAsterClearingHouse {
    struct OpenPositionParams {
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        uint256 amount;
        uint256 oppositeAmountBound;
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

error OnlyFacade();
error InvalidAddress();

/**
 * @title AsterAdapter
 * @notice IPerpExchange adapter for Aster DEX on Arbitrum. Ownerless — all config is immutable.
 *
 * Capital-movement calls are restricted to the immutable ExchangeFacade.
 * Spot trading is not supported; use UniswapV3Adapter (ISpotDex) for asset conversions.
 */
contract AsterAdapter is IPerpExchange {
    using SafeERC20 for IERC20;

    address public immutable clearingHouse;
    address public immutable vault;
    address public immutable accountBalance;
    address public immutable usdcAddress;
    address public immutable baseToken;
    address public immutable exchangeFacade;

    uint256 public constant DEFAULT_DEADLINE_OFFSET = 60;

    event AdapterCall(string action, uint256 amount);

    modifier onlyFacade() {
        if (msg.sender != exchangeFacade) revert OnlyFacade();
        _;
    }

    constructor(
        address _clearingHouse,
        address _vault,
        address _accountBalance,
        address _usdcAddress,
        address _baseToken,
        address _exchangeFacade
    ) {
        if (_exchangeFacade == address(0)) revert InvalidAddress();
        clearingHouse  = _clearingHouse;
        vault          = _vault;
        accountBalance = _accountBalance;
        usdcAddress    = _usdcAddress;
        baseToken      = _baseToken;
        exchangeFacade = _exchangeFacade;
    }

    function depositCollateral(address token, uint256 amount) external override onlyFacade {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).forceApprove(vault, amount);
        IAsterVault(vault).deposit(token, amount);
        emit AdapterCall("depositCollateral", amount);
    }

    function withdrawCollateral(address token, uint256 amount) external override onlyFacade returns (uint256 amountTransferred) {
        IAsterVault(vault).withdraw(token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
        amountTransferred = amount;
        emit AdapterCall("withdrawCollateral", amountTransferred);
    }

    function tradeSpot(address, address, uint256) external payable override returns (uint256) {
        revert("AsterAdapter: use ISpotDex for spot swaps");
    }

    function withdrawAsset(uint256) external pure override {
        revert("AsterAdapter: use ISpotDex for asset withdrawals");
    }

    function openPerpPosition(string calldata /* symbol */, uint256 size, bool /* isLong */) external override onlyFacade {
        IAsterClearingHouse.OpenPositionParams memory params = IAsterClearingHouse.OpenPositionParams({
            baseToken: baseToken,
            isBaseToQuote: true,
            isExactInput: true,
            amount: size,
            oppositeAmountBound: 0,
            deadline: block.timestamp + DEFAULT_DEADLINE_OFFSET,
            sqrtPriceLimitX96: 0,
            referralCode: bytes32(0)
        });
        IAsterClearingHouse(clearingHouse).openPosition(params);
        emit AdapterCall("openPerpPosition", size);
    }

    function closePerpPosition(string calldata /* symbol */) external override onlyFacade {
        IAsterClearingHouse(clearingHouse).closePosition(
            baseToken, 0, 0, block.timestamp + DEFAULT_DEADLINE_OFFSET, bytes32(0)
        );
        emit AdapterCall("closePerpPosition", 0);
    }

    function closePerpPosition(string calldata /* symbol */, uint256 closeSize) external override onlyFacade {
        IAsterClearingHouse.OpenPositionParams memory params = IAsterClearingHouse.OpenPositionParams({
            baseToken: baseToken,
            isBaseToQuote: false,
            isExactInput: false,
            amount: closeSize,
            oppositeAmountBound: type(uint256).max,
            deadline: block.timestamp + DEFAULT_DEADLINE_OFFSET,
            sqrtPriceLimitX96: 0,
            referralCode: bytes32(0)
        });
        IAsterClearingHouse(clearingHouse).openPosition(params);
        emit AdapterCall("closePerpPosition", closeSize);
    }

    function cancelOrder(bytes32 /* orderId */) external pure override {}

    function getSpotBalance() external view override returns (uint256) {
        int256 bal = IAsterVault(vault).getBalance(address(this));
        return bal > 0 ? uint256(bal) : 0;
    }

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
