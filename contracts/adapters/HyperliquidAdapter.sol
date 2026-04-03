// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IPerpExchange.sol";

/**
 * @title HyperliquidAdapter
 * @notice IPerpExchange adapter for the real Hyperliquid L1 / Arbitrum bridge.
 *
 * ── How Hyperliquid deposits work ────────────────────────────────────────────
 * Hyperliquid runs on its own L1 chain. Depositing USDC is a pure on-chain action:
 * call `USDC.transfer(bridge, amount)` and HL validators credit this contract's
 * address on the HL L1 within ~1 minute.
 *
 * Bridge2 on Arbitrum One: 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
 * USDC (native) on Arbitrum: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
 * Minimum deposit: 5 USDC.
 *
 * ── How Hyperliquid withdrawals work ─────────────────────────────────────────
 * Withdrawals are initiated off-chain via the HL REST API (an EIP-712 signed
 * `withdraw3` action). Validators process it and bridge USDC back to Arbitrum
 * in 3–4 minutes. The destination can be any Arbitrum address — the bot should
 * specify this adapter contract's address so USDC arrives here and can be
 * forwarded on to KashYield via withdrawCollateral().
 *
 * ── How trading works (spot and perp) ────────────────────────────────────────
 * All trading on Hyperliquid is off-chain via the HL REST API. There are no
 * on-chain Arbitrum transactions for spot buys/sells or perp open/close.
 *
 * This means tradeSpot(), openPerpPosition(), and closePerpPosition() are
 * *recording stubs* — they emit events so the bot can track call history,
 * but they do not trigger any HL action. The bot must:
 *   1. Execute the trade via the HL API.
 *   2. Call syncBalances() and/or syncPosition() on this adapter to update
 *      the on-chain state that KashYield reads.
 *
 * ── HL agent authorisation ────────────────────────────────────────────────────
 * The HL L1 account for this adapter is this contract's own Arbitrum address.
 * Because the adapter is a smart contract it cannot directly sign HL API
 * payloads. The bot operator must authorise the bot wallet as an HL "agent"
 * for this adapter's address via the HL REST API:
 *
 *   POST /exchange   { "action": { "type": "approveAgent", ... }, "signature": ... }
 *
 * This requires a one-time off-chain signature from a wallet that controls the
 * adapter's HL account. If the adapter contract's address was freshly credited
 * by a deposit and has never signed any HL action, the bot operator should use
 * the adapter owner wallet to create this signature via an EIP-1271-compatible
 * flow or by temporarily holding the "master key" for that address before the
 * adapter contract is deployed (create2 pre-authorisation pattern).
 *
 * In practice, the simplest setup for early-stage deployment is to let the
 * bot wallet be the HL account directly (by depositing from the bot wallet's
 * own address rather than through this adapter). See `directDepositMode` below.
 *
 * ── Direct-deposit mode ───────────────────────────────────────────────────────
 * When `directDepositMode` is true, depositCollateral() forwards USDC to the
 * configured `hlAccount` address (the bot wallet EOA) instead of sending it to
 * the bridge directly. The bot wallet then deposits to HL from its own address,
 * making the bot wallet the HL account. Withdrawals from HL are made directly
 * to this adapter's address (the bot specifies adapter as destination).
 *
 * directDepositMode = false: adapter address is the HL account (production ideal)
 * directDepositMode = true:  bot EOA is the HL account (simpler agent setup)
 *
 * ── Access control ────────────────────────────────────────────────────────────
 * Capital-movement functions (depositCollateral, withdrawCollateral, tradeSpot,
 * openPerpPosition, closePerpPosition, cancelOrder) are restricted to:
 *   - kashYieldAddress (the KashYield contract that owns this adapter)
 *   - owner (deployer / ops wallet for manual operations and scripts)
 * State-sync functions (syncBalances, syncPosition) are owner-only.
 */
