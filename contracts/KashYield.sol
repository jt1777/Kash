// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashToken.sol";

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
 * @title KashYield
 * @dev Yield strategy contract with daily batch settlement on Arbitrum.
 * Integrates with Aave for lending/borrowing. Hyperliquid interactions handled off-chain by bot.
 * Uses Chainlink oracles for token valuations. Batch processing automatable via Chainlink Automation.
 * Supports ETH, wETH, wBTC, USDT, USDC.
 * Improvements: Automated valuations, auto-distribution post-batch, fees, emergency pause/withdraw, fixed aggregations/redeems.
 */
contract KashYield {
    using SafeERC20 for IERC20;

    // Core state
    address payable public owner;
    Kash public kashToken;
    uint256 public currentNAV; // 18 decimals, initialized at 1e18 ($1)
    
    // Protocol addresses (Arbitrum Sepolia)
    // Aave V3 Pool: https://github.com/bgd-labs/aave-address-book (AaveV3ArbitrumSepolia.POOL)
    address public aavePoolAddress = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address public hyperliquidAddress; // Hyperliquid adapter or bridge (0 = disabled). Bot uses for deposit/short/withdraw.

    // Supported tokens (Arbitrum Sepolia addresses)
    address public constant ETH_ADDRESS = address(0);
    address public wethAddress = 0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9;
    address public wbtcAddress = 0x4D8b720b94D341F54df948696747B05998c5FbD5;
    address public usdtAddress = 0x833EdA586220B1d0C25034E9bAb5ed4B4a5769a1;
    address public usdcAddress = 0x15BB91b9e63EA29863678B1dcBcB01dE31bD8Ab5;
    
    // Chainlink oracles (Arbitrum Sepolia, USD pairs)
    mapping(address => address) public tokenOracles;
    mapping(address => uint8) public tokenDecimals;
    
    // Fees
    uint256 public feeBps = 3; // 0.03%
    uint256 public constant MAX_FEE_BPS = 100; // 1%
    
    // Pause state
    bool public paused;
    
    // Batch tracking
    uint256 public currentBatchCycle; // Current day number (timestamp / 86400)
    mapping(uint256 => bool) public batchProcessed; // batchCycle => processed
    mapping(uint256 => uint256) public batchNAV; // NAV at the time of batch processing
    
    // Pending requests tracking
    struct MintRequest {
        address user;
        address tokenIn;
        uint256 amountIn;
        uint256 amountInUSD; // USD value (18 decimals)
        uint256 batchCycle;
    }
    
    struct RedeemRequest {
        address user;
        uint256 kashAmount;
        address tokenOut;
        uint256 batchCycle;
    }
    
    // User request mappings
    mapping(address => mapping(uint256 => MintRequest)) public userMintRequests; // user => batchCycle => request
    mapping(address => mapping(uint256 => RedeemRequest)) public userRedeemRequests; // user => batchCycle => request
    
    // Batch totals for processing
    mapping(uint256 => uint256) public batchTotalMintValueUSD; // batchCycle => total USD value of mints
    mapping(uint256 => uint256) public batchTotalRedeemValueUSD; // batchCycle => total USD value of redeems
    mapping(uint256 => mapping(address => uint256)) public batchMintsByToken; // batchCycle => token => amount
    mapping(uint256 => mapping(address => uint256)) public batchRedeemsByTokenUSD; // batchCycle => token => estimated USD
    
    // Arrays to track users per batch for distribution
    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint; // prevent duplicates
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;

    // Time window constants (in seconds from day start)
    uint256 public constant USER_WINDOW_END = 23 * 3600 + 50 * 60; // 23:50
    uint256 public constant PROCESSING_WINDOW_START = 23 * 3600 + 50 * 60; // 23:50
    uint256 public constant PROCESSING_WINDOW_END = 24 * 3600; // 00:00 (next day)

    // Modifiers
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
        
        kashToken = new Kash();
        kashToken.transferOwnership(address(this)); // Contract owns token for minting/burning
        
        currentNAV = 1e18; // Initialize at $1.00
        currentBatchCycle = block.timestamp / 86400;
        
        // Set token decimals
        tokenDecimals[ETH_ADDRESS] = 18;
        tokenDecimals[wethAddress] = 18;
        tokenDecimals[wbtcAddress] = 8;
        tokenDecimals[usdtAddress] = 6;
        tokenDecimals[usdcAddress] = 6;
        
        // Set Chainlink oracles (Arbitrum Sepolia)
        tokenOracles[ETH_ADDRESS] = 0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4; // ETH/USD
        tokenOracles[wethAddress] = 0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4; // Same as ETH
        tokenOracles[wbtcAddress] = 0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27; // BTC/USD
        tokenOracles[usdtAddress] = 0x78a59DD416d0CE4AbfD2e27BFd2f6bFdceC446e3; // USDT/USD
        tokenOracles[usdcAddress] = 0xed45CBB45d34F53bf14C70e6FC2711bDd6454E76; // USDC/USD
    }

    // Allow contract to receive ETH
    receive() external payable {}

    // ============================================
    // USER FUNCTIONS
    // ============================================

    /**
     * @notice Request to mint Kash tokens by depositing assets
     * @param tokenIn Address of token to deposit (address(0) for ETH)
     * @param amount Amount of tokens to deposit (ignored for ETH, uses msg.value)
     */
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
        
        // Store user's mint request (USD value set during batch processing)
        userMintRequests[msg.sender][batchCycle] = MintRequest({
            user: msg.sender,
            tokenIn: tokenIn,
            amountIn: actualAmount,
            amountInUSD: 0, // Set later
            batchCycle: batchCycle
        });
        
        // Track batch totals (token amounts)
        batchMintsByToken[batchCycle][tokenIn] += actualAmount;
        
        // Add user to batch list (if not already added)
        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }
        
        emit MintRequested(msg.sender, tokenIn, actualAmount, batchCycle);
    }

    /**
     * @notice Request to redeem Kash tokens for a specific asset
     * @param kashAmount Amount of Kash tokens to redeem
     * @param tokenOut Address of token to receive (address(0) for ETH)
     */
    function requestRedeem(uint256 kashAmount, address tokenOut) external onlyUserWindow whenNotPaused {
        require(kashAmount > 0, "Amount must be greater than 0");
        require(isSupportedToken(tokenOut), "Token not supported");
        require(kashToken.balanceOf(msg.sender) >= kashAmount, "Insufficient Kash balance");
        
        // Transfer Kash to contract (will be burned after batch processing)
        kashToken.transferFrom(msg.sender, address(this), kashAmount);
        
        uint256 batchCycle = block.timestamp / 86400;
        
        // Store user's redeem request
        userRedeemRequests[msg.sender][batchCycle] = RedeemRequest({
            user: msg.sender,
            kashAmount: kashAmount,
            tokenOut: tokenOut,
            batchCycle: batchCycle
        });
        
        // Track redeem aggregation (estimated USD for bot liquidity planning)
        uint256 usdEstimate = (kashAmount * currentNAV) / 1e18;
        batchRedeemsByTokenUSD[batchCycle][tokenOut] += usdEstimate;
        
        // Add user to batch list (if not already added)
        if (!isInBatchRedeem[batchCycle][msg.sender]) {
            batchRedeemUsers[batchCycle].push(msg.sender);
            isInBatchRedeem[batchCycle][msg.sender] = true;
        }
        
        emit RedeemRequested(msg.sender, kashAmount, tokenOut, batchCycle);
    }

    // ============================================
    // BATCH PROCESSING FUNCTIONS
    // ============================================

    /**
     * @notice Process daily batch - calculate net positions, execute distributions
     * @dev Callable during processing window or by Chainlink Automation
     */
    function processBatch() public onlyProcessingWindow {
        uint256 batchCycle = (block.timestamp / 86400) - 1; // Process previous day's batch
        require(!batchProcessed[batchCycle], "Batch already processed");
        
        // Step 1: Value all mints using current oracles
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
        
        // Step 2: Calculate total redeem USD using current NAV
        uint256 totalRedeemUSD = 0;
        address[] memory redeemers = batchRedeemUsers[batchCycle];
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.user != address(0)) {
                totalRedeemUSD += (req.kashAmount * currentNAV) / 1e18;
            }
        }
        batchTotalRedeemValueUSD[batchCycle] = totalRedeemUSD;
        
        // Store NAV for this batch
        batchNAV[batchCycle] = currentNAV;
        
        // Calculate net position (positive = net mints, negative = net redeems)
        int256 netPositionUSD = int256(totalMintUSD) - int256(totalRedeemUSD);
        
        if (netPositionUSD > 0) {
            // Net mints - excess capital to deploy (bot acts on event)
            emit ProtocolInteraction("NET_MINT", address(0), uint256(netPositionUSD));
        } else if (netPositionUSD < 0) {
            // Net redeems - need to free up capital (bot acts on event)
            emit ProtocolInteraction("NET_REDEEM", address(0), uint256(-netPositionUSD));
        }
        
        // Burn redeemed Kash tokens
        uint256 totalKashToBurn = 0;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.user != address(0)) {
                totalKashToBurn += req.kashAmount;
            }
        }
        if (totalKashToBurn > 0) {
            kashToken.burn(address(this), totalKashToBurn);
        }
        
        // Auto-distribute mints and redeems
        for (uint256 i = 0; i < minters.length; i++) {
            address user = minters[i];
            MintRequest memory req = userMintRequests[user][batchCycle];
            if (req.amountInUSD > 0) {
                // Apply fee
                uint256 amountAfterFee = req.amountInUSD * (10000 - feeBps) / 10000;
                uint256 kashAmount = (amountAfterFee * 1e18) / currentNAV;
                kashToken.mint(user, kashAmount);
                emit TokensClaimed(user, address(kashToken), kashAmount, true);
            }
        }
        
        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            RedeemRequest memory req = userRedeemRequests[user][batchCycle];
            if (req.user != address(0)) {
                // Apply fee
                uint256 usdValue = (req.kashAmount * currentNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                uint256 tokenAmount = calculateTokenAmount(req.tokenOut, usdAfterFee);
                // Transfer
                if (req.tokenOut == ETH_ADDRESS) {
                    payable(user).transfer(tokenAmount);
                } else {
                    IERC20(req.tokenOut).safeTransfer(user, tokenAmount);
                }
                emit TokensClaimed(user, req.tokenOut, tokenAmount, false);
            }
        }
        
        // Mark batch as processed
        batchProcessed[batchCycle] = true;
        
        emit BatchProcessed(batchCycle, totalMintUSD, totalRedeemUSD, currentNAV);
    }

    // Chainlink Automation support
    function checkUpkeep(bytes calldata /* checkData */) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 batchCycle = (block.timestamp / 86400) - 1;
        uint256 timeOfDay = block.timestamp % 86400;
        upkeepNeeded = (timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END) && !batchProcessed[batchCycle];
        performData = "";
    }

    function performUpkeep(bytes calldata /* performData */) external {
        processBatch();
    }

    // ============================================
    // PROTOCOL INTERACTION FUNCTIONS (Owner Only)
    // ============================================

    function depositToAave(address asset, uint256 amount) external onlyOwner {
        if (asset == ETH_ADDRESS) {
            // Aave V3 on Arbitrum uses WETH for native ETH deposits
            // Wrap ETH to WETH first, then supply WETH to Aave
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
            // Withdraw WETH from Aave, then unwrap to ETH
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

    // ============================================
    // HYPERLIQUID INTERACTION (Owner / Bot Only)
    // ============================================
    // All moves stay in protocol: contract deposits/withdraws to Hyperliquid adapter (or bridge).
    // Real mainnet: deposit = transfer USDC to bridge; trading/withdraw often via Hyperliquid API (off-chain sigs).

    function setHyperliquid(address _hyperliquidAddress) external onlyOwner {
        hyperliquidAddress = _hyperliquidAddress;
    }

    /// @notice Deposit USDC from contract to Hyperliquid spot wallet (collateral).
    function depositToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_DEPOSIT", usdcAddress, amount);
    }

    /// @notice Withdraw USDC from Hyperliquid spot wallet back to contract.
    function withdrawFromHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IHyperliquid(hyperliquidAddress).withdrawFromSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_WITHDRAW", usdcAddress, amount);
    }

    /// @notice Add collateral to Hyperliquid (same as deposit).
    function addCollateralToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_ADD_COLLATERAL", usdcAddress, amount);
    }

    /// @notice Open a short perp position (e.g. "ETH", "BTC"). Size in asset units (18 decimals).
    function openShort(string calldata symbol, uint256 size) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(size > 0, "Size must be > 0");
        IHyperliquid(hyperliquidAddress).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction("HL_OPEN_SHORT", address(0), size);
    }

    /// @notice Close the short perp position for symbol.
    function closeShort(string calldata symbol) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).closePerpPosition(symbol);
        emit ProtocolInteraction("HL_CLOSE_SHORT", address(0), 0);
    }

    /// @notice Cancel an open order by id (if adapter supports it; otherwise no-op or revert).
    function cancelHyperliquidOrder(bytes32 orderId) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).cancelOrder(orderId);
        emit ProtocolInteraction("HL_CANCEL_ORDER", address(0), 0);
    }

    // --- Views ---

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

    // ============================================
    // NAV MANAGEMENT
    // ============================================

    /**
     * @notice Update NAV to reflect current portfolio value
     * @dev Called by owner/bot after calculating including off-chain (Hyperliquid) positions
     * @param newNAV New NAV value (18 decimals)
     */
    function updateNAV(uint256 newNAV) external onlyOwner {
        require(newNAV > 0, "NAV must be greater than 0");
        currentNAV = newNAV;
        emit NAVUpdateExecuted(newNAV, block.timestamp);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

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

    function emergencyWithdrawMint(uint256 batchCycle) external {
        require(paused, "Not paused");
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        require(req.user == msg.sender && req.amountIn > 0 && req.amountInUSD == 0, "Invalid request"); // Only unprocessed
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
        kashToken.transfer(msg.sender, req.kashAmount); // Return Kash
        delete userRedeemRequests[msg.sender][batchCycle];
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

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

    // ============================================
    // HELPER FUNCTIONS
    // ============================================

    /**
     * @notice Get USD value of a token amount (18 decimals)
     */
    function getTokenUSD(address token, uint256 amount) public view returns (uint256) {
        if (amount == 0) return 0;
        address oracle = tokenOracles[token];
        require(oracle != address(0), "No oracle for token");
        (, int256 price,,,) = AggregatorV3Interface(oracle).latestRoundData();
        require(price > 0, "Invalid oracle price");
        uint8 priceDec = 8; // All used feeds have 8 decimals
        uint8 tokDec = tokenDecimals[token];
        return (amount * uint256(price) * 10**18) / (10**tokDec * 10**priceDec);
    }

    /**
     * @notice Calculate token amount from USD value (18 decimals)
     */
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

    // Test helper function - should be removed or restricted in production
    function testMintKash(address to, uint256 amount) external onlyOwner {
        kashToken.mint(to, amount);
    }
}