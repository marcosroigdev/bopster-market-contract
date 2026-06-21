// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./BopsterMarket.sol";

/**
 * @title BopsterFactory
 * @author Marcos Roig
 * @notice Deploys BopsterMarket instances sharing a global config (token,
 *         oracle, treasury and the default fee schedule).
 *
 * @custom:security-contact https://github.com/marcosroigdev/bopster-market-contract/security/advisories/new
 * @custom:version 1.0.0
 *
 * The admin role (owner()) is separate from treasury: owner controls
 * pause/unpause and can rotate the admin (two-step via Ownable2Step), while
 * treasury just receives fees and is immutable. renounceOwnership() is disabled
 * so the admin role can never be orphaned.
 *
 * pause() only blocks new createMarket() calls; markets already deployed are
 * independent and keep running. Market creation is permissionless - curation of
 * what to show users happens off-chain.
 */
contract BopsterFactory is Ownable2Step, Pausable {
    // Global config
    address public immutable token;
    address public immutable reality;
    address public immutable treasury;

    // Default fees (bps)
    uint16 public immutable protocolFeeBps;
    uint16 public immutable creatorFeeBps;
    uint16 public immutable resolverRewardBps;

    // Market duration bounds (endTime relative to creation time)
    uint256 public constant MIN_MARKET_DURATION = 15 minutes;
    uint256 public constant MAX_MARKET_DURATION = 10 days;

    // Max (resolveTime - endTime). Mirrored in BopsterMarket - keep in sync.
    uint256 public constant MAX_RESOLUTION_WINDOW = 30 days;

    address[] public allMarkets;

    event MarketCreated(
        address indexed market,
        address indexed creator,
        bytes32 indexed questionId,
        uint64 endTime,
        uint64 resolveTime,
        string metadataURI
    );

    error BadAddress();
    error BadTimes();
    error BadFees();
    error BadQuestion();
    error BadURI();
    error EndTimeTooSoon();
    error EndTimeTooFar();
    error ResolutionWindowTooLarge();
    error RenounceOwnershipDisabled();

    constructor(
        address _token,
        address _reality,
        address _treasury,
        address _admin,
        uint16 _protocolFeeBps,
        uint16 _creatorFeeBps,
        uint16 _resolverRewardBps
    ) Ownable(_admin) {
        if (
            _token == address(0) ||
            _reality == address(0) ||
            _treasury == address(0) ||
            _admin == address(0)
        ) revert BadAddress();

        uint256 totalBps = uint256(_protocolFeeBps) +
            uint256(_creatorFeeBps) +
            uint256(_resolverRewardBps);

        if (totalBps > 1000) revert BadFees(); // cap total cuts at 10%

        token = _token;
        reality = _reality;
        treasury = _treasury;

        protocolFeeBps = _protocolFeeBps;
        creatorFeeBps = _creatorFeeBps;
        resolverRewardBps = _resolverRewardBps;
    }

    /// @notice Pause new market creation. createMarket() reverts EnforcedPause()
    ///         while paused; existing markets are unaffected.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume market creation.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled - renouncing would orphan the admin role and make
    ///         pause/unpause unreachable. Use transferOwnership + acceptOwnership.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    /**
     * @notice Deploy a new BopsterMarket. Permissionless when not paused.
     *
     * Duration rules: endTime must be MIN_MARKET_DURATION..MAX_MARKET_DURATION
     * in the future, resolveTime > endTime, and (resolveTime - endTime) <=
     * MAX_RESOLUTION_WINDOW. The questionId must already exist on Reality.eth -
     * create the Reality question first, then pass its id here.
     */
    function createMarket(
        bytes32 questionId,
        string calldata metadataURI,
        uint64 endTime,
        uint64 resolveTime
    ) external whenNotPaused returns (address market) {
        if (questionId == bytes32(0)) revert BadQuestion();
        if (bytes(metadataURI).length == 0) revert BadURI();
        if (endTime == 0 || resolveTime == 0 || endTime >= resolveTime) revert BadTimes();
        if (endTime < block.timestamp + MIN_MARKET_DURATION) revert EndTimeTooSoon();
        if (endTime > block.timestamp + MAX_MARKET_DURATION) revert EndTimeTooFar();
        if (uint256(resolveTime) - uint256(endTime) > MAX_RESOLUTION_WINDOW)
            revert ResolutionWindowTooLarge();

        BopsterMarket m = new BopsterMarket(
            token,
            reality,
            treasury,
            msg.sender, // creator
            questionId,
            metadataURI,
            endTime,
            resolveTime,
            protocolFeeBps,
            creatorFeeBps,
            resolverRewardBps
        );

        market = address(m);
        allMarkets.push(market);

        emit MarketCreated(market, msg.sender, questionId, endTime, resolveTime, metadataURI);
    }

    /// @notice Number of markets deployed by this factory.
    function marketsCount() external view returns (uint256) {
        return allMarkets.length;
    }

    /**
     * @notice Paginated slice of allMarkets for cheaper off-chain reads.
     * @param start First index (inclusive). Returns empty if past the end.
     * @param count Max entries to return; result is truncated to the array length.
     */
    function getMarkets(
        uint256 start,
        uint256 count
    ) external view returns (address[] memory slice) {
        uint256 total = allMarkets.length;
        if (start >= total) return new address[](0);
        uint256 end = start + count;
        if (end > total) end = total;
        uint256 n = end - start;
        slice = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            slice[i] = allMarkets[start + i];
        }
    }

    function minMarketDuration() external pure returns (uint256) {
        return MIN_MARKET_DURATION;
    }

    function maxMarketDuration() external pure returns (uint256) {
        return MAX_MARKET_DURATION;
    }

    function maxResolutionWindow() external pure returns (uint256) {
        return MAX_RESOLUTION_WINDOW;
    }
}
