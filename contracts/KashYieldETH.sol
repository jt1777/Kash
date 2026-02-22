// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashTokenEth.sol";

// Interface with Aave V3 Pool (Arbitrum Sepolia)
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getATokenBalance(address asset, address user) external view returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
}

// Interface for WETH (for wrapping/unwrapping ETH)
interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

// Minimal interface for Hyperliquid (or mock/adapter). Bot calls these via owner-only functions.
// Real Hyperliquid: deposit = transfer USDC to bridge; trading/withdraw may be API-signed. Use an adapter if needed.
interface IHyperliquid {
    function depositToSpotWallet(address stableToken, uint256 amount) external;
    function withdrawFromSpotWallet(address stableToken, uint256 amount) external;
    function tradeSpot(address tokenIn, address tokenOut, uint256 amountIn) external payable returns (uint256 amountOut);
    function openPerpPosition(string calldata symbol, uint256 size, bool isLong) external;
    function closePerpPosition(string calldata symbol) external;
    function getSpotBalance(address user) external view returns (uint256);
    function getPosition(address user, string calldata symbol) external view returns (
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        bool isLong,
        bool isActive
    );
    // Optional: order book (mock can no-op; real HL uses API)
    function cancelOrder(bytes32 orderId) external;
    function getOpenOrderIds(address account) external view returns (bytes32[] memory);
}

// Events (kept from original)
event MintRequested(address indexed user, address indexed tokenIn, uint256 amountIn, uint256 batchCycle);
event RedeemRequested(address indexed user, uint256 kashAmount, address indexed tokenOut, uint256 batchCycle);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 batchNAV);
event TokensClaimed(address indexed user, address indexed token, uint256 amount, bool isMint);
event NAVUpdateExecuted(uint256 newNAV, uint256 timestamp);
event ProtocolInteraction(string action, address indexed asset, uint256 amount);

/**
 * @title KashYieldETH
 * @dev ETH yield product: daily batch settlement on Arbitrum. Deposits in ETH/wETH receive KASH_ETH. Integrates Aave + Hyperliquid (short ETH funding).
 */
