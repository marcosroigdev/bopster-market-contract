# Bopster Contracts

**Binary prediction markets settled in USDC, resolved via Reality.eth.**
Designed for Base mainnet.

[![CI](https://github.com/marcosroigdev/bopster-market-contract/actions/workflows/ci.yml/badge.svg)](https://github.com/marcosroigdev/bopster-market-contract/actions/workflows/ci.yml)
![Solidity](https://img.shields.io/badge/Solidity-0.8.26-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Tests](https://img.shields.io/badge/tests-225%20passing-brightgreen)

---

> ⚠ **NOT AUDITED - DO NOT DEPLOY TO PRODUCTION**
>
> These contracts have NOT been audited by an external firm. They have
> undergone internal hardening across five phases (see
> [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)) and ship with 225 passing
> tests, but external review is **required** before any mainnet
> deployment with real funds.
>
> If you fork this code, you assume all risk. Audit it yourself first.

---

## What is Bopster

Bopster is a minimal, immutable protocol for **binary prediction markets**:

1. A market is created with a yes/no question, an end time, a resolve time,
   and a `questionId` pre-registered on **Reality.eth** (the oracle).
2. Users take **YES** or **NO** positions in **USDC** before `endTime`.
3. After `resolveTime`, anyone can call `finalize()` once Reality.eth has
   answered. The winning side splits the pool pro-rata after a small fee
   (capped at 10%); refund-path on non-binary outcomes.
4. If Reality fails to finalize within 90 days, anyone can trigger an
   **emergency refund** so every user recovers their stake.

The protocol is **two contracts**:

- **`BopsterFactory`** - deploys markets, holds global config (token,
  oracle, treasury, fees), can be paused by admin.
- **`BopsterMarket`** - one instance per question. Holds positions,
  finalizes against Reality, pays winners or refunds. **No admin, no
  upgrades** - once deployed, immutable.

The factory admin (a multisig) can pause new market creation in an
emergency but **cannot** drain funds, change fees, alter the treasury,
or interfere with already-deployed markets.

---

## Architecture

There are two contracts. `BopsterFactory` is deployed once per chain: it holds
the admin (a multisig), can pause/unpause new market creation, exposes
`createMarket()` and keeps a registry of every market. Each call to
`createMarket()` deploys a `BopsterMarket`, one per question, with immutable
config, its own state machine, the positions and the `finalize`/`claim` logic.

Bopster does not deploy its external dependencies: USDC (the ERC20 used for
positions and payouts) and Reality.eth ERC20 v3 (the outcome oracle).

Each market moves through four states. It starts `OPEN` for positions. Once
`endTime` passes it becomes `LOCKED`. After `resolveTime`, once Reality has
finalized the question, `finalize()` moves it to `RESOLVED` - a binary winner
means winners call `claim()`, no winner means everyone calls `claimRefund()`.
If Reality never answers, 90 days after `resolveTime` anyone can call
`triggerEmergencyRefund()` to reach `EMERGENCY_REFUND`, where stakes are
recovered with `claimRefund()`. In either terminal state, `sweepDust()` moves
any residual balance to the treasury 365 days after `resolveTime`.

---

## Quickstart

```bash
git clone https://github.com/marcosroigdev/bopster-market-contract.git
cd bopster-market-contract
npm ci
npx hardhat compile
npx hardhat test
```

Expected: **225 tests passing**, 0 failing.

Additional scripts:

```bash
npm run test:gas        # tests with gas reporter
npm run test:coverage   # solidity coverage
npm run lint            # solhint
npm run format          # prettier-solidity
```

Requires **Node.js >= 18**.

---

## Documentation

Comprehensive guides in this repo:

| Guide | Purpose |
|---|---|
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | Step-by-step production deployment on Base mainnet (env, wallets, hardhat config, commands, troubleshooting) |
| [CONTRACTS_USAGE_GUIDE.md](CONTRACTS_USAGE_GUIDE.md) | Integration reference: every external call, all events/errors, frontend + backend patterns |
| [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md) | Phase-by-phase changelog of contract evolution (Phases 1-5) |
| [SECURITY.md](SECURITY.md) | Responsible disclosure policy + security contact |
| [CHANGELOG.md](CHANGELOG.md) | Release history (semver) |

In-code references:

- `contracts/BopsterFactory.sol` - full NatSpec
- `contracts/BopsterMarket.sol` - full NatSpec including state-machine diagram
- `contracts/interfaces/IBopsterFactory.sol`, `contracts/interfaces/IBopsterMarket.sol` - drop-in interfaces for downstream integrators

---

## Deployed addresses

| Chain | Chain ID | Factory address | Block | Verified |
|---|---:|---|---|---|
| Base mainnet | 8453 | _pending deploy_ | - | - |
| Base Sepolia | 84532 | _pending_ | - | - |

Once deployed, this table is filled in from `deployments/<chain>-<timestamp>.json`.

---

## Audit status

**Unaudited.** Pre-audit hardening is complete (Phases 1-5 documented in
[MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)). The codebase ships with:

- 225 passing tests covering both contracts end-to-end
- Custom errors throughout (no `require` strings)
- `nonReentrant` on every transfer-bearing function
- `Ownable2Step` admin transfer
- `renounceOwnership` disabled
- Defense-in-depth: factory + market validate independently
- Documented token assumptions (USDC; no fee-on-transfer, rebasing, ERC777)

**Required next steps before mainnet:**
1. External audit (firm TBD)
2. Optional: Foundry-based invariant fuzzing (Echidna / Foundry's
   `forge invariant`)
3. Public bug bounty (post-audit)

---

## Tech stack

- **Solidity 0.8.26** (`paris` EVM target, `viaIR`, optimizer 200 runs)
- **Hardhat 2.28+**
- **OpenZeppelin Contracts v5** (`Ownable2Step`, `Pausable`,
  `ReentrancyGuard`, `SafeERC20`)
- **Reality.eth ERC20 v3** (oracle)
- **USDC** (canonical native; not bridged USDbC)

---

## Repository structure

```
bopster-market-contract/
  contracts/
    BopsterFactory.sol      # admin + market registry
    BopsterMarket.sol       # per-question lifecycle
    interfaces/             # IBopsterFactory, IBopsterMarket (integration)
    mocks/                  # test-only mocks (MockERC20, MockReality, MaliciousToken)
  test/                     # hardhat tests (Mocha + Chai)
  DEPLOYMENT_GUIDE.md
  CONTRACTS_USAGE_GUIDE.md
  MIGRATION_GUIDE.md
  SECURITY.md
  CHANGELOG.md
  hardhat.config.js
  package.json
```

---

## License

MIT. See [LICENSE](LICENSE).

## Security

For vulnerability disclosure, see [SECURITY.md](SECURITY.md).
Do NOT open a public issue for security reports.

---

## Acknowledgements

Built on the shoulders of:
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) - base abstractions
- [Reality.eth](https://reality.eth.limo) - outcome oracle
- [Circle](https://www.circle.com/en/usdc) - USDC
- [Foundry](https://book.getfoundry.sh/) - `cast` for state inspection
- [Hardhat](https://hardhat.org/) - test + deploy harness
