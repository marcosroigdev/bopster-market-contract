// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// External interface for BopsterFactory. Errors are omitted - reference them by
// selector from the ABI.
interface IBopsterFactory {
    event MarketCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed questionId,
        uint64 endTime,
        uint64 resolveTime,
        string metadataURI
    );

    // Immutable config
    function token() external view returns (address);
    function reality() external view returns (address);
    function treasury() external view returns (address);

    function protocolFeeBps() external view returns (uint16);
    function creatorFeeBps() external view returns (uint16);
    function resolverRewardBps() external view returns (uint16);

    // Bounds
    function MIN_MARKET_DURATION() external pure returns (uint256);
    function MAX_MARKET_DURATION() external pure returns (uint256);
    function MAX_RESOLUTION_WINDOW() external pure returns (uint256);

    function minMarketDuration() external pure returns (uint256);
    function maxMarketDuration() external pure returns (uint256);
    function maxResolutionWindow() external pure returns (uint256);

    // Market registry
    function allMarkets(uint256 index) external view returns (address);
    function marketsCount() external view returns (uint256);
    function getMarkets(uint256 start, uint256 count) external view returns (address[] memory);

    function createMarket(
        bytes32 questionId,
        string calldata metadataURI,
        uint64 endTime,
        uint64 resolveTime
    ) external returns (address market);

    // From OZ Pausable
    function paused() external view returns (bool);
}
