// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./libraries/KashVaultNavLib.sol";
import "./libraries/KashVaultOpsLib.sol";
import "./libraries/KashVaultBatchLib.sol";

error OnlyOwner();
error OnlyBotOrKeeper();
error Unauthorized();
error UserWindowClosed();
error NotInProcessingWindow();
error ContractPaused();
error NotPaused();
error AlreadyPaused();
error ZeroAmount();
error AlreadyProcessed();
error NoRequest();
error PhaseAlreadyStarted();
error WrongPhase();
error OpsNotDone();
error InsufficientAssetsForRedeems();
error ExceedsMintAssetForCycle();
error InvalidRequest();
error FeeTooHigh();
error MinCycleDuration();
error InvalidAddress();
error MintCapReached();
error RedeemCapReached();
error ClaimsNotExpired();
error ExceedsAllocation();
error PreviousBatchNotComplete();
error PreviewNotSupported();
error ClaimsNotOpen();
error NPlusOneHoldNotMet();
error SettlementDeviationTooLarge();
error ClaimExpired();

event DepositRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets);
event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares);
event OperatorSet(address indexed controller, address indexed operator, bool approved);
event Deposit(address indexed controller, address indexed receiver, uint256 assets, uint256 shares);
event Withdraw(address indexed controller, address indexed receiver, uint256 assets, uint256 shares);
event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 exactNAV);
event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);
event Paused(address indexed account);
event Unpaused(address indexed account);
event BotAddressSet(address indexed previousBot, address indexed newBot);
event WatcherAddressSet(address indexed previousWatcher, address indexed newWatcher);
event NavCorrected(uint256 newNAV, uint256 anchorNAV);
event NavMonitorTripped(uint256 indexed batchCycle, uint256 settlementNAV, uint256 anchorNAV, uint256 deviationBps);
event ExpiredRedeemClaimsMarked(uint256 indexed batchCycle);
event ExpiredMintClaimsMarked(uint256 indexed batchCycle);
event ExpiredRedeemReleased(uint256 indexed batchCycle, address indexed user, uint256 amount);
event ExpiredMintReleased(uint256 indexed batchCycle, address indexed user, uint256 amount);

/**
 * @title KashVault
 * @notice ERC-20 share token + ERC-4626/7540/7575 async vault. NAV is computed on-chain from
 *         Aster + Aave + Chainlink views. The bot cannot inject NAV or payout amounts.
 *
 * @dev N+1 redeem hold: `lastMintCycle[owner]` is set on every share mint.
 *      `requestRedeem` requires `getCurrentBatchCycle() > lastMintCycle[owner]`. Conservative:
 *      ANY current-cycle mint blocks redeeming older shares until the next cycle.
 */
