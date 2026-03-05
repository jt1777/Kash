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

// Minimal interface for Hyperliquid
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
    function cancelOrder(bytes32 orderId) external;
    function getOpenOrderIds(address account) external view returns (bytes32[] memory);
}

// Events
event MintRequested(address indexed user, uint256 amountIn, uint256 batchCycle);
event RedeemRequested(address indexed user, uint256 kashAmount, uint256 batchCycle);
event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 exactNAV);
event TokensClaimed(address indexed user, address indexed token, uint256 amount, bool isMint);
event NAVUpdateExecuted(uint256 newNAV, uint256 timestamp);
event ProtocolInteraction(string action, address indexed asset, uint256 amount);

/**
 * @title KashYieldETH
 * @dev ETH yield product: daily batch settlement on Arbitrum. Deposits in ETH/wETH receive KASH_ETH. Integrates Aave + Hyperliquid.
 */
contract KashYieldETH {
    using SafeERC20 for IERC20;

    // Core state
    address payable public owner;
    KashTokenEth public kashTokenEth;
    uint256 public currentNAV = 1e18; // 18 decimals, $1

    // Protocol addresses (Arbitrum Sepolia)
    address public aavePoolAddress = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address public hyperliquidAddress;
    address public keeperRegistry = 0x8194399B3f11fcA2E8cCEfc4c9A658c61B8Bf412; // Chainlink Automation on Arbitrum Sepolia
    address public botAddress; // Set by owner

    // Supported tokens: ETH/wETH for user flows; USDC for Hyperliquid (deposits/collateral)
    address public constant ETH_ADDRESS = address(0);
    address public wethAddress = 0x89c8C8AD33c4a9539361a2Cf1A908C4300F258D9;
    address public usdcAddress; // For Hyperliquid

    address public ethOracle = 0x1AdF01abD96C11AEE2f20a41a03fAD11b3D8d2b4; // ETH/USD oracle
    uint8 public ethDecimals = 18;

    uint256 public feeBps = 3;
    uint256 public constant MAX_FEE_BPS = 100;

    bool public paused;

    uint256 public currentBatchCycle;
    mapping(uint256 => bool) public batchProcessed;
    mapping(uint256 => uint256) public batchIndicativeNAV;
    mapping(uint256 => uint256) public batchExactNAV;
    mapping(uint256 => uint8) public batchPhase; // 0: unstarted, 1: indicative done, 2: ops done, 3: finalized

    struct MintRequest {
        address user;
        uint256 amountIn; // ETH amount (wETH unwrapped)
        uint256 amountInUSD;
        uint256 batchCycle;
    }

    struct RedeemRequest {
        address user;
        uint256 kashAmount;
        uint256 batchCycle;
    }

    mapping(address => mapping(uint256 => MintRequest)) public userMintRequests;
    mapping(address => mapping(uint256 => RedeemRequest)) public userRedeemRequests;

    mapping(uint256 => uint256) public batchTotalMintValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemKash; // For recycling
    mapping(uint256 => uint256) public batchTotalMintEth; // Deposited ETH

    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;

    mapping(uint256 => uint256) public batchMintEthDeployedToAave;

    uint256 public constant USER_WINDOW_END = 23 * 3600 + 50 * 60;
    uint256 public constant PROCESSING_WINDOW_START = 23 * 3600 + 50 * 60;
    uint256 public constant PROCESSING_WINDOW_END = 24 * 3600;

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyUserWindow() {
        uint256 timeOfDay = block.timestamp % 86400;
        require(timeOfDay < USER_WINDOW_END, "User window closed");
        _;
    }

    modifier onlyProcessingWindow() {
        uint256 timeOfDay = block.timestamp % 86400;
        require(timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END, "Not in processing window");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    modifier onlyBotOrKeeper() {
        require(msg.sender == botAddress || msg.sender == keeperRegistry, "Only bot or Chainlink Keeper");
        _;
    }

    constructor(address _botAddress) payable {
        owner = payable(msg.sender);
        botAddress = _botAddress; // Set bot address

        kashTokenEth = new KashTokenEth();
        kashTokenEth.transferOwnership(address(this));

        currentBatchCycle = block.timestamp / 86400;
    }

    receive() external payable {}

    function setBotAddress(address _botAddress) external onlyOwner {
        botAddress = _botAddress;
    }

    function setKeeperRegistry(address _keeperRegistry) external onlyOwner {
        keeperRegistry = _keeperRegistry;
    }

    function requestMint(uint256 amount) external payable onlyUserWindow whenNotPaused {
        uint256 actualAmount;
        if (msg.value > 0) {
            actualAmount = msg.value; // ETH
        } else {
            require(amount > 0, "Amount > 0");
            IERC20(wethAddress).safeTransferFrom(msg.sender, address(this), amount);
            IWETH(wethAddress).withdraw(amount); // Unwrap to ETH
            actualAmount = amount;
        }

        uint256 batchCycle = block.timestamp / 86400;

        userMintRequests[msg.sender][batchCycle] = MintRequest({
            user: msg.sender,
            amountIn: actualAmount,
            amountInUSD: 0,
            batchCycle: batchCycle
        });

        batchTotalMintEth[batchCycle] += actualAmount;

        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }

        emit MintRequested(msg.sender, actualAmount, batchCycle);
    }

    function requestRedeem(uint256 kashAmount) external onlyUserWindow whenNotPaused {
        require(kashAmount > 0, "Amount > 0");
        require(kashTokenEth.balanceOf(msg.sender) >= kashAmount, "Insufficient KASH_ETH");

        kashTokenEth.transferFrom(msg.sender, address(this), kashAmount);

        uint256 batchCycle = block.timestamp / 86400;

        userRedeemRequests[msg.sender][batchCycle] = RedeemRequest({
            user: msg.sender,
            kashAmount: kashAmount,
            batchCycle: batchCycle
        });

        batchTotalRedeemKash[batchCycle] += kashAmount;

        if (!isInBatchRedeem[batchCycle][msg.sender]) {
            batchRedeemUsers[batchCycle].push(msg.sender);
            isInBatchRedeem[batchCycle][msg.sender] = true;
        }

        emit RedeemRequested(msg.sender, kashAmount, batchCycle);
    }

    // Cancel functions (simplified for ETH-only)
    function cancelMintRequest(uint256 batchCycle) external whenNotPaused {
        require(!batchProcessed[batchCycle], "Processed");
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        require(req.amountIn > 0, "No request");

        uint256 amount = req.amountIn;
        batchTotalMintEth[batchCycle] -= amount;
        delete userMintRequests[msg.sender][batchCycle];

        payable(msg.sender).transfer(amount);
        emit ProtocolInteraction("CANCEL_MINT", ETH_ADDRESS, amount);
    }

    function cancelRedeemRequest(uint256 batchCycle) external whenNotPaused {
        require(!batchProcessed[batchCycle], "Processed");
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        require(req.kashAmount > 0, "No request");

        uint256 kashAmount = req.kashAmount;
        batchTotalRedeemKash[batchCycle] -= kashAmount;
        delete userRedeemRequests[msg.sender][batchCycle];

        kashTokenEth.transfer(msg.sender, kashAmount);
        emit ProtocolInteraction("CANCEL_REDEEM", address(kashTokenEth), kashAmount);
    }

    // Chainlink Upkeep
    function checkUpkeep(bytes calldata /* checkData */) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 batchCycle = block.timestamp / 86400;
        uint256 timeOfDay = block.timestamp % 86400;
        upkeepNeeded = (timeOfDay >= PROCESSING_WINDOW_START && timeOfDay < PROCESSING_WINDOW_END) && !batchProcessed[batchCycle];
        performData = "";
    }

    function performUpkeep(bytes calldata /* performData */) external onlyBotOrKeeper {
        uint256 batchCycle = block.timestamp / 86400;
        uint8 phase = batchPhase[batchCycle];
        if (phase == 0) {
            processBatchPhase1();
        } else if (phase == 2) {
            processBatchPhase2();
        }
    }

    // Phase 1: Indicative calcs
    function processBatchPhase1() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / 86400;
        require(batchPhase[batchCycle] == 0, "Phase started");

        uint256 ethPrice = getEthPrice(); // Fixed price for batch
        uint256 indicativeNAV = currentNAV;

        uint256 totalMintUSD = 0;
        address[] memory minters = batchMintUsers[batchCycle];
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest storage req = userMintRequests[minters[i]][batchCycle];
            if (req.amountIn > 0) {
                req.amountInUSD = (req.amountIn * ethPrice) / 1e18; // Assuming price 18 dec
                totalMintUSD += req.amountInUSD;
            }
        }
        batchTotalMintValueUSD[batchCycle] = totalMintUSD;

        uint256 totalRedeemUSD = 0;
        uint256 totalRedeemKash = 0;
        address[] memory redeemers = batchRedeemUsers[batchCycle];
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.kashAmount > 0) {
                totalRedeemUSD += (req.kashAmount * indicativeNAV) / 1e18;
                totalRedeemKash += req.kashAmount;
            }
        }
        batchTotalRedeemValueUSD[batchCycle] = totalRedeemUSD;
        batchTotalRedeemKash[batchCycle] = totalRedeemKash;

        batchIndicativeNAV[batchCycle] = indicativeNAV;

        int256 netPositionUSD = int256(totalMintUSD) - int256(totalRedeemUSD);
        if (netPositionUSD > 0) {
            emit ProtocolInteraction("NET_MINT", ETH_ADDRESS, uint256(netPositionUSD));
        } else if (netPositionUSD < 0) {
            emit ProtocolInteraction("NET_REDEEM", ETH_ADDRESS, uint256(-netPositionUSD));
        }

        batchPhase[batchCycle] = 1;
        emit BatchPhaseUpdated(batchCycle, 1, indicativeNAV);
    }

    // Owner marks ops done after Aave/Hyperliquid and updateNAV
    function markBatchOpsDone(uint256 batchCycle) external onlyOwner {
        require(batchPhase[batchCycle] == 1, "Wrong phase");
        batchPhase[batchCycle] = 2;
        emit BatchPhaseUpdated(batchCycle, 2, currentNAV); // Now exact
    }

    // Phase 2: Final distributions with exact NAV (current cycle only, time-gated)
    function processBatchPhase2() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / 86400;
        require(batchPhase[batchCycle] == 2, "Ops not done");
        _processBatchPhase2(batchCycle);
    }

    /// @notice Run Phase 2 for a specific batch (e.g. orphaned batch). Bot/keeper only. No time window.
    function processBatchPhase2ForCycle(uint256 batchCycle) external onlyBotOrKeeper {
        require(batchPhase[batchCycle] == 2, "Ops not done");
        require(batchCycle != block.timestamp / 86400, "Use performUpkeep for current");
        _processBatchPhase2(batchCycle);
    }

    function _processBatchPhase2(uint256 batchCycle) internal {
        uint256 exactNAV = currentNAV;
        batchExactNAV[batchCycle] = exactNAV;

        uint256 ethPrice = getEthPrice(); // Same as phase1, but refetch for exactness

        // Calc total mint KASH needed (after fee)
        uint256 totalMintKash = 0;
        address[] memory minters = batchMintUsers[batchCycle];
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest memory req = userMintRequests[minters[i]][batchCycle];
            if (req.amountInUSD > 0) {
                uint256 amountAfterFee = req.amountInUSD * (10000 - feeBps) / 10000;
                totalMintKash += (amountAfterFee * 1e18) / exactNAV;
            }
        }

        uint256 totalRedeemKash = batchTotalRedeemKash[batchCycle];

        // Minters receive exactly totalMintKash (their entitlement). Recycled KASH covers what it can; rest is mint or burn.
        int256 netKash = int256(totalMintKash) - int256(totalRedeemKash);
        if (netKash > 0) {
            kashTokenEth.mint(address(this), uint256(netKash)); // Mint shortfall so we have enough to distribute
        } else if (netKash < 0) {
            kashTokenEth.burn(address(this), uint256(-netKash)); // Burn excess: redeemers gave more KASH than minters need
        }
        // totalDistributableKash = totalMintKash (minters get exactly what they're entitled to)
        uint256 totalDistributableKash = totalMintKash;
        for (uint256 i = 0; i < minters.length; i++) {
            address user = minters[i];
            MintRequest memory req = userMintRequests[user][batchCycle];
            if (req.amountInUSD > 0) {
                uint256 userShare = (req.amountInUSD * totalDistributableKash) / batchTotalMintValueUSD[batchCycle];
                kashTokenEth.transfer(user, userShare);
                emit TokensClaimed(user, address(kashTokenEth), userShare, true);
            }
        }

        // Explicit ETH recycling: total ETH needed for redeem payouts vs mint deposits
        address[] memory redeemers = batchRedeemUsers[batchCycle];
        uint256 totalRedeemEthNeeded = 0;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.kashAmount > 0) {
                uint256 usdValue = (req.kashAmount * exactNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                totalRedeemEthNeeded += (usdAfterFee * 1e18) / ethPrice;
            }
        }

        require(address(this).balance >= totalRedeemEthNeeded, "Insufficient ETH for redeems");

        uint256 availableDepositEth = batchTotalMintEth[batchCycle];
        uint256 netEthNeeded = totalRedeemEthNeeded > availableDepositEth ? totalRedeemEthNeeded - availableDepositEth : 0;
        if (netEthNeeded > 0) {
            // Owner must have withdrawn netEthNeeded from Aave during ops before Phase 2 (no on-chain check)
        }
        uint256 excessMintEth = availableDepositEth > totalRedeemEthNeeded ? availableDepositEth - totalRedeemEthNeeded : 0;
        if (excessMintEth > 0) {
            emit ProtocolInteraction("NET_MINT_ETH_DEPLOY", ETH_ADDRESS, excessMintEth); // Signal for owner to deploy to Aave
        }

        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            RedeemRequest memory req = userRedeemRequests[user][batchCycle];
            if (req.kashAmount > 0) {
                uint256 usdValue = (req.kashAmount * exactNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                uint256 ethAmount = (usdAfterFee * 1e18) / ethPrice;
                payable(user).transfer(ethAmount);
                emit TokensClaimed(user, ETH_ADDRESS, ethAmount, false);
            }
        }

        batchProcessed[batchCycle] = true;
        batchPhase[batchCycle] = 3;

        emit BatchProcessed(batchCycle, batchTotalMintValueUSD[batchCycle], batchTotalRedeemValueUSD[batchCycle], exactNAV);
    }

    function depositToAave(uint256 amount) external onlyOwner {
        IWETH(wethAddress).deposit{value: amount}();
        IERC20(wethAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wethAddress, amount, address(this), 0);
        emit ProtocolInteraction("AAVE_DEPOSIT", wethAddress, amount);
    }

    function withdrawFromAave(uint256 amount) external onlyOwner {
        IPool(aavePoolAddress).withdraw(wethAddress, amount, address(this));
        IWETH(wethAddress).withdraw(amount);
        emit ProtocolInteraction("AAVE_WITHDRAW", ETH_ADDRESS, amount);
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

    function addCollateralToAave(uint256 amount) external onlyOwner {
        IWETH(wethAddress).deposit{value: amount}();
        IERC20(wethAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wethAddress, amount, address(this), 0);
        emit ProtocolInteraction("AAVE_ADD_COLLATERAL", wethAddress, amount);
    }

    // --- Hyperliquid ---
    function setHyperliquid(address _hyperliquidAddress) external onlyOwner {
        hyperliquidAddress = _hyperliquidAddress;
    }

    function depositToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAddress != address(0), "USDC not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_DEPOSIT", usdcAddress, amount);
    }

    function withdrawFromHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAddress != address(0), "USDC not set");
        require(amount > 0, "Amount must be > 0");
        IHyperliquid(hyperliquidAddress).withdrawFromSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_WITHDRAW", usdcAddress, amount);
    }

    function addCollateralToHyperliquid(uint256 amount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAddress != address(0), "USDC not set");
        require(amount > 0, "Amount must be > 0");
        IERC20(usdcAddress).forceApprove(hyperliquidAddress, amount);
        IHyperliquid(hyperliquidAddress).depositToSpotWallet(usdcAddress, amount);
        emit ProtocolInteraction("HL_ADD_COLLATERAL", usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(size > 0, "Size must be > 0");
        IHyperliquid(hyperliquidAddress).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction("HL_OPEN_SHORT", ETH_ADDRESS, size);
    }

    function closeShort(string calldata symbol) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).closePerpPosition(symbol);
        emit ProtocolInteraction("HL_CLOSE_SHORT", ETH_ADDRESS, 0);
    }

    function spotBuyOnHyperliquid(uint256 usdcAmount) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAddress != address(0), "USDC not set");
        require(usdcAmount > 0, "Amount must be > 0");
        uint256 amountOut = IHyperliquid(hyperliquidAddress).tradeSpot(usdcAddress, ETH_ADDRESS, usdcAmount);
        emit ProtocolInteraction("HL_SPOT_BUY", ETH_ADDRESS, amountOut);
    }

    function spotSellOnHyperliquid(uint256 amount) external payable onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        require(usdcAddress != address(0), "USDC not set");
        require(amount > 0, "Amount must be > 0");
        require(msg.value == amount, "ETH amount must match msg.value");
        uint256 amountOut = IHyperliquid(hyperliquidAddress).tradeSpot{value: amount}(ETH_ADDRESS, usdcAddress, amount);
        emit ProtocolInteraction("HL_SPOT_SELL", usdcAddress, amountOut);
    }

    function cancelHyperliquidOrder(bytes32 orderId) external onlyOwner {
        require(hyperliquidAddress != address(0), "Hyperliquid not set");
        IHyperliquid(hyperliquidAddress).cancelOrder(orderId);
        emit ProtocolInteraction("HL_CANCEL_ORDER", ETH_ADDRESS, 0);
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

    // --- Admin: NAV and config (call updateNAV after Aave/Hyperliquid ops, before markBatchOpsDone) ---
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

    function setWethAddress(address _weth) external onlyOwner {
        require(_weth != address(0), "Invalid address");
        wethAddress = _weth;
    }

    function setUsdcAddress(address _usdc) external onlyOwner {
        usdcAddress = _usdc;
    }

    function setEthOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Invalid oracle address");
        ethOracle = _oracle;
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }

    /// @notice Returns ETH reserved for users: unprocessed cycle (mint + redeem estimate), or if processed then mint ETH not yet deployed to Aave.
    function getReservedEth() public view returns (uint256) {
        uint256 currentCycle = block.timestamp / 86400;
        uint256 reserved = 0;

        if (!batchProcessed[currentCycle]) {
            reserved += batchTotalMintEth[currentCycle];
            uint256 redeemUsdEstimate = (batchTotalRedeemKash[currentCycle] * currentNAV) / 1e18;
            uint256 redeemEthEstimate = (redeemUsdEstimate * (10000 - feeBps) / 10000 * 1e18) / getEthPrice();
            reserved += redeemEthEstimate;
        } else {
            uint256 minted = batchTotalMintEth[currentCycle];
            uint256 deployed = batchMintEthDeployedToAave[currentCycle];
            if (minted > deployed) reserved += (minted - deployed);
        }
        return reserved;
    }

    /// @notice Call after depositing a cycle's mint ETH to Aave. Only owner.
    function markMintEthDeployed(uint256 batchCycle, uint256 amount) external onlyOwner {
        uint256 minted = batchTotalMintEth[batchCycle];
        require(batchMintEthDeployedToAave[batchCycle] + amount <= minted, "Exceeds mint ETH for cycle");
        batchMintEthDeployedToAave[batchCycle] += amount;
        emit ProtocolInteraction("MINT_ETH_DEPLOYED", ETH_ADDRESS, amount);
    }

    /// @notice Withdraw only excess ETH to the owner. Cannot withdraw reserved ETH.
    function ownerWithdrawEth(uint256 amount) external onlyOwner {
        uint256 reserved = getReservedEth();
        require(amount + reserved <= address(this).balance, "Insufficient excess ETH");
        payable(owner).transfer(amount);
        emit ProtocolInteraction("OWNER_WITHDRAW_ETH", ETH_ADDRESS, amount);
    }

    function emergencyWithdrawMint(uint256 batchCycle) external {
        require(paused, "Not paused");
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        require(req.user == msg.sender && req.amountIn > 0 && req.amountInUSD == 0, "Invalid request");
        payable(msg.sender).transfer(req.amountIn);
        delete userMintRequests[msg.sender][batchCycle];
    }

    function emergencyWithdrawRedeem(uint256 batchCycle) external {
        require(paused, "Not paused");
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        require(req.user == msg.sender && req.kashAmount > 0, "Invalid request");
        kashTokenEth.transfer(msg.sender, req.kashAmount);
        delete userRedeemRequests[msg.sender][batchCycle];
    }

    function getEthPrice() public view returns (uint256) {
        (, int256 price,,,) = AggregatorV3Interface(ethOracle).latestRoundData();
        require(price > 0, "Invalid price");
        uint8 dec = AggregatorV3Interface(ethOracle).decimals();
        return uint256(price) * 10 ** (18 - dec);
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

    function getCurrentBatchCycle() external view returns (uint256) {
        return block.timestamp / 86400;
    }
}