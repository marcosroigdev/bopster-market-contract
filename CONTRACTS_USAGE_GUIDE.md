# Bopster - Smart Contracts Usage Guide

Reference for integrating with `BopsterFactory` and `BopsterMarket`. Aimed
at frontend, backend, indexing, and contract-to-contract integrators.

Code samples use **ethers.js v6**. Equivalent viem/web3.js patterns map
directly.

---

## 1. Architecture overview

`BopsterFactory` is deployed once per chain. It holds the admin (a multisig),
controls pause/unpause for new market creation, exposes `createMarket()` and
keeps the market registry. Every `createMarket()` deploys a `BopsterMarket`, one
per Reality question, with immutable config, its own state machine, positions
and the `finalize`/`claim` logic.

Bopster does not deploy its external dependencies: USDC (the ERC20 used for
positions and payouts) and Reality.eth ERC20 v3 (the outcome oracle).

One factory per chain, many markets per factory. Each market is an
**independent contract** with its own state, its own balance, and no admin.

---

## 2. State machine

A market starts `OPEN` for positions. When `endTime` passes it becomes `LOCKED`
(automatically inside `finalize()`, or explicitly via `lock()`). After
`resolveTime`, once `Reality.isFinalized()` is true, `finalize()` moves it to
`RESOLVED`: a binary YES/NO winner means winners call `claim()`, no winner means
everyone calls `claimRefund()`.

If Reality never finalizes, 90 days after `resolveTime` anyone can call
`triggerEmergencyRefund()` to reach `EMERGENCY_REFUND`, where stakes come back
through `claimRefund()`. From either terminal state (`RESOLVED` or
`EMERGENCY_REFUND`), `sweepDust()` sends any residual balance to the treasury
365 days after `resolveTime`.

Status as a `uint8`:
- `0` = OPEN
- `1` = LOCKED
- `2` = RESOLVED
- `3` = EMERGENCY_REFUND

Status NEVER moves backward. Once terminal, it stays terminal.

---

## 3. Token assumptions

Bopster is designed for **USDC** (or any "vanilla" ERC20). Tokens with
these behaviours are NOT supported:

| Token behaviour | Why it breaks Bopster |
|-----------------|------------------------|
| Fee on transfer | Pool accounting drifts - credited amount != `amount` argument |
| Rebasing | Balances change between blocks - invariants corrupt |
| ERC777 / hooks | Re-entry surface during `safeTransfer*` |
| Blacklists (e.g., USDC blacklist) | A blacklisted user can lock funds - see section 11.4 |

The contracts do NOT validate token type. Deployers are expected to use
USDC. If you ever deploy with a different token, audit it against this
list first.

---

## 4. Reality.eth integration

Bopster does NOT create Reality questions. The question lifecycle is:

1. **Off-chain (your backend):** craft the question text and template
2. **On chain:** call `RealityETH_ERC20_v3_2.askQuestionWithMinBond(...)`
 -> returns `questionId` (`bytes32`)
3. **On chain:** call `factory.createMarket(questionId, ...)` to create
   the Bopster market that wraps that question

### 4.1 Answer encoding

Bopster reads `reality.resultFor(questionId)` and matches against:

| Bopster constant   | Value | Meaning |
|--------------------|-------|---------|
| `ANSWER_YES`       | `0x0000...0001` | YES wins |
| `ANSWER_NO`        | `0x0000...0000` | NO wins |
| `ANSWER_INVALID`   | `0xffff...ffff` | refund path |
| `ANSWER_TOO_SOON`  | `0xffff...fffe` | refund path |
| any other `bytes32`| any   | refund path |

**Important: NO = 0, YES = 1.** This is the convention for binary
questions in Reality.eth. Make sure your question template matches -
otherwise the market will pay the wrong side.

### 4.2 Arbitration

Reality's `resultFor` returns the final answer regardless of whether it
came from a regular answerer or from the configured arbitrator (e.g.
Kleros). Bopster does not care which path produced the answer. It only
reads `isFinalized()` + `resultFor()`.

### 4.3 Question metadata

The Bopster market stores a `metadataURI` (string) pointing to off-chain
content describing the market - typically IPFS or HTTPS. Recommended JSON
shape:

```json
{
  "title": "Will it rain in Madrid on 2026-06-13?",
  "description": "...",
  "rules": "...",
  "image": "ipfs://...",
  "createdAt": 1700000000,
  "category": "weather",
  "version": 1
}
```

The contract does not parse this - it's there for the UI/indexer to read.
Pin it on a reliable IPFS gateway.

