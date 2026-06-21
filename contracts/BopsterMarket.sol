// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Minimal Reality.eth interface (RealityETH_ERC20_v3_2). We only ever read the
// final bytes32 answer; isSettledTooSoon() is deliberately not used.
interface IReality {
    function isFinalized(bytes32 questionId) external view returns (bool);
    function resultFor(bytes32 questionId) external view returns (bytes32);
}

/**
 * @title BopsterMarket
 * @author Marcos Roig
 * @notice Binary YES/NO prediction market settled in USDC and resolved through
 *         Reality.eth after resolveTime.
 *
 * @custom:security-contact https://github.com/marcosroigdev/bopster-market-contract/security/advisories/new
 * @custom:version 1.0.0
 *
 * Token: built for USDC. Fee-on-transfer, rebasing and ERC777/callback tokens
 * are NOT supported - they break pool accounting or open reentrancy surfaces.
 * No on-chain token-type check is done; deployers must pass a plain ERC20.
 *
 * Tokens sent directly to this contract (not via positionYes/positionNo) are
 * not credited to any pool. They can only be recovered with sweepDust() once
 * SWEEP_DUST_DELAY has passed, and always go to the immutable treasury.
 *
 * Outcome encoding from Reality:
 *   YES = bytes32(1), NO = bytes32(0). Anything else (INVALID, TOO_SOON or any
 *   unknown answer) is treated as the refund path. The raw bytes32 is the only
 *   source of truth, so arbitration (e.g. Kleros) is transparent here.
 *
 * Fees (bps, capped at 10% total): protocolFee -> treasury, creatorFee ->
 * creator, resolverReward -> whoever calls finalize(). Fees are only taken when
 * there is a real YES/NO winner. On a refund the whole pool stays claimable.
 */
