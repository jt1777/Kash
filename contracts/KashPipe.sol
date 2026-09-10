// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IKashVault.sol";
import "./interfaces/ISpotDex.sol";

error InvalidAmount();
error MinOutRequired();
error ZeroAssetOut();
error InvalidAddress();
error SlippageExceeded();

/**
 * @title KashPipe
 * @notice ERC-7575 Pipe: stable ↔ vault asset via a closed DEX route, then 7540 request/claim
 *         on the vault. Not an ERC-20. Holds no balances after each call.
 *
 * @dev Deposit handoff (do not invert): `controller` = user (they claim shares); `owner_` = this Pipe.
 *      Redeem handoff: `owner_` = user (N+1 is checked on owner). The Pipe must be a 7540 operator
 *      of the user to `requestRedeem` / `redeem` on their behalf, then swaps the paid asset to the stable.
 */
contract KashPipe is ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes4 private constant ERC165_ID = 0x01ffc9a7;
    bytes4 private constant ERC7575_VAULT_ID = 0x2f0a18c5;
    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_SLIPPAGE_CEILING_BPS = 500;

    address public immutable vault;
    address public immutable stable;
    address public immutable assetToken;
    address public immutable spotDex;
    uint256 public immutable maxSlippageBps;

    event DepositRequestStable(
        address indexed controller,
        uint256 amount,
        uint256 assetOut,
        uint256 requestId
    );
    event RedeemRequestStable(address indexed controller, uint256 shares, uint256 requestId);
    event RedeemClaimStable(address indexed controller, address indexed receiver, uint256 shares, uint256 stableOut);

    constructor(
        address vault_,
        address stable_,
        address assetToken_,
        address spotDex_,
        uint256 maxSlippageBps_
    ) {
        if (
            vault_ == address(0) || stable_ == address(0) || assetToken_ == address(0)
                || spotDex_ == address(0)
        ) revert InvalidAddress();
        if (vault_ == stable_ || stable_ == assetToken_ || vault_ == assetToken_) revert InvalidAddress();
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING_BPS) revert InvalidAmount();
        if (IKashVault(vault_).asset() != assetToken_) revert InvalidAddress();

        vault = vault_;
        stable = stable_;
        assetToken = assetToken_;
        spotDex = spotDex_;
        maxSlippageBps = maxSlippageBps_;
    }

    /// @notice ERC-7575: the Pipe's asset is the stable, not the vault's WETH/wBTC.
    function asset() public view returns (address) {
        return stable;
    }

    /// @notice ERC-7575: shares are the vault ERC-20.
    function share() public view returns (address) {
        return vault;
    }

    function supportsInterface(bytes4 id) public pure returns (bool) {
        return id == ERC165_ID || id == ERC7575_VAULT_ID;
    }

    function quoteAssetOut(uint256 amount) external view returns (uint256) {
        return ISpotDex(spotDex).quoteExactIn(stable, assetToken, amount);
    }

    function quoteStableOut(uint256 assetAmount) external view returns (uint256) {
        return ISpotDex(spotDex).quoteExactIn(assetToken, stable, assetAmount);
    }

    /// @notice Pull `amount` of the configured stable, swap to the vault asset, request a 7540 deposit.
    /// @param amount Stable amount (6 decimals).
    /// @param minAssetOut Mandatory user slippage floor (non-zero). Combined with `maxSlippageBps`.
    /// @param controller User who will claim on the vault. Must not be this Pipe.
    function requestDepositStable(uint256 amount, uint256 minAssetOut, address controller)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (amount == 0 || controller == address(0) || controller == address(this)) revert InvalidAmount();
        if (minAssetOut == 0) revert MinOutRequired();

        IERC20(stable).safeTransferFrom(msg.sender, address(this), amount);
        uint256 assetOut = _swapToAsset(amount, minAssetOut);
        IERC20(assetToken).forceApprove(vault, assetOut);
        requestId = IKashVault(vault).requestDeposit(assetOut, controller, address(this));
        emit DepositRequestStable(controller, amount, assetOut, requestId);
    }

    /// @notice Request a vault redeem of `shares`. `owner_` is `msg.sender` so N+1 applies to the user.
    /// @dev Caller must `vault.setOperator(pipe, true)` first. Cancel and pending live on the vault.
    function requestRedeemStable(uint256 shares, address controller)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0 || controller == address(0) || controller == address(this)) revert InvalidAmount();
        requestId = IKashVault(vault).requestRedeem(shares, controller, msg.sender);
        emit RedeemRequestStable(controller, shares, requestId);
    }

    /// @notice Claim a settled redeem on the vault, swap the asset to the stable, pay `receiver`.
    /// @dev Caller must be the 7540 controller (or have set this Pipe as operator). `minStableOut` is mandatory.
    function claimRedeemStable(uint256 shares, uint256 minStableOut, address receiver)
        external
        nonReentrant
        returns (uint256 stableOut)
    {
        if (shares == 0 || receiver == address(0)) revert InvalidAmount();
        if (minStableOut == 0) revert MinOutRequired();

        IKashVault(vault).redeem(shares, address(this), msg.sender);
        uint256 assetIn = IERC20(assetToken).balanceOf(address(this));
        if (assetIn == 0) revert ZeroAssetOut();
        stableOut = _swapToStable(assetIn, minStableOut);
        IERC20(stable).safeTransfer(receiver, stableOut);
        emit RedeemClaimStable(msg.sender, receiver, shares, stableOut);
    }

    function _swapToAsset(uint256 amountIn, uint256 minAssetOut) internal returns (uint256 assetOut) {
        uint256 expectedOut = ISpotDex(spotDex).quoteExactIn(stable, assetToken, amountIn);
        uint256 floor = expectedOut * (BPS - maxSlippageBps) / BPS;
        uint256 effective = minAssetOut > floor ? minAssetOut : floor;

        IERC20(stable).forceApprove(spotDex, amountIn);
        ISpotDex(spotDex).swapExactIn(stable, assetToken, amountIn, effective, address(this));

        assetOut = IERC20(assetToken).balanceOf(address(this));
        if (assetOut == 0) revert ZeroAssetOut();
        if (assetOut < effective) revert SlippageExceeded();
    }

    function _swapToStable(uint256 amountIn, uint256 minStableOut) internal returns (uint256 stableOut) {
        uint256 expectedOut = ISpotDex(spotDex).quoteExactIn(assetToken, stable, amountIn);
        uint256 floor = expectedOut * (BPS - maxSlippageBps) / BPS;
        uint256 effective = minStableOut > floor ? minStableOut : floor;

        IERC20(assetToken).forceApprove(spotDex, amountIn);
        ISpotDex(spotDex).swapExactIn(assetToken, stable, amountIn, effective, address(this));

        stableOut = IERC20(stable).balanceOf(address(this));
        if (stableOut == 0) revert ZeroAssetOut();
        if (stableOut < effective) revert SlippageExceeded();
    }
}