---

## 5. Action: Create a market

### 5.1 Who

Anyone, as long as `factory.paused()` is `false`.

### 5.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `questionId != bytes32(0)` | `BadQuestion()` |
| `bytes(metadataURI).length > 0` | `BadURI()` |
| `endTime != 0 && resolveTime != 0 && endTime < resolveTime` | `BadTimes()` |
| `endTime >= block.timestamp + MIN_MARKET_DURATION` (15 min) | `EndTimeTooSoon()` |
| `endTime <= block.timestamp + MAX_MARKET_DURATION` (10 days) | `EndTimeTooFar()` |
| `resolveTime - endTime <= MAX_RESOLUTION_WINDOW` (30 days) | `ResolutionWindowTooLarge()` |
| factory not paused | `EnforcedPause()` |

### 5.3 Example

```js
import { ethers } from "ethers";
import factoryAbi from "./abi/BopsterFactory.json";

const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, signer);

// Read bounds at runtime - don't hardcode
const MIN = await factory.minMarketDuration();
const MAX = await factory.maxMarketDuration();

const now = Math.floor(Date.now() / 1000);
const endTime     = now + 24 * 3600;      // 1 day from now
const resolveTime = endTime + 12 * 3600;  // 12h after endTime

const tx = await factory.createMarket(
    questionId,                   // bytes32 from Reality
    "ipfs://bafy...",             // metadata URI
    endTime,
    resolveTime
);
const receipt = await tx.wait();

// Extract the new market address from the MarketCreated event
const log = receipt.logs.find(
    (l) => l.fragment?.name === "MarketCreated"
);
const marketAddress = log.args.market;
console.log("Market deployed:", marketAddress);
```

### 5.4 Effects

- Deploys a new `BopsterMarket` (full bytecode, not a proxy).
- Pushes the address to `factory.allMarkets`.
- Emits `MarketCreated(market, creator, questionId, endTime, resolveTime, metadataURI)`.

The `creator` address (= `msg.sender`) becomes the recipient of `creatorFeeBps` on a binary outcome. Pick the caller carefully - for example, you may want a backend bot to call this only for "official" markets, or you may allow any user to create markets and pocket the creator fee themselves.

---

## 6. Action: Take a position

### 6.1 Who

Anyone - no whitelist.

### 6.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == OPEN` | `NotOpen()` |
| `block.timestamp < endTime` | `NotOpen()` |
| `amount > 0` | `InvalidAmount()` |
| Caller has approved `amount` USDC to the market | `SafeERC20FailedOperation(token)` |
| Caller has `amount` USDC balance | `SafeERC20FailedOperation(token)` |

### 6.3 Example

```js
import marketAbi from "./abi/BopsterMarket.json";
import usdcAbi from "./abi/IERC20.json";

const market = new ethers.Contract(MARKET_ADDRESS, marketAbi, signer);
const usdc   = new ethers.Contract(USDC_ADDRESS,   usdcAbi,   signer);

const amount = ethers.parseUnits("100", 6);  // 100 USDC (6 decimals)

// 1. Approve
const allowance = await usdc.allowance(await signer.getAddress(), MARKET_ADDRESS);
if (allowance < amount) {
    await (await usdc.approve(MARKET_ADDRESS, amount)).wait();
}

// 2. Position
const tx = await market.positionYes(amount);
await tx.wait();
```

### 6.4 Effects

- `yesPosition[msg.sender] += amount` (or `noPosition` for `positionNo`)
- `totalYes += amount` (or `totalNo`)
- `amount` USDC pulled from `msg.sender` to the market contract
- Emits `PositionPlaced(user, sideYes, amount)`

### 6.5 Hedging

A user CAN call both `positionYes` and `positionNo` on the same market.
On resolution:
- **Binary winner:** only the winning side is paid out. The losing-side
  stake stays in the pool and is distributed to winners.
- **Refund path / emergency:** the full combined stake is returned.

If you build a UI, decide whether to show a hedge as one combined
position or as two separate ones. Most users find "two separate
positions" clearer.

---

## 7. Action: Lock a market

### 7.1 Who

Anyone - permissionless.

### 7.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == OPEN` | `NotOpen()` |
| `block.timestamp >= endTime` | `TooEarly()` |

### 7.3 Why call it

- After `endTime`, positions are already blocked at the `_position` level
  (the `block.timestamp >= endTime` check fires). But `status` stays
  `OPEN` until either `lock()` or `finalize()` is called.
