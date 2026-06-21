# Security Policy

## Supported versions

Only the latest tagged release of `bopster-market-contract` is supported.
Older versions (including pre-audit phases) receive no security updates.

| Version | Status |
|---------|--------|
| `1.0.0` (pre-audit) | Latest - internal hardening complete; **no production deployment** |

Once an external audit is complete and a `v1.0.0-audited` release is
tagged, this table will be updated accordingly.

---

## Reporting a vulnerability

**Please report security issues responsibly.** Do NOT open a public
GitHub issue, pull request, or discussion for vulnerabilities. Public
disclosure before remediation puts users' funds at risk.

### How to report - GitHub Security Advisories (private)

Use GitHub's built-in private vulnerability reporting. It keeps the
report visible only to repository maintainers and to you, with full
audit trail and no email needed.

1. Go to <https://github.com/marcosroigdev/bopster-market-contract/security/advisories/new>
   (or click **Security -> Advisories -> "Report a vulnerability"** in
   the repo header).
2. Fill in the form: title, description, affected version, severity.
3. Submit. Only repository admins (and any collaborators you add) can
   see the advisory until it is published.

This is the **only supported** disclosure channel. No email, no DMs,
no Twitter - that way nothing falls through the cracks and there is
no inbox to compromise.

### What to include

- Clear description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept (e.g. a Hardhat test)
- Affected contract / function / line numbers
- Your suggested severity rating
- Your handle / name for credit in the eventual advisory (or "anonymous")

### Response timeline

- **Within 48 hours** - acknowledgement of receipt
- **Within 7 days** - initial assessment + severity classification
- **Within 30 days** - fix released (or status update with revised
  timeline for complex issues)

Once a fix is deployed, the advisory is **published** from the same
page where it was reported - researchers and the wider community can
read the details once users are safe.

### Coordinated disclosure

We follow **responsible disclosure**. Please give a reasonable window
to remediate before publishing details. The publication of the
advisory is coordinated with you and credits your contribution.

---

## Scope

### In scope

- Contracts in `contracts/` of this repo
  - `BopsterFactory.sol`
  - `BopsterMarket.sol`
  - `interfaces/IBopsterFactory.sol`
  - `interfaces/IBopsterMarket.sol`
- Deploy scripts in `scripts/` (once added)
- Configuration in `hardhat.config.js` that affects deployed bytecode

### Out of scope

- **Dependencies** - report directly to upstream:
  - OpenZeppelin: <https://github.com/OpenZeppelin/openzeppelin-contracts/security>
  - Reality.eth: <https://github.com/RealityETH/reality-eth-monorepo/security>
  - USDC (Circle): <https://www.circle.com/legal/responsible-disclosure>
- **Test mocks** in `contracts/mocks/`
- **Frontend / backend** integrations (separate repos / projects)
- **Off-chain infrastructure** (indexers, IPFS pinning, RPC providers)
- **Issues already documented** in `MIGRATION_GUIDE.md` (known limitations
  by design)

---

## Threat model - known limitations by design

The following are **documented design choices**, not vulnerabilities:

1. **Token assumptions** - Bopster supports vanilla ERC20s (specifically
   USDC). Fee-on-transfer, rebasing, and ERC777-style tokens are NOT
   supported. Using an unsupported token corrupts pool accounting; this
   is the deployer's responsibility, not a contract bug.

2. **Tokens sent directly to a market** (not via `positionYes` /
   `positionNo`) are NOT credited to any pool. They can only be
   recovered via `sweepDust()` after 365 days, sent to the immutable
   treasury. See `BopsterMarket.sol` NatSpec.

3. **Unclaimed user funds** after `SWEEP_DUST_DELAY` (365 days) are
   forfeited to the treasury via `sweepDust()`. Users have a full year
   to claim.

4. **Resolver reward race** - the `resolverRewardBps` payout goes to
   `msg.sender` of the first successful `finalize()`. MEV bots may
   front-run user transactions. This is intentional permissionless
   incentive design.

5. **Reality.eth template trust** - Bopster reads `bytes32` final
   answers and matches `1 = YES`, `0 = NO`, anything else = refund. If
   a market is created with a Reality question whose template encodes
   answers differently, the market will systematically misresolve. This
   is a question-creation concern, not a contract concern.

6. **No upgradability** - once deployed, contracts cannot be upgraded.
   The admin can only `pause()` new market creation; existing markets
   are independent. A discovered bug post-deploy requires a fresh
   factory deployment.

---

## Enabling private vulnerability reporting (maintainer setup)

For this policy to actually work, **private vulnerability reporting
must be enabled** on the GitHub repository. One-time setup:

1. Go to the repo on GitHub -> **Settings**.
2. In the left sidebar: **Code security and analysis**.
3. Under **Private vulnerability reporting**, click **Enable**.

After enabling, the **"Report a vulnerability"** button appears in the
repo's **Security** tab for everyone. No email infrastructure needed.

---

## Bug bounty

A formal bug bounty program will be announced **post-audit**. Pre-audit
reports are still welcome and will be acknowledged; bounty terms may be
applied retroactively at our discretion based on severity.

---

## Hall of fame

Researchers who have contributed valid reports will be listed here, with
their permission, after their advisories are public.

(empty - no reports yet)
