// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashTokenBtc.sol";
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

// ─── Custom errors (4-byte selectors replace string literals → smaller bytecode) ──
error OnlyOwner();
error OnlyBotOrKeeper();
error UserWindowClosed();
error NotInProcessingWindow();
error ContractPaused();
error ZeroAmount();
error AlreadyProcessed();
error NoRequest();
error InsufficientKashBtc();
error PhaseAlreadyStarted();
error WrongPhase();
error OpsNotDone();
error UsePerformUpkeep();
error InsufficientWbtcForRedeems();
error InsufficientWbtcInContract();
error InsufficientExcessWbtc();
error ExceedsMintWbtcForCycle();
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
event ProtocolInteraction(string action, address indexed asset, uint256 amount);
event ExchangeRegistered(string indexed name, address adapter);
event AdapterProposed(string indexed name, address adapter, uint256 readyAt);
event ExchangeSwitchConfirmed(string indexed name, address adapter);
event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

/**
 * @title KashYieldBtc
 * @dev wBTC yield product: daily batch settlement on Arbitrum. Deposits in wBTC receive KASH_BTC.
 * Integrates Aave V3 for collateral/borrowing and any IPerpExchange adapter for hedging.
 *
 * EXCHANGE REGISTRY: perpExchanges maps string names ("HL", "GMX", "ASTER", ...) to adapter
 * addresses.  activePerpExchange selects which one is used.  Registering a new adapter requires
 * a 48-hour timelock (propose → confirm).  Switching the active exchange is immediate once the
 * adapter is confirmed.  Adding a new exchange never requires redeploying this contract.
 */