- Indexers usually surface a market's UI state from `status`. Calling
  `lock()` cleanly emits a `Locked` event and lets the UI render
  "Awaiting resolution" without ambiguity.
- If you don't call `lock()`, `finalize()` will auto-lock as part of its
  flow. So `lock()` is purely about emitting a clean checkpoint event.

### 7.4 Example

```js
if ((await market.status()) === 0n &&
    Date.now() / 1000 >= Number(await market.endTime())) {
    await (await market.lock()).wait();
}
```

---

## 8. Action: Finalize a market

### 8.1 Who

Anyone - permissionless. The first caller gets the resolver reward (on a
binary outcome only).

### 8.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == OPEN` and `block.timestamp < endTime` | `TooEarly()` (inside auto-lock branch) |
| `status != LOCKED` (after auto-lock attempt) | `NotLocked()` |
| `block.timestamp >= resolveTime` | `TooEarly()` |
| `reality.isFinalized(questionId)` | `RealityNotFinalized()` |

### 8.3 Example

```js
const status = await market.status();
const now    = Math.floor(Date.now() / 1000);
const rt     = Number(await market.resolveTime());

if (status === 1n && now >= rt) {
    const reality = new ethers.Contract(
        await market.reality(),
        ["function isFinalized(bytes32) view returns (bool)"],
        provider
    );
    const qid = await market.questionId();
    if (await reality.isFinalized(qid)) {
        await (await market.finalize()).wait();
    }
}
```

### 8.4 Effects

- Reads `reality.resultFor(questionId)` and stores it in `finalAnswer`.
- Sets `outcomeYes` + `outcomeInvalid` based on the answer.
- Computes `netPayoutPool = totalYes + totalNo - protocolFee - creatorFee - resolverReward`.
- Transfers `protocolFee` -> `treasury`, `creatorFee` -> `creator`,
  `resolverReward` -> `msg.sender`.
- Sets `status = RESOLVED`.
- Emits `Resolved(finalAnswer, poolTotal, netPool, protocolFee, creatorFee, resolverReward)`.

**On the refund path** (non-binary answer or empty pool):
- `netPayoutPool = totalYes + totalNo` (full pool).
- **No fees paid. No resolver reward.**
- Still emits `Resolved` with `0, 0, 0` for the fee fields.

### 8.5 MEV / front-running on the resolver reward

The reward goes to whoever lands the first successful `finalize()` tx.
Any sophisticated mempool watcher can front-run a community member. This
is by design (permissionless incentive). UI guidance:

- Don't promise users they'll "earn" the reward by clicking a button.
- If you want internal control of resolution, run a backend bot with
  priority gas. Make it idempotent (multiple bots OK - the second one
  will revert harmlessly).
- For the refund path, there's no reward, so nobody will front-run you.
  But also: nobody is incentivized to call `finalize` at all in that
  case. Plan to have your backend call it.

---

## 9. Action: Claim winnings

### 9.1 Who

Any user with a position on the winning side.

### 9.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == EMERGENCY_REFUND` | `EmergencyRefundActive()` (use `claimRefund`) |
| `status != RESOLVED` | `NotResolved()` |
| `!claimed[msg.sender]` | `NothingToClaim()` |
| `winningStake > 0` | `NothingToClaim()` |
| `totalWinningSide > 0` (otherwise refund path) | `NothingToClaim()` |
| `payout > 0` (could be 0 from integer-division dust) | `NothingToClaim()` |

### 9.3 Payout math

```
payout = (userStake * netPayoutPool) / totalWinningSide
```

Pro rata of the winning side, against the post-fee pool. Losers'
contributions are absorbed into `netPayoutPool`. Integer division
truncates - see "Dust" in section 13.

### 9.4 Example

```js
const tx = await market.claim();
await tx.wait();
```

That's it - `msg.sender` is read on chain; no args needed.

### 9.5 Effects

- `claimed[msg.sender] = true` (one-shot per user)
- `payout` USDC transferred to `msg.sender`
- Emits `Claimed(msg.sender, payout)`

---

## 10. Action: Claim a refund

### 10.1 Who

Any user with any position (YES, NO, or both), in either:
- `RESOLVED` with `totalWinningSide == 0` (refund path), or
- `EMERGENCY_REFUND`

### 10.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| Status is one of (RESOLVED+no-win, EMERGENCY_REFUND) | `NotResolved()` |
| `!claimed[msg.sender]` | `NothingToClaim()` |
| `yesPosition + noPosition > 0` | `NothingToClaim()` |

### 10.3 Payout math