contract HyperliquidAdapter is IPerpExchange {
    using SafeERC20 for IERC20;

    /// @notice HL Bridge2 on Arbitrum One: 0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7
    address public immutable hlBridgeAddress;
    /// @notice Native USDC on Arbitrum One: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
    address public immutable usdcAddress;
    /// @notice wBTC address for the BTC product; address(0) for the ETH product.
    address public immutable assetAddress;
    /// @notice True if this adapter serves the ETH yield product.
    bool public immutable isEthAsset;
    /// @notice The KashYield contract authorised to call capital-movement functions.
    address public immutable kashYieldAddress;

    address public owner;
    address public pendingOwner;

    /// @notice When true, depositCollateral forwards USDC to hlAccount (bot EOA as HL account).
    /// When false, USDC is sent directly to the bridge (adapter address as HL account).
    bool public directDepositMode;
    /// @notice Bot wallet EOA used when directDepositMode = true, or for reference.
    address public hlAccount;

    // ── Bot-maintained state ──────────────────────────────────────────────────
    // HL is an off-chain system; on-chain state is kept in sync by the bot calling
    // syncBalances() / syncPosition() after each HL API operation.

    /// @notice USDC held in this adapter's HL spot wallet (6 decimals).
    uint256 public usdcBalance;
    /// @notice ETH or wBTC held in this adapter's HL spot wallet (18-dec internal units).
    uint256 public assetBalance;

    struct Position {
        uint256 size;       // 18-dec
        uint256 collateral; // always 0 on HL (USDC margin is pooled)
        uint256 entryPrice; // 18-dec USD
        bool    isLong;
        bool    isActive;
    }
    mapping(string => Position) public positions;

    event AdapterCall(string action, uint256 amount);
    event DirectDepositModeUpdated(bool enabled, address hlAccount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event BalancesSynced(uint256 usdcBalance, uint256 assetBalance);
    event PositionSynced(string symbol, uint256 size, uint256 entryPrice, bool isActive);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    /// @dev Allows the KashYield contract or the owner (ops scripts / manual ops).
    modifier onlyAuthorized() {
        require(
            msg.sender == kashYieldAddress || msg.sender == owner,
            "Unauthorized"
        );
        _;
    }

    constructor(
        address _hlBridgeAddress,
        address _usdcAddress,
        address _assetAddress,
        bool    _isEthAsset,
        address _kashYieldAddress
    ) {
        require(_kashYieldAddress != address(0), "kashYieldAddress required");
        hlBridgeAddress   = _hlBridgeAddress;
        usdcAddress       = _usdcAddress;
        assetAddress      = _assetAddress;
        isEthAsset        = _isEthAsset;
        kashYieldAddress  = _kashYieldAddress;
        owner             = msg.sender;
        directDepositMode = false;
    }

    // ── Ownership (two-step) ──────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }
    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner        = pendingOwner;
        pendingOwner = address(0);
    }

    // ── Configuration ─────────────────────────────────────────────────────────

    /// @notice Toggle between bridge-direct and forwarded-to-EOA deposit modes.
    function setDirectDepositMode(bool enabled, address _hlAccount) external onlyOwner {
        directDepositMode = enabled;
        hlAccount = _hlAccount;
        emit DirectDepositModeUpdated(enabled, _hlAccount);
    }

    // ── Capital movement ──────────────────────────────────────────────────────

    /**
     * @inheritdoc IPerpExchange
     *
     * @dev On mainnet, only USDC is accepted by Hyperliquid.
     *
     * directDepositMode = false (default, adapter is HL account):
     *   Sends USDC directly to the HL Bridge2 contract. HL validators credit
     *   this adapter's Arbitrum address on the HL L1 within ~1 minute.
     *   Requires prior off-chain HL agent authorisation for the bot wallet.
     *
     * directDepositMode = true (bot EOA is HL account):
     *   Forwards USDC to hlAccount (bot wallet). Bot deposits to bridge from
     *   its own EOA, becoming the HL account holder without agent setup.
     */
    function depositCollateral(address token, uint256 amount) external override onlyAuthorized {
        require(token == usdcAddress, "HL only accepts USDC");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (directDepositMode) {
            require(hlAccount != address(0), "hlAccount not set");
            IERC20(token).safeTransfer(hlAccount, amount);
        } else {
            // Direct bridge deposit: HL credits this adapter's address on L1.
            IERC20(token).safeTransfer(hlBridgeAddress, amount);
        }
        usdcBalance += amount;
        emit AdapterCall("depositCollateral", amount);
    }

    /**
     * @inheritdoc IPerpExchange
     *
     * @dev The bot must first initiate the HL withdrawal via the HL REST API,
     * specifying this adapter's Arbitrum address as the destination. USDC arrives
     * here in 3–4 minutes. This function transfers however much has actually
     * settled (capped to the real ERC-20 balance) rather than reverting if the
     * bridged amount is slightly different from the requested amount.
     *
     * If the withdrawal was sent directly to KashYield (rather than this adapter),
     * call this function with amount = 0 to just update the tracked balance.
     */
    function withdrawCollateral(address token, uint256 amount) external override onlyAuthorized {
        require(token == usdcAddress, "HL only withdraws USDC");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (amount > bal) amount = bal; // cap to what has actually settled
        if (amount > 0) {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        if (usdcBalance >= amount) usdcBalance -= amount;
        emit AdapterCall("withdrawCollateral", amount);
    }

    // ── Spot trading (no-op stubs) ────────────────────────────────────────────
    //
    // On real HL, spot trades are off-chain API calls. These stubs emit events
    // for audit purposes only. The bot executes the actual trade via the HL API,
    // then calls syncBalances() to record the result on-chain.

    /// @inheritdoc IPerpExchange
    function tradeSpot(
        address /*tokenIn*/,
        address /*tokenOut*/,
        uint256 amountIn
    ) external payable override onlyAuthorized returns (uint256) {
        emit AdapterCall("tradeSpot", amountIn);
        return 0;
    }

    /**
     * @inheritdoc IPerpExchange
     * @dev HL does not allow direct ETH/wBTC withdrawals — only USDC exits the bridge.
     * Use withdrawCollateral() for USDC. Swap excess USDC to ETH/wBTC via Uniswap
     * (swapFromUsdc on KashYieldETH) if additional collateral is needed.
     */
    function withdrawAsset(uint256) external pure override {
        revert("HL withdrawals are USDC-only; use withdrawCollateral");
    }

    // ── Perp positions (no-op stubs) ──────────────────────────────────────────
    //
    // All perp operations are off-chain via the HL REST API. After executing,
    // the bot calls syncPosition() to record the new state on-chain.

    /// @inheritdoc IPerpExchange
    function openPerpPosition(string calldata /*symbol*/, uint256 size, bool /*isLong*/) external override onlyAuthorized {
        emit AdapterCall("openPerpPosition", size);
    }
    /// @inheritdoc IPerpExchange
    function closePerpPosition(string calldata /*symbol*/) external override onlyAuthorized {
        emit AdapterCall("closePerpPosition", 0);
    }
    /// @inheritdoc IPerpExchange
    function closePerpPosition(string calldata /*symbol*/, uint256 closeSize) external override onlyAuthorized {
        emit AdapterCall("closePerpPosition", closeSize);
    }
    /// @inheritdoc IPerpExchange
    function cancelOrder(bytes32) external override onlyAuthorized {
        emit AdapterCall("cancelOrder", 0);
    }

    // ── Bot state-sync functions ──────────────────────────────────────────────
    //
    // After every HL API operation the bot calls these to keep on-chain state
    // accurate. KashYield view calls (getHyperliquidSpotBalance etc.) read these.

    /**
     * @notice Update USDC and asset balances after any HL trade or transfer.
     * @param newUsdcBalance  Current USDC balance in HL spot wallet (6 decimals).
     * @param newAssetBalance Current ETH/wBTC balance in HL spot wallet (18-dec).
     */
    function syncBalances(uint256 newUsdcBalance, uint256 newAssetBalance) external onlyOwner {
        usdcBalance  = newUsdcBalance;
        assetBalance = newAssetBalance;
        emit BalancesSynced(newUsdcBalance, newAssetBalance);
    }

    /**
     * @notice Update a perp position after open or (partial) close.
     * @param symbol     Asset symbol, e.g. "ETH" or "BTC".
     * @param size       Remaining position size (18-dec). Pass 0 to mark closed.
     * @param entryPrice Entry price in USD (18-dec). Pass 0 when closing.
     * @param isActive   True if the position is still open.
     */
    function syncPosition(
        string calldata symbol,
        uint256 size,
        uint256 entryPrice,
        bool isActive
    ) external onlyOwner {
        positions[symbol] = Position({
            size:       size,
            collateral: 0,
            entryPrice: entryPrice,
            isLong:     false,
            isActive:   isActive
        });
        emit PositionSynced(symbol, size, entryPrice, isActive);
    }

    // ── Views (return bot-synced state) ──────────────────────────────────────

    /// @inheritdoc IPerpExchange
    function getSpotBalance() external view override returns (uint256) {
        return usdcBalance;
    }

    /// @inheritdoc IPerpExchange
    function getAssetBalance() external view override returns (uint256) {
        return assetBalance;
    }

    /// @inheritdoc IPerpExchange
    function getPosition(string calldata symbol) external view override returns (
        uint256 size,
        uint256 collateral,
        uint256 entryPrice,
        bool    isLong,
        bool    isActive
    ) {
        Position storage p = positions[symbol];
        return (p.size, p.collateral, p.entryPrice, p.isLong, p.isActive);
    }

    /// @inheritdoc IPerpExchange
    /// @dev HL order management is entirely off-chain; there are no on-chain order IDs.
    function getOpenOrderIds() external pure override returns (bytes32[] memory) {
        return new bytes32[](0);
    }
}