contract KashYieldBtc is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WBTC_DECIMALS = 8;

    // ── Core state ────────────────────────────────────────────────────────
    address payable public owner;
    address public pendingOwner;
    KashTokenBtc public kashTokenBtc;
    uint256 public currentNAV = 1e18;

    // ── Protocol addresses ────────────────────────────────────────────────
    address public aavePoolAddress = 0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff;
    address public keeperRegistry  = 0x8194399B3f11fcA2E8cCEfc4c9A658c61B8Bf412;
    address public botAddress;

    address public wbtcAddress = 0x4D8b720b94D341F54df948696747B05998c5FbD5;
    address public usdcAddress;
    address public btcOracle    = 0xBfFE5FE928F9597E2A21Ba8f2cDE7D2D10C09d27;
    uint8   public btcDecimals  = 8;

    // ── Exchange registry ─────────────────────────────────────────────────
    /// @notice All registered perp exchange adapters (implements IPerpExchange).
    mapping(string => address) public perpExchanges;
    /// @notice Currently active exchange used for all perp/spot operations.
    string public activePerpExchange;

    // Adapter registration timelock: proposed adapters wait 48 hours before they can be confirmed.
    // The very first adapter bypasses the timelock so the protocol can be used immediately on deploy.
    bool    private anyAdapterConfirmed;
    mapping(string => address) private pendingAdapters;
    mapping(string => uint256) public  adapterReadyAt;
    uint256 public exchangeSwitchDelay = 48 hours;

    // ── Spot DEX (Uniswap V3 adapter for asset ↔ USDC) ───────────────────
    address public spotDexAddress;

    // ── Swap slippage ─────────────────────────────────────────────────────
    uint256 public maxSwapSlippageBps     = 50;   // 0.5% default
    uint256 public constant MAX_SLIPPAGE_BPS = 500; // 5% hard cap

    // ── Fee config ────────────────────────────────────────────────────────
    uint256 public feeBps = 3;
    uint256 public constant MAX_FEE_BPS = 100;

    bool public paused;

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
    mapping(uint256 => uint256) public batchTotalMintBtc;
    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;
    mapping(uint256 => uint256) public batchMintBtcDeployedToAave;

    mapping(address => uint256) public totalDepositedBtcByUser;
    mapping(address => uint256) public totalRedeemedBtcByUser;

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

    constructor(address _botAddress) payable {
        owner = payable(msg.sender);
        botAddress = _botAddress;
        kashTokenBtc = new KashTokenBtc();
        kashTokenBtc.transferOwnership(address(this));
        currentBatchCycle = block.timestamp / cycleDurationSeconds;
    }

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

    function setBotAddress(address _botAddress) external onlyOwner {
        botAddress = _botAddress;
    }
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
    function setKeeperRegistry(address _keeperRegistry) external onlyOwner {
        keeperRegistry = _keeperRegistry;
    }
    function setAavePool(address _aavePool) external onlyOwner {
        if (_aavePool == address(0)) revert InvalidAddress();
        aavePoolAddress = _aavePool;
    }
    function setWbtcAddress(address _wbtc) external onlyOwner {
        if (_wbtc == address(0)) revert InvalidAddress();
        wbtcAddress = _wbtc;
    }
    function setUsdcAddress(address _usdc) external onlyOwner {
        usdcAddress = _usdc;
    }
    function setBtcOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidAddress();
        btcOracle = _oracle;
    }
    function setFeeBps(uint256 newFee) external onlyOwner {
        if (newFee > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFee;
    }
    function pause()   external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    // ── Exchange registry ─────────────────────────────────────────────────

    /// @notice Register a new adapter. First-ever registration is immediate; all subsequent ones
    ///         require a 48-hour timelock (propose here → confirmPerpExchange after delay).
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

    /// @notice Confirm a previously proposed adapter after the 48-hour timelock has elapsed.
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

    /// @notice Set the spot DEX adapter (no timelock — only used for asset↔USDC swaps).
    function setSpotDex(address _spotDex) external onlyOwner {
        spotDexAddress = _spotDex;
    }
    /// @notice Set adapter registration timelock. Use 0 for testnet, 48 hours for mainnet.
    function setExchangeSwitchDelay(uint256 _seconds) external onlyOwner { exchangeSwitchDelay = _seconds; }

    function setMaxSwapSlippageBps(uint256 _bps) external onlyOwner {
        if (_bps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        maxSwapSlippageBps = _bps;
    }

    /// @notice Legacy convenience: equivalent to setPerpExchange("HL", adapter).
    ///         First-ever call is immediate; subsequent calls start a 48h timelock.
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

    function requestMint(uint256 amount) external onlyUserWindow whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        IERC20(wbtcAddress).safeTransferFrom(msg.sender, address(this), amount);

        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        userMintRequests[msg.sender][batchCycle] = MintRequest({
            user: msg.sender, amountIn: amount, amountInUSD: 0, batchCycle: batchCycle
        });
        batchTotalMintBtc[batchCycle] += amount;
        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }
        emit MintRequested(msg.sender, amount, batchCycle);
    }

    function requestRedeem(uint256 kashAmount) external onlyUserWindow whenNotPaused {
        if (kashAmount == 0) revert ZeroAmount();
        if (kashTokenBtc.balanceOf(msg.sender) < kashAmount) revert InsufficientKashBtc();
        kashTokenBtc.transferFrom(msg.sender, address(this), kashAmount);

        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        userRedeemRequests[msg.sender][batchCycle] = RedeemRequest({
            user: msg.sender, kashAmount: kashAmount, batchCycle: batchCycle
        });
        batchTotalRedeemKash[batchCycle] += kashAmount;
        if (!isInBatchRedeem[batchCycle][msg.sender]) {
            batchRedeemUsers[batchCycle].push(msg.sender);
            isInBatchRedeem[batchCycle][msg.sender] = true;
        }
        emit RedeemRequested(msg.sender, kashAmount, batchCycle);
    }

    function cancelMintRequest(uint256 batchCycle) external whenNotPaused {
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.amountIn == 0) revert NoRequest();
        uint256 amount = req.amountIn;
        batchTotalMintBtc[batchCycle] -= amount;
        delete userMintRequests[msg.sender][batchCycle];
        IERC20(wbtcAddress).safeTransfer(msg.sender, amount);
        emit ProtocolInteraction("CANCEL_MINT", wbtcAddress, amount);
    }

    function cancelRedeemRequest(uint256 batchCycle) external whenNotPaused {
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        if (req.kashAmount == 0) revert NoRequest();
        uint256 kashAmount = req.kashAmount;
        batchTotalRedeemKash[batchCycle] -= kashAmount;
        delete userRedeemRequests[msg.sender][batchCycle];
        kashTokenBtc.transfer(msg.sender, kashAmount);
        emit ProtocolInteraction("CANCEL_REDEEM", address(kashTokenBtc), kashAmount);
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

        uint256 btcPrice = getBtcPrice();
        uint256 indicativeNAV = currentNAV;
        uint256 totalMintUSD = 0;

        address[] memory minters = batchMintUsers[batchCycle];
        for (uint256 i = 0; i < minters.length; i++) {
            MintRequest storage req = userMintRequests[minters[i]][batchCycle];
            if (req.amountIn > 0) {
                req.amountInUSD = (req.amountIn * btcPrice) / (10 ** WBTC_DECIMALS);
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
        if (netPositionUSD > 0) emit ProtocolInteraction("NET_MINT",   wbtcAddress, uint256(netPositionUSD));
        else if (netPositionUSD < 0) emit ProtocolInteraction("NET_REDEEM", wbtcAddress, uint256(-netPositionUSD));

        batchPhase[batchCycle] = 1;
        emit BatchPhaseUpdated(batchCycle, 1, indicativeNAV);
    }

    function markBatchOpsDone(uint256 batchCycle) external onlyOwner {
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

    function _processBatchPhase2(uint256 batchCycle) internal nonReentrant {
        uint256 exactNAV = currentNAV;
        batchExactNAV[batchCycle] = exactNAV;
        uint256 btcPrice = getBtcPrice();

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
        int256 netKash = int256(totalMintKash) - int256(totalRedeemKash);
        if (netKash > 0) kashTokenBtc.mint(address(this), uint256(netKash));
        else if (netKash < 0) kashTokenBtc.burn(address(this), uint256(-netKash));

        uint256 totalDistributableKash = totalMintKash;
        for (uint256 i = 0; i < minters.length; i++) {
            address user = minters[i];
            MintRequest memory req = userMintRequests[user][batchCycle];
            if (req.amountInUSD > 0) {
                uint256 userShare = (req.amountInUSD * totalDistributableKash) / batchTotalMintValueUSD[batchCycle];
                kashTokenBtc.transfer(user, userShare);
                emit TokensClaimed(user, address(kashTokenBtc), userShare, true);
                totalDepositedBtcByUser[user] += req.amountIn;
            }
        }

        address[] memory redeemers = batchRedeemUsers[batchCycle];
        uint256 totalRedeemBtcNeeded = 0;
        for (uint256 i = 0; i < redeemers.length; i++) {
            RedeemRequest memory req = userRedeemRequests[redeemers[i]][batchCycle];
            if (req.kashAmount > 0) {
                uint256 usdValue = (req.kashAmount * exactNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                totalRedeemBtcNeeded += (usdAfterFee * (10 ** WBTC_DECIMALS)) / btcPrice;
            }
        }
        if (IERC20(wbtcAddress).balanceOf(address(this)) < totalRedeemBtcNeeded) revert InsufficientWbtcForRedeems();

        uint256 availableDepositBtc = batchTotalMintBtc[batchCycle];
        uint256 excessMintBtc = availableDepositBtc > totalRedeemBtcNeeded ? availableDepositBtc - totalRedeemBtcNeeded : 0;
        if (excessMintBtc > 0) emit ProtocolInteraction("NET_MINT_BTC_DEPLOY", wbtcAddress, excessMintBtc);

        for (uint256 i = 0; i < redeemers.length; i++) {
            address user = redeemers[i];
            RedeemRequest memory req = userRedeemRequests[user][batchCycle];
            if (req.kashAmount > 0) {
                uint256 usdValue    = (req.kashAmount * exactNAV) / 1e18;
                uint256 usdAfterFee = usdValue * (10000 - feeBps) / 10000;
                uint256 wbtcAmount  = (usdAfterFee * (10 ** WBTC_DECIMALS)) / btcPrice;
                IERC20(wbtcAddress).safeTransfer(user, wbtcAmount);
                emit TokensClaimed(user, wbtcAddress, wbtcAmount, false);
                totalRedeemedBtcByUser[user] += wbtcAmount;
            }
        }

        batchProcessed[batchCycle] = true;
        batchPhase[batchCycle] = 3;
        emit BatchProcessed(batchCycle, batchTotalMintValueUSD[batchCycle], batchTotalRedeemValueUSD[batchCycle], exactNAV);
    }

    // ── Aave (unchanged) ──────────────────────────────────────────────────

    function depositToAave(uint256 amount) external onlyOwner nonReentrant {
        IERC20(wbtcAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wbtcAddress, amount, address(this), 0);
        emit ProtocolInteraction("AAVE_DEPOSIT", wbtcAddress, amount);
    }

    function withdrawFromAave(uint256 amount) external onlyOwner nonReentrant {
        IPool(aavePoolAddress).withdraw(wbtcAddress, amount, address(this));
        emit ProtocolInteraction("AAVE_WITHDRAW", wbtcAddress, amount);
    }

    function borrowFromAave(address asset, uint256 amount) external onlyOwner nonReentrant {
        IPool(aavePoolAddress).borrow(asset, amount, 2, 0, address(this));
        emit ProtocolInteraction("AAVE_BORROW", asset, amount);
    }

    function repayToAave(address asset, uint256 amount) external onlyOwner nonReentrant {
        IERC20(asset).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).repay(asset, amount, 2, address(this));
        emit ProtocolInteraction("AAVE_REPAY", asset, amount);
    }

    function addCollateralToAave(uint256 amount) external onlyOwner nonReentrant {
        IERC20(wbtcAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wbtcAddress, amount, address(this), 0);
        emit ProtocolInteraction("AAVE_ADD_COLLATERAL", wbtcAddress, amount);
    }

    // ── Exchange operations (route through active IPerpExchange adapter) ──

    function depositToHyperliquid(uint256 amount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction("EXCHANGE_DEPOSIT", usdcAddress, amount);
    }

    function withdrawFromHyperliquid(uint256 amount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).withdrawCollateral(usdcAddress, amount);
        emit ProtocolInteraction("EXCHANGE_WITHDRAW", usdcAddress, amount);
    }

    function withdrawBtcFromHyperliquid(uint256 amount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).withdrawAsset(amount);
        emit ProtocolInteraction("EXCHANGE_WITHDRAW_ASSET", wbtcAddress, amount);
    }

    function addCollateralToHyperliquid(uint256 amount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, amount);
        IPerpExchange(adapter).depositCollateral(usdcAddress, amount);
        emit ProtocolInteraction("EXCHANGE_ADD_COLLATERAL", usdcAddress, amount);
    }

    function openShort(string calldata symbol, uint256 size) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).openPerpPosition(symbol, size, false);
        emit ProtocolInteraction("EXCHANGE_OPEN_SHORT", wbtcAddress, size);
    }

    function closeShort(string calldata symbol) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).closePerpPosition(symbol);
        emit ProtocolInteraction("EXCHANGE_CLOSE_SHORT", wbtcAddress, 0);
    }

    function closeShort(string calldata symbol, uint256 closeSize) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).closePerpPosition(symbol, closeSize);
        emit ProtocolInteraction("EXCHANGE_CLOSE_SHORT", wbtcAddress, closeSize);
    }

    function spotBuyOnHyperliquid(uint256 usdcAmount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(usdcAddress).forceApprove(adapter, usdcAmount);
        uint256 amountOut = IPerpExchange(adapter).tradeSpot(usdcAddress, wbtcAddress, usdcAmount);
        emit ProtocolInteraction("EXCHANGE_SPOT_BUY", wbtcAddress, amountOut);
    }

    function spotSellOnHyperliquid(uint256 amount) external onlyOwner nonReentrant {
        address adapter = _activePerpAdapter();
        IERC20(wbtcAddress).forceApprove(adapter, amount);
        uint256 amountOut = IPerpExchange(adapter).tradeSpot(wbtcAddress, usdcAddress, amount);
        emit ProtocolInteraction("EXCHANGE_SPOT_SELL", usdcAddress, amountOut);
    }

    function cancelHyperliquidOrder(bytes32 orderId) external onlyOwner {
        address adapter = _activePerpAdapter();
        IPerpExchange(adapter).cancelOrder(orderId);
        emit ProtocolInteraction("EXCHANGE_CANCEL_ORDER", wbtcAddress, 0);
    }

    // ── Spot DEX swaps (Uniswap V3) ───────────────────────────────────────

    /// @notice Swap wBTC → USDC via the registered spot DEX. Used to cover residual Aave debt.
    function swapForUsdc(uint256 wbtcAmount) external onlyOwner nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        uint256 minOut = _minUsdcOut(wbtcAmount);
        IERC20(wbtcAddress).forceApprove(spotDexAddress, wbtcAmount);
        uint256 usdcOut = ISpotDex(spotDexAddress).swapExactIn(
            wbtcAddress, usdcAddress, wbtcAmount, minOut, address(this)
        );
        emit ProtocolInteraction("DEX_SWAP_FOR_USDC", usdcAddress, usdcOut);
    }

    /// @notice Swap USDC → wBTC via the registered spot DEX.
    function swapFromUsdc(uint256 usdcAmount) external onlyOwner nonReentrant {
        if (spotDexAddress == address(0)) revert SpotDexNotSet();
        uint256 minOut = _minWbtcOut(usdcAmount);
        IERC20(usdcAddress).forceApprove(spotDexAddress, usdcAmount);
        uint256 wbtcOut = ISpotDex(spotDexAddress).swapExactIn(
            usdcAddress, wbtcAddress, usdcAmount, minOut, address(this)
        );
        emit ProtocolInteraction("DEX_SWAP_FROM_USDC", wbtcAddress, wbtcOut);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function getHyperliquidSpotBalance() external view returns (uint256) {
        address adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) return 0;
        return IPerpExchange(adapter).getSpotBalance();
    }

    /// @notice BTC balance held in the active exchange (18-dec internal units).
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

    function updateNAV(uint256 newNAV) external onlyOwner {
        if (newNAV == 0) revert InvalidNAV();
        currentNAV = newNAV;
        emit NAVUpdateExecuted(newNAV, block.timestamp);
    }

    function getBtcPrice() public view returns (uint256) {
        (, int256 price,,,) = AggregatorV3Interface(btcOracle).latestRoundData();
        if (price <= 0) revert InvalidPrice();
        uint8 dec = AggregatorV3Interface(btcOracle).decimals();
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

    function getReservedBtc() public view returns (uint256) {
        uint256 currentCycle = block.timestamp / cycleDurationSeconds;
        uint256 reserved = 0;
        if (!batchProcessed[currentCycle]) {
            reserved += batchTotalMintBtc[currentCycle];
            uint256 redeemUsdEstimate = (batchTotalRedeemKash[currentCycle] * currentNAV) / 1e18;
            uint256 redeemBtcEstimate = (redeemUsdEstimate * (10000 - feeBps) / 10000 * (10 ** WBTC_DECIMALS)) / getBtcPrice();
            reserved += redeemBtcEstimate;
        } else {
            uint256 minted = batchTotalMintBtc[currentCycle];
            uint256 deployed = batchMintBtcDeployedToAave[currentCycle];
            if (minted > deployed) reserved += (minted - deployed);
        }
        return reserved;
    }

    function markMintBtcDeployed(uint256 batchCycle, uint256 amount) external onlyOwner {
        if (batchMintBtcDeployedToAave[batchCycle] + amount > batchTotalMintBtc[batchCycle]) revert ExceedsMintWbtcForCycle();
        batchMintBtcDeployedToAave[batchCycle] += amount;
        emit ProtocolInteraction("MINT_BTC_DEPLOYED", wbtcAddress, amount);
    }

    function ownerManuallyProcessRedeem(address[] calldata users, uint256 batchCycle) external onlyOwner nonReentrant {
        if (users.length == 0) revert NoUsersProvided();
        uint256 btcPrice = getBtcPrice();
        uint256 totalWbtcNeeded = 0;
        for (uint256 i = 0; i < users.length; i++) {
            RedeemRequest storage req = userRedeemRequests[users[i]][batchCycle];
            if (req.kashAmount == 0) revert NoPendingRedeemRequest();
            uint256 usdAfterFee = (req.kashAmount * currentNAV / 1e18) * (10000 - feeBps) / 10000;
            totalWbtcNeeded += (usdAfterFee * (10 ** WBTC_DECIMALS)) / btcPrice;
        }
        if (IERC20(wbtcAddress).balanceOf(address(this)) < totalWbtcNeeded) revert InsufficientWbtcInContract();
        for (uint256 i = 0; i < users.length; i++) {
            address user = users[i];
            RedeemRequest storage req = userRedeemRequests[user][batchCycle];
            uint256 usdAfterFee = (req.kashAmount * currentNAV / 1e18) * (10000 - feeBps) / 10000;
            uint256 wbtcAmount  = (usdAfterFee * (10 ** WBTC_DECIMALS)) / btcPrice;
            uint256 kashToBurn  = req.kashAmount;
            delete userRedeemRequests[user][batchCycle];
            kashTokenBtc.burn(address(this), kashToBurn);
            IERC20(wbtcAddress).safeTransfer(user, wbtcAmount);
            emit TokensClaimed(user, wbtcAddress, wbtcAmount, false);
        }
        emit ProtocolInteraction("OWNER_MANUAL_REDEEM", wbtcAddress, totalWbtcNeeded);
    }

    function ownerWithdrawWbtc(uint256 amount) external onlyOwner {
        uint256 reserved = getReservedBtc();
        if (amount + reserved > IERC20(wbtcAddress).balanceOf(address(this))) revert InsufficientExcessWbtc();
        IERC20(wbtcAddress).safeTransfer(owner, amount);
        emit ProtocolInteraction("OWNER_WITHDRAW_WBTC", wbtcAddress, amount);
    }

    function emergencyWithdrawMint(uint256 batchCycle) external {
        if (!paused) revert NotPaused();
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.amountIn == 0 || req.amountInUSD != 0) revert InvalidRequest();
        IERC20(wbtcAddress).safeTransfer(msg.sender, req.amountIn);
        delete userMintRequests[msg.sender][batchCycle];
    }

    function emergencyWithdrawRedeem(uint256 batchCycle) external {
        if (!paused) revert NotPaused();
        RedeemRequest storage req = userRedeemRequests[msg.sender][batchCycle];
        if (req.user != msg.sender || req.kashAmount == 0) revert InvalidRequest();
        kashTokenBtc.transfer(msg.sender, req.kashAmount);
        delete userRedeemRequests[msg.sender][batchCycle];
    }

    function getTotalDepositedBtc(address user) external view returns (uint256) { return totalDepositedBtcByUser[user]; }
    function getTotalRedeemedBtc(address user)  external view returns (uint256) { return totalRedeemedBtcByUser[user]; }

    // ── Internal helpers ──────────────────────────────────────────────────

    function _activePerpAdapter() internal view returns (address adapter) {
        adapter = perpExchanges[activePerpExchange];
        if (adapter == address(0)) revert NoActivePerpExchange();
    }

    /// @notice Minimum USDC out for a wBTC → USDC swap, accounting for slippage.
    function _minUsdcOut(uint256 wbtcAmount) internal view returns (uint256) {
        uint256 price = getBtcPrice();
        // wbtcAmount (8-dec) * price (18-dec) / 1e8 → USD 18-dec → /1e12 → USDC 6-dec
        uint256 expectedUsdc = (wbtcAmount * price) / (10 ** WBTC_DECIMALS) / 1e12;
        return expectedUsdc * (10000 - maxSwapSlippageBps) / 10000;
    }

    /// @notice Minimum wBTC out for a USDC → wBTC swap, accounting for slippage.
    function _minWbtcOut(uint256 usdcAmount) internal view returns (uint256) {
        uint256 price = getBtcPrice();
        // usdcAmount (6-dec) * 1e12 → 18-dec → * 1e8 / price → wBTC 8-dec
        uint256 expectedWbtc = (usdcAmount * 1e12 * (10 ** WBTC_DECIMALS)) / price;
        return expectedWbtc * (10000 - maxSwapSlippageBps) / 10000;
    }
}