```
refund = yesPosition[msg.sender] + noPosition[msg.sender]
```

The full combined stake. No fees, no haircut. The `claimed` flag is
**shared** with `claim()` - a user who already claimed cannot then
refund (or vice versa).

### 10.4 Example

```js
const tx = await market.claimRefund();
await tx.wait();
```

### 10.5 UI guidance

Show the refund button when:
```js
const status = await market.status();
const tws    = await market.totalWinningSide();
const showRefund =
    (status === 2n && tws === 0n) || // RESOLVED no winner
    (status === 3n);                  // EMERGENCY_REFUND
```

---

## 11. Action: Trigger emergency refund

### 11.1 Who

Anyone - permissionless.

### 11.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == LOCKED` | `NotLocked()` |
| `block.timestamp >= resolveTime + EMERGENCY_REFUND_DELAY` (90 days) | `EmergencyRefundNotYetAvailable()` |
| `!reality.isFinalized(questionId)` | `RealityAlreadyFinalized()` |

The third check is critical: if Reality finalized, you must use
`finalize()` instead. Emergency refund is for stuck-oracle scenarios only.

### 11.3 Effects

- `status = EMERGENCY_REFUND`
- `outcomeInvalid = true`, `outcomeYes = false`
- `totalWinningSide = 0`
- `netPayoutPool = totalYes + totalNo` (full pool)
- `finalAnswer` stays `bytes32(0)` (Reality was never consulted)
- Emits `EmergencyRefundEnabled(poolTotal)`

After this, `finalize()` is blocked (status no longer `LOCKED`). Every
user can recover their stake via `claimRefund()`.

### 11.4 Example

```js
const tx = await market.triggerEmergencyRefund();
await tx.wait();
```

### 11.5 UI guidance

Compute the threshold:

```js
const resolveTime = Number(await market.resolveTime());
const delay       = Number(await market.EMERGENCY_REFUND_DELAY()); // 7776000

const emergencyTs = resolveTime + delay;
const now         = Math.floor(Date.now() / 1000);

if (now >= emergencyTs) {
    const reality = new ethers.Contract(/* ... */);
    const finalized = await reality.isFinalized(await market.questionId());
    if (!finalized) {
        // show "Trigger Emergency Refund" button
    } else {
        // show "Finalize Market" instead - Reality has answered
    }
}
```

---

## 12. Action: Sweep dust

### 12.1 Who

Anyone - permissionless. Destination is **always** `treasury`.

### 12.2 Preconditions

| Check | Reverts with |
|-------|--------------|
| `status == RESOLVED` or `status == EMERGENCY_REFUND` | `NotResolved()` |
| `block.timestamp >= resolveTime + SWEEP_DUST_DELAY` (365 days) | `SweepDustNotYetAvailable()` |
| `token.balanceOf(market) > 0` | `NoDust()` |

### 12.3 What gets swept

- Integer-division dust from `claim()` payouts (`netPayoutPool % totalWinningSide`)
- Tokens transferred directly to the contract bypassing `position*`
- Stakes from users who never claimed within the 365-day window
  (**they forfeit their payout**)

### 12.4 Effects

- Full `token.balanceOf(this)` -> `treasury`
- Emits `DustSwept(treasury, amount)`

### 12.5 UI guidance

Hide claim buttons after the sweep - they'll revert from the underlying
ERC20 transfer (`SafeERC20FailedOperation`), not from `NothingToClaim`.
You can pre-empt this by hiding the button when
`now > resolveTime + 365d` AND `token.balanceOf(market) == 0`.

---

## 13. Constants reference

Read at runtime - don't hardcode in clients:

| Constant | Value | Where |
|----------|-------|-------|
| `MIN_MARKET_DURATION` | 15 minutes (900 s) | Factory |
| `MAX_MARKET_DURATION` | 10 days (864000 s) | Factory |
| `MAX_RESOLUTION_WINDOW` | 30 days (2592000 s) | Factory + Market |
| `EMERGENCY_REFUND_DELAY` | 90 days (7776000 s) | Market |
| `SWEEP_DUST_DELAY` | 365 days (31536000 s) | Market |
| `ANSWER_YES` | `bytes32(uint256(1))` | Market |
| `ANSWER_NO` | `bytes32(uint256(0))` | Market |
| `ANSWER_INVALID` | `bytes32(type(uint256).max)` | Market |
| `ANSWER_TOO_SOON` | `bytes32(type(uint256).max - 1)` | Market |

---

## 14. Events reference

### 14.1 Factory