contract KashYieldETH {
    using SafeERC20 for IERC20;

    // Core state
    address payable public owner;
    KashTokenEth public kashTokenEth;
    uint256 public currentNAV; // 18 decimals, initialized at 1e18 ($1)

    // Protocol addresses (Arbitrum Sepolia)
    address public aavePoolAddress = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address public hyperliquidAddress;

    // Supported tokens (Arbitrum Sepolia addresses)
    address public constant ETH_ADDRESS = address(0);
    address public wethAddress = 0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9;
    address public wbtcAddress = 0x4D8b720b94D341F54df948696747B05998c5FbD5;
    address public usdtAddress = 0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1;
    address public usdcAddress = 0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5;

    mapping(address => address) public tokenOracles;
    mapping(address => uint8) public tokenDecimals;

    uint256 public feeBps = 3;
    uint256 public constant MAX_FEE_BPS = 100;

    bool public paused;

    uint256 public currentBatchCycle;
    mapping(uint256 => bool) public batchProcessed;
    mapping(uint256 => uint256) public batchNAV;

    struct MintRequest {
        address user;
        address tokenIn;
        uint256 amountIn;
        uint256 amountInUSD;
        uint256 batchCycle;
    }

    struct RedeemRequest {
        address user;
        uint256 kashAmount;
        address tokenOut;
        uint256 batchCycle;
    }

    mapping(address => mapping(uint256 => MintRequest)) public userMintRequests;
    mapping(address => mapping(uint256 => RedeemRequest)) public userRedeemRequests;

    mapping(uint256 => uint256) public batchTotalMintValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemValueUSD;
    mapping(uint256 => mapping(address => uint256)) public batchMintsByToken;
    mapping(uint256 => mapping(address => uint256)) public batchRedeemsByTokenUSD;

    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;

    uint256 public constant USER_WINDOW_END = 23 * 3600 + 50 * 60;
    uint256 public constant PROCESSING_WINDOW_START = 23 * 3600 + 50 * 60;
    uint256 public constant PROCESSING_WINDOW_END = 24 * 3600;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function");
        _;
    }

    modifier onlyUserWindow() {
        uint256 timeOfDay = block.timestamp % 86400;
        require(timeOfDay < USER_WINDOW_END, "User window closed (23:50-23:59)");
        _;
    }

    modifier onlyProcessingWindow() {
        uint256 timeOfDay = block.timestamp % 86400;
        require(timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END, "Not in processing window (23:50-23:59)");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract paused");
        _;
    }

    constructor() payable {
        owner = payable(msg.sender);

        kashTokenEth = new KashTokenEth();
        kashTokenEth.transferOwnership(address(this));

        currentNAV = 1e18;
        currentBatchCycle = block.timestamp / 86400;

        tokenDecimals[ETH_ADDRESS] = 18;
        tokenDecimals[wethAddress] = 18;
        tokenDecimals[wbtcAddress] = 8;
        tokenDecimals[usdtAddress] = 6;
        tokenDecimals[usdcAddress] = 6;

        tokenOracles[ETH_ADDRESS] = 0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4;
        tokenOracles[wethAddress] = 0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4;
        tokenOracles[wbtcAddress] = 0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27;
        tokenOracles[usdtAddress] = 0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3;
        tokenOracles[usdcAddress] = 0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76;
    }

    receive() external payable {}

    function requestMint(address tokenIn, uint256 amount) external payable onlyUserWindow whenNotPaused {
        require(isSupportedToken(tokenIn), "Token not supported");

        uint256 actualAmount;
        if (tokenIn == ETH_ADDRESS) {
            require(msg.value > 0, "Must send ETH");
            actualAmount = msg.value;
        } else {
            require(amount > 0, "Amount must be greater than 0");
            actualAmount = amount;
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), actualAmount);
        }

        uint256 batchCycle = block.timestamp / 86400;

        userMintRequests[msg.sender][batchCycle] = MintRequest({
            user: msg.sender,
            tokenIn: tokenIn,
            amountIn: actualAmount,
            amountInUSD: 0,
            batchCycle: batchCycle
        });

        batchMintsByToken[batchCycle][tokenIn] += actualAmount;

        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }

        emit MintRequested(msg.sender, tokenIn, actualAmount, batchCycle);
    }

    function requestRedeem(uint256 kashAmount, address tokenOut) external onlyUserWindow whenNotPaused {
        require(kashAmount > 0, "Amount must be greater than 0");
        require(isSupportedToken(tokenOut), "Token not supported");
        require(kashTokenEth.balanceOf(msg.sender) >= kashAmount, "Insufficient KASH_ETH balance");

        kashTokenEth.transferFrom(msg.sender, address(this), kashAmount);

        uint256 batchCycle = block.timestamp / 86400;

        userRedeemRequests[msg.sender][batchCycle] = RedeemRequest({
            user: msg.sender,
            kashAmount: kashAmount,
            tokenOut: tokenOut,
            batchCycle: batchCycle
        });

        uint256 usdEstimate = (kashAmount * currentNAV) / 1e18;
        batchRedeemsByTokenUSD[batchCycle][tokenOut] += usdEstimate;

        if (!isInBatchRedeem[batchCycle][msg.sender]) {
            batchRedeemUsers[batchCycle].push(msg.sender);
            isInBatchRedeem[batchCycle][msg.sender] = true;
        }

        emit RedeemRequested(msg.sender, kashAmount, tokenOut, batchCycle);
    }

    function processBatch() public onlyProcessingWindow {
        uint256 batchCycle = (block.timestamp / 86400) - 1;
        require(!batchProcessed[batchCycle], "Batch already processed");

        uint256 totalMintUSD = 0;
        address[] memory minters = batchMintUsers[batchCycle];
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest storage req = userMintRequests[minters[i]][batchCycle];
            if (req.user != address(0)) {
                req.amountInUSD = getTokenUSD(req.tokenIn, req.amountIn);
                totalMintUSD += req.amountInUSD;
            }
        }
        batchTotalMintValueUSD[batchCycle] = totalMintUSD;

        uint256 totalRedeemUSD = 0;
        address[] memory redeemers = batchRedeemUsers[batchCycle];
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.user != address(0)) {
                totalRedeemUSD += (req.kashAmount * currentNAV) / 1e18;
            }
        }
        batchTotalRedeemValueUSD[batchCycle] = totalRedeemUSD;

        batchNAV[batchCycle] = currentNAV;

        int256 netPositionUSD = int256(totalMintUSD) - int256(totalRedeemUSD);

        if (netPositionUSD > 0) {
            emit ProtocolInteraction("NET_MINT", address(0), uint256(netPositionUSD));
        } else if (netPositionUSD < 0) {
            emit ProtocolInteraction("NET_REDEEM", address(0), uint256(-netPositionUSD));
        }

        uint256 totalKashToBurn = 0;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.user != address(0)) {
                totalKashToBurn += req.kashAmount;
            }
        }
        if (totalKashToBurn > 0) {
            kashTokenEth.burn(address(this), totalKashToBurn);
        }

        for (uint256 i = 0; i < minters.length; i++) {
            address user = minters[i];
            MintRequest memory req = userMintRequests[user][batchCycle];
            if (req.amountInUSD > 0) {
                uint256 amountAfterFee = req.amountInUSD * (10000 - feeBps) / 10000;
                uint256 kashAmount = (amountAfterFee * 1e18) / currentNAV;
                kashTokenEth.mint(user, kashAmount);
                emit TokensClaimed(user, address(kashTokenEth), kashAmount, true);
            }
        }

        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            RedeemRequest memory req = userRedeemRequests[user][batchCycle];
            if (req.user != address(0)) {
                uint256 usdValue = (req.kashAmount * currentNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                uint256 tokenAmount = calculateTokenAmount(req.tokenOut, usdAfterFee);
                if (req.tokenOut == ETH_ADDRESS) {
                    payable(user).transfer(tokenAmount);
                } else {
                    IERC20(req.tokenOut).safeTransfer(user, tokenAmount);
                }
                emit TokensClaimed(user, req.tokenOut, tokenAmount, false);
            }
        }

        batchProcessed[batchCycle] = true;

        emit BatchProcessed(batchCycle, totalMintUSD, totalRedeemUSD, currentNAV);
    }

    function checkUpkeep(bytes calldata /* checkData */) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 batchCycle = (block.timestamp / 86400) - 1;
        uint256 timeOfDay = block.timestamp % 86400;
        upkeepNeeded = (timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END) && !batchProcessed[batchCycle];
        performData = "";
    }

    function performUpkeep(bytes calldata /* performData */) external {
        processBatch();
    }

    function depositToAave(address asset, uint256 amount) external onlyOwner {
        if (asset == ETH_ADDRESS) {
            IWETH(wethAddress).deposit{value: amount}();
            IERC20(wethAddress).forceApprove(aavePoolAddress, amount);
            IPool(aavePoolAddress).supply(wethAddress, amount, address(this), 0);
            emit ProtocolInteraction("AAVE_DEPOSIT", wethAddress, amount);
        } else {
            IERC20(asset).forceApprove(aavePoolAddress, amount);
            IPool(aavePoolAddress).supply(asset, amount, address(this), 0);
            emit ProtocolInteraction("AAVE_DEPOSIT", asset, amount);
        }
    }

    function withdrawFromAave(address asset, uint256 amount) external onlyOwner {
        if (asset == ETH_ADDRESS) {
            IPool(aavePoolAddress).withdraw(wethAddress, amount, address(this));
            IWETH(wethAddress).withdraw(amount);
            emit ProtocolInteraction("AAVE_WITHDRAW", ETH_ADDRESS, amount);
        } else {
            IPool(aavePoolAddress).withdraw(asset, amount, address(this));
            emit ProtocolInteraction("AAVE_WITHDRAW", asset, amount);
        }
    }

    function borrowFromAave(address asset, uint256 amount) external onlyOwner {
        IPool(aavePoolAddress).borrow(asset, amount, 2, 0, address(this));
        emit ProtocolInteraction("AAVE_BORROW", asset, amount);
    }

    function repayToAave(address asset, uint256 amount) external onlyOwner {
        IERC20(asset).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).repay(asset, amount, 2, address(this));
        emit ProtocolInteraction("AAVE_REPAY", asset, amount);
    }

    function setHyperliquid(address _hyperliquidAddress) external onlyOwner {
        hyperliquidAddress = _hyperliquidAddress;
    }

    function depositToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_DEPOSIT", usdcAddress, amount);
    }

    function withdrawFromHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IHyperliquid(hyperliquidAddress).withdrawFromSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_WITHDRAW", usdcAddress, amount);
    }

    function addCollateralToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_ADD_COLLATERAL", usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(size > 0, "Size must be > 0");
        IHyperliquid(hyperliquidAddress).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction("HL_OPEN_SHORT", address(0), size);
    }

    function closeShort(string calldata symbol) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).closePerpPosition(symbol);
        emit ProtocolInteraction("HL_CLOSE_SHORT", address(0), 0);
    }

    function spotBuyOnHyperliquid(address tokenOut, uint256 usdcAmount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAmount > 0, "Amount must be > 0");
        require(tokenOut == ETH_ADDRESS || tokenOut == wbtcAddress, "tokenOut must be ETH or wBTC");
        uint256 amountOut = IHyperliquid(hyperliquidAddress).tradeSpot(usdcAddress, tokenOut, usdcAmount);
        emit ProtocolInteraction("HL_SPOT_BUY", tokenOut, amountOut);
    }

    function spotSellOnHyperliquid(address tokenIn, uint256 amount) external payable onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        require(tokenIn == ETH_ADDRESS || tokenIn == wbtcAddress, "tokenIn must be ETH or wBTC");
        if (tokenIn == ETH_ADDRESS) {
            require(msg.value == amount, "ETH amount must match msg.value");
        }
        uint256 amountOut = IHyperliquid(hyperliquidAddress).tradeSpot{value: tokenIn == ETH_ADDRESS ? amount : 0}(tokenIn, usdcAddress, amount);
        emit ProtocolInteraction("HL_SPOT_SELL", usdcAddress, amountOut);
    }

    function cancelHyperliquidOrder(bytes32 orderId) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).cancelOrder(orderId);
        emit ProtocolInteraction("HL_CANCEL_ORDER", address(0), 0);
    }

    function getHyperliquidSpotBalance() external view returns (uint256) {
        if (hyperliquidAddress == address(0)) return 0;
        return IHyperliquid(hyperliquidAddress).getSpotBalance(address(this));
    }

    function getHyperliquidPosition(string calldata symbol) external view returns (
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        bool isLong,
        bool isActive
    ) {
        if (hyperliquidAddress == address(0)) return (0, 0, 0, false, false);
        return IHyperliquid(hyperliquidAddress).getPosition(address(this), symbol);
    }

    function getHyperliquidOpenOrderIds() external view returns (bytes32[] memory) {
        if (hyperliquidAddress == address(0)) return new bytes32[](0);
        return IHyperliquid(hyperliquidAddress).getOpenOrderIds(address(this));
    }

    function updateNAV(uint256 newNAV) external onlyOwner {
        require(newNAV > 0, "NAV must be greater than 0");
        currentNAV = newNAV;
        emit NAVUpdateExecuted(newNAV, block.timestamp);
    }

    function setFeeBps(uint256 newFee) external onlyOwner {
        require(newFee <= MAX_FEE_BPS, "Fee too high");
        feeBps = newFee;
    }

    function setAavePool(address _aavePool) external onlyOwner {
        require(_aavePool != address(0), "Invalid address");
        aavePoolAddress = _aavePool;
    }

    function setTokenAddresses(
        address _weth,
        address _wbtc,
        address _usdt,
        address _usdc
    ) external onlyOwner {
        require(_weth != address(0) && _wbtc != address(0) && _usdt != address(0) && _usdc != address(0), "Invalid address");
        wethAddress = _weth;
        wbtcAddress = _wbtc;
        usdtAddress = _usdt;
        usdcAddress = _usdc;
    }

    function setOracle(address token, address oracle) external onlyOwner {
        require(oracle != address(0), "Invalid oracle address");
        tokenOracles[token] = oracle;
    }

    function setTokenDecimals(address token, uint8 decimals) external onlyOwner {
        tokenDecimals[token] = decimals;
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }

    /// @notice Withdraw excess ETH from the contract to the owner (e.g. after redeploying or draining protocol).
    /// Use with care: ensure no user redemptions are pending that need this ETH.
    function ownerWithdrawEth(uint256 amount) external onlyOwner {
        require(amount <= address(this).balance, "Insufficient balance");
        payable(owner).transfer(amount);
        emit ProtocolInteraction("OWNER_WITHDRAW_ETH", ETH_ADDRESS, amount);
    }

    function emergencyWithdrawMint(uint256 batchCycle) external {
        require(paused, "Not paused");
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        require(req.user == msg.sender && req.amountIn > 0 && req.amountInUSD == 0, "Invalid request");
        if (req.tokenIn == ETH_ADDRESS) {
            payable(msg.sender).transfer(req.amountIn);
        } else {
            IERC20(req.tokenIn).safeTransfer(msg.sender, req.amountIn);
        }
        delete userMintRequests[msg.sender][batchCycle];
    }

    function emergencyWithdrawRedeem(uint256 batchCycle) external {
        require(paused, "Not paused");
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        require(req.user == msg.sender && req.kashAmount > 0, "Invalid request");
        kashTokenEth.transfer(msg.sender, req.kashAmount);
        delete userRedeemRequests[msg.sender][batchCycle];
    }

    function getNAV() external view returns (uint256) {
        return currentNAV;
    }

    function isUserWindow() public view returns (bool) {
        uint256 timeOfDay = block.timestamp % 86400;
        return timeOfDay < USER_WINDOW_END;
    }

    function isProcessingWindow() public view returns (bool) {
        uint256 timeOfDay = block.timestamp % 86400;
        return timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END;
    }

    function getPendingMintRequest(address user, uint256 batchCycle) external view returns (MintRequest memory) {
        return userMintRequests[user][batchCycle];
    }

    function getPendingRedeemRequest(address user, uint256 batchCycle) external view returns (RedeemRequest memory) {
        return userRedeemRequests[user][batchCycle];
    }

    function getBatchInfo(uint256 batchCycle) external view returns (
        uint256 totalMintUSD,
        uint256 totalRedeemUSD,
        bool processed,
        uint256 mintUsersCount,
        uint256 redeemUsersCount
    ) {
        return (
            batchTotalMintValueUSD[batchCycle],
            batchTotalRedeemValueUSD[batchCycle],
            batchProcessed[batchCycle],
            batchMintUsers[batchCycle].length,
            batchRedeemUsers[batchCycle].length
        );
    }

    function isSupportedToken(address token) public view returns (bool) {
        return token == ETH_ADDRESS ||
               token == wethAddress ||
               token == wbtcAddress ||
               token == usdtAddress ||
               token == usdcAddress;
    }

    function getTokenUSD(address token, uint256 amount) public view returns (uint256) {
        if (amount == 0) return 0;
        address oracle = tokenOracles[token];
        require(oracle != address(0), "No oracle for token");
        (, int256 price,,,) = AggregatorV3Interface(oracle).latestRoundData();
        require(price > 0, "Invalid oracle price");
        uint8 priceDec = 8;
        uint8 tokDec = tokenDecimals[token];
        return (amount * uint256(price) * 10**18) / (10**tokDec * 10**priceDec);
    }

    function calculateTokenAmount(address token, uint256 usdValue) public view returns (uint256) {
        if (usdValue == 0) return 0;
        address oracle = tokenOracles[token];
        require(oracle != address(0), "No oracle for token");
        (, int256 price,,,) = AggregatorV3Interface(oracle).latestRoundData();
        require(price > 0, "Invalid oracle price");
        uint8 priceDec = 8;
        uint8 tokDec = tokenDecimals[token];
        return (usdValue * 10**tokDec * 10**priceDec) / (uint256(price) * 10**18);
    }

    function getCurrentBatchCycle() external view returns (uint256) {
        return block.timestamp / 86400;
    }

    function testMintKashEth(address to, uint256 amount) external onlyOwner {
        kashTokenEth.mint(to, amount);
    }
}