abstract contract KashVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    bytes4 private constant ERC165_ID = 0x01ffc9a7;
    bytes4 private constant ERC7540_OPERATOR_ID = 0xe3bc4e65;
    bytes4 private constant ERC7540_ASYNC_DEPOSIT_ID = 0xce3bbe50;
    bytes4 private constant ERC7540_ASYNC_REDEEM_ID = 0x620ee8e4;
    bytes4 private constant ERC7575_VAULT_ID = 0x2f0a18c5;

    uint256 public constant NAV_MAX_DEVIATION_BPS = 1500;
    uint256 public constant SETTLEMENT_DEVIATION_BPS = 200;
    uint256 public constant CORRECT_NAV_MAX_DEVIATION_BPS = 500;
    uint256 public constant ORACLE_MAX_STALENESS = 25 hours;
    uint256 public constant PAUSE_TIMELOCK_SECONDS = 7 days;
    uint256 public constant CLAIM_HOLD_SECONDS = 6 hours;
    uint256 public constant CLAIM_EXPIRY_SECONDS = 30 days;
    uint256 public constant VIRTUAL_SHARES = 1000;
    uint256 public constant VIRTUAL_ASSETS = 1;
    uint256 public constant BPS_DENOM = 10_000;

    struct Init {
        address owner;
        address bot;
        address watcher;
        address asset;
        address usdc;
        address exchangeFacade;
        address spotDex;
        address assetOracle;
        address keeperRegistry;
        address feeReceiver;
        address aavePool;
        address aToken;
        address variableDebtUsdc;
        address asterClearingHouse;
        uint256 cycleDurationSeconds;
        uint256 userWindowEnd;
        uint256 processingWindowStart;
        uint256 maxSwapSlippageBps;
        uint256 feeBps;
        uint256 maxDepositUsers;
        uint256 maxRedeemUsers;
        uint256 redeemPayoutBufferBps;
    }

    struct BatchClaimInfo {
        uint256 totalNetClaimable;
        uint256 totalMintClaimable;
        uint256 claimDeadline;
        uint256 claimedAmount;
        uint256 mintClaimedAmount;
        bool redeemClaimsExpired;
        bool mintClaimsExpired;
    }

    address public immutable owner;
    address public botAddress;
    address public watcher;
    address public immutable assetToken;
    address public immutable usdcAddress;
    address public immutable exchangeFacade;
    address public immutable spotDexAddress;
    address public immutable assetOracle;
    address public immutable keeperRegistry;
    address public immutable feeReceiver;
    address public immutable aavePoolAddress;
    address public immutable aTokenAddress;
    address public immutable variableDebtUsdc;
    address public immutable asterClearingHouse;
    uint8 public immutable assetDecimals;

    uint256 public immutable cycleDurationSeconds;
    uint256 public immutable userWindowEnd;
    uint256 public immutable processingWindowStart;
    uint256 public immutable maxSwapSlippageBps;
    uint256 public immutable feeBps;
    uint256 public immutable maxDepositUsers;
    uint256 public immutable maxRedeemUsers;
    uint256 public immutable redeemPayoutBufferBps;

    uint256 public currentNAV = 1e18;
    uint256 public lastAssetPrice;
    bool public paused;
    uint256 public pausedAt;
    uint256 public lockedClaimAsset;
    uint256 public totalPendingDepositAssets;

    mapping(uint256 => bool) public batchProcessed;
    mapping(uint256 => uint256) public cycleStartNAV;
    mapping(uint256 => uint256) public batchIndicativeNAV;
    mapping(uint256 => uint256) public batchMintAssetPrice;
    mapping(uint256 => uint8) public batchPhase;
    mapping(uint256 => uint256) public claimOpenAt;
    mapping(uint256 => uint256) public batchTotalMintValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemValueUSD;
    mapping(uint256 => uint256) public batchTotalRedeemShares;
    mapping(uint256 => uint256) public batchTotalMintAsset;
    mapping(uint256 => uint256) public batchMintAssetDeployed;
    mapping(uint256 => uint256) public activeDepositUsers;
    mapping(uint256 => uint256) public activeRedeemUsers;
    mapping(uint256 => address[]) public batchDepositUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchDeposit;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;
    mapping(uint256 => mapping(address => uint256)) internal _pendingDeposit;
    mapping(uint256 => mapping(address => uint256)) internal _pendingRedeem;
    mapping(uint256 => mapping(address => uint256)) internal _claimableDepositAssets;
    mapping(uint256 => mapping(address => uint256)) internal _claimableDepositShares;
    mapping(uint256 => mapping(address => uint256)) internal _claimableRedeemShares;
    mapping(uint256 => mapping(address => uint256)) internal _claimableRedeemAssets;
    mapping(uint256 => mapping(address => uint256)) public batchRedeemReleasedAsset;
    mapping(uint256 => mapping(address => uint256)) public batchMintSharesReleased;
    mapping(uint256 => BatchClaimInfo) public batchClaimInfo;
    mapping(address => uint256) public lastMintCycle;
    mapping(address => mapping(address => bool)) internal _isOperator;
    mapping(address => EnumerableSet.UintSet) internal _claimableDepositCycles;
    mapping(address => EnumerableSet.UintSet) internal _claimableRedeemCycles;

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyBotOrKeeper() {
        if (msg.sender != botAddress && msg.sender != keeperRegistry) revert OnlyBotOrKeeper();
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

    constructor(string memory name_, string memory symbol_, Init memory i) ERC20(name_, symbol_) {
        if (i.owner == address(0) || i.bot == address(0)) revert InvalidAddress();
        if (i.asset == address(0) || i.usdc == address(0)) revert InvalidAddress();
        if (i.exchangeFacade == address(0) || i.spotDex == address(0) || i.assetOracle == address(0)) revert InvalidAddress();
        if (i.feeReceiver == address(0)) revert InvalidAddress();
        if (i.cycleDurationSeconds < 60) revert MinCycleDuration();
        if (i.userWindowEnd > i.cycleDurationSeconds) revert InvalidRequest();
        if (i.processingWindowStart > i.cycleDurationSeconds) revert InvalidRequest();
        if (i.maxSwapSlippageBps > 500) revert FeeTooHigh();
        if (i.feeBps > 30) revert FeeTooHigh();
        if (i.redeemPayoutBufferBps > 500) revert FeeTooHigh();
        if (i.maxDepositUsers == 0 || i.maxDepositUsers > 100_000) revert InvalidRequest();
        if (i.maxRedeemUsers == 0 || i.maxRedeemUsers > 100_000) revert InvalidRequest();

        owner = i.owner;
        botAddress = i.bot;
        watcher = i.watcher;
        assetToken = i.asset;
        usdcAddress = i.usdc;
        exchangeFacade = i.exchangeFacade;
        spotDexAddress = i.spotDex;
        assetOracle = i.assetOracle;
        keeperRegistry = i.keeperRegistry;
        feeReceiver = i.feeReceiver;
        aavePoolAddress = i.aavePool;
        aTokenAddress = i.aToken;
        variableDebtUsdc = i.variableDebtUsdc;
        asterClearingHouse = i.asterClearingHouse;
        cycleDurationSeconds = i.cycleDurationSeconds;
        userWindowEnd = i.userWindowEnd;
        processingWindowStart = i.processingWindowStart;
        maxSwapSlippageBps = i.maxSwapSlippageBps;
        feeBps = i.feeBps;
        maxDepositUsers = i.maxDepositUsers;
        maxRedeemUsers = i.maxRedeemUsers;
        redeemPayoutBufferBps = i.redeemPayoutBufferBps;
        assetDecimals = IERC20Metadata(i.asset).decimals();
        lastAssetPrice = 1e18;
    }

    // ── ERC-165 / 7575 / 4626 identity ────────────────────────────────────

    function supportsInterface(bytes4 id) public pure returns (bool) {
        return id == ERC165_ID
            || id == ERC7540_OPERATOR_ID
            || id == ERC7540_ASYNC_DEPOSIT_ID
            || id == ERC7540_ASYNC_REDEEM_ID
            || id == ERC7575_VAULT_ID; // share-side 0xf815c03d skipped (size); share() is implemented
    }

    function asset() public view returns (address) {
        return assetToken;
    }

    function share() public view returns (address) {
        return address(this);
    }

    function decimals() public pure override returns (uint8) {
        return 18;
    }

    // ── Roles ─────────────────────────────────────────────────────────────

    function pause() external {
        if (msg.sender != owner && msg.sender != watcher) revert Unauthorized();
        if (paused) revert AlreadyPaused();
        paused = true;
        pausedAt = block.timestamp;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (!paused) revert NotPaused();
        bool timelocked = block.timestamp >= pausedAt + PAUSE_TIMELOCK_SECONDS;
        if (!timelocked && msg.sender != owner) revert OnlyOwner();
        paused = false;
        pausedAt = 0;
        emit Unpaused(msg.sender);
    }

    function setBotAddress(address newBot) external onlyOwner {
        if (newBot == address(0)) revert InvalidAddress();
        address prev = botAddress;
        botAddress = newBot;
        emit BotAddressSet(prev, newBot);
    }

    function setWatcherAddress(address newWatcher) external onlyOwner {
        address prev = watcher;
        watcher = newWatcher;
        emit WatcherAddressSet(prev, newWatcher);
    }

    function correctNAV(uint256 newNAV) external onlyOwner {
        if (newNAV == 0) revert InvalidNAV();
        uint256 cycle = _currentCycle();
        uint256 anchor = cycleStartNAV[cycle];
        if (anchor == 0) anchor = currentNAV;
        uint256 lower = anchor * (BPS_DENOM - CORRECT_NAV_MAX_DEVIATION_BPS) / BPS_DENOM;
        uint256 upper = anchor * (BPS_DENOM + CORRECT_NAV_MAX_DEVIATION_BPS) / BPS_DENOM;
        if (newNAV < lower || newNAV > upper) revert NAVDeviationTooLarge();
        currentNAV = newNAV;
        emit NavCorrected(newNAV, anchor);
    }

    // ── 7540 operators ────────────────────────────────────────────────────

    function isOperator(address controller, address operator) public view returns (bool) {
        return _isOperator[controller][operator];
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        _isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    // ── 7540 request ──────────────────────────────────────────────────────

    function requestDeposit(uint256 assets, address controller, address owner_)
        public
        virtual
        whenNotPaused
        onlyUserWindow
        nonReentrant
        returns (uint256 requestId)
    {
        if (assets == 0) revert ZeroAmount();
        if (controller == address(0) || owner_ == address(0)) revert InvalidAddress();
        _authOwner(owner_);
        uint256 cycle = _currentCycle();
        if (batchPhase[cycle] != 0) revert WrongPhase();
        if (batchProcessed[cycle]) revert AlreadyProcessed();

        IERC20(assetToken).safeTransferFrom(owner_, address(this), assets);
        _addPendingDeposit(cycle, controller, assets);
        emit DepositRequest(controller, owner_, cycle, msg.sender, assets);
        return cycle;
    }

    function requestRedeem(uint256 shares, address controller, address owner_)
        public
        virtual
        whenNotPaused
        onlyUserWindow
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0) revert ZeroAmount();
        if (controller == address(0) || owner_ == address(0)) revert InvalidAddress();
        _authOwner(owner_);
        uint256 cycle = _currentCycle();
        if (cycle <= lastMintCycle[owner_]) revert NPlusOneHoldNotMet();
        if (batchPhase[cycle] != 0) revert WrongPhase();
        if (batchProcessed[cycle]) revert AlreadyProcessed();
        if (balanceOf(owner_) < shares) revert InvalidRequest();

        _transfer(owner_, address(this), shares);
        _addPendingRedeem(cycle, controller, shares);
        emit RedeemRequest(controller, owner_, cycle, msg.sender, shares);
        return cycle;
    }

    function cancelDepositRequest(uint256 requestId, address controller) external whenNotPaused nonReentrant {
        _authController(controller);
        if (batchProcessed[requestId] || batchPhase[requestId] != 0) revert AlreadyProcessed();
        uint256 assets = _pendingDeposit[requestId][controller];
        if (assets == 0) revert NoRequest();
        _pendingDeposit[requestId][controller] = 0;
        batchTotalMintAsset[requestId] -= assets;
        totalPendingDepositAssets -= assets;
        unchecked { activeDepositUsers[requestId]--; }
        IERC20(assetToken).safeTransfer(controller, assets);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_MINT, assetToken, assets);
    }

    function cancelRedeemRequest(uint256 requestId, address controller) external whenNotPaused nonReentrant {
        _authController(controller);
        if (batchProcessed[requestId] || batchPhase[requestId] != 0) revert AlreadyProcessed();
        uint256 shares = _pendingRedeem[requestId][controller];
        if (shares == 0) revert NoRequest();
        _pendingRedeem[requestId][controller] = 0;
        batchTotalRedeemShares[requestId] -= shares;
        unchecked { activeRedeemUsers[requestId]--; }
        _transfer(address(this), controller, shares);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_REDEEM, address(this), shares);
    }

    // ── 4626/7540 claim (FIFO oldest cycle) ───────────────────────────────

    function deposit(uint256 assets, address receiver) public returns (uint256 shares) {
        return deposit(assets, receiver, msg.sender);
    }

    function deposit(uint256 assets, address receiver, address controller)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        _authController(controller);
        uint256 remaining = assets;
        while (remaining > 0) {
            uint256 cycle = _oldestCycle(_claimableDepositCycles[controller]);
            _requireClaimsOpen(cycle);
            uint256 claimable = _claimableDepositAssets[cycle][controller];
            if (claimable == 0) revert NoRequest();
            uint256 take = remaining < claimable ? remaining : claimable;
            uint256 sharesPart = _takeDeposit(cycle, controller, take, false);
            shares += sharesPart;
            remaining -= take;
            _transfer(address(this), receiver, sharesPart);
            lastMintCycle[receiver] = _currentCycle();
            emit Deposit(controller, receiver, take, sharesPart);
        }
    }

    function mint(uint256 shares, address receiver) public returns (uint256 assets) {
        return mint(shares, receiver, msg.sender);
    }

    function mint(uint256 shares, address receiver, address controller)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        _authController(controller);
        uint256 remaining = shares;
        while (remaining > 0) {
            uint256 cycle = _oldestCycle(_claimableDepositCycles[controller]);
            _requireClaimsOpen(cycle);
            uint256 claimableShares = _claimableDepositShares[cycle][controller];
            if (claimableShares == 0) revert NoRequest();
            uint256 takeShares = remaining < claimableShares ? remaining : claimableShares;
            uint256 assetsPart = _takeDeposit(cycle, controller, takeShares, true);
            assets += assetsPart;
            remaining -= takeShares;
            _transfer(address(this), receiver, takeShares);
            lastMintCycle[receiver] = _currentCycle();
            emit Deposit(controller, receiver, assetsPart, takeShares);
        }
    }

    function redeem(uint256 shares, address receiver, address controller)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        _authController(controller);
        uint256 remaining = shares;
        while (remaining > 0) {
            uint256 cycle = _oldestCycle(_claimableRedeemCycles[controller]);
            _requireClaimsOpen(cycle);
            uint256 claimableShares = _claimableRedeemShares[cycle][controller];
            if (claimableShares == 0) revert NoRequest();
            uint256 takeShares = remaining < claimableShares ? remaining : claimableShares;
            uint256 assetsPart = _takeRedeem(cycle, controller, takeShares, true);
            assets += assetsPart;
            remaining -= takeShares;
            IERC20(assetToken).safeTransfer(receiver, assetsPart);
            emit Withdraw(controller, receiver, assetsPart, takeShares);
        }
    }

    function withdraw(uint256 assets, address receiver, address controller)
        public
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        _authController(controller);
        uint256 remaining = assets;
        while (remaining > 0) {
            uint256 cycle = _oldestCycle(_claimableRedeemCycles[controller]);
            _requireClaimsOpen(cycle);
            uint256 claimableAssets = _claimableRedeemAssets[cycle][controller];
            if (claimableAssets == 0) revert NoRequest();
            uint256 takeAssets = remaining < claimableAssets ? remaining : claimableAssets;
            uint256 sharesPart = _takeRedeem(cycle, controller, takeAssets, false);
            shares += sharesPart;
            remaining -= takeAssets;
            IERC20(assetToken).safeTransfer(receiver, takeAssets);
            emit Withdraw(controller, receiver, takeAssets, sharesPart);
        }
    }

    function redeem(uint256 shares, address receiver) external returns (uint256) {
        return redeem(shares, receiver, msg.sender);
    }

    function withdraw(uint256 assets, address receiver) external returns (uint256) {
        return withdraw(assets, receiver, msg.sender);
    }

    // ── 7540 views ────────────────────────────────────────────────────────

    function pendingDepositRequest(uint256 requestId, address controller) public view returns (uint256) {
        return _pendingDeposit[requestId][controller];
    }

    function pendingRedeemRequest(uint256 requestId, address controller) public view returns (uint256) {
        return _pendingRedeem[requestId][controller];
    }

    function claimableDepositRequest(uint256 requestId, address controller) public view returns (uint256) {
        return _claimableDepositAssets[requestId][controller];
    }

    function claimableRedeemRequest(uint256 requestId, address controller) public view returns (uint256) {
        return _claimableRedeemShares[requestId][controller];
    }

    function previewDeposit(uint256) public pure returns (uint256) { revert PreviewNotSupported(); }
    function previewMint(uint256) public pure returns (uint256) { revert PreviewNotSupported(); }
    function previewRedeem(uint256) public pure returns (uint256) { revert PreviewNotSupported(); }
    function previewWithdraw(uint256) public pure returns (uint256) { revert PreviewNotSupported(); }

    function maxDeposit(address controller) public view returns (uint256) {
        return _sumOpen(_claimableDepositCycles[controller], _claimableDepositAssets, controller);
    }

    function maxMint(address controller) public view returns (uint256) {
        return _sumOpen(_claimableDepositCycles[controller], _claimableDepositShares, controller);
    }

    function maxWithdraw(address controller) public view returns (uint256) {
        return _sumOpen(_claimableRedeemCycles[controller], _claimableRedeemAssets, controller);
    }

    function maxRedeem(address controller) public view returns (uint256) {
        return _sumOpen(_claimableRedeemCycles[controller], _claimableRedeemShares, controller);
    }

    function totalAssets() public view returns (uint256) {
        (uint256 nav, uint256 price) = _navAndPriceSafe();
        return KashVaultBatchLib.totalAssetsOf(totalSupply(), nav, price, assetDecimals);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        (uint256 nav, uint256 price) = _navAndPriceSafe();
        return KashVaultBatchLib.convertToShares(
            assets, totalSupply(), totalAssets(), nav, price, assetDecimals, VIRTUAL_SHARES, VIRTUAL_ASSETS
        );
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        (uint256 nav, uint256 price) = _navAndPriceSafe();
        return KashVaultBatchLib.convertToAssets(
            shares, totalSupply(), totalAssets(), nav, price, assetDecimals, VIRTUAL_SHARES, VIRTUAL_ASSETS
        );
    }

    // ── NAV ───────────────────────────────────────────────────────────────

    function getNAV() public view returns (uint256) {
        return _computeNAV(_assetPrice(), false);
    }

    function getAssetPrice() public view returns (uint256) {
        return _assetPrice();
    }

    function _portfolioUsd(uint256 price, bool includePendingMint) internal view returns (uint256) {
        return KashVaultNavLib.portfolioUsd(
            assetToken,
            usdcAddress,
            aTokenAddress,
            variableDebtUsdc,
            asterClearingHouse,
            exchangeFacade,
            price,
            assetDecimals,
            lockedClaimAsset,
            totalPendingDepositAssets,
            includePendingMint
        );
    }

    function _computeNAV(uint256 price, bool includePendingMint) internal view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return currentNAV;
        uint256 aum = _portfolioUsd(price, includePendingMint);
        return (aum * 1e18) / supply;
    }

    function _assetPrice() internal view returns (uint256) {
        return KashVaultNavLib.assetPrice(assetOracle, ORACLE_MAX_STALENESS);
    }

    function _navAndPriceSafe() internal view returns (uint256 nav, uint256 price) {
        try this.getAssetPrice() returns (uint256 p) {
            price = p;
            nav = _computeNAV(p, false);
        } catch {
            price = lastAssetPrice;
            nav = currentNAV;
        }
    }

    function _applyNavCaps(uint256 newNAV) internal view {
        uint256 cycle = _currentCycle();
        uint256 anchor = cycleStartNAV[cycle];
        if (anchor == 0) anchor = currentNAV;
        KashVaultNavLib.checkNavCaps(newNAV, currentNAV, anchor, NAV_MAX_DEVIATION_BPS);
    }

    function _checkSettlementDeviation(uint256 cycle, uint256 settlementNAV) internal {
        uint256 anchor = cycleStartNAV[cycle];
        if (anchor == 0) return;
        uint256 diff = settlementNAV > anchor ? settlementNAV - anchor : anchor - settlementNAV;
        uint256 deviationBps = (diff * BPS_DENOM) / anchor;
        if (deviationBps > SETTLEMENT_DEVIATION_BPS) {
            emit NavMonitorTripped(cycle, settlementNAV, anchor, deviationBps);
            revert SettlementDeviationTooLarge();
        }
    }

    // ── Batch ─────────────────────────────────────────────────────────────

    function performUpkeep(bytes calldata) external onlyBotOrKeeper whenNotPaused onlyProcessingWindow {
        uint256 cycle = _currentCycle();
        uint8 phase = batchPhase[cycle];
        if (phase == 0) _processBatchPhase1();
        else if (phase == 2) _processBatchPhase2(cycle);
        else revert WrongPhase();
    }

    function processBatchPhase2ForCycle(uint256 batchCycle)
        external
        onlyBotOrKeeper
        whenNotPaused
        nonReentrant
        onlyProcessingWindow
    {
        if (batchPhase[batchCycle] != 2) revert OpsNotDone();
        _processBatchPhase2(batchCycle);
    }

    /// @notice Advance phase 1 → 2 after hedge ops. Redeem pool is derived on-chain in phase 2.
    function markBatchOpsDone(uint256 batchCycle) external onlyBotOrKeeper whenNotPaused {
        if (batchPhase[batchCycle] != 1) revert WrongPhase();
        batchPhase[batchCycle] = 2;
        emit BatchPhaseUpdated(batchCycle, 2, currentNAV);
    }

    function _processBatchPhase1() internal {
        uint256 cycle = _currentCycle();
        if (batchPhase[cycle] != 0) revert PhaseAlreadyStarted();
        if (cycle > 0) {
            uint8 prev = batchPhase[cycle - 1];
            if (prev != 0 && prev != 3) revert PreviousBatchNotComplete();
        }

        uint256 price = _assetPrice();
        uint256 indicativeNAV = _computeNAV(price, false);
        _applyNavCaps(indicativeNAV);
        currentNAV = indicativeNAV;
        lastAssetPrice = price;
        batchMintAssetPrice[cycle] = price;
        cycleStartNAV[cycle] = indicativeNAV;
        batchIndicativeNAV[cycle] = indicativeNAV;

        uint256 totalMintUSD = (batchTotalMintAsset[cycle] * price) / (10 ** uint256(assetDecimals));
        batchTotalMintValueUSD[cycle] = totalMintUSD;
        batchTotalRedeemValueUSD[cycle] = (batchTotalRedeemShares[cycle] * indicativeNAV) / 1e18;

        int256 netPositionUSD = int256(totalMintUSD) - int256(batchTotalRedeemValueUSD[cycle]);
        if (netPositionUSD > 0) emit ProtocolInteraction(ProtocolActionCodes.NET_MINT, assetToken, uint256(netPositionUSD));
        else if (netPositionUSD < 0) emit ProtocolInteraction(ProtocolActionCodes.NET_REDEEM, assetToken, uint256(-netPositionUSD));

        batchPhase[cycle] = 1;
        emit BatchPhaseUpdated(cycle, 1, indicativeNAV);
    }

    function _processBatchPhase2(uint256 cycle) internal {
        uint256 price = _assetPrice();
        uint256 settlementNAV = _computeNAV(price, false);
        _checkSettlementDeviation(cycle, settlementNAV);
        _applyNavCaps(settlementNAV);
        currentNAV = settlementNAV;
        lastAssetPrice = price;

        uint256 totalMintUSD = batchTotalMintValueUSD[cycle];
        uint256 totalMintShares;
        if (totalMintUSD > 0) {
            uint256 afterFee = totalMintUSD * (BPS_DENOM - feeBps) / BPS_DENOM;
            totalMintShares = (afterFee * 1e18) / settlementNAV;
        }
        uint256 totalMintFeeAsset = batchTotalMintAsset[cycle] * feeBps / BPS_DENOM;

        uint256 totalRedeemShares_ = batchTotalRedeemShares[cycle];
        uint256 grossRedeemAsset;
        if (totalRedeemShares_ > 0) {
            uint256 redeemUsd = (totalRedeemShares_ * settlementNAV) / 1e18;
            grossRedeemAsset = (redeemUsd * (10 ** uint256(assetDecimals))) / price;
        }
        batchTotalRedeemValueUSD[cycle] = grossRedeemAsset;

        (uint256 totalNet, uint256 totalRedeemFee) = KashVaultBatchLib.lockRedeems(
            batchRedeemUsers[cycle],
            _pendingRedeem,
            _claimableRedeemShares,
            _claimableRedeemAssets,
            _claimableRedeemCycles,
            cycle,
            totalRedeemShares_,
            grossRedeemAsset,
            feeBps
        );
        KashVaultBatchLib.lockMints(
            batchDepositUsers[cycle],
            _pendingDeposit,
            _claimableDepositAssets,
            _claimableDepositShares,
            _claimableDepositCycles,
            cycle,
            totalMintShares,
            batchTotalMintAsset[cycle]
        );

        uint256 totalFee = totalMintFeeAsset + totalRedeemFee;
        uint256 buffer = (totalNet * redeemPayoutBufferBps) / BPS_DENOM;
        uint256 idle = IERC20(assetToken).balanceOf(address(this));
        if (idle + buffer < totalNet + totalFee + lockedClaimAsset) revert InsufficientAssetsForRedeems();
        if (totalFee > 0) IERC20(assetToken).safeTransfer(feeReceiver, totalFee);

        BatchClaimInfo storage info = batchClaimInfo[cycle];
        uint256 deadline = block.timestamp + CLAIM_EXPIRY_SECONDS;
        claimOpenAt[cycle] = block.timestamp + CLAIM_HOLD_SECONDS;
        info.claimDeadline = deadline;

        if (totalRedeemShares_ > 0) {
            lockedClaimAsset += totalNet;
            info.totalNetClaimable = totalNet;
        }
        if (totalMintShares > 0) info.totalMintClaimable = totalMintShares;

        uint256 mintedNow = totalMintShares;
        uint256 burnedNow = totalRedeemShares_;
        if (mintedNow > burnedNow) _mint(address(this), mintedNow - burnedNow);
        else if (burnedNow > mintedNow) _burn(address(this), burnedNow - mintedNow);

        totalPendingDepositAssets -= batchTotalMintAsset[cycle];

        batchProcessed[cycle] = true;
        batchPhase[cycle] = 3;
        emit BatchProcessed(cycle, batchTotalMintValueUSD[cycle], batchTotalRedeemValueUSD[cycle], settlementNAV);
    }

    // ── Ops (full-pause gated) ────────────────────────────────────────────

    function approveExchangeFacadeUsdc(uint256 amount) external onlyBotOrKeeper whenNotPaused {
        IERC20(usdcAddress).forceApprove(exchangeFacade, amount);
    }

    function depositToAave(uint256 amount) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.depositToAave(aavePoolAddress, assetToken, amount);
    }

    function withdrawFromAave(uint256 amount) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.withdrawFromAave(aavePoolAddress, assetToken, amount);
    }

    function borrowFromAave(address token, uint256 amount) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.borrowFromAave(aavePoolAddress, token, amount);
    }

    function repayToAave(address token, uint256 amount) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.repayToAave(aavePoolAddress, token, amount);
    }

    function addCollateralToAave(uint256 amount) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.addCollateralToAave(aavePoolAddress, assetToken, amount);
    }

    function swapForUsdc(uint256 assetAmount, uint256 minOut) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.swapForUsdc(spotDexAddress, assetToken, usdcAddress, assetAmount, minOut, maxSwapSlippageBps);
    }

    function swapFromUsdc(uint256 usdcAmount, uint256 minOut) external onlyBotOrKeeper whenNotPaused nonReentrant {
        KashVaultOpsLib.swapFromUsdc(spotDexAddress, assetToken, usdcAddress, usdcAmount, minOut, maxSwapSlippageBps);
    }

    function markMintAssetDeployed(uint256 batchCycle, uint256 amount) external onlyBotOrKeeper whenNotPaused {
        if (batchMintAssetDeployed[batchCycle] + amount > batchTotalMintAsset[batchCycle]) revert ExceedsMintAssetForCycle();
        batchMintAssetDeployed[batchCycle] += amount;
        emit ProtocolInteraction(ProtocolActionCodes.MINT_ETH_DEPLOYED, assetToken, amount);
    }

    // ── Expired claims ────────────────────────────────────────────────────

    function sweepExpired(uint256 batchCycle, bool isMint) external onlyBotOrKeeper {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        if (block.timestamp <= info.claimDeadline) revert ClaimsNotExpired();
        if (isMint) {
            if (info.mintClaimsExpired) revert AlreadyProcessed();
            if (info.totalMintClaimable <= info.mintClaimedAmount) revert ZeroAmount();
            info.mintClaimsExpired = true;
            emit ExpiredMintClaimsMarked(batchCycle);
        } else {
            if (info.redeemClaimsExpired) revert AlreadyProcessed();
            if (info.totalNetClaimable <= info.claimedAmount) revert ZeroAmount();
            info.redeemClaimsExpired = true;
            emit ExpiredRedeemClaimsMarked(batchCycle);
        }
    }

    function releaseExpired(uint256 batchCycle, address user, uint256 amount, bool isMint)
        external
        onlyBotOrKeeper
        nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (isMint) {
            if (!info.mintClaimsExpired) revert ClaimsNotExpired();
            uint256 cap = _claimableDepositShares[batchCycle][user];
            uint256 already = batchMintSharesReleased[batchCycle][user];
            if (amount > cap - already) revert ExceedsAllocation();
            batchMintSharesReleased[batchCycle][user] = already + amount;
            _claimableDepositShares[batchCycle][user] -= amount;
            _transfer(address(this), user, amount);
            lastMintCycle[user] = _currentCycle();
            emit ExpiredMintReleased(batchCycle, user, amount);
        } else {
            if (!info.redeemClaimsExpired) revert ClaimsNotExpired();
            uint256 cap = _claimableRedeemAssets[batchCycle][user];
            uint256 already = batchRedeemReleasedAsset[batchCycle][user];
            if (amount > cap - already) revert ExceedsAllocation();
            batchRedeemReleasedAsset[batchCycle][user] = already + amount;
            _claimableRedeemAssets[batchCycle][user] -= amount;
            lockedClaimAsset -= amount;
            IERC20(assetToken).safeTransfer(user, amount);
            emit ExpiredRedeemReleased(batchCycle, user, amount);
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────

    function isUserWindow() public view returns (bool) {
        return block.timestamp % cycleDurationSeconds < userWindowEnd;
    }

    function isProcessingWindow() public view returns (bool) {
        uint256 t = block.timestamp % cycleDurationSeconds;
        return t >= processingWindowStart && t < cycleDurationSeconds;
    }

    function getCurrentBatchCycle() public view returns (uint256) {
        return _currentCycle();
    }

    // ── Internals ─────────────────────────────────────────────────────────

    function _currentCycle() internal view returns (uint256) {
        return block.timestamp / cycleDurationSeconds;
    }

    function _authOwner(address owner_) internal view {
        if (msg.sender != owner_ && !_isOperator[owner_][msg.sender]) revert Unauthorized();
    }

    function _authController(address controller) internal view {
        if (msg.sender != controller && !_isOperator[controller][msg.sender]) revert Unauthorized();
    }

    function _requireClaimsOpen(uint256 cycle) internal view {
        if (claimOpenAt[cycle] == 0 || block.timestamp < claimOpenAt[cycle]) revert ClaimsNotOpen();
        if (block.timestamp > batchClaimInfo[cycle].claimDeadline) revert ClaimExpired();
    }

    function _addPendingDeposit(uint256 cycle, address controller, uint256 assets) internal {
        bool wasActive = _pendingDeposit[cycle][controller] > 0;
        _pendingDeposit[cycle][controller] += assets;
        batchTotalMintAsset[cycle] += assets;
        totalPendingDepositAssets += assets;
        if (!wasActive) {
            if (activeDepositUsers[cycle] >= maxDepositUsers) revert MintCapReached();
            unchecked { activeDepositUsers[cycle]++; }
        }
        if (!isInBatchDeposit[cycle][controller]) {
            batchDepositUsers[cycle].push(controller);
            isInBatchDeposit[cycle][controller] = true;
        }
    }

    function _addPendingRedeem(uint256 cycle, address controller, uint256 shares) internal {
        bool wasActive = _pendingRedeem[cycle][controller] > 0;
        _pendingRedeem[cycle][controller] += shares;
        batchTotalRedeemShares[cycle] += shares;
        if (!wasActive) {
            if (activeRedeemUsers[cycle] >= maxRedeemUsers) revert RedeemCapReached();
            unchecked { activeRedeemUsers[cycle]++; }
        }
        if (!isInBatchRedeem[cycle][controller]) {
            batchRedeemUsers[cycle].push(controller);
            isInBatchRedeem[cycle][controller] = true;
        }
    }

    function _sumOpen(
        EnumerableSet.UintSet storage cycles,
        mapping(uint256 => mapping(address => uint256)) storage amounts,
        address controller
    ) internal view returns (uint256 total) {
        uint256 n = cycles.length();
        for (uint256 i = 0; i < n; i++) {
            uint256 cycle = cycles.at(i);
            if (claimOpenAt[cycle] != 0 && block.timestamp >= claimOpenAt[cycle]) {
                total += amounts[cycle][controller];
            }
        }
    }

    function _oldestCycle(EnumerableSet.UintSet storage set) internal view returns (uint256 oldest) {
        uint256 n = set.length();
        if (n == 0) revert NoRequest();
        oldest = type(uint256).max;
        for (uint256 i = 0; i < n; i++) {
            uint256 c = set.at(i);
            if (c < oldest) oldest = c;
        }
    }

    /// @dev `byShares` true = mint()/redeem() path; false = deposit()/withdraw() path.
    function _takeDeposit(uint256 cycle, address controller, uint256 amount, bool byShares)
        internal
        returns (uint256 other)
    {
        if (byShares) {
            other = KashVaultBatchLib.takePair(
                _claimableDepositShares, _claimableDepositAssets, _claimableDepositCycles, cycle, controller, amount, true
            );
            batchClaimInfo[cycle].mintClaimedAmount += amount;
        } else {
            other = KashVaultBatchLib.takePair(
                _claimableDepositAssets, _claimableDepositShares, _claimableDepositCycles, cycle, controller, amount, true
            );
            batchClaimInfo[cycle].mintClaimedAmount += other;
        }
    }

    function _takeRedeem(uint256 cycle, address controller, uint256 amount, bool byShares)
        internal
        returns (uint256 other)
    {
        if (byShares) {
            other = KashVaultBatchLib.takePair(
                _claimableRedeemShares, _claimableRedeemAssets, _claimableRedeemCycles, cycle, controller, amount, true
            );
            lockedClaimAsset -= other;
            batchClaimInfo[cycle].claimedAmount += other;
        } else {
            other = KashVaultBatchLib.takePair(
                _claimableRedeemAssets, _claimableRedeemShares, _claimableRedeemCycles, cycle, controller, amount, true
            );
            lockedClaimAsset -= amount;
            batchClaimInfo[cycle].claimedAmount += amount;
        }
    }
}
