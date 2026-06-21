// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// External interface for BopsterMarket, for frontends, indexers and other
// contracts that don't want to import the full implementation. Errors are left
// out (reference them by selector from the ABI); token/reality are returned as
// address to keep this dependency-free.
interface IBopsterMarket {
    // OPEN = 0, LOCKED = 1, RESOLVED = 2, EMERGENCY_REFUND = 3
    enum Status {
        OPEN,
        LOCKED,
        RESOLVED,
        EMERGENCY_REFUND
    }

    event PositionPlaced(address indexed user, bool indexed sideYes, uint256 amount);
    event Locked(uint256 yesPool, uint256 noPool);
    event Resolved(
        bytes32 finalAnswer,
        uint256 poolTotal,
        uint256 netPool,
        uint256 protocolFee,
        uint256 creatorFee,
        uint256 resolverReward
    );
    event Claimed(address indexed user, uint256 amount);
    event EmergencyRefundEnabled(uint256 poolTotal);
    event DustSwept(address indexed treasury, uint256 amount);

    // Immutable config
    function token() external view returns (address);
    function reality() external view returns (address);
    function treasury() external view returns (address);
    function creator() external view returns (address);

    function questionId() external view returns (bytes32);
    function metadataURI() external view returns (string memory);

    function endTime() external view returns (uint64);
    function resolveTime() external view returns (uint64);

    function protocolFeeBps() external view returns (uint16);
    function creatorFeeBps() external view returns (uint16);
    function resolverRewardBps() external view returns (uint16);

    // Constants
    function ANSWER_YES() external pure returns (bytes32);
    function ANSWER_NO() external pure returns (bytes32);
    function ANSWER_INVALID() external pure returns (bytes32);
    function ANSWER_TOO_SOON() external pure returns (bytes32);

    function EMERGENCY_REFUND_DELAY() external pure returns (uint64);
    function MAX_RESOLUTION_WINDOW() external pure returns (uint256);
    function SWEEP_DUST_DELAY() external pure returns (uint64);

    // Market state
    function status() external view returns (Status);
    function totalYes() external view returns (uint256);
    function totalNo() external view returns (uint256);
    function yesPosition(address user) external view returns (uint256);
    function noPosition(address user) external view returns (uint256);

    // Resolution data
    function outcomeYes() external view returns (bool);
    function outcomeInvalid() external view returns (bool);
    function finalAnswer() external view returns (bytes32);
    function totalWinningSide() external view returns (uint256);
    function netPayoutPool() external view returns (uint256);
    function claimed(address user) external view returns (bool);

    // Lifecycle
    function positionYes(uint256 amount) external;
    function positionNo(uint256 amount) external;

    function lock() external;
    function finalize() external;
    function triggerEmergencyRefund() external;

    function claim() external;
    function claimRefund() external;

    function sweepDust() external;
}
