# Migration Guide - Contract Changes (Phase 1 + Phase 2 Hardening + Phase 3 + Phase 4)

This document describes all breaking changes that affect frontend and backend
integrations. Every ABI-level change is listed with its old and new form so
that consumers can do a targeted search-and-replace.

---

## Summary

| Category | Change | Impact |
|---|---|---|
| Function renamed | `betYes()` -> `positionYes()` | **Breaking** - update all call sites |
| Function renamed | `betNo()` -> `positionNo()` | **Breaking** - update all call sites |
| Storage renamed | `yesBet(address)` -> `yesPosition(address)` | **Breaking** - update all read sites |
| Storage renamed | `noBet(address)` -> `noPosition(address)` | **Breaking** - update all read sites |
| Event renamed | `BetPlaced` -> `PositionPlaced` | **Breaking** - update all event listeners/indexers |
| Error removed | `TransferFailed()` | **Breaking** - no longer emitted |
| Error added (OZ) | `SafeERC20FailedOperation(address token)` | **New** - handle in transfer error paths |
| Factory validation | `createMarket()` now rejects `endTime <= block.timestamp` (Phase 3) + min/max duration bounds (Phase 4) | **Additive** - new error conditions `EndTimeTooSoon`, `EndTimeTooFar` |
| Factory constants | `MIN_MARKET_DURATION` (15 min), `MAX_MARKET_DURATION` (10 days) | **Additive** - read via `min/maxMarketDuration()` |
| Behaviour fix | `positionYes/No` no longer mutates state before reverting when past `endTime` | Non-breaking for users, relevant for indexers |

---

## 1. Function Renames

### `betYes(uint256 amount)` -> `positionYes(uint256 amount)`

The function signature is identical. Only the name changed.

**Before:**
```js
await market.betYes(amount);
```

**After:**
```js
await market.positionYes(amount);
```

---

### `betNo(uint256 amount)` -> `positionNo(uint256 amount)`

**Before:**
```js
await market.betNo(amount);
```

**After:**
```js
await market.positionNo(amount);
```

---

## 2. Storage / View Renames

