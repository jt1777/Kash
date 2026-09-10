// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Tether-style approve: cannot change a non-zero allowance except by setting it to 0 first.
contract MockUSDT is ERC20 {
    uint8 private immutable _customDecimals;

    constructor() ERC20("Tether USD", "USDT") {
        _customDecimals = 6;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        require(amount == 0 || allowance(msg.sender, spender) == 0, "USDT: approve from non-zero");
        return super.approve(spender, amount);
    }

    /// @dev Test helper to leave a leftover allowance so `forceApprove` must zero first.
    function setAllowance(address owner, address spender, uint256 amount) external {
        _approve(owner, spender, amount);
    }
}
