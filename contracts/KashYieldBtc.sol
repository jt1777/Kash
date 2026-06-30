// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./KashTokenBtc.sol";
import "./ExchangeFacade.sol";
import "./libraries/MerkleVerify.sol";
import "./libraries/ProtocolActionCodes.sol";
import "./interfaces/ISpotDex.sol";

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function getATokenBalance(address asset, address user) external view returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
    function repay(address asset, uint256 amount, uint256 rateMode, address onBehalfOf) external returns (uint256);
}

error OnlyBotOrKeeper();
error UserWindowClosed();
error NotInProcessingWindow();
error ZeroAmount();
error AlreadyProcessed();
error NoRequest();
error InsufficientKashBtc();
error PhaseAlreadyStarted();
error WrongPhase();
error OpsNotDone();
error UsePerformUpkeep();
error InsufficientWbtcForRedeems();
error ExceedsMintWbtcForCycle();
error NoUsersProvided();
error InvalidRequest();
error InvalidNAV();
error InvalidPrice();
error FeeTooHigh();
error SpotDexNotSet();
error MinCycleDuration();
error InvalidAddress();
error MintCapReached();
error RedeemCapReached();
error UseBotPhase2();
error InvalidMerkleRoot();
error AlreadyClaimed();
error ClaimExpired();
error InvalidProof();
error ClaimsNotExpired();

event MintRequested(address indexed user, uint256 amountIn, uint256 batchCycle);
event RedeemRequested(address indexed user, uint256 kashAmount, uint256 batchCycle);
event BatchPhaseUpdated(uint256 indexed batchCycle, uint8 phase, uint256 indicativeNAV);
event BatchProcessed(uint256 indexed batchCycle, uint256 totalMintValueUSD, uint256 totalRedeemValueUSD, uint256 exactNAV);
event TokensClaimed(address indexed user, address indexed token, uint256 amount, bool isMint);
event NAVUpdateExecuted(uint256 newNAV, uint256 timestamp);
event NAVProposedAndUpdated(uint256 newNAV, uint256 usdcBalance, uint256 assetBalance, uint256 perpPnL, uint256 timestamp);
event ProtocolInteraction(uint8 indexed action, address indexed asset, uint256 amount);
event RedeemMerkleRootCommitted(uint256 indexed batchCycle, bytes32 root, uint256 totalNetClaimable, uint256 claimDeadline);
event MintMerkleRootCommitted(uint256 indexed batchCycle, bytes32 root, uint256 totalMintClaimable, uint256 claimDeadline);
event ExpiredClaimsSwept(uint256 indexed batchCycle, uint256 amountSwept);
event ExpiredMintClaimsSwept(uint256 indexed batchCycle, uint256 amountSwept);

/**
 * @title KashYieldBtc
 * @dev V3 wBTC yield vault — ownerless, immutable config for bug-bounty deployment.
 *      Merkle roots are committed once by the bot; no admin can override claims or drain reserves.
 */