```solidity
event MarketCreated(
    address indexed market,
    address indexed creator,
    bytes32 indexed questionId,
    uint64 endTime,
    uint64 resolveTime,
    string metadataURI
);
```
Inherited from OZ:
- `Paused(address)`, `Unpaused(address)`
- `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` (Ownable2Step)
- `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)`

### 14.2 Market

```solidity
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
```

### 14.3 Subgraph / indexer schema sketch

```
type Market @entity {
    id: ID!                    # market address
    creator: Bytes!
    questionId: Bytes!
    metadataURI: String!
    endTime: BigInt!
    resolveTime: BigInt!
    status: Int!                # 0..3
    totalYes: BigInt!
    totalNo: BigInt!
    outcomeYes: Boolean
    outcomeInvalid: Boolean
    finalAnswer: Bytes
    positions: [Position!]! @derivedFrom(field: "market")
    claims:    [Claim!]!    @derivedFrom(field: "market")
}

type Position @entity {
    id: ID!                    # market - user - side
    market: Market!
    user: Bytes!
    sideYes: Boolean!
    amount: BigInt!
    txHash: Bytes!
    blockNumber: BigInt!
}

type Claim @entity {
    id: ID!                    # market - user
    market: Market!
    user: Bytes!
    amount: BigInt!
    txHash: Bytes!
    blockNumber: BigInt!
}
```

Map handlers from `MarketCreated`, `PositionPlaced`, `Locked`, `Resolved`,
`Claimed`, `EmergencyRefundEnabled`, `DustSwept`.

---

## 15. Errors reference

### 15.1 Factory

| Error | Meaning |
|-------|---------|
| `BadAddress()` | constructor: a core address was zero |
| `BadTimes()` | `endTime == 0`, `resolveTime == 0`, or `endTime >= resolveTime` |
| `BadFees()` | total fee bps > 1000 |
| `BadQuestion()` | `questionId == bytes32(0)` |
| `BadURI()` | `metadataURI` is empty |
| `EndTimeTooSoon()` | `endTime < now + MIN_MARKET_DURATION` |
| `EndTimeTooFar()` | `endTime > now + MAX_MARKET_DURATION` |
| `ResolutionWindowTooLarge()` | `resolveTime - endTime > MAX_RESOLUTION_WINDOW` |
| `RenounceOwnershipDisabled()` | `renounceOwnership` is intentionally disabled |
| `EnforcedPause()` | factory is paused (OZ Pausable) |
| `OwnableUnauthorizedAccount(address)` | caller is not the owner (OZ Ownable) |

### 15.2 Market

| Error | Meaning |
|-------|---------|
| `ZeroToken / ZeroReality / ZeroTreasury / ZeroCreator` | constructor: one of these args is zero |
| `ZeroQuestionId()` | `questionId == bytes32(0)` |
| `EmptyMetadataURI()` | empty metadata URI |
| `EndTimeInPast()` | `endTime <= now` at construction |
| `InvalidTimeOrder()` | `endTime >= resolveTime` |
| `FeesTooHigh()` | total bps > 1000 |
| `CutsExceedPool()` | invariant tripwire - should be unreachable |
| `ResolutionWindowTooLarge()` | `resolveTime - endTime > MAX_RESOLUTION_WINDOW` |
| `NotOpen()` | tried to position when not OPEN, or past endTime |
| `NotLocked()` | tried to finalize / triggerEmergencyRefund when not LOCKED |
| `NotResolved()` | tried to claim / claimRefund / sweepDust before resolution |
| `TooEarly()` | endTime or resolveTime not reached |
| `InvalidAmount()` | `amount == 0` |
| `RealityNotFinalized()` | Reality has not finalized the question yet |
| `NothingToClaim()` | already claimed, or no stake, or payout rounds to zero |
| `EmergencyRefundNotYetAvailable()` | 90-day delay not elapsed |
| `RealityAlreadyFinalized()` | trying to emergency-refund a market that can `finalize()` |
| `EmergencyRefundActive()` | tried `claim()` on an emergency-refunded market |
| `SweepDustNotYetAvailable()` | 365-day delay not elapsed |
| `NoDust()` | nothing to sweep |
| `ReentrancyGuardReentrantCall()` | OZ ReentrancyGuard tripped |
| `SafeERC20FailedOperation(address)` | OZ SafeERC20 - token transfer reverted |

---

## 16. Frontend integration patterns

### 16.1 Reading the factory's market list

