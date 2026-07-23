// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only mintable ERC20 that burns a fixed basis-point cut of every
/// transfer, so the recipient always receives less than the caller-supplied amount --
/// exactly the non-standard behavior audit finding #5 concerns itself with. Not part
/// of the bridge itself; exists only so BridgeLock.deposit()/refund() can be tested
/// against a real token that diverges from a caller-supplied `amount`, not just
/// asserted correct by inspection.
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;

    constructor(string memory name_, string memory symbol_, uint256 feeBps_) ERC20(name_, symbol_) {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee); // burn the fee
        super._update(from, to, value - fee);
    }
}
