// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./interfaces/IPerpExchange.sol";

/// @notice Immutable perp exchange routing contract (V3 bug-bounty hardening).
///         Bot/keeper call through here; adapter and config are frozen at deploy time.
contract ExchangeFacade {
    using SafeERC20 for IERC20;

    address public immutable botAddress;
    address public immutable keeperRegistry;
    address public immutable usdcAddress;
    address public immutable primaryAsset;
    address public immutable kashYieldAddress;
    address public immutable perpAdapter;
    string public activePerpExchange;

    event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);

    modifier onlyBotOrKeeper() {
        require(msg.sender == botAddress || msg.sender == keeperRegistry, "Only bot/keeper");
        _;
    }

    constructor(
        address _bot,
        address _keeper,
        address _usdc,
        address _primaryAsset,
        address _kashYield,
        string memory _exchangeName,
        address _adapterAddress
    ) {
        require(_bot != address(0), "Invalid bot");
        require(_usdc != address(0), "Invalid USDC");
        require(_kashYield != address(0), "Invalid kashYield");
        require(_adapterAddress != address(0), "Invalid adapter");
        botAddress = _bot;
        keeperRegistry = _keeper;
        usdcAddress = _usdc;
        primaryAsset = _primaryAsset;
        kashYieldAddress = _kashYield;
        perpAdapter = _adapterAddress;
        activePerpExchange = _exchangeName;
    }

    function perpExchangeAddress() external view returns (address) {
        return perpAdapter;
    }

    function depositToPerpExchange(uint256 amount) external onlyBotOrKeeper {
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), amount);
        IERC20(usdcAddress).forceApprove(perpAdapter, amount);
        IPerpExchange(perpAdapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_DEPOSIT, usdcAddress, amount);
    }

    function withdrawFromPerpExchange(uint256 amount) external onlyBotOrKeeper {
        uint256 transferred = IPerpExchange(perpAdapter).withdrawCollateral(usdcAddress, amount);
        IERC20(usdcAddress).safeTransfer(kashYieldAddress, transferred);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW, usdcAddress, transferred);
    }

    function withdrawAssetFromPerpExchange(uint256 amount) external onlyBotOrKeeper {
        IPerpExchange(perpAdapter).withdrawAsset(amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW_ASSET, primaryAsset, amount);
    }

    function addCollateralToPerpExchange(uint256 amount) external onlyBotOrKeeper {
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), amount);
        IERC20(usdcAddress).forceApprove(perpAdapter, amount);
        IPerpExchange(perpAdapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_ADD_COLLATERAL, usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyBotOrKeeper {
        IPerpExchange(perpAdapter).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_OPEN_SHORT, primaryAsset, size);
    }

    function closeShort(string calldata symbol) external onlyBotOrKeeper {
        IPerpExchange(perpAdapter).closePerpPosition(symbol);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, primaryAsset, 0);
    }

    function closeShort(string calldata symbol, uint256 closeSize) external onlyBotOrKeeper {
        IPerpExchange(perpAdapter).closePerpPosition(symbol, closeSize);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, primaryAsset, closeSize);
    }

    function spotBuyOnPerpExchange(uint256 usdcAmount) external onlyBotOrKeeper {
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), usdcAmount);
        IERC20(usdcAddress).forceApprove(perpAdapter, usdcAmount);
        uint256 out = IPerpExchange(perpAdapter).tradeSpot(usdcAddress, primaryAsset, usdcAmount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_BUY, primaryAsset, out);
    }

    function spotSellOnPerpExchange(uint256 amount) external onlyBotOrKeeper {
        uint256 out = IPerpExchange(perpAdapter).tradeSpot(primaryAsset, usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_SELL, usdcAddress, out);
    }

    function cancelPerpExchangeOrder(bytes32 orderId) external onlyBotOrKeeper {
        IPerpExchange(perpAdapter).cancelOrder(orderId);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CANCEL_ORDER, primaryAsset, 0);
    }

    function getPerpExchangeSpotBalance() external view returns (uint256) {
        return IPerpExchange(perpAdapter).getSpotBalance();
    }

    function getExchangeAssetBalance() external view returns (uint256) {
        return IPerpExchange(perpAdapter).getAssetBalance();
    }

    function getPerpExchangePosition(string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        return IPerpExchange(perpAdapter).getPosition(symbol);
    }
}
