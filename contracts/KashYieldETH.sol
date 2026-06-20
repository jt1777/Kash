// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashTokenEth.sol";
import "./ExchangeFacade.sol";
import "./libraries/MerkleVerify.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./interfaces/ISpotDex.sol";

// ─── Aave V3 Pool interface ───────────────────────────────────────────────────
interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getATokenBalance(address asset, address user) external view returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
}

// ─── WETH interface ───────────────────────────────────────────────────────────
interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

// ─── Custom errors ────────────────────────────────────────────────────────────
error OnlyOwner();
error OnlyBotOrKeeper();
error UserWindowClosed();
error NotInProcessingWindow();
error ContractPaused();
error ZeroAmount();
error AlreadyProcessed();
error NoRequest();
error InsufficientKashEth();
error PhaseAlreadyStarted();
error WrongPhase();
error OpsNotDone();
error UsePerformUpkeep();
error InsufficientEthForRedeems();
error InsufficientEthInContract();
error InsufficientExcessEth();
error InsufficientOwnerEthReserve();
error InsufficientOwnerUsdcReserve();
error ExceedsMintEthForCycle();
error NoUsersProvided();
error NotPaused();
error InvalidRequest();
error InvalidNAV();
error InvalidPrice();
error FeeTooHigh();
error SpotDexNotSet();
error NotPendingOwner();
error MinCycleDuration();
error InvalidAddress();
error NoPendingRedeemRequest();
error MintCapReached();
error RedeemCapReached();
error UseBotPhase2();
error InvalidMerkleRoot();
error AlreadyClaimed();
error ClaimExpired();
error InvalidProof();
error ClaimsNotExpired();

// ─── Events ───────────────────────────────────────────────────────────────────
event MintRequested(address indexed user, uint256 amountIn, uint256 batchCycle);
event RedeemRequested(address indexed user, uint256 kashAmount, uint256 batchCycle);
event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 exactNAV);
event TokensClaimed(address indexed user, address indexed token, uint256 amount, bool isMint);
event NAVUpdateExecuted(uint256 newNAV, uint256 timestamp);
    event NAVProposedAndUpdated(uint256 newNAV, uint256 usdcBalance, uint256 assetBalance, uint256 perpPnL, uint256 timestamp);
event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);
event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
event RedeemMerkleRootCommitted(uint256 indexed batchCycle, bytes32 root, uint256 totalNetClaimable, uint256 claimDeadline);
event RedeemMerkleRootOverridden(uint256 indexed batchCycle, bytes32 oldRoot, bytes32 newRoot);
event MintMerkleRootCommitted(uint256 indexed batchCycle, bytes32 root, uint256 totalMintClaimable, uint256 claimDeadline);
event MintMerkleRootOverridden(uint256 indexed batchCycle, bytes32 oldRoot, bytes32 newRoot);
event ExpiredClaimsSwept(uint256 indexed batchCycle, uint256 amountSwept);
event ExpiredMintClaimsSwept(uint256 indexed batchCycle, uint256 amountSwept);
event MaxMintUsersUpdated(uint256 newMax);
event MaxRedeemUsersUpdated(uint256 newMax);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
event FeeUpdated(uint256 newFeeBps);
event OracleUpdated(address indexed newOracle);

/**
 * @title KashYieldETH
 * @dev ETH yield product: daily batch settlement on Arbitrum. Deposits in ETH/wETH receive KASH_ETH.
 * Integrates Aave V3 for collateral/borrowing and any IPerpExchange adapter for hedging.
 *
 * EXCHANGE REGISTRY: perpExchanges maps string names ("HL", "GMX", "ASTER", ...) to adapter
 * addresses. activePerpExchange selects which one is used. Registering a new adapter requires
 * a 24-hour timelock (propose → confirm). Switching the active exchange is immediate once the
 * adapter is confirmed. Adding a new exchange never requires redeploying this contract.
 */