```js
const total = Number(await factory.marketsCount());
const PAGE = 50;
const markets = [];
for (let start = 0; start < total; start += PAGE) {
    const slice = await factory.getMarkets(start, PAGE);
    markets.push(...slice);
}
```

For large registries, prefer subgraph queries over RPC pagination.

### 16.2 Status -> UI label mapping

```js
function statusLabel(status, market) {
    switch (Number(status)) {
        case 0: return "Open";
        case 1: return "Locked - awaiting resolution";
        case 2: return market.outcomeInvalid
                  ? "Resolved - refund available"
                  : (market.outcomeYes ? "Resolved - YES wins" : "Resolved - NO wins");
        case 3: return "Emergency refund - claim your stake";
    }
}
```

### 16.3 Cache constants

`MIN_MARKET_DURATION`, `MAX_MARKET_DURATION`, `EMERGENCY_REFUND_DELAY`,
`SWEEP_DUST_DELAY`, `ANSWER_*` are constants. Read them once on app load
and cache. Don't re-fetch per render.

### 16.4 Approval UX

Default to "exact approval" (approve the position amount, not infinite).
USDC's `approve` has a known race condition that requires going through
zero on amount changes - but as long as you approve **per position**
(not on top of an existing allowance), you avoid this.

If you do offer infinite approval, warn users explicitly. A compromised
market contract is impossible by design (no admin), but the approval also
applies to the underlying market - which is bytecode-permanent. Users
intuit infinite approvals as risky; respect that.

### 16.5 Time displays

Always display `endTime` and `resolveTime` as absolute (with timezone) AND
relative ("ends in 3h 12m"). Both. Users misread one or the other in
practice.

### 16.6 Error message mapping

```js
function decodeBopsterError(err) {
    const map = {
        NotOpen:              "Positions are closed for this market.",
        InvalidAmount:        "Amount must be greater than zero.",
        NotResolved:          "Market is not yet resolved.",
        TooEarly:             "It's too early to perform this action.",
        RealityNotFinalized:  "The oracle has not finalized the answer yet.",
        EmergencyRefundActive:"Emergency refund is active - use the Refund button.",
        EmergencyRefundNotYetAvailable: "The 90-day emergency window has not elapsed yet.",
        RealityAlreadyFinalized: "The oracle finalized - use Finalize instead of Emergency Refund.",
        NothingToClaim:       "You have nothing to claim on this market.",
        SafeERC20FailedOperation: "Token transfer failed - check your balance and approval.",
        EnforcedPause:        "Market creation is currently paused.",
        EndTimeTooSoon:       "Markets must end at least 15 minutes from now.",
        EndTimeTooFar:        "Markets cannot end more than 10 days from now.",
        ResolutionWindowTooLarge: "Resolution time must be within 30 days of end time.",
    };
    for (const [name, msg] of Object.entries(map)) {
        if (err.message.includes(name)) return msg;
    }
    return "Transaction failed - please try again.";
}
```

---

## 17. Backend integration patterns

### 17.1 Reality question lifecycle

A robust backend flow:

1. User submits market proposal (off-chain).
2. Backend creates the IPFS metadata blob, pins it.
3. Backend creates the Reality question via `RealityETH_ERC20_v3_2.askQuestionWithMinBond`.
4. Backend waits for the tx to confirm, extracts `questionId`.
5. Backend records `(questionId, metadataCid)` in its DB.
6. Backend (or user) calls `factory.createMarket(...)` referring to that
   `questionId`.

If step 3 succeeds but step 6 fails, the Reality question exists "orphaned" - no Bopster market wraps it. Retry step 6, or write a small reconciler. The Reality question survives indefinitely; it costs nothing on chain to leave it floating.

### 17.2 Resolution bot

Run a watcher that:

```
every block:
  for each LOCKED market:
    if block.timestamp >= resolveTime + 60s:    # small buffer
      if reality.isFinalized(questionId):
        market.finalize()                       # earns resolverReward
```

Make it idempotent - if two instances run, the second one reverts harmlessly with `NotLocked`. Fund the bot's EOA from the resolver rewards it earns.

### 17.3 Emergency-refund watcher

```
weekly cron:
  for each LOCKED market where now >= resolveTime + 90 days:
    if not reality.isFinalized(questionId):
      market.triggerEmergencyRefund()
```

No resolver reward here, so the bot is a public-good operation. Probably run it from the protocol itself, paying gas from treasury.

### 17.4 Dust-sweep watcher

```
weekly cron:
  for each (RESOLVED or EMERGENCY_REFUND) market where now >= resolveTime + 365 days:
    if token.balanceOf(market) > 0:
      market.sweepDust()
```