contract KashYieldBtc is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WBTC_DECIMALS = 8;
    string public constant VERSION = "3.0.0";

    KashTokenBtc public kashTokenBtc;
    uint256 public currentNAV = 1e18;

    address public immutable aavePoolAddress;
    address public immutable botAddress;
    address public immutable keeperRegistry;
    address public immutable wbtcAddress;
    address public immutable usdcAddress;
    address public immutable exchangeFacade;
    address public immutable spotDexAddress;
    address public immutable btcOracle;
    address public immutable feeReceiver;
    uint8   public immutable btcDecimals;

    uint256 public immutable maxSwapSlippageBps;
    uint256 public immutable maxMintUsers;
    uint256 public immutable maxRedeemUsers;
    uint256 public immutable feeBps;
    uint256 public immutable cycleDurationSeconds;
    uint256 public immutable userWindowEnd;
    uint256 public immutable processingWindowStart;

    uint256 private constant REDEEM_PAYOUT_TOLERANCE = 30;
    uint256 public constant CLAIM_EXPIRY_SECONDS = 30 days;

    uint256 public lockedClaimWbtc;
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
    mapping(uint256 => uint256) public batchTotalMintBtc;
    mapping(uint256 => address[]) public batchMintUsers;
    mapping(uint256 => address[]) public batchRedeemUsers;
    mapping(uint256 => mapping(address => bool)) public isInBatchMint;
    mapping(uint256 => mapping(address => bool)) public isInBatchRedeem;
    mapping(uint256 => uint256) public batchMintBtcDeployedToAave;
    mapping(address => uint256) public totalDepositedBtcByUser;
    mapping(address => uint256) public totalRedeemedBtcByUser;

    modifier onlyUserWindow() {
        if (block.timestamp % cycleDurationSeconds >= userWindowEnd) revert UserWindowClosed();
        _;
    }
    modifier onlyProcessingWindow() {
        uint256 t = block.timestamp % cycleDurationSeconds;
        if (t < processingWindowStart || t >= cycleDurationSeconds) revert NotInProcessingWindow();
        _;
    }
    modifier onlyBotOrKeeper() {
        if (msg.sender != botAddress && msg.sender != keeperRegistry) revert OnlyBotOrKeeper();
        _;
    }

    constructor(
        address _botAddress,
        address _wbtc,
        address _usdc,
        address _exchangeFacade,
        address _spotDex,
        address _btcOracle,
        address _keeperRegistry,
        address _feeReceiver,
        uint256 _cycleDurationSeconds,
        uint256 _userWindowEnd,
        uint256 _processingWindowStart,
        uint256 _maxSwapSlippageBps,
        uint256 _feeBps,
        uint256 _maxMintUsers,
        uint256 _maxRedeemUsers
    ) payable {
        if (_botAddress == address(0)) revert InvalidAddress();
        if (_wbtc == address(0) || _usdc == address(0)) revert InvalidAddress();
        if (_exchangeFacade == address(0) || _spotDex == address(0) || _btcOracle == address(0)) revert InvalidAddress();
        if (_feeReceiver == address(0)) revert InvalidAddress();
        if (_cycleDurationSeconds < 60) revert MinCycleDuration();
        if (_userWindowEnd > _cycleDurationSeconds) revert InvalidRequest();
        if (_processingWindowStart > _cycleDurationSeconds) revert InvalidRequest();
        if (_maxSwapSlippageBps > 500) revert FeeTooHigh();
        if (_feeBps > 100) revert FeeTooHigh();
        if (_maxMintUsers == 0 || _maxMintUsers > 100_000) revert InvalidRequest();
        if (_maxRedeemUsers == 0 || _maxRedeemUsers > 100_000) revert InvalidRequest();

        botAddress = _botAddress;
        wbtcAddress = _wbtc;
        usdcAddress = _usdc;
        exchangeFacade = _exchangeFacade;
        spotDexAddress = _spotDex;
        btcOracle = _btcOracle;
        keeperRegistry = _keeperRegistry;
        feeReceiver = _feeReceiver;
        cycleDurationSeconds = _cycleDurationSeconds;
        userWindowEnd = _userWindowEnd;
        processingWindowStart = _processingWindowStart;
        maxSwapSlippageBps = _maxSwapSlippageBps;
        feeBps = _feeBps;
        maxMintUsers = _maxMintUsers;
        maxRedeemUsers = _maxRedeemUsers;
        btcDecimals = AggregatorV3Interface(_btcOracle).decimals();

        aavePoolAddress = 0x794a61358D6845594F94dc1DB02A252b5b4814aD;

        kashTokenBtc = new KashTokenBtc();
        kashTokenBtc.transferOwnership(address(this));
    }

    function approveExchangeFacadeUsdc(uint256 amount) external onlyBotOrKeeper {
        IERC20(usdcAddress).forceApprove(exchangeFacade, amount);
    }

    function perpExchangeAddress() external view returns (address) {
        return ExchangeFacade(exchangeFacade).perpExchangeAddress();
    }

    function getPerpExchangeSpotBalance() external view returns (uint256) {
        return ExchangeFacade(exchangeFacade).getPerpExchangeSpotBalance();
    }

    function getExchangeAssetBalance() external view returns (uint256) {
        return ExchangeFacade(exchangeFacade).getExchangeAssetBalance();
    }

    function getPerpExchangePosition(string calldata symbol) external view returns (
        uint256 size, uint256 collateral, uint256 entryPrice, bool isLong, bool isActive
    ) {
        return ExchangeFacade(exchangeFacade).getPerpExchangePosition(symbol);
    }

    function requestMint(uint256 amount) external onlyUserWindow {
        if (amount == 0) revert ZeroAmount();
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        IERC20(wbtcAddress).safeTransferFrom(msg.sender, address(this), amount);
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        bool wasActive = req.amountIn > 0;
        req.user = msg.sender;
        req.amountIn += amount;
        req.batchCycle = batchCycle;
        uint256 btcPrice = getBtcPrice();
        uint256 usdIncrement = (amount * btcPrice) / (10 ** WBTC_DECIMALS);
        req.amountInUSD += usdIncrement;
        batchTotalMintValueUSD[batchCycle] += usdIncrement;
        batchTotalMintBtc[batchCycle] += amount;
        if (!wasActive) {
            if (activeMintUsers[batchCycle] >= maxMintUsers) revert MintCapReached();
            unchecked { activeMintUsers[batchCycle]++; }
        }
        if (!isInBatchMint[batchCycle][msg.sender]) {
            batchMintUsers[batchCycle].push(msg.sender);
            isInBatchMint[batchCycle][msg.sender] = true;
        }
        emit MintRequested(msg.sender, amount, batchCycle);
    }

    function requestRedeem(uint256 kashAmount) external onlyUserWindow {
        if (kashAmount == 0) revert ZeroAmount();
        if (kashTokenBtc.balanceOf(msg.sender) < kashAmount) revert InsufficientKashBtc();
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        kashTokenBtc.transferFrom(msg.sender, address(this), kashAmount);
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

    function cancelMintRequest(uint256 batchCycle) external {
        if (batchProcessed[batchCycle]) revert AlreadyProcessed();
        if (batchPhase[batchCycle] != 0) revert WrongPhase();
        MintRequest storage req = userMintRequests[msg.sender][batchCycle];
        if (req.amountIn == 0) revert NoRequest();
        uint256 amount = req.amountIn;
        uint256 usdAmount = req.amountInUSD;
        batchTotalMintBtc[batchCycle] -= amount;
        batchTotalMintValueUSD[batchCycle] -= usdAmount;
        unchecked { activeMintUsers[batchCycle]--; }
        delete userMintRequests[msg.sender][batchCycle];
        IERC20(wbtcAddress).safeTransfer(msg.sender, amount);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_MINT, wbtcAddress, amount);
    }

    function cancelRedeemRequest(uint256 batchCycle) external {
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
        kashTokenBtc.transfer(msg.sender, kashAmount);
        emit ProtocolInteraction(ProtocolActionCodes.CANCEL_REDEEM, address(kashTokenBtc), kashAmount);
    }

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

    function processBatchPhase1() internal onlyProcessingWindow {
        uint256 batchCycle = block.timestamp / cycleDurationSeconds;
        if (batchPhase[batchCycle] != 0) revert PhaseAlreadyStarted();

        uint256 indicativeNAV = currentNAV;
        uint256 totalMintUSD = batchTotalMintValueUSD[batchCycle];
        uint256 totalRedeemUSD = batchTotalRedeemValueUSD[batchCycle];
        batchIndicativeNAV[batchCycle] = indicativeNAV;

        int256 netPositionUSD = int256(totalMintUSD) - int256(totalRedeemUSD);
        if (netPositionUSD > 0) emit ProtocolInteraction(ProtocolActionCodes.NET_MINT, wbtcAddress, uint256(netPositionUSD));
        else if (netPositionUSD < 0) emit ProtocolInteraction(ProtocolActionCodes.NET_REDEEM, wbtcAddress, uint256(-netPositionUSD));

        batchPhase[batchCycle] = 1;
        emit BatchPhaseUpdated(batchCycle, 1, indicativeNAV);
    }

    function markBatchOpsDone(uint256 batchCycle, uint256 grossRedeemAssetAmount) external onlyBotOrKeeper {
        if (batchPhase[batchCycle] != 1) revert WrongPhase();
        if (batchTotalRedeemKash[batchCycle] > 0) {
            if (grossRedeemAssetAmount == 0) revert InsufficientWbtcForRedeems();
            batchTotalRedeemValueUSD[batchCycle] = grossRedeemAssetAmount;
        }
        batchPhase[batchCycle] = 2;
        emit BatchPhaseUpdated(batchCycle, 2, currentNAV);
    }

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

    function _allocRedeemWbtc(
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
        uint256 totalMintFeeBtc = batchTotalMintBtc[batchCycle] * feeBps / 10000;

        uint256 totalRedeemKash = batchTotalRedeemKash[batchCycle];
        (, uint256 totalRedeemBtcNeeded, uint256 totalRedeemFeeBtc) =
            _allocRedeemWbtc(batchCycle, redeemers, totalRedeemKash, batchTotalRedeemValueUSD[batchCycle]);
        uint256 totalProtocolFeeBtc = totalMintFeeBtc + totalRedeemFeeBtc;
        if (IERC20(wbtcAddress).balanceOf(address(this)) + REDEEM_PAYOUT_TOLERANCE < totalRedeemBtcNeeded + lockedClaimWbtc) revert InsufficientWbtcForRedeems();
        if (totalProtocolFeeBtc > 0) {
            IERC20(wbtcAddress).safeTransfer(feeReceiver, totalProtocolFeeBtc);
        }

        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        uint256 claimDeadline = block.timestamp + CLAIM_EXPIRY_SECONDS;

        if (totalRedeemKash > 0) {
            lockedClaimWbtc += totalRedeemBtcNeeded;
            info.redeemMerkleRoot = redeemMerkleRoot;
            info.totalNetClaimable = totalRedeemBtcNeeded;
            info.claimDeadline = claimDeadline;
            emit RedeemMerkleRootCommitted(batchCycle, redeemMerkleRoot, totalRedeemBtcNeeded, claimDeadline);
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
        if (netKash > 0) kashTokenBtc.mint(address(this), uint256(netKash));
        else if (netKash < 0) kashTokenBtc.burn(address(this), uint256(-netKash));
    }

    function claimMint(uint256 batchCycle, uint256 kashAmount, bytes32[] calldata proof) external nonReentrant {
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
        totalDepositedBtcByUser[msg.sender] += req.amountIn;
        kashTokenBtc.transfer(msg.sender, kashAmount);
        emit TokensClaimed(msg.sender, address(kashTokenBtc), kashAmount, true);
    }

    function claimRedeem(uint256 batchCycle, uint256 wbtcAmount, bytes32[] calldata proof) external nonReentrant {
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (info.redeemMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (redeemClaimed[batchCycle][msg.sender]) revert AlreadyClaimed();
        if (block.timestamp > info.claimDeadline) revert ClaimExpired();

        bytes32 leaf = keccak256(abi.encode(batchCycle, msg.sender, wbtcAmount));
        if (!MerkleVerify.verify(proof, info.redeemMerkleRoot, leaf)) revert InvalidProof();

        redeemClaimed[batchCycle][msg.sender] = true;
        info.claimedAmount += wbtcAmount;
        lockedClaimWbtc -= wbtcAmount;
        totalRedeemedBtcByUser[msg.sender] += wbtcAmount;
        IERC20(wbtcAddress).safeTransfer(msg.sender, wbtcAmount);
        emit TokensClaimed(msg.sender, wbtcAddress, wbtcAmount, false);
    }

    function sweepExpiredClaims(uint256 batchCycle) external onlyBotOrKeeper {
        BatchClaimInfo storage info = batchClaimInfo[batchCycle];
        if (!batchProcessed[batchCycle]) revert WrongPhase();
        if (block.timestamp <= info.claimDeadline) revert ClaimsNotExpired();
        uint256 unclaimed = info.totalNetClaimable - info.claimedAmount;
        if (unclaimed == 0) revert ZeroAmount();
        info.claimedAmount = info.totalNetClaimable;
        lockedClaimWbtc -= unclaimed;
        IERC20(wbtcAddress).safeTransfer(feeReceiver, unclaimed);
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
        kashTokenBtc.burn(address(this), unclaimed);
        emit ExpiredMintClaimsSwept(batchCycle, unclaimed);
    }

    function depositToAave(uint256 amount) external onlyBotOrKeeper nonReentrant {
        IERC20(wbtcAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wbtcAddress, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_DEPOSIT, wbtcAddress, amount);
    }

    function withdrawFromAave(uint256 amount) external onlyBotOrKeeper nonReentrant {
        IPool(aavePoolAddress).withdraw(wbtcAddress, amount, address(this));
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_WITHDRAW, wbtcAddress, amount);
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
        IERC20(wbtcAddress).forceApprove(aavePoolAddress, amount);
        IPool(aavePoolAddress).supply(wbtcAddress, amount, address(this), 0);
        emit ProtocolInteraction(ProtocolActionCodes.AAVE_ADD_COLLATERAL, wbtcAddress, amount);
    }

    function swapForUsdc(uint256 wbtcAmount, uint256 minOut) external onlyBotOrKeeper nonReentrant {
        IERC20(wbtcAddress).forceApprove(spotDexAddress, wbtcAmount);
        uint256 usdcOut = ISpotDex(spotDexAddress).swapExactIn(
            wbtcAddress, usdcAddress, wbtcAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FOR_USDC, usdcAddress, usdcOut);
    }

    function swapFromUsdc(uint256 usdcAmount, uint256 minOut) external onlyBotOrKeeper nonReentrant {
        IERC20(usdcAddress).forceApprove(spotDexAddress, usdcAmount);
        uint256 wbtcOut = ISpotDex(spotDexAddress).swapExactIn(
            usdcAddress, wbtcAddress, usdcAmount, minOut, address(this)
        );
        emit ProtocolInteraction(ProtocolActionCodes.DEX_SWAP_FROM_USDC, wbtcAddress, wbtcOut);
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

    function markMintBtcDeployed(uint256 batchCycle, uint256 amount) external onlyBotOrKeeper {
        if (batchMintBtcDeployedToAave[batchCycle] + amount > batchTotalMintBtc[batchCycle]) revert ExceedsMintWbtcForCycle();
        batchMintBtcDeployedToAave[batchCycle] += amount;
        emit ProtocolInteraction(ProtocolActionCodes.MINT_BTC_DEPLOYED, wbtcAddress, amount);
    }
}
