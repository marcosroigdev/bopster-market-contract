// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockReality
 * @dev Controllable mock for Reality.eth oracle (RealityETH_ERC20_v3_2).
 *      Allows tests to set finalization state, result, and the
 *      isSettledTooSoon flag for any questionId independently.
 */
contract MockReality {
    mapping(bytes32 => bool)    public finalized;
    mapping(bytes32 => bytes32) public results;
    mapping(bytes32 => bool)    public settledTooSoon;

    /// @notice Configure a question's state in one call.
    function setResult(bytes32 questionId, bytes32 result, bool _finalized) external {
        results[questionId]   = result;
        finalized[questionId] = _finalized;
    }

    /// @notice Set the isSettledTooSoon flag independently (for edge-case tests).
    function setSettledTooSoon(bytes32 questionId, bool _tooSoon) external {
        settledTooSoon[questionId] = _tooSoon;
    }

    function isFinalized(bytes32 questionId) external view returns (bool) {
        return finalized[questionId];
    }

    function resultFor(bytes32 questionId) external view returns (bytes32) {
        require(finalized[questionId], "NOT_FINALIZED");
        return results[questionId];
    }

    function isSettledTooSoon(bytes32 questionId) external view returns (bool) {
        return settledTooSoon[questionId];
    }
}