Same pattern - public good, run from protocol funds.

---

## 18. Troubleshooting

### 18.1 "Why does my `positionYes` revert with `NotOpen`?"

In order of likelihood:
1. `endTime` has passed. Even if `status` is still `OPEN` on chain, the
   `_position` check `block.timestamp >= endTime` fires.
2. `status` was already moved to `LOCKED` by someone calling `lock()`.
3. Stale RPC: your provider is behind the chain. Refresh and retry.

### 18.2 "Why does `finalize()` revert with `RealityNotFinalized`?"

Reality has not reached its bond-timeout window yet, OR the question is
under active arbitration (Kleros) and waiting for the arbitrator's ruling
to be submitted. Wait. Check the question on the Reality UI.

### 18.3 "Why does `finalize()` revert with `TooEarly`?"

`block.timestamp < resolveTime`. Wait. Or check that your client is
reading `resolveTime` in seconds (uint64), not milliseconds.

### 18.4 "My user has both YES and NO positions - what should the UI show?"

Show them both as separate line items. On resolution:
- Binary outcome: show "Won (YES leg)" + "Lost (NO leg) - absorbed in pool".
  Display the `claim()` amount as the payout.
- Refund / emergency: show one combined "Refund" line equal to YES + NO.

### 18.5 "User sent USDC directly to the market contract, not via `positionYes`. Can they recover?"

Not before `resolveTime + 365 days`. Then `sweepDust` will move it to the
treasury (NOT back to the sender). This is documented behaviour. If a
user reports this, you have two options:
- Wait for sweep, then make them whole from treasury manually (off chain).
- Run an out-of-band reimbursement out of protocol funds.

There is no on-chain rescue mechanism by design.

### 18.6 "Reality returned `0` - does that mean NO or INVALID?"

`bytes32(0)` = `ANSWER_NO` in Bopster's encoding. If Reality returned `0`
because the question was answered with NO, that's correct. If Reality
returned `0` because of an oracle bug or wrong template - that's a
serious problem; the market will pay out NO holders. **Verify your
question template encodes binary as `1 = YES, 0 = NO`**.

### 18.7 "How do I distinguish RESOLVED-with-no-winner from EMERGENCY_REFUND?"

Read `status`:
- `2` (RESOLVED): outcome went through Reality. Check `outcomeInvalid` to
  know whether refund or binary winner. `finalAnswer` is populated.
- `3` (EMERGENCY_REFUND): Reality never answered in time. `finalAnswer`
  is `bytes32(0)`. Refund only.

### 18.8 "Resolver reward is `0` - bug?"

No. The reward is `0` in two cases:
- `resolverRewardBps == 0` (admin configured it that way).
- The market resolved on the refund path (no fees, no rewards).

### 18.9 "`claim()` says `NothingToClaim` but I have a stake."

Possible causes:
- You already claimed (`claimed[you] == true`).
- You're on the losing side; you can only `claim` if `outcomeYes` matches
  your position side.
- The market is in `EMERGENCY_REFUND` - use `claimRefund()`.
- Your payout rounds to zero (extremely small stake on a large pool with
  ugly numbers). Practically only at the dust threshold of 1 USDC base
  unit (`1e-6` USDC).

### 18.10 "`getMarkets` is slow"

`getMarkets` is `view` - no gas cost - but it's still an RPC call with
N+1 SLOAD's worth of cost on the RPC side. For very large registries,
the cleaner approach is to listen to `MarketCreated` events into a
subgraph or local index. The contract function is fine for <= 1000
markets; past that, lean on indexers.

---

## 19. Best practices

### 19.1 For frontend builders

- Always read constants once and cache. Re-fetching `EMERGENCY_REFUND_DELAY`
  on every render is silly.
- Always show `paused()` state on the create-market form.
- Always validate `endTime` and `resolveTime` against `min/maxMarketDuration`
  and `maxResolutionWindow` client-side. Use the same labels the contract
  uses so error messages are consistent.
- Always display fees BEFORE the user takes a position. "If YES wins, you
  receive your stake + share of NO stakes minus a 2.5% protocol fee."
- Always render a clear emergency-refund countdown for `LOCKED` markets
  past `resolveTime`.
- For long-duration markets (> 3 days), warn the user that liquidity will
  thin out and resolution may be slow.

### 19.2 For backend / infrastructure

