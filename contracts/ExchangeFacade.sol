// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./interfaces/IPerpExchange.sol";

/// @notice Standalone perp exchange registry and HL operation facade (deployed separately from vault).
contract ExchangeFacade {
    using SafeERC20 for IERC20;

    address public owner;
    address public botAddress;
    address public keeperRegistry;
    address public immutable usdcAddress;
    address public immutable primaryAsset;
    address public immutable kashYieldAddress;

    mapping(string => address) public perpExchanges;
    string public activePerpExchange;

    bool private anyAdapterConfirmed;
    mapping(string => address) private pendingAdapters;
    mapping(string => uint256) public adapterReadyAt;
    uint256 public exchangeSwitchDelay = 24 hours;

    event ExchangeRegistered(string indexed name, address adapter);
    event AdapterProposed(string indexed name, address adapter, uint256 readyAt);
    event ExchangeSwitchConfirmed(string indexed name, address adapter);
    event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyBotOrKeeper() {
        require(msg.sender == botAddress || msg.sender == keeperRegistry, "Only bot/keeper");
        _;
    }

    constructor(address _owner, address _bot, address _usdc, address _primaryAsset, address _kashYield) {
        owner = _owner;
        botAddress = _bot;
        usdcAddress = _usdc;
        primaryAsset = _primaryAsset;
        kashYieldAddress = _kashYield;
    }

    function setBotAddress(address _bot) external onlyOwner { botAddress = _bot; }
    function setKeeperRegistry(address _keeper) external onlyOwner { keeperRegistry = _keeper; }

    function setPerpExchange(string calldata name, address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        if (!anyAdapterConfirmed) {
            perpExchanges[name] = adapter;
            anyAdapterConfirmed = true;
            emit ExchangeRegistered(name, adapter);
            return;
        }
        pendingAdapters[name] = adapter;
        adapterReadyAt[name] = block.timestamp + exchangeSwitchDelay;
        emit AdapterProposed(name, adapter, adapterReadyAt[name]);
    }

    function confirmPerpExchange(string calldata name) external onlyOwner {
        require(adapterReadyAt[name] != 0 && block.timestamp >= adapterReadyAt[name], "Timelock");
        perpExchanges[name] = pendingAdapters[name];
        emit ExchangeRegistered(name, perpExchanges[name]);
        delete pendingAdapters[name];
        delete adapterReadyAt[name];
    }

    function setActivePerpExchange(string calldata name) external onlyOwner {
        require(perpExchanges[name] != address(0), "Not registered");
        activePerpExchange = name;
        emit ExchangeSwitchConfirmed(name, perpExchanges[name]);
    }

    function setHyperliquid(address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        if (!anyAdapterConfirmed) {
            perpExchanges["HL"] = adapter;
            anyAdapterConfirmed = true;
            emit ExchangeRegistered("HL", adapter);
            return;
        }
        pendingAdapters["HL"] = adapter;
        adapterReadyAt["HL"] = block.timestamp + exchangeSwitchDelay;
        emit AdapterProposed("HL", adapter, adapterReadyAt["HL"]);
    }
    function hyperliquidAddress() external view returns (address) { return perpExchanges["HL"]; }

    function depositToHyperliquid(uint256 amount) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), amount);
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_DEPOSIT, usdcAddress, amount);
    }

    function withdrawFromHyperliquid(uint256 amount) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        uint256 transferred = IPerpExchange(adapter).withdrawCollateral(usdcAddress, amount);
        IERC20(usdcAddress).safeTransfer(kashYieldAddress, transferred);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW, usdcAddress, transferred);
    }

    function withdrawAssetFromHyperliquid(uint256 amount) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).withdrawAsset(amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW_ASSET, primaryAsset, amount);
    }

    function addCollateralToHyperliquid(uint256 amount) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), amount);
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_ADD_COLLATERAL, usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyBotOrKeeper {
        IPerpExchange(_activePerpAdapter()).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_OPEN_SHORT, primaryAsset, size);
    }

    function closeShort(string calldata symbol) external onlyBotOrKeeper {
        IPerpExchange(_activePerpAdapter()).closePerpPosition(symbol);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, primaryAsset, 0);
    }

    function closeShort(string calldata symbol, uint256 closeSize) external onlyBotOrKeeper {
        IPerpExchange(_activePerpAdapter()).closePerpPosition(symbol, closeSize);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, primaryAsset, closeSize);
    }

    function spotBuyOnHyperliquid(uint256 usdcAmount) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).safeTransferFrom(kashYieldAddress, address(this), usdcAmount);
        IERC20(usdcAddress).forceApprove(adapter, usdcAmount);
        uint256 out = IPerpExchange(adapter).tradeSpot(usdcAddress, primaryAsset, usdcAmount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_BUY, primaryAsset, out);
    }

    function spotSellOnHyperliquid(uint256 amount) external onlyBotOrKeeper {
        uint256 out = IPerpExchange(_activePerpAdapter()).tradeSpot(primaryAsset, usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_SELL, usdcAddress, out);
    }

    function cancelHyperliquidOrder(bytes32 orderId) external onlyBotOrKeeper {
        IPerpExchange(_activePerpAdapter()).cancelOrder(orderId);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CANCEL_ORDER, primaryAsset, 0);
    }

    function getHyperliquidSpotBalance() external view returns (uint256) {
        address adapter = perpExchanges[activePerpExchange];
        return adapter == address(0) ? 0 : IPerpExchange(adapter).getSpotBalance();
    }

    function getExchangeAssetBalance() external view returns (uint256) {
        address adapter = perpExchanges[activePerpExchange];
        return adapter == address(0) ? 0 : IPerpExchange(adapter).getAssetBalance();
    }

    function getHyperliquidPosition(string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return (0, 0, 0, false, false);
        return IPerpExchange(adapter).getPosition(symbol);
    }

    function _activePerpAdapter() internal view returns (address adapter) {
        adapter = perpExchanges[activePerpExchange];
        require(adapter != address(0), "No active exchange");
    }
}
