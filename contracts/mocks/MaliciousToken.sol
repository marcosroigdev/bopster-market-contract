// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title IReentrancyTarget
 * @dev Minimal view of BopsterMarket entry points the malicious token tries
 *      to re-enter during a transfer callback.
 */
interface IReentrancyTarget {
    function claim() external;
    function claimRefund() external;
    function positionYes(uint256 amount) external;
    function sweepDust() external;
}

/**
 * @title MaliciousToken
 * @dev ERC20 that attempts to re-enter a target contract on every transfer
 *      and transferFrom. Used exclusively in tests to prove that
 *      BopsterMarket's nonReentrant guard blocks reentrancy on the
 *      transfer-bearing functions (positionYes/No, claim, claimRefund,
 *      finalize, sweepDust).
 *
 *      This simulates the ERC777 / callback-token threat model documented in
 *      BopsterMarket as explicitly unsupported.
 */
contract MaliciousToken is ERC20 {
    address public target;

    // 0 = no attack, 1 = claim, 2 = claimRefund, 3 = positionYes, 4 = sweepDust
    uint8 public attackMode;

    // Prevents the malicious callback from recursing into itself if the guard
    // ever failed to fire, keeping the test deterministic.
    bool private attacking;

    constructor(uint256 initialSupply) ERC20("Malicious", "EVIL") {
        _mint(msg.sender, initialSupply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address _target) external {
        target = _target;
    }

    function setAttackMode(uint8 mode) external {
        attackMode = mode;
    }

    function _maybeAttack() internal {
        if (attackMode == 0 || target == address(0) || attacking) return;
        attacking = true;
        if (attackMode == 1) {
            IReentrancyTarget(target).claim();
        } else if (attackMode == 2) {
            IReentrancyTarget(target).claimRefund();
        } else if (attackMode == 3) {
            IReentrancyTarget(target).positionYes(1);
        } else if (attackMode == 4) {
            IReentrancyTarget(target).sweepDust();
        }
        attacking = false;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _maybeAttack();
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _maybeAttack();
        return super.transferFrom(from, to, amount);
    }
}