- Run idempotent finalize/refund/sweep bots. Don't depend on user clicks.
- Index `MarketCreated`, `PositionPlaced`, `Resolved`, `Claimed`,
  `EmergencyRefundEnabled`, `DustSwept` minimally. Add other events as needed.
- Audit your Reality question template carefully. Mistakes here are
  systemic - every market wired to a bad template misresolves.
- Pin metadata IPFS via two pinning services. If one rotates, the URI stays
  resolvable.

### 19.3 For contract-to-contract integrators

- Don't assume `BopsterMarket` is a proxy - it's a full contract. Each
  market is `~16 KB` of bytecode and ~25k gas of cold reads.
- Use `IBopsterFactory` / `IBopsterMarket` from `contracts/interfaces/`.
- Be cautious about wrapping `positionYes` / `positionNo` from another
  contract - your contract becomes the position holder, not the end
  user. `claim()` will pay your contract; you'll need to forward
  proceeds. Bopster doesn't take a position in user identity beyond
  `msg.sender`.

### 19.4 General

- **Don't manipulate `metadataURI` after market creation.** It's stored
  on chain but functionally immutable (no setter). If you want versioning,
  point the URI at an IPNS name and update the IPFS content under that
  name. Be aware: indexers may have cached the original CID.
- **Don't hardcode the EMERGENCY_REFUND_DELAY or any other constant in
  the client.** Read it from the contract. Hardcoded constants drift
  silently if the contracts ever change.
- **Don't use single-step token approvals for amounts > 0 on top of a
  previous non-zero allowance.** USDC requires you to go through zero
  first when changing a non-zero allowance. Easier: approve per
  position, exact amount, every time.
- **Don't promise refunds outside the contract logic.** Once a binary
  outcome is final, losing-side stakes are gone (to winners). There's no
  rollback.

---

## 20. Appendix - full ABI surface (signatures)

### 20.1 BopsterFactory

```
function token() view returns (address)
function reality() view returns (address)
function treasury() view returns (address)
function protocolFeeBps() view returns (uint16)
function creatorFeeBps() view returns (uint16)
function resolverRewardBps() view returns (uint16)
function MIN_MARKET_DURATION() pure returns (uint256)
function MAX_MARKET_DURATION() pure returns (uint256)
function MAX_RESOLUTION_WINDOW() pure returns (uint256)
function minMarketDuration() pure returns (uint256)
function maxMarketDuration() pure returns (uint256)
function maxResolutionWindow() pure returns (uint256)
function allMarkets(uint256) view returns (address)
function marketsCount() view returns (uint256)
function getMarkets(uint256 start, uint256 count) view returns (address[])
function createMarket(bytes32 questionId, string metadataURI, uint64 endTime, uint64 resolveTime) returns (address)
function paused() view returns (bool)
function pause()                           // onlyOwner
function unpause()                         // onlyOwner
function owner() view returns (address)
function pendingOwner() view returns (address)
function transferOwnership(address newOwner)   // onlyOwner
function acceptOwnership()                     // pendingOwner only
function renounceOwnership()                   // reverts always
```

### 20.2 BopsterMarket

```
function token() view returns (address)
function reality() view returns (address)
function treasury() view returns (address)
function creator() view returns (address)
function questionId() view returns (bytes32)
function metadataURI() view returns (string)
function endTime() view returns (uint64)
function resolveTime() view returns (uint64)
function protocolFeeBps() view returns (uint16)
function creatorFeeBps() view returns (uint16)
function resolverRewardBps() view returns (uint16)
function ANSWER_YES() pure returns (bytes32)
function ANSWER_NO() pure returns (bytes32)
function ANSWER_INVALID() pure returns (bytes32)
function ANSWER_TOO_SOON() pure returns (bytes32)
function EMERGENCY_REFUND_DELAY() pure returns (uint64)
function MAX_RESOLUTION_WINDOW() pure returns (uint256)
function SWEEP_DUST_DELAY() pure returns (uint64)
function status() view returns (uint8)
function totalYes() view returns (uint256)
function totalNo() view returns (uint256)
function yesPosition(address) view returns (uint256)
function noPosition(address) view returns (uint256)
function outcomeYes() view returns (bool)
function outcomeInvalid() view returns (bool)
function finalAnswer() view returns (bytes32)
function totalWinningSide() view returns (uint256)
function netPayoutPool() view returns (uint256)
function claimed(address) view returns (bool)
function positionYes(uint256 amount)
function positionNo(uint256 amount)
function lock()
function finalize()
function triggerEmergencyRefund()
function claim()
function claimRefund()
function sweepDust()
```
