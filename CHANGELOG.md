# Changelog

All notable changes to `bopster-market-contract` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

For the per-phase narrative with full ABI diffs and integrator
migration notes, see [`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md).

---

## [Unreleased]

- External audit pending.
- Mainnet deployment to Base pending.

---

## [1.0.0] - Pre-mainnet (unreleased)

Internal hardening complete across five phases. Ready for external
audit. **Not yet deployed to any mainnet.**

### Phase 5 - Pre-Mainnet Hardening (2026-06-13)

**Security**
- `Ownable` -> `Ownable2Step` on `BopsterFactory` (two-step ownership
  transfer; prevents fat-finger admin loss).
- `renounceOwnership()` explicitly disabled - reverts with
  `RenounceOwnershipDisabled`. Prevents accidental orphaning of admin role.
- Compiler upgraded `0.8.20` -> `0.8.26` (fixes IR optimizer regressions).
- `evmVersion` pinned to `paris` (avoids PUSH0 portability issues).
- Strict CEI ordering enforced in `_position` (state before transfer).
- Explicit `uint256` promotion unified in `triggerEmergencyRefund` /
  `sweepDust` time arithmetic.

**Cleanup**
- `totalClaimed` storage variable removed (was tracked but never used).
- `CutsExceedPool` error documented as defense-in-depth invariant
  tripwire (unreachable under current fee cap).
- `EMERGENCY_REFUND_DELAY` documentation synced to 90 days across all
  references.
- Hedge case (YES + NO positions by same user) documented in NatSpec.
- `sweepDust` post-condition comment corrected.

**Additions**
- `BopsterFactory.getMarkets(uint256 start, uint256 count)` paginated view.
- External interface files: `IBopsterFactory.sol`, `IBopsterMarket.sol`.
- NatSpec coverage extended on factory helpers (`marketsCount`,
  `minMarketDuration`, etc.).

**Tests**
- Test count: 225 passing, 0 failing.
- Added: `getMarkets` pagination, `renounceOwnership` disabled,
  Ownable2Step two-step flow.
- Removed: obsolete `totalClaimed` tests.

### Phase 4 - Market Duration Validation (2026-05-22)

- `BopsterFactory.createMarket` enforces minimum (`15 minutes`) and
  maximum (`10 days`) market duration. New errors: `EndTimeTooSoon`,
  `EndTimeTooFar`.
- New constants: `MIN_MARKET_DURATION`, `MAX_MARKET_DURATION`.
- New helper views: `minMarketDuration()`, `maxMarketDuration()`.

### Phase 3 - Final Hardening (Production-Ready)

- All constructor `require(_, "STRING")` replaced with custom errors:
  `ZeroToken`, `ZeroReality`, `ZeroTreasury`, `ZeroCreator`,
  `ZeroQuestionId`, `EmptyMetadataURI`, `EndTimeInPast`,
  `InvalidTimeOrder`, `FeesTooHigh`, `CutsExceedPool`.
- `triggerEmergencyRefund` now guards against
  `RealityAlreadyFinalized` - forces normal `finalize()` path when
  Reality has answered.
- Custom inline ReentrancyGuard replaced with OZ
  `ReentrancyGuard`.
- `isSettledTooSoon` call removed from `finalize` (logic relies only
  on the bytes32 final answer).

### Phase 2 - Reality Hardening & Emergency Refund

- New status: `EMERGENCY_REFUND` (index `3`).
- New function: `triggerEmergencyRefund()` - permissionless, callable
  after `resolveTime + EMERGENCY_REFUND_DELAY` (90 days) without
  Reality finalization.
- New constants: `ANSWER_TOO_SOON`, `EMERGENCY_REFUND_DELAY`.
- Reality answer handling broadened: any non-YES/NO answer
  (`INVALID`, `TOO_SOON`, unknown) routes to refund path without
  reverting.
- `claimRefund()` extended to cover `EMERGENCY_REFUND` state.
- `InvalidRealityAnswer` error removed.

### Phase 1 - Initial release

- `BopsterFactory` - deploys + tracks `BopsterMarket` instances with
  shared configuration (token, Reality, treasury, fee schedule).
- `BopsterMarket` - per-question lifecycle:
  - `positionYes` / `positionNo` (USDC positions)
  - `lock()` (permissionless, after endTime)
  - `finalize()` (permissionless, after resolveTime + Reality finalized)
  - `claim()` (winning side, pro-rata of post-fee pool)
  - `claimRefund()` (refund path on non-binary outcomes)
  - `sweepDust()` (treasury sweep after 365 days)
- Events: `MarketCreated`, `PositionPlaced`, `Locked`, `Resolved`,
  `Claimed`, `EmergencyRefundEnabled`, `DustSwept`.
- Fees in basis points, capped at 10% total.

---

[Unreleased]: https://github.com/marcosroigdev/bopster-market-contract/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/marcosroigdev/bopster-market-contract/releases/tag/v1.0.0
