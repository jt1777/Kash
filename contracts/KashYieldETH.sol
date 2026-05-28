// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashTokenEth.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./interfaces/IPerpExchange.sol";
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
error InvalidAdapter();
error ExchangeNotRegistered();
error NoActivePerpExchange();
error NoPendingAdapter();
error TimelockNotExpired();
error SlippageTooHigh();
error SpotDexNotSet();
error NotPendingOwner();
error MinCycleDuration();
error InvalidAddress();
error NoPendingRedeemRequest();

// ─── Events ───────────────────────────────────────────────────────────────────
event MintRequested(address indexed user, uint256 amountIn, uint256 batchCycle);
event RedeemRequested(address indexed user, uint256 kashAmount, uint256 batchCycle);
event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 exactNAV);
event TokensClaimed(address indexed user, address indexed token, uint256 amount, bool isMint);
event NAVUpdateExecuted(uint256 newNAV, uint256 timestamp);
    event NAVProposedAndUpdated(uint256 newNAV, uint256 usdcBalance, uint256 assetBalance, uint256 perpPnL, uint256 timestamp);
event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);
event ExchangeRegistered(string indexed name, address adapter);
event AdapterProposed(string indexed name, address adapter, uint256 readyAt);
event ExchangeSwitchConfirmed(string indexed name, address adapter);
event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
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
    string public constant VERSION = "1.0.0";

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
    address public ethOracle = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612; // Chainlink ETH/USD — Arbitrum One
    uint8   public ethDecimals = 18;

    // ── Exchange registry ─────────────────────────────────────────────────
    mapping(string => address) public perpExchanges;
    string public activePerpExchange;

    // Adapter registration timelock: proposed adapters wait before they can be confirmed.
    // The very first adapter bypasses the timelock so the protocol can be used immediately on deploy.
    // Set to 0 for testnet/development; 24 hours recommended for mainnet.
    bool    private anyAdapterConfirmed;
    mapping(string => address) private pendingAdapters;
    mapping(string => uint256) public  adapterReadyAt;
    uint256 public exchangeSwitchDelay = 24 hours;

    // ── Spot DEX ─────────────────────────────────────────────────────────
    // Whitelisted spot DEX routers (UniswapV3 on Arbitrum mainnet)
    address public constant UNISWAP_V3_ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    // USDT on Arbitrum One (allowed as a swap path intermediate)
    address public constant USDT_ADDRESS      = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    address public spotDexAddress;
    mapping(address => bool) public allowedSpotTokens;
    mapping(address => bool) public allowedSpotDexRouters; // whitelist of permitted DEX adapter contracts

    uint256 public spotDexTimelock = 24 hours;
    mapping(address => uint256) public spotDexPending;

    uint256 public maxSwapSlippageBps     = 50;
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

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

    // ── Batch state ───────────────────────────────────────────────────────
    uint256 public currentBatchCycle;
    mapping(uint256 => bool)    public batchProcessed;
    mapping(uint256 => uint256) public batchIndicativeNAV;
    mapping(uint256 => uint256) public batchExactNAV;
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
    // Default: users can request mints/redeems for the first 23h 50m of each cycle,
    // then a 10-minute processing window closes user submissions so the bot can settle.
    // Set userWindowEnd = cycleDurationSeconds and processingWindowStart = 0 to disable windowing.
    uint256 public userWindowEnd         = 23 * 3600 + 50 * 60; // 85800 s = 23 h 50 m
    uint256 public processingWindowStart = 23 * 3600 + 50 * 60; // 85800 s = 23 h 50 m
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
        currentBatchCycle = block.timestamp / cycleDurationSeconds;

        // Hard-coded mainnet addresses
        aavePoolAddress = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;
        wethAddress     = _weth;
        usdcAddress     = _usdc;

        // Whitelist tokens allowed in spot DEX swaps
        allowedSpotTokens[ETH_ADDRESS] = true;
        allowedSpotTokens[wethAddress] = true;
        allowedSpotTokens[usdcAddress] = true;
        allowedSpotTokens[USDT_ADDRESS] = true;

        // Whitelist permitted spot DEX adapter contracts
        allowedSpotDexRouters[UNISWAP_V3_ROUTER] = true;
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
    function pause()   external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    // ── Exchange registry ─────────────────────────────────────────────────

    /// @notice Register a new adapter. First-ever registration is immediate; all subsequent ones
    ///         require a 24-hour timelock (propose here → confirmPerpExchange after delay).
    function setPerpExchange(string calldata name, address adapter) external onlyOwner {
        if (adapter == address(0)) revert InvalidAdapter();
        if (!anyAdapterConfirmed) {
            perpExchanges[name] = adapter;
            anyAdapterConfirmed = true;
            emit ExchangeRegistered(name, adapter);
            return;
        }
        pendingAdapters[name] = adapter;
        adapterReadyAt[name]  = block.timestamp + exchangeSwitchDelay;
        emit AdapterProposed(name, adapter, adapterReadyAt[name]);
    }

    /// @notice Confirm a previously proposed adapter after the 24-hour timelock has elapsed.
    function confirmPerpExchange(string calldata name) external onlyOwner {
        if (adapterReadyAt[name] == 0) revert NoPendingAdapter();
        if (block.timestamp < adapterReadyAt[name]) revert TimelockNotExpired();
        perpExchanges[name] = pendingAdapters[name];
        emit ExchangeRegistered(name, perpExchanges[name]);
        delete pendingAdapters[name];
        delete adapterReadyAt[name];
    }

    /// @notice Immediately set the active perp exchange (adapter must already be confirmed).
    function setActivePerpExchange(string calldata name) external onlyOwner {
        if (perpExchanges[name] == address(0)) revert ExchangeNotRegistered();
        activePerpExchange = name;
        emit ExchangeSwitchConfirmed(name, perpExchanges[name]);
    }

    /// @notice Propose a new spot DEX adapter. First-ever call is immediate (no timelock);
    ///         all subsequent changes require a spotDexTimelock-second wait before confirming.
    ///         The adapter address must be on the allowedSpotDexRouters whitelist.
    function setSpotDex(address _spotDex) external onlyOwner {
        if (_spotDex == address(0)) revert InvalidAddress();
        if (!allowedSpotDexRouters[_spotDex]) revert InvalidAdapter();
        if (spotDexPending[_spotDex] != 0) revert TimelockNotExpired();
        if (spotDexAddress == address(0)) {
            // First-ever set: immediate, no timelock
            spotDexAddress = _spotDex;
            emit ExchangeSwitchConfirmed("SPOT_DEX", _spotDex);
            return;
        }
        spotDexPending[_spotDex] = block.timestamp + spotDexTimelock;
        emit AdapterProposed("SPOT_DEX", _spotDex, spotDexPending[_spotDex]);
    }

    /// @notice Confirm a previously proposed spot DEX adapter after the timelock has elapsed.
    function confirmSpotDex(address _spotDex) external onlyOwner {
        if (spotDexPending[_spotDex] == 0) revert NoPendingAdapter();
        if (block.timestamp < spotDexPending[_spotDex]) revert TimelockNotExpired();
        spotDexAddress = _spotDex;
        delete spotDexPending[_spotDex];
        emit ExchangeSwitchConfirmed("SPOT_DEX", _spotDex);
    }

    /// @notice Add or remove a spot DEX adapter from the whitelist.
    function setAllowedSpotDexRouter(address router, bool allowed) external onlyOwner {
        allowedSpotDexRouters[router] = allowed;
    }

    /// @notice Set adapter registration timelock. Use 0 for testnet, 24 hours for mainnet.
    function setExchangeSwitchDelay(uint256 _seconds) external onlyOwner { exchangeSwitchDelay = _seconds; }

    function setMaxSwapSlippageBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        maxSwapSlippageBps = _bps;
    }

    /// @notice Legacy convenience: equivalent to setPerpExchange("HL", adapter).
    ///         First-ever call is immediate; subsequent calls start a 24h timelock.
    function setHyperliquid(address adapter) external onlyOwner {
        if (adapter == address(0)) revert InvalidAdapter();
        if (!anyAdapterConfirmed) {
            perpExchanges["HL"] = adapter;
            anyAdapterConfirmed = true;
            emit ExchangeRegistered("HL", adapter);
            return;
        }
        pendingAdapters["HL"] = adapter;
        adapterReadyAt["HL"]  = block.timestamp + exchangeSwitchDelay;
        emit AdapterProposed("HL", adapter, adapterReadyAt["HL"]);
    }

    /// @notice Returns the HL adapter address (backwards-compat with bot / frontend).
    function hyperliquidAddress() external view returns (address) {
        return perpExchanges["HL"];
    }

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
        req.user = msg.sender;
        req.amountIn += actualAmount;
        req.batchCycle = batchCycle;
        batchTotalMintEth[batchCycle] += actualAmount;
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
        req.user = msg.sender;
        req.kashAmount += kashAmount;
        req.batchCycle = batchCycle;
        batchTotalRedeemKash[batchCycle] += kashAmount;
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
        batchTotalMintEth[batchCycle] -= amount;
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
        batchTotalRedeemKash[batchCycle] -= kashAmount;
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
        else if (phase == 2) processBatchPhase2();
    }

    // ── Batch Phase 1 ─────────────────────────────────────────────────────

    function processBatchPhase1() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert PhaseAlreadyStarted();

        uint256 ethPrice = getEthPrice();
        uint256 indicativeNAV = currentNAV;
        uint256 totalMintUSD = 0;

        address[] memory minters = batchMintUsers[batchCycle];
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest storage req = userMintRequests[minters[i]][batchCycle];
            if (req.amountIn > 0) {
                req.amountInUSD = (req.amountIn * ethPrice) / (10 ** ETH_DECIMALS);
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
        if (netPositionUSD > 0) emit ProtocolInteraction(ProtocolActionCodes.NET_MINT, ETH_ADDRESS, uint256(netPositionUSD));
        else if (netPositionUSD < 0) emit ProtocolInteraction(ProtocolActionCodes.NET_REDEEM, ETH_ADDRESS, uint256(-netPositionUSD));

        batchPhase[batchCycle] = 1;
        emit BatchPhaseUpdated(batchCycle, 1, indicativeNAV);
    }

    function markBatchOpsDone(uint256 batchCycle) external onlyBotOrKeeper {
        if (batchPhase[batchCycle] != 1) revert WrongPhase();
        batchPhase[batchCycle] = 2;
        emit BatchPhaseUpdated(batchCycle, 2, currentNAV);
    }

    // ── Batch Phase 2 ─────────────────────────────────────────────────────

    function processBatchPhase2() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 2) revert OpsNotDone();
        _processBatchPhase2(batchCycle);
    }

    function processBatchPhase2ForCycle(uint256 batchCycle) external onlyBotOrKeeper nonReentrant {
        if (batchPhase[batchCycle] != 2) revert OpsNotDone();
        if (batchCycle == block.timestamp / cycleDurationSeconds) revert UsePerformUpkeep();
        _processBatchPhase2(batchCycle);
    }

    function _processBatchPhase2(uint256 batchCycle) internal {
        uint256 exactNAV = currentNAV;
        uint256 ethPrice = getEthPrice();

        address[] memory minters  = batchMintUsers[batchCycle];
        address[] memory redeemers = batchRedeemUsers[batchCycle];

        uint256 totalMintKash = 0;
        uint256 totalMintFeeEth = 0;
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest memory req = userMintRequests[minters[i]][batchCycle];
            if (req.amountInUSD > 0) {
                totalMintFeeEth += req.amountIn * feeBps / 10000;
                uint256 amountAfterFee = req.amountInUSD * (10000 - feeBps) / 10000;
                totalMintKash += (amountAfterFee * 1e18) / exactNAV;
            }
        }

        uint256[] memory redeemEthAmounts = new uint256[](redeemers.length);
        uint256 totalRedeemEthNeeded = 0;
        uint256 totalRedeemFeeEth = 0;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.kashAmount > 0) {
                uint256 usdValue = (req.kashAmount * exactNAV) / 1e18;
                uint256 grossEthAmount = (usdValue * (10 ** ETH_DECIMALS)) / ethPrice;
                uint256 feeEthAmount = grossEthAmount * feeBps / 10000;
                redeemEthAmounts[i] = grossEthAmount - feeEthAmount;
                totalRedeemEthNeeded += redeemEthAmounts[i];
                totalRedeemFeeEth += feeEthAmount;
            }
        }
        uint256 totalProtocolFeeEth = totalMintFeeEth + totalRedeemFeeEth;
        if (address(this).balance < ownerEthReserve + totalProtocolFeeEth + totalRedeemEthNeeded) revert InsufficientEthForRedeems();
        ownerEthReserve += totalProtocolFeeEth;
        protocolFeeEthReserve += totalProtocolFeeEth;

        batchExactNAV[batchCycle] = exactNAV;
        batchProcessed[batchCycle] = true;
        batchPhase[batchCycle] = 3;
        emit BatchProcessed(batchCycle, batchTotalMintValueUSD[batchCycle], batchTotalRedeemValueUSD[batchCycle], exactNAV);

        uint256 totalRedeemKash = batchTotalRedeemKash[batchCycle];
        int256 netKash = int256(totalMintKash) - int256(totalRedeemKash);
        if (netKash > 0) kashTokenEth.mint(address(this), uint256(netKash));
        else if (netKash < 0) kashTokenEth.burn(address(this), uint256(-netKash));

        uint256 totalDistributableKash = totalMintKash;
        for (uint256 i = 0; i < minters.length; i++) {
            address user = minters[i];
            MintRequest memory req = userMintRequests[user][batchCycle];
            if (req.amountInUSD > 0) {
                uint256 userShare = (req.amountInUSD * totalDistributableKash) / batchTotalMintValueUSD[batchCycle];
                kashTokenEth.transfer(user, userShare);
                emit TokensClaimed(user, address(kashTokenEth), userShare, true);
                totalDepositedEthByUser[user] += req.amountIn;
            }
        }

        for (uint256 i = 0; i < redeemers.length; i++) {
            if (redeemEthAmounts[i] == 0) continue;
            address user = redeemers[i];
            uint256 ethAmount = redeemEthAmounts[i];
            totalRedeemedEthByUser[user] += ethAmount;
            (bool success, ) = payable(user).call{value: ethAmount}("");
            if (success) {
                emit TokensClaimed(user, ETH_ADDRESS, ethAmount, false);
            } else {
                emit ProtocolInteraction(ProtocolActionCodes.REDEEM_TRANSFER_FAILED, user, ethAmount);
            }
        }
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

    // ── Exchange operations (route through active IPerpExchange adapter) ──

    function depositToHyperliquid(uint256 amount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_DEPOSIT, usdcAddress, amount);
    }

    function withdrawFromHyperliquid(uint256 amount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        uint256 transferred = IPerpExchange(adapter).withdrawCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW, usdcAddress, transferred);
    }

    function withdrawEthFromHyperliquid(uint256 amount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).withdrawAsset(amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_WITHDRAW_ASSET, ETH_ADDRESS, amount);
    }

    function addCollateralToHyperliquid(uint256 amount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_ADD_COLLATERAL, usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_OPEN_SHORT, ETH_ADDRESS, size);
    }

    function closeShort(string calldata symbol) external onlyBotOrKeeper nonReentrant {
        _closeShort(symbol, true, 0);
    }

    function closeShort(string calldata symbol, uint256 closeSize) external onlyBotOrKeeper nonReentrant {
        _closeShort(symbol, false, closeSize);
    }

    function _closeShort(string calldata symbol, bool fullClose, uint256 closeSize) private {
        address adapter = _activePerpAdapter();
        if (fullClose) {
            IPerpExchange(adapter).closePerpPosition(symbol);
            emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, ETH_ADDRESS, 0);
        } else {
            IPerpExchange(adapter).closePerpPosition(symbol, closeSize);
            emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CLOSE_SHORT, ETH_ADDRESS, closeSize);
        }
    }

    function spotBuyOnHyperliquid(uint256 usdcAmount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, usdcAmount);
        uint256 amountOut = IPerpExchange(adapter).tradeSpot(usdcAddress, ETH_ADDRESS, usdcAmount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_BUY, ETH_ADDRESS, amountOut);
    }

    function spotSellOnHyperliquid(uint256 amount) external onlyBotOrKeeper nonReentrant {
        address adapter = _activePerpAdapter();
        // ETH is already held in the exchange's internal account (ethBalance) from a prior
        // spot buy — no native ETH forwarding required (mirrors how a real HL API call works).
        uint256 amountOut = IPerpExchange(adapter).tradeSpot(ETH_ADDRESS, usdcAddress, amount);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_SPOT_SELL, usdcAddress, amountOut);
    }

    function cancelHyperliquidOrder(bytes32 orderId) external onlyBotOrKeeper {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).cancelOrder(orderId);
        emit ProtocolInteraction(ProtocolActionCodes.EXCHANGE_CANCEL_ORDER, ETH_ADDRESS, 0);
    }

    // ── Spot DEX swaps (Uniswap V3) ───────────────────────────────────────

    /// @notice Swap ETH → USDC via the registered spot DEX. Used to cover residual Aave debt.
    function swapForUsdc(uint256 ethAmount) external onlyBotOrKeeper nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        uint256 minOut = _minUsdcOut(ethAmount);
        uint256 usdcOut = ISpotDex(spotDexAddress).swapExactIn{value: ethAmount}(
            ETH_ADDRESS, usdcAddress, ethAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FOR_USDC, usdcAddress, usdcOut);
    }

    /// @notice Swap USDC → ETH via the registered spot DEX.
    function swapFromUsdc(uint256 usdcAmount) external onlyBotOrKeeper nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        uint256 minOut = _minEthOut(usdcAmount);
        IERC20(usdcAddress).forceApprove(spotDexAddress, usdcAmount);
        uint256 ethOut = ISpotDex(spotDexAddress).swapExactIn(
            usdcAddress, ETH_ADDRESS, usdcAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FROM_USDC, ETH_ADDRESS, ethOut);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function getHyperliquidSpotBalance() external view returns (uint256) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return 0;
        return IPerpExchange(adapter).getSpotBalance();
    }

    function getExchangeAssetBalance() external view returns (uint256) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return 0;
        return IPerpExchange(adapter).getAssetBalance();
    }

    function getHyperliquidPosition(string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return (0, 0, 0, false, false);
        return IPerpExchange(adapter).getPosition(symbol);
    }

    function getHyperliquidOpenOrderIds() external view returns (bytes32[] memory) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return new bytes32[](0);
        return IPerpExchange(adapter).getOpenOrderIds();
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

    function getReservedEth() public view returns (uint256) {
        uint256 currentCycle = block.timestamp / cycleDurationSeconds;
        uint256 reserved = 0;
        uint256 ethPrice = getEthPrice();
        // Sum reservations across the current cycle and the last 10 past cycles so that
        // Pending mint/redeem obligations for NAV and ops; owner asset pulls are limited to ownerEthReserve.
        uint256 lookback = 10;
        for (uint256 i = 0; i <= lookback; i++) {
            if (i > currentCycle) break;
            uint256 cycle = currentCycle - i;
            if (batchProcessed[cycle]) continue;
            reserved += batchTotalMintEth[cycle];
            uint256 redeemUsdEstimate = (batchTotalRedeemKash[cycle] * currentNAV) / 1e18;
            uint256 redeemEthEstimate = (redeemUsdEstimate * (10 ** ETH_DECIMALS)) / ethPrice;
            reserved += redeemEthEstimate;
        }
        return reserved;
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
        if (amount > bal) revert InsufficientExcessEth();
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
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.amountIn == 0 || req.amountInUSD != 0) revert InvalidRequest();
        payable(msg.sender).transfer(req.amountIn);
        delete userMintRequests[msg.sender][batchCycle];
    }

    function emergencyWithdrawRedeem(uint256 batchCycle) external {
        if (!paused) revert NotPaused();
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.kashAmount == 0) revert InvalidRequest();
        kashTokenEth.transfer(msg.sender, req.kashAmount);
        delete userRedeemRequests[msg.sender][batchCycle];
    }

    function getTotalDepositedEth(address user) external view returns (uint256) { return totalDepositedEthByUser[user]; }
    function getTotalRedeemedEth(address user)  external view returns (uint256) { return totalRedeemedEthByUser[user]; }

    // ── Internal helpers ──────────────────────────────────────────────────

    function _activePerpAdapter() internal view returns (address adapter) {
        adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) revert NoActivePerpExchange();
    }

    function _minUsdcOut(uint256 ethAmount) internal view returns (uint256) {
        uint256 price = getEthPrice();
        uint256 expectedUsdc = (ethAmount * price) / (10 ** ETH_DECIMALS) / 1e12;
        return expectedUsdc * (10000 - maxSwapSlippageBps) / 10000;
    }

    function _minEthOut(uint256 usdcAmount) internal view returns (uint256) {
        uint256 price = getEthPrice();
        uint256 expectedEth = (usdcAmount * 1e12 * (10 ** ETH_DECIMALS)) / price;
        return expectedEth * (10000 - maxSwapSlippageBps) / 10000;
    }
}
