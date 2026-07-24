// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrancyTarget {
    function deposit(uint256 amount, bytes20 xecRecipient) external returns (bytes32);
}

/// @notice Test-only ERC20 whose transferFrom re-enters a configured target's
/// deposit() before completing its own balance update -- standing in for a
/// hook-bearing (ERC-777-style) token, so BridgeLock.deposit()'s nonReentrant guard
/// (2026-07 review, reentrant balance-delta double-count finding) can be proven to
/// actually block the nested call rather than merely being asserted to. Not part of
/// the bridge itself.
contract MockReentrantERC20 is ERC20 {
    address public target;
    bool public reenter;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setReentrancy(address target_, bool reenter_) external {
        target = target_;
        reenter = reenter_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (reenter) {
            reenter = false; // one-shot, avoid infinite recursion
            IReentrancyTarget(target).deposit(value, bytes20(uint160(1)));
        }
        return super.transferFrom(from, to, value);
    }
}