contract KashYieldETH is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant ETH_DECIMALS = 18;
    string public constant VERSION = "2.0.0";

    // ── Core state ────────────────────────────────────────────────────────
    address payable public owner;
    address public pendingOwner;
    KashTokenEth public kashTokenEth;
    uint256 public currentNAV = 1e18;

    // ── Protocol addresses ────────────────────────────────────────────────
    address public immutable aavePoolAddress; // Aave V3 Pool — hardcoded in constructor
    address public keeperRegistry = address(0); // set via setKeeperRegistry() if using Chainlink Automation
    address public botAddress;

    address public constant ETH_ADDRESS = address(0);
    address public immutable wethAddress; // WETH9-compatible contract with deposit()/withdraw()
    address public immutable usdcAddress;
    address public exchangeFacade;
    address public spotDexAddress;
    uint256 public maxSwapSlippageBps = 100;
    address public ethOracle = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612; // Chainlink ETH/USD — Arbitrum One
    uint8   public ethDecimals = 18;

    uint256 private constant REDEEM_PAYOUT_TOLERANCE = 1e13; // wei — rounding vs locked G
    uint256 public constant MAX_MINT_USERS_CEILING = 100_000;
    uint256 public constant MAX_REDEEM_USERS_CEILING = 100_000;
    uint256 public maxMintUsers = 10_000;
    uint256 public maxRedeemUsers = 10_000;
    uint256 public constant CLAIM_EXPIRY_SECONDS = 30 days;

    // ── Fee config ────────────────────────────────────────────────────────
    uint256 public feeBps = 3;
    uint256 public constant MAX_FEE_BPS = 100;

    bool public paused;

    /// @notice Owner / treasury USDC credited on-chain but excluded from user NAV accounting (see markOwnerUsdcDeposit).
    uint256 public ownerUsdcReserve;
    /// @notice Owner ETH buffer (gas, HL fees, profit) excluded from user NAV accounting (see markOwnerEthDeposit).
    uint256 public ownerEthReserve;
    /// @notice Current owner ETH reserve that came from protocol mint/redeem fees.
    uint256 public protocolFeeEthReserve;
    uint256 public lockedClaimEth;
    uint256 public lockedClaimKash;

    struct BatchClaimInfo {
        bytes32 redeemMerkleRoot;
        bytes32 mintMerkleRoot;
        uint256 totalNetClaimable;
        uint256 totalMintClaimable;
        uint256 claimDeadline;
        uint256 claimedAmount;
        uint256 mintClaimedAmount;
    }
    mapping(uint256 => BatchClaimInfo) public batchClaimInfo;
    mapping(uint256 => mapping(address => bool)) public redeemClaimed;
    mapping(uint256 => mapping(address => bool)) public mintClaimed;
    mapping(uint256 => uint256) public activeMintUsers;
    mapping(uint256 => uint256) public activeRedeemUsers;

    // ── Batch state ───────────────────────────────────────────────────────
    mapping(uint256 => bool)    public batchProcessed;
    mapping(uint256 => uint256) public batchIndicativeNAV;
    mapping(uint256 => uint8)   public batchPhase;

    struct MintRequest {
        address user;
        uint256 amountIn;
        uint256 amountInUSD;
        uint256 batchCycle;
    }
    struct RedeemRequest {
        address user;
        uint256 kashAmount;
        uint256 redeemValueUSD;
        uint256 batchCycle;
    }

    mapping(address => mapping(uint256 => MintRequest))  public userMintRequests;
    mapping(address => mapping(uint256 => RedeemRequest)) public userRedeemRequests;

    mapping(uint256 => uint256) public batchTotalMintValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemKash;
    mapping(uint256 => uint256) public batchTotalMintEth;
    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;
    mapping(uint256 => uint256) public batchMintEthDeployedToAave;
    mapping(address => uint256) public totalDepositedEthByUser;
    mapping(address => uint256) public totalRedeemedEthByUser;

    // Time-window boundaries (seconds into the cycle).
    // Default: users can request mints/redeems for the first 23h 45m of each cycle,
    // then a 15-minute processing window closes user submissions so the bot can settle.
    // Set userWindowEnd = cycleDurationSeconds and processingWindowStart = 0 to disable windowing.
    uint256 public userWindowEnd         = 23 * 3600 + 45 * 60; // 85500 s = 23 h 45 m
    uint256 public processingWindowStart = 23 * 3600 + 45 * 60; // 85500 s = 23 h 45 m
    uint256 public cycleDurationSeconds  = 86400;

    // ── Modifiers ─────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }
    modifier onlyUserWindow() {
        if (block.timestamp % cycleDurationSeconds >= userWindowEnd) revert UserWindowClosed();
        _;
    }
    modifier onlyProcessingWindow() {
        uint256 t = block.timestamp % cycleDurationSeconds;
        if (t < processingWindowStart || t >= cycleDurationSeconds) revert NotInProcessingWindow();
        _;
    }
    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }
    modifier onlyBotOrKeeper() {
        if (msg.sender != botAddress && msg.sender != keeperRegistry) revert OnlyBotOrKeeper();
        _;
    }

    constructor(address _botAddress, address _weth, address _usdc) payable {
        owner = payable(msg.sender);
        botAddress = _botAddress;
        kashTokenEth = new KashTokenEth();
        kashTokenEth.transferOwnership(address(this));

        // Hard-coded mainnet addresses
        aavePoolAddress = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        wethAddress     = _weth;
        usdcAddress     = _usdc;

    }

    function setExchangeFacade(address _facade) external onlyOwner {
        if (_facade == address(0)) revert InvalidAddress();
        exchangeFacade = _facade;
    }

    function approveExchangeFacadeUsdc(uint256 amount) external onlyBotOrKeeper {
        if (exchangeFacade == address(0)) revert InvalidAddress();
        IERC20(usdcAddress).forceApprove(exchangeFacade, amount);
    }

    function setSpotDex(address _spotDex) external onlyOwner {
        if (_spotDex == address(0)) revert InvalidAddress();
        spotDexAddress = _spotDex;
    }

    function setMaxSwapSlippageBps(uint256 _bps) external onlyOwner {
        if (_bps > 500) revert FeeTooHigh();
        maxSwapSlippageBps = _bps;
    }

    function hyperliquidAddress() external view returns (address) {
        return exchangeFacade == address(0) ? address(0) : ExchangeFacade(exchangeFacade).hyperliquidAddress();
    }

    function getHyperliquidSpotBalance() external view returns (uint256) {
        return exchangeFacade == address(0) ? 0 : ExchangeFacade(exchangeFacade).getHyperliquidSpotBalance();
    }

    function getExchangeAssetBalance() external view returns (uint256) {
        return exchangeFacade == address(0) ? 0 : ExchangeFacade(exchangeFacade).getExchangeAssetBalance();
    }

    function getHyperliquidPosition(string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        if (exchangeFacade == address(0)) return (0, 0, 0, false, false);
        return ExchangeFacade(exchangeFacade).getHyperliquidPosition(symbol);
    }

    receive() external payable {}

    // ── Ownership (two-step) ──────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = payable(pendingOwner);
        pendingOwner = address(0);
    }

    // ── Admin setters ─────────────────────────────────────────────────────

    function setBotAddress(address _botAddress) external onlyOwner { botAddress = _botAddress; }
    function setCycleDurationSeconds(uint256 _seconds) external onlyOwner {
        if (_seconds < 60) revert MinCycleDuration();
        cycleDurationSeconds = _seconds;
    }
    /// @notice Set when user submissions close within a cycle.
    ///         Use cycleDurationSeconds to disable (keeps window open the entire cycle).
    function setUserWindowEnd(uint256 _seconds) external onlyOwner {
        require(_seconds <= cycleDurationSeconds, "userWindowEnd > cycleDurationSeconds");
        userWindowEnd = _seconds;
    }
    /// @notice Set when the bot's processing window opens within a cycle.
    ///         Use 0 to disable (bot can always process). Must equal userWindowEnd in production.
    function setProcessingWindowStart(uint256 _seconds) external onlyOwner {
        require(_seconds <= cycleDurationSeconds, "processingWindowStart > cycleDurationSeconds");
        processingWindowStart = _seconds;
    }
    function setKeeperRegistry(address _keeperRegistry) external onlyOwner { keeperRegistry = _keeperRegistry; }
    function setEthOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidAddress();
        ethOracle = _oracle;
        emit OracleUpdated(_oracle);
    }
    function setFeeBps(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFee;
        emit FeeUpdated(newFee);
    }
    function setMaxMintUsers(uint256 newMax) external onlyOwner {
        if (newMax == 0 || newMax > MAX_MINT_USERS_CEILING) revert InvalidRequest();
        maxMintUsers = newMax;
        emit MaxMintUsersUpdated(newMax);
    }
    function setMaxRedeemUsers(uint256 newMax) external onlyOwner {
        if (newMax == 0 || newMax > MAX_REDEEM_USERS_CEILING) revert InvalidRequest();
        maxRedeemUsers = newMax;
        emit MaxRedeemUsersUpdated(newMax);
    }
    function pause()   external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    // ── User-facing: mint / redeem ────────────────────────────────────────

    function requestMint(uint256 amount) external payable onlyUserWindow whenNotPaused {
        uint256 actualAmount;
        if (msg.value > 0) {
            actualAmount = msg.value;
        } else {
            if (amount == 0) revert ZeroAmount();
            IERC20(wethAddress).safeTransferFrom(msg.sender, address(this), amount);
            IWETH(wethAddress).withdraw(amount);
            actualAmount = amount;
        }
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        // Accumulate into the existing request so multiple deposits in the same window
        // are treated as one combined request.
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        bool wasActive = req.amountIn > 0;
        req.user = msg.sender;
        req.amountIn += actualAmount;
        req.batchCycle = batchCycle;
        uint256 ethPrice = getEthPrice();
        uint256 usdIncrement = (actualAmount * ethPrice) / (10 ** ETH_DECIMALS);
        req.amountInUSD += usdIncrement;
        batchTotalMintValueUSD[batchCycle] += usdIncrement;
        batchTotalMintEth[batchCycle] += actualAmount;
        if (!wasActive) {
            if (activeMintUsers[batchCycle] >= maxMintUsers) revert MintCapReached();
            unchecked { activeMintUsers[batchCycle]++; }
        }
        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }
        emit MintRequested(msg.sender, actualAmount, batchCycle);
    }

    function requestRedeem(uint256 kashAmount) external onlyUserWindow whenNotPaused {
        if (kashAmount == 0) revert ZeroAmount();
        if (kashTokenEth.balanceOf(msg.sender) < kashAmount) revert InsufficientKashEth();
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        kashTokenEth.transferFrom(msg.sender, address(this), kashAmount);
        // Accumulate into the existing request so multiple redeems in the same window
        // are treated as one combined request.
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        bool wasActive = req.kashAmount > 0;
        req.user = msg.sender;
        req.kashAmount += kashAmount;
        req.batchCycle = batchCycle;
        uint256 usdIncrement = (kashAmount * currentNAV) / 1e18;
        req.redeemValueUSD += usdIncrement;
        batchTotalRedeemValueUSD[batchCycle] += usdIncrement;
        batchTotalRedeemKash[batchCycle] += kashAmount;
        if (!wasActive) {
            if (activeRedeemUsers[batchCycle] >= maxRedeemUsers) revert RedeemCapReached();
            unchecked { activeRedeemUsers[batchCycle]++; }
        }
        if (!isInBatchRedeem[batchCycle][msg.sender]) {
            batchRedeemUsers[batchCycle].push(msg.sender);
            isInBatchRedeem[batchCycle][msg.sender] = true;
        }
        emit RedeemRequested(msg.sender, kashAmount, batchCycle);
    }

    function cancelMintRequest(uint256 batchCycle) external whenNotPaused {
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.amountIn == 0) revert NoRequest();
        uint256 amount = req.amountIn;
        uint256 usdAmount = req.amountInUSD;
        batchTotalMintEth[batchCycle] -= amount;
        batchTotalMintValueUSD[batchCycle] -= usdAmount;
        unchecked { activeMintUsers[batchCycle]--; }
        delete userMintRequests[msg.sender][batchCycle];
        payable(msg.sender).transfer(amount);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_MINT, ETH_ADDRESS, amount);
    }

    function cancelRedeemRequest(uint256 batchCycle) external whenNotPaused {
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        if (req.kashAmount == 0) revert NoRequest();
        uint256 kashAmount = req.kashAmount;
        uint256 usdAmount = req.redeemValueUSD;
        batchTotalRedeemKash[batchCycle] -= kashAmount;
        batchTotalRedeemValueUSD[batchCycle] -= usdAmount;
        unchecked { activeRedeemUsers[batchCycle]--; }
        delete userRedeemRequests[msg.sender][batchCycle];
        kashTokenEth.transfer(msg.sender, kashAmount);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_REDEEM, address(kashTokenEth), kashAmount);
    }

    // ── Chainlink Upkeep ──────────────────────────────────────────────────

    function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData) {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        uint256 t = block.timestamp % cycleDurationSeconds;
        upkeepNeeded = (t >= processingWindowStart && t < cycleDurationSeconds) && !batchProcessed[batchCycle];
        performData = "";
    }

    function performUpkeep(bytes calldata) external onlyBotOrKeeper {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        uint8 phase = batchPhase[batchCycle];
        if (phase == 0) processBatchPhase1();
        else if (phase == 2) {
            if (batchTotalRedeemKash[batchCycle] > 0 || batchTotalMintValueUSD[batchCycle] > 0) revert UseBotPhase2();
            processBatchPhase2();
        }
    }

    // ── Batch Phase 1 ─────────────────────────────────────────────────────

    function processBatchPhase1() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert PhaseAlreadyStarted();

        uint256 indicativeNAV = currentNAV;
        uint256 totalMintUSD = batchTotalMintValueUSD[batchCycle];
        uint256 totalRedeemUSD = batchTotalRedeemValueUSD[batchCycle];
        batchIndicativeNAV[batchCycle] = indicativeNAV;

        int256 netPositionUSD = int256(totalMintUSD) - int256(totalRedeemUSD);
        if (netPositionUSD > 0) emit ProtocolInteraction(ProtocolActionCodes.NET_MINT, ETH_ADDRESS, uint256(netPositionUSD));
        else if (netPositionUSD < 0) emit ProtocolInteraction(ProtocolActionCodes.NET_REDEEM, ETH_ADDRESS, uint256(-netPositionUSD));

        batchPhase[batchCycle] = 1;
        emit BatchPhaseUpdated(batchCycle, 1, indicativeNAV);
    }

    function markBatchOpsDone(uint256 batchCycle, uint256 grossRedeemAssetAmount) external onlyBotOrKeeper {
        if (batchPhase[batchCycle] != 1) revert WrongPhase();
        if (batchTotalRedeemKash[batchCycle] > 0) {
            if (grossRedeemAssetAmount == 0) revert InsufficientEthForRedeems();
            batchTotalRedeemValueUSD[batchCycle] = grossRedeemAssetAmount;
        }
        batchPhase[batchCycle] = 2;
        emit BatchPhaseUpdated(batchCycle, 2, currentNAV);
    }

    // ── Batch Phase 2 ─────────────────────────────────────────────────────

    function processBatchPhase2() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 2) revert OpsNotDone();
        _processBatchPhase2(batchCycle, bytes32(0), bytes32(0));
    }

    function processBatchPhase2ForCycle(
        uint256 batchCycle,
        bytes32 redeemMerkleRoot,
        bytes32 mintMerkleRoot
    ) external onlyBotOrKeeper nonReentrant {
        if (batchPhase[batchCycle] != 2) revert OpsNotDone();
        if (batchTotalRedeemKash[batchCycle] > 0 && redeemMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (batchTotalMintValueUSD[batchCycle] > 0 && mintMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        _processBatchPhase2(batchCycle, redeemMerkleRoot, mintMerkleRoot);
    }

    function _allocRedeemEth(
        uint256 batchCycle,
        address[] memory redeemers,
        uint256 totalRedeemKash,
        uint256 totalGrossRedeem
    ) private view returns (uint256[] memory amounts, uint256 totalNet, uint256 totalFee) {
        amounts = new uint256[](redeemers.length);
        uint256 kashLeft = totalRedeemKash;
        uint256 grossLeft = totalGrossRedeem;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.kashAmount == 0) continue;
            uint256 gross = kashLeft == req.kashAmount
                ? grossLeft
                : (totalGrossRedeem * req.kashAmount) / totalRedeemKash;
            kashLeft -= req.kashAmount;
            grossLeft -= gross;
            uint256 fee = gross * feeBps / 10000;
            amounts[i] = gross - fee;
            totalNet += amounts[i];
            totalFee += fee;
        }
    }

    function _processBatchPhase2(uint256 batchCycle, bytes32 redeemMerkleRoot, bytes32 mintMerkleRoot) internal {
        uint256 exactNAV = currentNAV;

        address[] memory redeemers = batchRedeemUsers[batchCycle];

        uint256 totalMintUSD = batchTotalMintValueUSD[batchCycle];
        uint256 totalMintKash = 0;
        if (totalMintUSD > 0) {
            uint256 amountAfterFeeTotal = totalMintUSD * (10000 - feeBps) / 10000;
            totalMintKash = (amountAfterFeeTotal * 1e18) / exactNAV;
        }
        uint256 totalMintFeeEth = batchTotalMintEth[batchCycle] * feeBps / 10000;

        uint256 totalRedeemKash = batchTotalRedeemKash[batchCycle];
        (, uint256 totalRedeemEthNeeded, uint256 totalRedeemFeeEth) =
            _allocRedeemEth(batchCycle, redeemers, totalRedeemKash, batchTotalRedeemValueUSD[batchCycle]);
        uint256 totalProtocolFeeEth = totalMintFeeEth + totalRedeemFeeEth;
        if (address(this).balance + REDEEM_PAYOUT_TOLERANCE < ownerEthReserve + totalProtocolFeeEth + totalRedeemEthNeeded + lockedClaimEth) revert InsufficientEthForRedeems();
        ownerEthReserve += totalProtocolFeeEth;
        protocolFeeEthReserve += totalProtocolFeeEth;

        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        uint256 claimDeadline = block.timestamp + CLAIM_EXPIRY_SECONDS;

        if (totalRedeemKash > 0) {
            lockedClaimEth += totalRedeemEthNeeded;
            info.redeemMerkleRoot = redeemMerkleRoot;
            info.totalNetClaimable = totalRedeemEthNeeded;
            info.claimDeadline = claimDeadline;
            emit RedeemMerkleRootCommitted(batchCycle, redeemMerkleRoot, totalRedeemEthNeeded, claimDeadline);
        }

        if (totalMintKash > 0) {
            lockedClaimKash += totalMintKash;
            info.mintMerkleRoot = mintMerkleRoot;
            info.totalMintClaimable = totalMintKash;
            info.claimDeadline = claimDeadline;
            emit MintMerkleRootCommitted(batchCycle, mintMerkleRoot, totalMintKash, claimDeadline);
        }

        batchProcessed[batchCycle] = true;
        batchPhase[batchCycle] = 3;
        emit BatchProcessed(batchCycle, batchTotalMintValueUSD[batchCycle], batchTotalRedeemValueUSD[batchCycle], exactNAV);

        int256 netKash = int256(totalMintKash) - int256(totalRedeemKash);
        if (netKash > 0) kashTokenEth.mint(address(this), uint256(netKash));
        else if (netKash < 0) kashTokenEth.burn(address(this), uint256(-netKash));
    }

    function claimMint(uint256 batchCycle, uint256 kashAmount, bytes32[] calldata proof) external nonReentrant whenNotPaused {
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (info.mintMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (mintClaimed[batchCycle][msg.sender]) revert AlreadyClaimed();
        if (block.timestamp > info.claimDeadline) revert ClaimExpired();

        bytes32 leaf = keccak256(abi.encode(batchCycle, msg.sender, kashAmount));
        if (!MerkleVerify.verify(proof, info.mintMerkleRoot, leaf)) revert InvalidProof();

        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.amountIn == 0) revert NoRequest();

        mintClaimed[batchCycle][msg.sender] = true;
        info.mintClaimedAmount += kashAmount;
        lockedClaimKash -= kashAmount;
        totalDepositedEthByUser[msg.sender] += req.amountIn;
        kashTokenEth.transfer(msg.sender, kashAmount);
        emit TokensClaimed(msg.sender, address(kashTokenEth), kashAmount, true);
    }

    function claimRedeem(uint256 batchCycle, uint256 ethAmount, bytes32[] calldata proof) external nonReentrant whenNotPaused {
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (info.redeemMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (redeemClaimed[batchCycle][msg.sender]) revert AlreadyClaimed();
        if (block.timestamp > info.claimDeadline) revert ClaimExpired();

        bytes32 leaf = keccak256(abi.encode(batchCycle, msg.sender, ethAmount));
        if (!MerkleVerify.verify(proof, info.redeemMerkleRoot, leaf)) revert InvalidProof();

        redeemClaimed[batchCycle][msg.sender] = true;
        info.claimedAmount += ethAmount;
        lockedClaimEth -= ethAmount;
        totalRedeemedEthByUser[msg.sender] += ethAmount;
        (bool success, ) = payable(msg.sender).call{value: ethAmount}("");
        if (!success) revert InsufficientEthInContract();
        emit TokensClaimed(msg.sender, ETH_ADDRESS, ethAmount, false);
    }

    function overrideRedeemMerkleRoot(uint256 batchCycle, bytes32 newRoot) external onlyOwner {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle] || info.totalNetClaimable == 0) revert WrongPhase();
        if (info.claimedAmount > 0) revert AlreadyClaimed();
        if (newRoot == bytes32(0)) revert InvalidMerkleRoot();
        bytes32 oldRoot = info.redeemMerkleRoot;
        info.redeemMerkleRoot = newRoot;
        emit RedeemMerkleRootOverridden(batchCycle, oldRoot, newRoot);
    }

    function overrideMintMerkleRoot(uint256 batchCycle, bytes32 newRoot) external onlyOwner {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle] || info.totalMintClaimable == 0) revert WrongPhase();
        if (info.mintClaimedAmount > 0) revert AlreadyClaimed();
        if (newRoot == bytes32(0)) revert InvalidMerkleRoot();
        bytes32 oldRoot = info.mintMerkleRoot;
        info.mintMerkleRoot = newRoot;
        emit MintMerkleRootOverridden(batchCycle, oldRoot, newRoot);
    }

    function sweepExpiredClaims(uint256 batchCycle) external onlyBotOrKeeper {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        if (block.timestamp <= info.claimDeadline) revert ClaimsNotExpired();
        uint256 unclaimed = info.totalNetClaimable - info.claimedAmount;
        if (unclaimed == 0) revert ZeroAmount();
        info.claimedAmount = info.totalNetClaimable;
        lockedClaimEth -= unclaimed;
        ownerEthReserve += unclaimed;
        protocolFeeEthReserve += unclaimed;
        emit ExpiredClaimsSwept(batchCycle, unclaimed);
    }

    function sweepExpiredMintClaims(uint256 batchCycle) external onlyBotOrKeeper {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        if (block.timestamp <= info.claimDeadline) revert ClaimsNotExpired();
        uint256 unclaimed = info.totalMintClaimable - info.mintClaimedAmount;
        if (unclaimed == 0) revert ZeroAmount();
        info.mintClaimedAmount = info.totalMintClaimable;
        lockedClaimKash -= unclaimed;
        kashTokenEth.burn(address(this), unclaimed);
        emit ExpiredMintClaimsSwept(batchCycle, unclaimed);
    }

    // ── Aave (unchanged) ──────────────────────────────────────────────────

    function depositToAave(uint256 amount) external onlyBotOrKeeper nonReentrant {
        IWETH(wethAddress).deposit{value: amount}();
        IERC20(wethAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wethAddress, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_DEPOSIT, wethAddress, amount);
    }

    function withdrawFromAave(uint256 amount) external onlyBotOrKeeper nonReentrant {
        IPool(aavePoolAddress).withdraw(wethAddress, amount, address(this));
        IWETH(wethAddress).withdraw(amount);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_WITHDRAW, ETH_ADDRESS, amount);
    }

    function borrowFromAave(address asset, uint256 amount) external onlyBotOrKeeper nonReentrant {
        IPool(aavePoolAddress).borrow(asset, amount, 2, 0, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_BORROW, asset, amount);
    }

    function repayToAave(address asset, uint256 amount) external onlyBotOrKeeper nonReentrant {
        IERC20(asset).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).repay(asset, amount, 2, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_REPAY, asset, amount);
    }

    function addCollateralToAave(uint256 amount) external onlyBotOrKeeper nonReentrant {
        IWETH(wethAddress).deposit{value: amount}();
        IERC20(wethAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wethAddress, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_ADD_COLLATERAL, wethAddress, amount);
    }

    /// @notice Swap ETH → USDC via the registered spot DEX. Bot supplies minOut from a live DEX quote.
    function swapForUsdc(uint256 ethAmount, uint256 minOut) external onlyBotOrKeeper nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        uint256 usdcOut = ISpotDex(spotDexAddress).swapExactIn{value: ethAmount}(
            ETH_ADDRESS, usdcAddress, ethAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FOR_USDC, usdcAddress, usdcOut);
    }

    /// @notice Swap USDC → ETH via the registered spot DEX. Bot supplies minOut from a live DEX quote.
    function swapFromUsdc(uint256 usdcAmount, uint256 minOut) external onlyBotOrKeeper nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        IERC20(usdcAddress).forceApprove(spotDexAddress, usdcAmount);
        uint256 ethOut = ISpotDex(spotDexAddress).swapExactIn(
            usdcAddress, ETH_ADDRESS, usdcAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FROM_USDC, ETH_ADDRESS, ethOut);
    }

    function updateNAV(
        uint256 newNAV,
        uint256 usdcBalance,
        uint256 assetBalance,
        uint256 perpPnL
    ) external onlyBotOrKeeper {
        if (newNAV == 0) revert InvalidNAV();
        currentNAV = newNAV;
        emit NAVProposedAndUpdated(newNAV, usdcBalance, assetBalance, perpPnL, block.timestamp);
        emit NAVUpdateExecuted(newNAV, block.timestamp);
    }

    function getEthPrice() public view returns (uint256) {
        (, int256 price,,,) = AggregatorV3Interface(ethOracle).latestRoundData();
        if (price <= 0) revert InvalidPrice();
        uint8 dec = AggregatorV3Interface(ethOracle).decimals();
        return uint256(price) * 10 ** (18 - dec);
    }

    function getNAV() external view returns (uint256) { return currentNAV; }

    function isUserWindow() public view returns (bool) {
        return block.timestamp % cycleDurationSeconds < userWindowEnd;
    }

    function isProcessingWindow() public view returns (bool) {
        uint256 t = block.timestamp % cycleDurationSeconds;
        return t >= processingWindowStart && t < cycleDurationSeconds;
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
        bool    processed,
        uint256 mintUsersCount,
        uint256 redeemUsersCount,
        uint256 totalRedeemKash
    ) {
        return (
            batchTotalMintValueUSD[batchCycle],
            batchTotalRedeemValueUSD[batchCycle],
            batchProcessed[batchCycle],
            batchMintUsers[batchCycle].length,
            batchRedeemUsers[batchCycle].length,
            batchTotalRedeemKash[batchCycle]
        );
    }

    function getCurrentBatchCycle() external view returns (uint256) {
        return block.timestamp / cycleDurationSeconds;
    }

    function markMintEthDeployed(uint256 batchCycle, uint256 amount) external onlyBotOrKeeper {
        if (batchMintEthDeployedToAave[batchCycle] + amount > batchTotalMintEth[batchCycle]) revert ExceedsMintEthForCycle();
        batchMintEthDeployedToAave[batchCycle] += amount;
        emit ProtocolInteraction(ProtocolActionCodes.MINT_ETH_DEPLOYED, ETH_ADDRESS, amount);
    }

    /// @notice Pull owner-marked ETH from the vault (protocol fees credit `ownerEthReserve` on phase 2).
    ///         Does not withdraw unreserved vault ETH that backs user NAV.
    function ownerWithdrawEth(uint256 amount) external onlyOwner {
        if (amount > ownerEthReserve) revert InsufficientOwnerEthReserve();
        uint256 bal = address(this).balance;
        uint256 available = bal > lockedClaimEth ? bal - lockedClaimEth : 0;
        if (amount > available) revert InsufficientExcessEth();
        unchecked {
            ownerEthReserve -= amount;
        }
        uint256 protocolFeeConsumed = amount < protocolFeeEthReserve ? amount : protocolFeeEthReserve;
        unchecked {
            protocolFeeEthReserve -= protocolFeeConsumed;
        }
        payable(owner).transfer(amount);
        emit ProtocolInteraction(ProtocolActionCodes.OWNER_WITHDRAW_ETH, ETH_ADDRESS, amount);
    }

    function rescueERC20(address token, uint256 amount, address recipient) external onlyOwner {
        if (token == ETH_ADDRESS) revert InvalidAddress();
        if (recipient == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit ProtocolInteraction(ProtocolActionCodes.RESCUE_ERC20, token, amount);
    }

    /// @notice Pull USDC from the owner and credit owner reserve (excluded from user NAV).
    function markOwnerUsdcDeposit(uint256 amount) external onlyOwner {
        IERC20(usdcAddress).safeTransferFrom(owner, address(this), amount);
        ownerUsdcReserve += amount;
        emit ProtocolInteraction(ProtocolActionCodes.OWNER_USDC_DEPOSIT, usdcAddress, amount);
    }

    /// @notice Credit owner ETH reserve (msg.value) — excluded from user NAV / ops balance views.
    function markOwnerEthDeposit() external payable onlyOwner {
        ownerEthReserve += msg.value;
        emit ProtocolInteraction(ProtocolActionCodes.OWNER_ETH_DEPOSIT, ETH_ADDRESS, msg.value);
    }

    /// @notice Bot draws down owner USDC reserve to label a shortfall cover (accounting only).
    function coverUsdcShortfall(uint256 amount) external onlyBotOrKeeper {
        if (amount == 0) revert ZeroAmount();
        if (amount > ownerUsdcReserve) revert InsufficientOwnerUsdcReserve();
        ownerUsdcReserve -= amount;
        emit ProtocolInteraction(ProtocolActionCodes.OWNER_USDC_COVER_SHORTFALL, usdcAddress, amount);
    }

    function emergencyWithdrawMint(uint256 batchCycle) external {
        if (!paused) revert NotPaused();
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.amountIn == 0) revert InvalidRequest();
        uint256 amount = req.amountIn;
        uint256 usdAmount = req.amountInUSD;
        batchTotalMintEth[batchCycle] -= amount;
        batchTotalMintValueUSD[batchCycle] -= usdAmount;
        unchecked { activeMintUsers[batchCycle]--; }
        delete userMintRequests[msg.sender][batchCycle];
        payable(msg.sender).transfer(amount);
    }

    function emergencyWithdrawRedeem(uint256 batchCycle) external {
        if (!paused) revert NotPaused();
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.kashAmount == 0) revert InvalidRequest();
        kashTokenEth.transfer(msg.sender, req.kashAmount);
        delete userRedeemRequests[msg.sender][batchCycle];
    }

}