contract BopsterMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Immutable config
    IERC20 public immutable token;
    IReality public immutable reality;
    address public immutable treasury; // protocol fee destination
    address public immutable creator;

    bytes32 public immutable questionId;
    string public metadataURI; // off-chain metadata pointer (IPFS/HTTPS)

    uint64 public immutable endTime; // position taking closes
    uint64 public immutable resolveTime; // earliest time finalize() can run

    // Fees in basis points (100 = 1%)
    uint16 public immutable protocolFeeBps;
    uint16 public immutable creatorFeeBps;
    uint16 public immutable resolverRewardBps; // paid to msg.sender of finalize()

    // Reality answer encoding
    bytes32 public constant ANSWER_YES = bytes32(uint256(1));
    bytes32 public constant ANSWER_NO = bytes32(uint256(0));
    bytes32 public constant ANSWER_INVALID = bytes32(type(uint256).max);
    bytes32 public constant ANSWER_TOO_SOON = bytes32(type(uint256).max - 1);

    // Grace period after resolveTime before triggerEmergencyRefund() opens up.
    // 90 days covers the worst case of Reality + a Kleros arbitration round; a
    // shorter window could race a dispute that was about to resolve correctly.
    uint64 public constant EMERGENCY_REFUND_DELAY = 90 days;

    // Max allowed (resolveTime - endTime). Mirrored in BopsterFactory - keep
    // both in sync if you ever change it.
    uint256 public constant MAX_RESOLUTION_WINDOW = 30 days;

    // After this delay since resolveTime, leftover balance (division dust,
    // direct transfers, unclaimed stakes) can be swept to treasury. Users get a
    // full year to claim; after that, unclaimed payouts are forfeited.
    uint64 public constant SWEEP_DUST_DELAY = 365 days;

    enum Status {
        OPEN, // positions can be placed
        LOCKED, // endTime passed, awaiting resolution
        RESOLVED, // Reality answered; claim() / claimRefund()
        EMERGENCY_REFUND // stuck past the delay; everyone refunds their stake
    }
    Status public status;

    uint256 public totalYes;
    uint256 public totalNo;

    mapping(address => uint256) public yesPosition;
    mapping(address => uint256) public noPosition;

    // Resolution data
    bool public outcomeYes; // only meaningful when outcomeInvalid == false
    bool public outcomeInvalid; // true => no binary winner (refund path)
    bytes32 public finalAnswer; // raw answer from Reality; stays 0 if never finalized

    uint256 public totalWinningSide;
    uint256 public netPayoutPool; // pool available for claim/refund after fees
    mapping(address => bool) public claimed;

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

    // Constructor / config
    error ZeroToken();
    error ZeroReality();
    error ZeroTreasury();
    error ZeroCreator();
    error ZeroQuestionId();
    error EmptyMetadataURI();
    error EndTimeInPast();
    error InvalidTimeOrder();
    error FeesTooHigh();
    error CutsExceedPool(); // see note in finalize(): guard, not expected to fire
    error ResolutionWindowTooLarge();

    // State machine
    error NotOpen();
    error NotLocked();
    error NotResolved();
    error TooEarly();
    error InvalidAmount();
    error RealityNotFinalized();
    error NothingToClaim();

    // Emergency refund
    error EmergencyRefundNotYetAvailable();
    error RealityAlreadyFinalized();
    error EmergencyRefundActive(); // claim() during emergency -> use claimRefund()

    // Sweep dust
    error SweepDustNotYetAvailable();
    error NoDust();

    constructor(
        address _token,
        address _reality,
        address _treasury,
        address _creator,
        bytes32 _questionId,
        string memory _metadataURI,
        uint64 _endTime,
        uint64 _resolveTime,
        uint16 _protocolFeeBps,
        uint16 _creatorFeeBps,
        uint16 _resolverRewardBps
    ) {
        if (_token == address(0)) revert ZeroToken();
        if (_reality == address(0)) revert ZeroReality();
        if (_treasury == address(0)) revert ZeroTreasury();
        if (_creator == address(0)) revert ZeroCreator();
        if (_questionId == bytes32(0)) revert ZeroQuestionId();
        if (bytes(_metadataURI).length == 0) revert EmptyMetadataURI();
        if (_endTime <= block.timestamp) revert EndTimeInPast();
        if (_endTime >= _resolveTime) revert InvalidTimeOrder();
        if (uint256(_resolveTime) - uint256(_endTime) > MAX_RESOLUTION_WINDOW)
            revert ResolutionWindowTooLarge();

        uint256 totalBps = uint256(_protocolFeeBps) +
            uint256(_creatorFeeBps) +
            uint256(_resolverRewardBps);
        if (totalBps > 1000) revert FeesTooHigh();

        token = IERC20(_token);
        reality = IReality(_reality);
        treasury = _treasury;
        creator = _creator;
        questionId = _questionId;
        metadataURI = _metadataURI;

        endTime = _endTime;
        resolveTime = _resolveTime;

        protocolFeeBps = _protocolFeeBps;
        creatorFeeBps = _creatorFeeBps;
        resolverRewardBps = _resolverRewardBps;

        status = Status.OPEN;
    }

    /// @notice Take a YES position. Caller must have approved `amount` first.
    function positionYes(uint256 amount) external nonReentrant {
        _position(true, amount);
    }

    /// @notice Take a NO position. Caller must have approved `amount` first.
    function positionNo(uint256 amount) external nonReentrant {
        _position(false, amount);
    }

    // State is updated before the external transfer (checks-effects-interactions),
    // and entry points are nonReentrant - belt and suspenders against odd tokens.
    function _position(bool sideYes, uint256 amount) internal {
        if (status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= endTime) revert NotOpen();
        if (amount == 0) revert InvalidAmount();

        if (sideYes) {
            yesPosition[msg.sender] += amount;
            totalYes += amount;
        } else {
            noPosition[msg.sender] += amount;
            totalNo += amount;
        }

        token.safeTransferFrom(msg.sender, address(this), amount);

        emit PositionPlaced(msg.sender, sideYes, amount);
    }

    /// @notice Lock the market once endTime has passed. Anyone can call it.
    function lock() external {
        if (status != Status.OPEN) revert NotOpen();
        if (block.timestamp < endTime) revert TooEarly();
        status = Status.LOCKED;
        emit Locked(totalYes, totalNo);
    }

    /**
     * @notice Resolve the market from the Reality.eth answer. Permissionless,
     *         callable once resolveTime has passed and Reality is finalized.
     *
     * The first successful caller earns resolverRewardBps of the pool, but only
     * when there's a real YES/NO winner. On the refund path nobody is paid, so
     * stakers are expected to call finalize() themselves to unlock claimRefund()
     * (or wait for triggerEmergencyRefund() as a backstop).
     *
     * YES -> YES wins, NO -> NO wins, anything else -> refund path (covers
     * INVALID, TOO_SOON and any unknown arbitrator response). If still OPEN past
     * endTime, the market is auto-locked first.
     */
    function finalize() external nonReentrant {
        // Auto-lock if still OPEN past endTime
        if (status == Status.OPEN) {
            if (block.timestamp < endTime) revert TooEarly();
            status = Status.LOCKED;
            emit Locked(totalYes, totalNo);
        }

        // Must be LOCKED - blocks RESOLVED and EMERGENCY_REFUND
        if (status != Status.LOCKED) revert NotLocked();
        if (block.timestamp < resolveTime) revert TooEarly();

        if (!reality.isFinalized(questionId)) revert RealityNotFinalized();

        bytes32 ans = reality.resultFor(questionId);
        finalAnswer = ans;

        uint256 poolTotal = totalYes + totalNo;
        uint256 winning;

        if (ans == ANSWER_YES) {
            outcomeInvalid = false;
            outcomeYes = true;
            winning = totalYes;
        } else if (ans == ANSWER_NO) {
            outcomeInvalid = false;
            outcomeYes = false;
            winning = totalNo;
        } else {
            // INVALID, TOO_SOON or anything else -> refund path
            outcomeInvalid = true;
            outcomeYes = false;
            winning = 0;
        }

        status = Status.RESOLVED;
        totalWinningSide = winning;

        // Refund path: no binary winner, empty pool, or nobody on the winning side
        if (outcomeInvalid || poolTotal == 0 || winning == 0) {
            netPayoutPool = poolTotal;
            emit Resolved(ans, poolTotal, poolTotal, 0, 0, 0);
            return;
        }

        // Normal payout path
        uint256 protocolFee = (poolTotal * protocolFeeBps) / 10000;
        uint256 creatorFee = (poolTotal * creatorFeeBps) / 10000;
        uint256 resolverReward = (poolTotal * resolverRewardBps) / 10000;

        // Can't trip while the constructor caps total bps at 1000 (10%); guard
        // stays in case that cap is ever relaxed.
        uint256 cuts = protocolFee + creatorFee + resolverReward;
        if (cuts > poolTotal) revert CutsExceedPool();

        netPayoutPool = poolTotal - cuts;

        if (protocolFee > 0) token.safeTransfer(treasury, protocolFee);
        if (creatorFee > 0) token.safeTransfer(creator, creatorFee);
        if (resolverReward > 0) token.safeTransfer(msg.sender, resolverReward);

        emit Resolved(ans, poolTotal, netPayoutPool, protocolFee, creatorFee, resolverReward);
    }

    /**
     * @notice Backstop for a market stuck in LOCKED. Permissionless, callable
     *         once EMERGENCY_REFUND_DELAY has passed since resolveTime and
     *         Reality still hasn't finalized the question.
     *
     * Reverts with RealityAlreadyFinalized() if Reality did finalize - use
     * finalize() then. On success the full pool becomes refundable via
     * claimRefund(); no fees or rewards are paid and finalAnswer stays 0.
     */
    function triggerEmergencyRefund() external nonReentrant {
        if (status != Status.LOCKED) revert NotLocked();
        if (block.timestamp < uint256(resolveTime) + uint256(EMERGENCY_REFUND_DELAY))
            revert EmergencyRefundNotYetAvailable();
        if (reality.isFinalized(questionId)) revert RealityAlreadyFinalized();

        status = Status.EMERGENCY_REFUND;
        totalWinningSide = 0;
        outcomeInvalid = true;
        outcomeYes = false;

        uint256 poolTotal = totalYes + totalNo;
        netPayoutPool = poolTotal;

        emit EmergencyRefundEnabled(poolTotal);
    }

    /**
     * @notice Claim winnings when the market resolved with a YES/NO winner.
     *
     * Hedged positions are paid on the winning side only; a held losing leg
     * stays in the pool for the winners. Reverts EmergencyRefundActive in the
     * emergency state (use claimRefund there).
     */
    function claim() external nonReentrant {
        if (status == Status.EMERGENCY_REFUND) revert EmergencyRefundActive();
        if (status != Status.RESOLVED) revert NotResolved();
        if (claimed[msg.sender]) revert NothingToClaim();

        uint256 userStake = outcomeYes ? yesPosition[msg.sender] : noPosition[msg.sender];
        if (userStake == 0) revert NothingToClaim();
        if (totalWinningSide == 0) revert NothingToClaim(); // refunds go through claimRefund()

        claimed[msg.sender] = true;

        uint256 payout = (userStake * netPayoutPool) / totalWinningSide;
        if (payout == 0) revert NothingToClaim();

        token.safeTransfer(msg.sender, payout);
        emit Claimed(msg.sender, payout);
    }

    /**
     * @notice Refund the original stake. Available either when RESOLVED with no
     *         binary winner (INVALID/TOO_SOON/etc), or in EMERGENCY_REFUND.
     *
     * Returns the full stake (yes + no). Shares the `claimed` flag with claim()
     * so a position can't be recovered twice.
     */
    function claimRefund() external nonReentrant {
        bool isEmergency = (status == Status.EMERGENCY_REFUND);
        bool isResolvedNoWin = (status == Status.RESOLVED && totalWinningSide == 0);

        if (!isEmergency && !isResolvedNoWin) revert NotResolved();
        if (claimed[msg.sender]) revert NothingToClaim();

        uint256 stake = yesPosition[msg.sender] + noPosition[msg.sender];
        if (stake == 0) revert NothingToClaim();

        claimed[msg.sender] = true;
        token.safeTransfer(msg.sender, stake);
        emit Claimed(msg.sender, stake);
    }

    /**
     * @notice Sweep any leftover balance to treasury. Permissionless, but only
     *         from a terminal state (RESOLVED / EMERGENCY_REFUND) and after
     *         SWEEP_DUST_DELAY since resolveTime.
     *
     * Recovers division dust, direct transfers, and stakes nobody claimed in the
     * 365-day window. Destination is the immutable treasury. A user who hasn't
     * claimed by then loses access: their accounting stays on-record but the
     * later transfer reverts on insufficient balance (not with NothingToClaim).
     */
    function sweepDust() external nonReentrant {
        if (status != Status.RESOLVED && status != Status.EMERGENCY_REFUND) revert NotResolved();
        if (block.timestamp < uint256(resolveTime) + uint256(SWEEP_DUST_DELAY))
            revert SweepDustNotYetAvailable();

        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert NoDust();

        token.safeTransfer(treasury, balance);
        emit DustSwept(treasury, balance);
    }
}