These are public mappings. If you read them directly via the ABI (e.g. to
display a user's current stake), update the getter name.

### `yesBet(address)` -> `yesPosition(address)`

**Before:**
```js
const stake = await market.yesBet(userAddress);
```

**After:**
```js
const stake = await market.yesPosition(userAddress);
```

---

### `noBet(address)` -> `noPosition(address)`

**Before:**
```js
const stake = await market.noBet(userAddress);
```

**After:**
```js
const stake = await market.noPosition(userAddress);
```

---

## 3. Event Rename

### `BetPlaced` -> `PositionPlaced`

The event parameters are **identical**:

```solidity
// Signature (unchanged parameters)
event PositionPlaced(address indexed user, bool indexed sideYes, uint256 amount);
```

**Update all listeners:**

```js
// Before
market.on("BetPlaced", (user, sideYes, amount) => { ... });

// After
market.on("PositionPlaced", (user, sideYes, amount) => { ... });
```

**Update all subgraph/indexer event handlers:**

```yaml
# Before
- event: BetPlaced(indexed address,indexed bool,uint256)
  handler: handleBetPlaced

# After
- event: PositionPlaced(indexed address,indexed bool,uint256)
  handler: handlePositionPlaced
```

---

## 4. Error Changes

### `TransferFailed()` - REMOVED

This custom error no longer exists in the contract. It was replaced by
OpenZeppelin's `SafeERC20FailedOperation`.

**Before (error handling):**
```js
} catch (e) {
    if (e.message.includes("TransferFailed")) { ... }
}
```

**After:**
```js
} catch (e) {
    // OZ SafeERC20 throws: SafeERC20FailedOperation(address token)
    if (e.message.includes("SafeERC20FailedOperation")) { ... }
}
```

The new error includes the token address as a parameter, which makes
debugging easier.

---

## 5. Factory - New Validation on `createMarket()`

`BopsterFactory.createMarket()` now validates that `endTime > block.timestamp`
**in addition** to the existing time checks.

The error thrown is the existing `BadTimes()` - no new error type.

**What changes:**
- If you submit a `createMarket` transaction where `endTime` is in the past
  (e.g. due to a slow submission or UI bug), the Factory now rejects it
  immediately with `BadTimes` instead of passing the check and failing later
  inside the market constructor.
- The `BadTimes` error is already handled in most UIs - no new error type
  to add.

**Recommended UI guard:**
```js
if (endTime <= Math.floor(Date.now() / 1000)) {
    throw new Error("endTime must be in the future");
}
```

---

## 6. Behaviour Change - No State Mutation on Expired Position

**Previous behaviour (bugfix, not a feature):**

When a user called `betYes()` or `betNo()` after `endTime` had passed,
the contract would:
1. Write `status = LOCKED` to storage.
2. Emit a `Locked` event.
3. Revert the entire transaction (discarding all writes).

This meant that even though the state was reverted, the emitted event
*appeared* in the transaction receipt as a failed transaction event. Some
indexers may have processed this spurious `Locked` emission.

**New behaviour:**

The call fails immediately with `NotOpen()`. No state is written, no event
is emitted.

**Action required for indexers:**

If your subgraph or event processor handles `Locked` events from failed
transactions, you can safely remove that logic. The `Locked` event is now
only emitted from:
- `lock()` - explicit external call after `endTime`
- `finalize()` - when called while still OPEN

---

## 7. ABI Diff Reference

Below is the minimal set of ABI entries that changed. Use this to update your
ABI JSON files or typechain-generated types.

### Removed from ABI

```json
{ "name": "betYes", "type": "function" },
{ "name": "betNo",  "type": "function" },
{ "name": "yesBet", "type": "function" },
{ "name": "noBet",  "type": "function" },
{ "name": "BetPlaced", "type": "event" },
{ "name": "TransferFailed", "type": "error" }
```

### Added to ABI

```json
{ "name": "positionYes", "type": "function" },
{ "name": "positionNo",  "type": "function" },
{ "name": "yesPosition", "type": "function" },
{ "name": "noPosition",  "type": "function" },
{ "name": "PositionPlaced", "type": "event" }
```

Note: `SafeERC20FailedOperation` is defined in the OpenZeppelin library and
is not part of the contract's own ABI. Handle it via the raw revert data or
by catching the generic `CALL_EXCEPTION`.

---

## 8. Checklist for Integration Teams

- [ ] Update all `betYes()` call sites -> `positionYes()`
- [ ] Update all `betNo()` call sites -> `positionNo()`
- [ ] Update all `yesBet(addr)` read sites -> `yesPosition(addr)`
- [ ] Update all `noBet(addr)` read sites -> `noPosition(addr)`
- [ ] Update `BetPlaced` event listeners -> `PositionPlaced`
- [ ] Update `BetPlaced` entries in subgraph schema/handlers
- [ ] Update error handling: `TransferFailed` -> `SafeERC20FailedOperation`
- [ ] Add UI guard: `endTime > now` before calling `createMarket()`
- [ ] Re-generate TypeChain / SDK types from the new ABI
- [ ] Recompile and re-deploy contracts (these are not upgradeable)
- [ ] Update contract addresses in all environments after re-deploy

---

## Phase 2 - Reality Hardening & Emergency Refund

### Overview

| Category | Change | Impact |
|---|---|---|
| New state | `EMERGENCY_REFUND` added to `Status` enum | **Additive** - new state index 3 |
| New function | `triggerEmergencyRefund()` | **Additive** - new callable function |
| New constant | `ANSWER_TOO_SOON` (bytes32(type(uint256).max - 1)) | **Additive** |
| New constant | `EMERGENCY_REFUND_DELAY` = 90 days | **Additive** |
| Error removed | `InvalidRealityAnswer(bytes32)` | **Breaking** - no longer thrown |
| New error | `EmergencyRefundNotYetAvailable()` | **Additive** |
| New error | `EmergencyRefundActive()` | **Breaking** - `claim()` throws this in emergency |
| New event | `EmergencyRefundEnabled(uint256 poolTotal)` | **Additive** - listen for it |
| Behaviour change | `finalize()`: any non-YES/NO answer -> refund, not revert | **Non-breaking for users** |
| Behaviour change | `claimRefund()` now also works in `EMERGENCY_REFUND` state | **Additive** |
| `claim()` guard | Reverts `EmergencyRefundActive` (not `NotResolved`) in emergency | **Breaking** |

---

### 9. New State: `EMERGENCY_REFUND`

The `Status` enum now has four values:

```solidity
enum Status { OPEN, LOCKED, RESOLVED, EMERGENCY_REFUND }
//             0      1       2          3
```

**What it means:**
The market was stuck in `LOCKED` state. Reality never finalized the question
within `resolveTime + EMERGENCY_REFUND_DELAY` (90 days). The pool is now fully
available for all users to recover via `claimRefund()`.

**How to detect it:**
```js
const status = await market.status(); // returns BigInt
if (status === 3n) {
    // EMERGENCY_REFUND - show "Emergency refund available" UI
}
```

---

### 10. New Function: `triggerEmergencyRefund()`

```solidity
function triggerEmergencyRefund() external
```

**Conditions to call:**
- `status == LOCKED`
- `block.timestamp >= resolveTime + EMERGENCY_REFUND_DELAY`

**Effects:**
- `status` -> `EMERGENCY_REFUND`
- `totalWinningSide = 0`
- `netPayoutPool = totalYes + totalNo` (full pool)
- `outcomeInvalid = true`
- Emits `EmergencyRefundEnabled(poolTotal)`
- No fees distributed

**Who can call it:** Anyone (permissionless).

**Frontend guidance:**
```js
const resolveTime   = await market.resolveTime();        // uint64
const emergencyDelay = await market.EMERGENCY_REFUND_DELAY(); // uint64 (7776000 = 90 days)
const emergencyTs   = resolveTime + emergencyDelay;

if (Date.now() / 1000 >= emergencyTs) {
    // show "Trigger Emergency Refund" button
}
```

---

### 11. Reality Answer Handling Change

**Old behaviour:**
- `YES` -> YES wins
- `NO` -> NO wins
- `INVALID` -> refund path
- **any other answer -> revert with `InvalidRealityAnswer(bytes32)`**

**New behaviour:**
- `YES` -> YES wins
- `NO` -> NO wins
- **any other answer (INVALID, TOO_SOON, unknown) -> refund path, no revert**

This means `finalize()` will never get stuck due to an unexpected oracle response.
If Reality returns `ANSWERED_TOO_SOON` or any other exotic value, the market
resolves into the refund path automatically.

**Error removed:** `InvalidRealityAnswer` no longer exists. Remove any handling for it.

```js
// Before - this error no longer exists:
} catch (e) {
    if (e.message.includes("InvalidRealityAnswer")) { ... } // DELETE
}
```

---

### 12. New Event: `EmergencyRefundEnabled`

```solidity
event EmergencyRefundEnabled(uint256 poolTotal);
```

Listen for this to detect markets that entered emergency mode:

```js
market.on("EmergencyRefundEnabled", (poolTotal) => {
    console.log("Emergency refund active. Pool:", poolTotal);
    // Update UI: show claimRefund button, hide claim button
});
```

**Subgraph handler:**
```yaml
- event: EmergencyRefundEnabled(uint256)
  handler: handleEmergencyRefundEnabled
```

---

### 13. `claim()` - New Error in Emergency State

If a user tries to call `claim()` while `status == EMERGENCY_REFUND`, they now
receive `EmergencyRefundActive` (not `NotResolved` or `NothingToClaim`).

```js
} catch (e) {
    if (e.message.includes("EmergencyRefundActive")) {
        // Guide user to use claimRefund() instead
    }
}
```

---

### 14. `claimRefund()` - Now Works in Two States

`claimRefund()` is now valid in both:

1. `RESOLVED` with `totalWinningSide == 0` (INVALID / TOO_SOON / no winners)
2. `EMERGENCY_REFUND` (stuck market)

No change needed on the call site - the function signature is identical.
The UI should offer `claimRefund()` whenever the market is in either of these states.

---

### 15. New Constants to Read from Contract

```js
// How long after resolveTime until emergency refund is available
const EMERGENCY_REFUND_DELAY = await market.EMERGENCY_REFUND_DELAY(); // 7776000 (90 days)

// Reality answer constants (for display / debugging)
const ANSWER_YES      = await market.ANSWER_YES();
const ANSWER_NO       = await market.ANSWER_NO();
const ANSWER_INVALID  = await market.ANSWER_INVALID();
const ANSWER_TOO_SOON = await market.ANSWER_TOO_SOON();
```

---

### 16. Updated ABI Diff (Phase 2)

**Removed from ABI:**
```json
{ "name": "InvalidRealityAnswer", "type": "error" }
```

**Added to ABI:**
```json
{ "name": "triggerEmergencyRefund", "type": "function" },
{ "name": "ANSWER_TOO_SOON",        "type": "function" },
{ "name": "EMERGENCY_REFUND_DELAY", "type": "function" },
{ "name": "EmergencyRefundEnabled", "type": "event"    },
{ "name": "EmergencyRefundNotYetAvailable", "type": "error" },
{ "name": "EmergencyRefundActive",          "type": "error" }
```

---

### 17. Phase 2 Integration Checklist

- [ ] Handle new `EMERGENCY_REFUND` status (index 3) in status displays
- [ ] Add UI logic to show `triggerEmergencyRefund()` button after delay expires
- [ ] Listen for `EmergencyRefundEnabled` event in subgraph/indexer
- [ ] Remove handling for `InvalidRealityAnswer` error (no longer thrown)
- [ ] Add handling for `EmergencyRefundActive` in `claim()` error path
- [ ] Update `claimRefund()` UI trigger condition: `RESOLVED+no-winners` **OR** `EMERGENCY_REFUND`
- [ ] Add UI guard showing emergency refund countdown (`resolveTime + 30d`)
- [ ] Read `EMERGENCY_REFUND_DELAY` from market contract (not hardcoded in FE)
- [ ] Re-generate TypeChain / SDK types from updated ABI

---

## Phase 3 - Final Hardening (Production-Ready)

### Overview

| Category | Change | Impact |
|---|---|---|
| Constructor errors | All `require(_, "STRING")` replaced with custom errors | **Breaking** - error selectors changed |
| Error removed | `"TOKEN_0"`, `"REALITY_0"`, `"TREASURY_0"`, `"CREATOR_0"` | **Breaking** - no longer thrown as strings |
| Error removed | `"QID_0"`, `"END_IN_PAST"`, `"TIME_ORDER"`, `"FEES_TOO_HIGH"`, `"CUTS_GT_POOL"` | **Breaking** - replaced by custom errors |
| New errors (constructor) | `ZeroToken`, `ZeroReality`, `ZeroTreasury`, `ZeroCreator`, `ZeroQuestionId` | **Additive** |
| New errors (config) | `EndTimeInPast`, `InvalidTimeOrder`, `FeesTooHigh`, `CutsExceedPool` | **Additive** |
| New error (emergency) | `RealityAlreadyFinalized()` | **Additive** - new guard on `triggerEmergencyRefund()` |
| Behaviour change | `triggerEmergencyRefund()` now checks `reality.isFinalized()` before activating | **Breaking** - was previously unchecked |
| State consistency | Emergency refund now explicitly sets `outcomeYes = false` | Non-breaking for integrations |
| `finalize()` cleanup | `reality.isSettledTooSoon()` call removed entirely | Non-breaking |
| ReentrancyGuard | Replaced custom inline guard with OZ `ReentrancyGuard` (`utils/ReentrancyGuard.sol`) | Non-breaking for callers |
| `IReality` interface | `isSettledTooSoon()` removed from interface | Non-breaking for callers |
| Token documentation | Explicit USDC design assumptions documented in NatSpec | Non-breaking (docs only) |

---

### 18. Constructor Errors - Full Migration

All constructor validation errors have changed from `require` strings to
custom errors. Update any error-handling code that catches these by message
string.

| Old (string) | New (custom error) |
|---|---|
| `"TOKEN_0"` | `ZeroToken()` |
| `"REALITY_0"` | `ZeroReality()` |
| `"TREASURY_0"` | `ZeroTreasury()` |
| `"CREATOR_0"` | `ZeroCreator()` |
| `"QID_0"` | `ZeroQuestionId()` |
| `"END_IN_PAST"` | `EndTimeInPast()` |
| `"TIME_ORDER"` | `InvalidTimeOrder()` |
| `"FEES_TOO_HIGH"` | `FeesTooHigh()` |
| `"CUTS_GT_POOL"` | `CutsExceedPool()` |
| `"REENTRANCY"` | *(OZ ReentrancyGuard - throws `ReentrancyGuardReentrantCall()`)* |

**Example - catching constructor errors on deployment:**

```js
try {
    await BopsterMarket.deploy(...);
} catch (e) {
    // Before: e.message.includes("END_IN_PAST")
    // After:
    if (e.message.includes("EndTimeInPast"))    { /* endTime in the past */ }
    if (e.message.includes("InvalidTimeOrder")) { /* endTime >= resolveTime */ }
    if (e.message.includes("FeesTooHigh"))      { /* total bps > 1000 */ }
    if (e.message.includes("ZeroToken"))        { /* token = address(0) */ }
    // etc.
}
```

---

### 19. `triggerEmergencyRefund()` - New Guard

**Old behaviour:** `triggerEmergencyRefund()` could be called even if Reality had
already finalized the question, potentially bypassing normal resolution and
cutting off fee distribution.

**New behaviour:** `triggerEmergencyRefund()` reverts with `RealityAlreadyFinalized()`
if `reality.isFinalized(questionId)` returns `true`. Callers must use `finalize()`
to resolve the market when Reality has an answer.

```js
try {
    await market.triggerEmergencyRefund();
} catch (e) {
    if (e.message.includes("RealityAlreadyFinalized")) {
        // Reality has answered - call finalize() instead
        await market.finalize();
    }
    if (e.message.includes("EmergencyRefundNotYetAvailable")) {
        // Delay has not elapsed yet
    }
}
```

**Recommended frontend flow for the "Emergency Refund" button:**

```js
const isFinalized = await reality.isFinalized(questionId);
if (isFinalized) {
    // Don't show "Emergency Refund" - show "Finalize Market" instead
    return;
}
const emergencyTs = resolveTime + EMERGENCY_REFUND_DELAY;
if (Date.now() / 1000 >= emergencyTs) {
    // show "Trigger Emergency Refund" button
}
```

---

### 20. Updated ABI Diff (Phase 3)

**Removed from ABI (errors replaced):**
```json
{ "name": "REENTRANCY", "type": "error" }
```
*(OZ ReentrancyGuard emits `ReentrancyGuardReentrantCall()` instead)*

**Added to ABI:**
```json
{ "name": "ZeroToken",          "type": "error" },
{ "name": "ZeroReality",        "type": "error" },
{ "name": "ZeroTreasury",       "type": "error" },
{ "name": "ZeroCreator",        "type": "error" },
{ "name": "ZeroQuestionId",     "type": "error" },
{ "name": "EndTimeInPast",      "type": "error" },
{ "name": "InvalidTimeOrder",   "type": "error" },
{ "name": "FeesTooHigh",        "type": "error" },
{ "name": "CutsExceedPool",     "type": "error" },
{ "name": "RealityAlreadyFinalized", "type": "error" }
```

---

### 21. Token Assumptions (USDC Design)

`BopsterMarket` is designed for **USDC**. The following token types are
**not supported**:

| Token type | Why unsupported |
|---|---|
| Fee-on-transfer tokens | Amount credited != `amount` parameter; breaks pool accounting |
| Rebasing tokens | Balances change outside of transfers; corrupts pool invariants |
| ERC777 / tokens with callbacks | Re-entry risk during `safeTransfer` / `safeTransferFrom` |

No on-chain validation is performed. Deployers must supply a standard ERC20.

---

### 22. Phase 3 Integration Checklist

- [ ] Update error handling: replace string-based constructor error checks with custom error selectors
- [ ] Add `RealityAlreadyFinalized` to `triggerEmergencyRefund()` error handling
- [ ] Update frontend emergency refund flow: check `reality.isFinalized()` before showing the button
- [ ] Remove `isSettledTooSoon` from any `IReality` interface used client-side (no longer in contract)
- [ ] Re-generate TypeChain / SDK types from updated ABI (new error types)
- [ ] Verify deployment scripts handle new custom errors from constructor validation

---

## Phase 4: Market Duration Validation (Factory)

**Date:** 2026-05-22

### Summary

`BopsterFactory.createMarket()` now enforces minimum and maximum market
duration bounds. This prevents markets with absurd timestamps (seconds away or
years in the future) and ensures a fast, social resolution cadence.

| Rule | Value | Error |
|---|---|---|
| Minimum duration | 15 minutes | `EndTimeTooSoon()` |
| Maximum duration | 10 days | `EndTimeTooFar()` |

Previously the factory only checked `endTime > block.timestamp` (reverting with
`BadTimes`). The old check is subsumed by the new minimum: `endTime < now + 15min`
automatically covers the past case without Solidity 0.8 underflow risk.

---

### 23. New Factory Constants

```solidity
uint256 public constant MIN_MARKET_DURATION = 15 minutes;  // 900
uint256 public constant MAX_MARKET_DURATION = 10 days;     // 864000
```

### 24. New Factory Errors

```solidity
error EndTimeTooSoon();  // endTime < block.timestamp + MIN_MARKET_DURATION
error EndTimeTooFar();   // endTime > block.timestamp + MAX_MARKET_DURATION
```

### 25. Helper Functions

```solidity
function minMarketDuration() external pure returns (uint256);
function maxMarketDuration() external pure returns (uint256);
```

Frontend/backend should read these at runtime instead of hard-coding values.

### 26. Updated ABI Diff (Phase 4)

**Added to Factory ABI:**
```json
{ "name": "MIN_MARKET_DURATION", "type": "function", "stateMutability": "view" },
{ "name": "MAX_MARKET_DURATION", "type": "function", "stateMutability": "view" },
{ "name": "minMarketDuration",   "type": "function", "stateMutability": "pure" },
{ "name": "maxMarketDuration",   "type": "function", "stateMutability": "pure" },
{ "name": "EndTimeTooSoon",      "type": "error" },
{ "name": "EndTimeTooFar",       "type": "error" }
```

**Removed from Factory validation path (behaviour change):**
- `BadTimes` is no longer emitted when `endTime <= block.timestamp`.
  `EndTimeTooSoon` is emitted instead (covers both past and too-close cases).
  `BadTimes` is still used for zero endTime, zero resolveTime, and
  `endTime >= resolveTime`.

### 27. Frontend Validation (Required)

The frontend must replicate the same bounds for UX:

```js
const MIN_DURATION = 15 * 60;    // 15 minutes
const MAX_DURATION = 10 * 86400; // 10 days
const now = Math.floor(Date.now() / 1000);
if (endTime < now + MIN_DURATION) return "endTime too soon";
if (endTime > now + MAX_DURATION) return "endTime too far";
```

UI should display:
> "Markets can close between 15 minutes and 10 days from now."

And a warning for durations over 3 days:
> "Long-duration markets usually receive less activity and slower resolution."

### 28. BopsterMarket.sol (No Changes)

The Market constructor retains its own `EndTimeInPast()` check as defense in
depth. Both the Factory and the Market validate endTime independently, but the
Factory's stricter check means the Market should never receive an invalid
endTime.

### 29. Phase 4 Integration Checklist

- [ ] Update frontend client-side validation to match contract bounds
- [ ] Add UX messages: limits info text + long-duration warning (>3 days)
- [ ] Update error handling for `EndTimeTooSoon` and `EndTimeTooFar` in tx error paths
- [ ] Re-generate ABI / TypeChain from updated Factory artifact
- [ ] Backend (if any): validate endTime duration before creating Reality questions

---

## Phase 5 - Pre-Mainnet Hardening

**Date:** 2026-06-13

### Overview

Final pass before public mainnet deployment. Tightens the admin model on
the Factory, removes unused storage on the Market, fixes minor docs/code
drift, and adds an off-chain ergonomics view. Two changes are
ABI-breaking - see sections 31 and 33.

| Category | Change | Impact |
|---|---|---|
| Compiler | Solidity `0.8.20` -> `0.8.26`, `evmVersion: "paris"` pinned | **Build-time** - re-compile + re-deploy. Bytecode changes. |
| Factory admin | `Ownable` -> `Ownable2Step` (two-step ownership transfer) | **Breaking for admin tooling** - see section 31 |
| Factory admin | `renounceOwnership()` disabled - always reverts | **Breaking** - any tooling that assumed renounce works will fail |
| Factory view | New `getMarkets(uint256 start, uint256 count)` paginated view | **Additive** |
| Factory error | New `RenounceOwnershipDisabled()` error | **Additive** |
| Market storage | `totalClaimed` removed - getter no longer in ABI | **Breaking for indexers** - see section 33 |
| Market docs | `EMERGENCY_REFUND_DELAY` value clarified - always **90 days** (`7776000`) | Docs sync only |

---

### 30. Compiler Upgrade

The contracts now compile with Solidity `0.8.26` and `evmVersion: "paris"`.
The `paris` target avoids emitting the `PUSH0` opcode (Shanghai+), which is
not supported on every L2 / sidechain. Re-deploy after re-compile; bytecode
will change.

```js
// hardhat.config.js
solidity: {
    version: "0.8.26",
    settings: {
        evmVersion: "paris",
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
    },
}
```

If every target chain is later confirmed to support PUSH0, the `evmVersion`
can be bumped to `"shanghai"` or `"cancun"`.

---

### 31. Factory - Two-Step Ownership Transfer

`BopsterFactory` now extends `Ownable2Step` instead of `Ownable`. Ownership
transfer requires two transactions:

1. Current owner calls `transferOwnership(newOwner)` - sets
   `pendingOwner = newOwner`. The current owner does **NOT** change.
2. The new owner calls `acceptOwnership()` from the new address -
   `owner` updates and `pendingOwner` resets to `address(0)`.

This prevents the admin role from being lost to a typo or to an
uncontrolled address.

**Before (single-step):**
```js
await factory.connect(currentAdmin).transferOwnership(newAdmin.address);
// done - newAdmin is owner
```

**After (two-step):**
```js
await factory.connect(currentAdmin).transferOwnership(newAdmin.address);
// pendingOwner is now newAdmin; owner unchanged
await factory.connect(newAdmin).acceptOwnership();
// now newAdmin is owner
```

**New view: `pendingOwner()`** returns the address that has been nominated
but has not yet accepted, or `address(0)` if none.

---

### 32. Factory - `renounceOwnership()` Disabled

`renounceOwnership()` now always reverts with the new custom error
`RenounceOwnershipDisabled()`. The admin role cannot be left orphaned,
because `pause()` / `unpause()` would then become permanently unreachable.

To rotate the admin, use the two-step flow described in section 31. To
remove operational control entirely (e.g. after a migration), transfer
ownership to a burn address or to a contract with no callable functions.

```js
// Will always revert.
await factory.connect(admin).renounceOwnership();
// -> reverts with RenounceOwnershipDisabled()
```

---

### 33. Market - `totalClaimed` Removed

The `totalClaimed` storage variable and its auto-generated getter have
been removed from `BopsterMarket`. The variable was tracked but never
consumed - `sweepDust()` transfers the entire residual balance directly,
without consulting `totalClaimed`.

**Before:**
```js
const claimed = await market.totalClaimed();
```

**After:**
- The function no longer exists on the contract.
- If you need per-market claim totals, derive them off-chain from
  `Claimed(address indexed user, uint256 amount)` event logs.

**Subgraph / indexer impact:**
- Remove any entity field or query that resolved `totalClaimed`.
- Replace with an aggregated sum of `Claimed` event `amount` parameters
  scoped to the market address.

---

### 34. Factory - Paginated `getMarkets` View

For off-chain consumers (subgraphs, dashboards, the UI's market list),
iterating `allMarkets(i)` via N individual RPC calls is expensive once
the registry grows. The new view returns up to `count` consecutive
addresses starting at `start`:

```solidity
function getMarkets(uint256 start, uint256 count)
    external view returns (address[] memory);
```

Behaviour:
- Returns an empty array when `start >= allMarkets.length` or when
  `count == 0`.
- Truncates the result when `start + count > allMarkets.length`.
- Never reverts on out-of-range input.

```js
// Page through all markets in chunks of 50
let page = 0;
while (true) {
    const slice = await factory.getMarkets(page * 50, 50);
    if (slice.length === 0) break;
    process(slice);
    page++;
}
```

`marketsCount()` and `allMarkets(uint256)` remain available; the new view
is additive.

---

### 35. Market - `EMERGENCY_REFUND_DELAY` Value Clarification

Previous sections of this document (Phase 2) referenced
`EMERGENCY_REFUND_DELAY` as `30 days` / `2592000`. The on-chain value
shipped to mainnet is **`90 days` / `7776000`**. All prior references in
this guide have been updated for consistency. No on-chain change in
Phase 5 - this is a docs-only correction.

If any frontend code hard-coded `2592000` instead of reading the constant
from the market contract, update it now. The recommended pattern is
always to read the value at runtime:

```js
const delay = await market.EMERGENCY_REFUND_DELAY(); // 7776000
```

---

### 36. ABI Diff (Phase 5)

**Added to `BopsterFactory` ABI:**
```json
{ "name": "pendingOwner",         "type": "function", "stateMutability": "view" },
{ "name": "acceptOwnership",      "type": "function" },
{ "name": "getMarkets",           "type": "function", "stateMutability": "view" },
{ "name": "RenounceOwnershipDisabled", "type": "error" },
{ "name": "OwnershipTransferStarted",  "type": "event" }
```

`OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)`
is emitted by `Ownable2Step.transferOwnership()` in addition to the
existing `OwnershipTransferred` event (emitted on accept).

**Behaviour changes (no ABI surface change, but semantics differ):**
- `transferOwnership(address)` - no longer transfers immediately; sets
  `pendingOwner` and emits `OwnershipTransferStarted`.
- `renounceOwnership()` - always reverts with `RenounceOwnershipDisabled`.

**Removed from `BopsterMarket` ABI:**
```json
{ "name": "totalClaimed", "type": "function" }
```

No new errors or events on the Market in Phase 5.

---

### 37. Phase 5 Integration Checklist

- [ ] Re-deploy contracts (compiler + ABI changed; not upgradeable)
- [ ] Re-generate TypeChain / SDK types from the new ABI
- [ ] Update admin runbook: `transferOwnership` requires `acceptOwnership` follow-up
- [ ] Update any tooling that called `renounceOwnership` - it will now always revert
- [ ] Listen for `OwnershipTransferStarted` in indexers (optional, for visibility into pending transfers)
- [ ] Remove `totalClaimed` reads from frontend, backend, and subgraphs; derive from `Claimed` events if needed
- [ ] Swap loops over `allMarkets(i)` with `getMarkets(start, count)` for pagination performance
- [ ] Audit hard-coded `2592000` / `30 days` references - replace with runtime reads of `EMERGENCY_REFUND_DELAY`
- [ ] Confirm all target chains support `paris` EVM (always); reassess only when bumping `evmVersion`
- [ ] Recommend (out of scope for this phase): external audit, fuzzing/invariant test suite, bug bounty before public launch
