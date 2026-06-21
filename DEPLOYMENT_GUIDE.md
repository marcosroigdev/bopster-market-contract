# Bopster - Production Deployment Guide (Base Mainnet)

End-to-end procedure for deploying `BopsterFactory` to **Base mainnet**.
Every value you need to put into `.env.production`, every config file
change, every command, and the wallet/private key setup is spelled out
inline - no "TODO", no "see X for details".

The same procedure works for other chains by swapping the chain-specific
constants (table in section 4.7). Base is treated as the primary target.

Pre-requisite reading:
- `MULTISIG_GUIDE.md` - your admin Safe must already exist before step 7
- `CONTRACTS_USAGE_GUIDE.md` - for the post-deploy smoke test

---

## Table of contents

1. Overview - what gets deployed
2. Required accounts and roles
3. Tools you need installed
4. Target chain: Base mainnet
5. Local repo setup
6. Wallet & private key configuration (3 paths)
7. `.env.production` - every variable explained
8. `hardhat.config.js` - Base network entry
9. The deploy script
10. Deployment procedure (commands + expected output)
11. Verification on Basescan
12. Live smoke test
13. Hand over admin to the multisig
14. Post-deployment monitoring
15. Troubleshooting
16. Best practices
17. Appendix - quick command reference
18. Appendix - deployment record template

---

## 1. Overview - what gets deployed

You deploy exactly **one contract** in this procedure:
- `BopsterFactory` - owns the registry, holds the global config, deploys
  market instances.

External dependencies are **not** deployed by you - they already exist on Base:
- **USDC** (canonical, Circle-native): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Reality.eth ERC20 v3** - verify the address before deploy (section 4.4)

Individual `BopsterMarket` instances are NOT deployed at launch. Anyone can
create a market by calling `factory.createMarket(...)` once the factory is
live (and not paused).

---

## 2. Required accounts and roles

Three distinct on-chain addresses. **None of them should be the same.**

| Role | Type | Used for | Sensitivity |
|------|------|----------|-------------|
| Deployer | EOA (Ledger or burner) | Signing the factory deploy tx; pays gas | Throwaway - burn after deploy |
| Treasury | Address (multisig or cold wallet) | Receives protocol fees forever - **immutable** | High - never rotate |
| Admin | **Multisig (Safe)** | Owns the factory; can pause/unpause; can transfer to a new admin | High - rotatable via Ownable2Step |

The deployer EOA only matters for ~30 minutes (the deploy itself). The
treasury is on chain forever and cannot be changed. The admin is operational
and rotatable.

Practical recommendation:
- **Deployer**: Path A (Ledger) below. If you must use a burner, generate a
  fresh EOA just for this deploy and burn it after (Path B).
- **Treasury**: a separate Safe (or a cold wallet you control), NOT the
  admin Safe.
- **Admin**: a 3-of-5 Safe - see `MULTISIG_GUIDE.md`.

---

## 3. Tools you need installed

```bash
# Versions known-good with this repo:
node --version       # v20.x  (anything >= 18 LTS is fine)
npm --version        # v10.x  (>= 9 fine)
git --version        # any modern version
```

**Foundry** (for `cast` - used to read state and decode tx data):
```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
cast --version       # should report a version
```

**Ledger Live** (only if using Path A in section 6):
- Install from https://www.ledger.com/ledger-live
- Update the firmware and the Ethereum app to the latest version

---

## 4. Target chain: Base mainnet

### 4.1 Identity

| Field | Value |
|---|---|
| Chain name | Base |
| Chain ID | `8453` |
| Native token | ETH |
| Block explorer | https://basescan.org |
| Faucet (testnet only) | https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet (for Base Sepolia, chain id 84532) |

### 4.2 RPC endpoint

**Do NOT use the public RPC `https://mainnet.base.org` for the deploy** - it
is rate-limited and unreliable for tx broadcast. Use a paid provider with
SLA. Recommended:

| Provider | URL template | Free tier sufficient for deploy? |
|---|---|---|
| Alchemy | `https://base-mainnet.g.alchemy.com/v2/<KEY>` | Yes (free tier OK) |
| Infura | `https://base-mainnet.infura.io/v3/<KEY>` | Yes |
| QuickNode | per-account URL | Yes (free tier) |
| Ankr | `https://rpc.ankr.com/base/<KEY>` | Yes |

Sign up, create a project, copy the URL. Have a **second** provider's URL
ready as a fallback in case the primary rate-limits during deploy.

### 4.3 USDC on Base

```
Token name:    USD Coin
Address:       0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
Decimals:      6
Source:        https://www.circle.com/en/multi-chain-usdc
Basescan:      https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

There is also **USDbC** (`0xd9aA...`) - the bridged version. Do NOT use it.
Use the canonical native USDC above.

### 4.4 Reality.eth on Base

The Reality.eth contracts are deployed per-chain by the realityeth project.
Always verify the address yourself before deploy - addresses can change
across releases and have multiple variants (ETH, ERC20, different token
versions).

**Lookup procedure:**

1. Open: https://github.com/RealityETH/reality-eth-monorepo/tree/main/packages/contracts/chains/deployments
2. Open the folder for chain ID `8453` (Base mainnet). If it does not
   exist, Reality.eth may not be deployed to Base - STOP and consult the
   project before proceeding.
3. Find the contract named `RealityETH_ERC20_v3_2` (or the closest
   variant matching USDC). The JSON file contains the deployed address
   and the token address (must match the USDC above).
4. Confirm the contract is real by opening its address on Basescan and
   verifying the bytecode is the same as the verified source in the
   monorepo.

Save the address - you'll paste it into `.env.production` as
`REALITY_ADDRESS`.

If Reality.eth ERC20 v3 is NOT deployed on Base, you have two options:
- Deploy it yourself (consult realityeth docs - out of scope here).
- Defer Bopster to a chain where it already exists (Polygon, Gnosis,
  Ethereum mainnet).

### 4.5 Gas estimate

Deploying `BopsterFactory` on Base costs approximately:
- Gas: ~3.0M units
- Base gas price (typical): ~0.001 gwei
- Total cost: ~0.000003 ETH (a few cents)

Verification + ownership tx adds maybe 50k-100k gas. Fund the deployer
with **0.01 ETH** to have generous margin.

### 4.6 Block explorer API key

Required for source verification.

1. Go to https://basescan.org/myapikey
2. Register, get a free API key
3. Save it - goes into `.env.production` as `BASESCAN_API_KEY`

### 4.7 Other chains - reference table

If you ever deploy to a chain other than Base, swap these in:

| Chain | Chain ID | RPC pattern | Native USDC | Reality.eth lookup |
|---|---|---|---|---|
| Ethereum | 1 | `https://eth-mainnet.g.alchemy.com/v2/<KEY>` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | monorepo chain `1` |
| Polygon | 137 | `https://polygon-mainnet.g.alchemy.com/v2/<KEY>` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | monorepo chain `137` |
| Arbitrum One | 42161 | `https://arb-mainnet.g.alchemy.com/v2/<KEY>` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | monorepo chain `42161` |
| Optimism | 10 | `https://opt-mainnet.g.alchemy.com/v2/<KEY>` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | monorepo chain `10` |
| Base | 8453 | `https://base-mainnet.g.alchemy.com/v2/<KEY>` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | monorepo chain `8453` |
| Gnosis | 100 | `https://rpc.gnosischain.com` | bridged USDC.e - verify | monorepo chain `100` |

Always verify against Circle (USDC) and the Reality.eth monorepo at deploy
time - addresses do change.

---

## 5. Local repo setup

### 5.1 Clone and check out the deploy commit

```bash
git clone <your-repo-url> bopster-market-contract
cd bopster-market-contract

# Check out the exact commit/tag you intend to deploy.
git checkout <your-release-tag>          # e.g. v1.0.0
git rev-parse HEAD                       # record this - goes in deployment record
git status                               # MUST be clean
```

### 5.2 Install dependencies from the lockfile

**Always use `npm ci` for production deploys**, not `npm install`. `ci`
respects `package-lock.json` exactly, ensuring reproducible bytecode.

```bash
rm -rf node_modules artifacts cache
npm ci
```

Verify Hardhat picks up the lockfile (no warnings about missing peer deps).

### 5.3 Install missing deploy-time plugins

The repo's `package.json` has the contract-side deps. For deploy, add:

```bash
npm install --save-dev @nomicfoundation/hardhat-verify dotenv
```

(`@nomicfoundation/hardhat-toolbox` already brings these transitively in
recent versions; the explicit install is harmless.)

If using Ledger (Path A in section 6), also install:

```bash
npm install --save-dev @nomicfoundation/hardhat-ledger
```

### 5.4 Compile and test

```bash
npx hardhat clean
npx hardhat compile
npx hardhat test                         # all 225 tests should pass
```

If anything fails - STOP. Do not deploy from a repo that doesn't build
cleanly.

### 5.5 Record the build fingerprint

```bash
shasum -a 256 artifacts/contracts/BopsterFactory.sol/BopsterFactory.json
shasum -a 256 artifacts/contracts/BopsterMarket.sol/BopsterMarket.json
```

Save these hashes - they go in your deployment record. Any teammate
should be able to clone, `npm ci`, `npx hardhat compile`, and reproduce
the same hashes.

---

## 6. Wallet & private key configuration

Pick ONE path. Path A is strongly preferred for production.

### 6.1 Path A - Ledger hardware wallet (RECOMMENDED)

Private key never leaves the device. You'll be physically prompted to
approve the deploy tx on the Ledger screen.

#### Step 1: Set up the device

1. Unbox your Ledger from the official Ledger Live store. Don't buy from
   Amazon/eBay/random resellers.
2. Initialize it: generate a fresh 24-word seed, write it on paper
   (never type it digitally), confirm.
3. Set a PIN you can remember.
4. Open **Ledger Live** -> install the **Ethereum** app on the device.
5. On the device: **Ethereum app -> Settings -> Blind signing -> Enabled**.
   This is required to sign contract deployments (the tx data won't
   decode to a known ABI on a fresh device).

#### Step 2: Note the deployer address

In Ledger Live:
- Open the **Ethereum** account -> Receive
- Copy the address (looks like `0xAbCd...1234`)

This address is what you'll fund and what will appear in the deploy tx as
`from`.

#### Step 3: Install the Hardhat Ledger plugin

```bash
npm install --save-dev @nomicfoundation/hardhat-ledger
```

#### Step 4: Add to `hardhat.config.js`

At the top of the file (we'll write the full file in section 8):

```js
require("@nomicfoundation/hardhat-ledger");
```

And in the `networks.base` block, use `ledgerAccounts` (no private key):

```js
base: {
    url: process.env.RPC_URL,
    chainId: 8453,
    ledgerAccounts: [process.env.DEPLOYER_ADDRESS],
},
```

#### Step 5: Put the address in `.env.production`

```bash
# .env.production
DEPLOYER_ADDRESS=0x<your_ledger_eth_address>
# Do NOT set DEPLOYER_PRIVATE_KEY - leave it unset.
```

#### Step 6: Fund the Ledger address with ETH on Base

You need ~0.01 ETH. Send from any wallet you control on Base (a Coinbase
withdrawal works - Coinbase has native Base support).

#### Step 7: Test connectivity

With the Ledger connected, unlocked, and the Ethereum app open:

```bash
HARDHAT_NETWORK=base npx hardhat console
# In the console:
> const [s] = await ethers.getSigners()
> await s.getAddress()      // should prompt Ledger to confirm
# Approve on device; should return your address.
> exit
```

If this works, you're ready to deploy via Path A.

### 6.2 Path B - Burner EOA via raw private key

Use only if you don't have a hardware wallet. Generate a fresh EOA
dedicated solely to this deploy. **Never reuse** an existing MetaMask
account.

#### Step 1: Generate a fresh keypair

Using Foundry's `cast`:

```bash
cast wallet new
```

Output:
```
Successfully created new keypair.
Address:     0xAbCd...1234
Private key: 0x<64 hex chars>
```

Copy the private key carefully **once** - into `.env.production` - and
nowhere else. Don't paste it into Slack, email, or any AI chat (including
this one). Don't take a screenshot.

Alternative if you don't have Foundry:

```bash
# OpenSSL-based generation (Linux/macOS)
PRIV=0x$(openssl rand -hex 32)
echo "Private key: $PRIV"
# Then derive the address (requires Foundry):
cast wallet address --private-key $PRIV
```

#### Step 2: Save with restrictive permissions

```bash
cd bopster-market-contract
touch .env.production
chmod 600 .env.production
ls -la .env.production
# Expected: -rw-------  1 you  staff  ...  .env.production
```

Write the key into `.env.production`:

```bash
# .env.production
DEPLOYER_PRIVATE_KEY=0x<the 64 hex chars from cast>
# Do NOT set DEPLOYER_ADDRESS - leave unset for this path.
```

#### Step 3: Verify the file is git-ignored

```bash
git status
# .env.production MUST NOT appear in the output.

grep -E "(^|/)\.env" .gitignore
# Should show at least .env or .env*
```

If `.env.production` is not gitignored:

```bash
cat >> .gitignore <<'EOF'

# Local secrets - never commit
.env
.env.*
!.env.example
EOF

git status                  # confirm clean
```

#### Step 4: Recover the address

```bash
cast wallet address --private-key $(grep DEPLOYER_PRIVATE_KEY .env.production | cut -d= -f2)
# Outputs the deployer EOA address.
```

#### Step 5: Fund the deployer with ETH on Base

Send ~0.01 ETH to the deployer address. Verify:

```bash
RPC=$(grep ^RPC_URL= .env.production | cut -d= -f2-)
ADDR=$(cast wallet address --private-key $(grep DEPLOYER_PRIVATE_KEY .env.production | cut -d= -f2))
cast balance $ADDR --rpc-url $RPC
# Should show 10000000000000000 (0.01 ETH in wei)
```

#### Step 6: After deploy - burn the key

Once the deploy is complete and confirmed:
1. Sweep any leftover ETH back to your main wallet:
   ```bash
   cast send <main_wallet_address> --value <amount_minus_gas> \
     --private-key <DEPLOYER_PRIVATE_KEY> --rpc-url $RPC
   ```
2. **Remove the `DEPLOYER_PRIVATE_KEY` line** from `.env.production`.
3. The address remains in the deploy record (which is fine - it's public
   on chain anyway). The private key has no further role.

### 6.3 Path C - Foundry `cast` with Ledger (advanced)

If you prefer not to wire Hardhat to Ledger, you can use Foundry's
`forge create` directly. Skip section 8 (hardhat.config update for
deploy network) if going this route - you'll deploy and verify in one
Foundry command. Detail in section 10.6 if you want this path.

---

## 7. `.env.production` - every variable explained

Now build the full file. Open `.env.production` (already created in
section 6.2 step 2) and paste this template, then fill in the values:

```bash
# -----------------------------------------------------------------
# Bopster - Base mainnet deploy config
# This file is gitignored. Never commit.
# -----------------------------------------------------------------

# --- Chain identity ------------------------------------------------
TARGET_CHAIN=base
CHAIN_ID=8453

# --- RPC -----------------------------------------------------------
# PRIMARY: paid provider URL (Alchemy/Infura/QuickNode)
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>

# FALLBACK: a second provider for redundancy
RPC_URL_FALLBACK=https://base-mainnet.infura.io/v3/<YOUR_INFURA_KEY>

# Optional: Base Sepolia (testnet) for fork-based dry-runs
RPC_URL_SEPOLIA=https://base-sepolia.g.alchemy.com/v2/<YOUR_ALCHEMY_KEY>

# --- Deployer signer -----------------------------------------------
# PATH A (Ledger): set DEPLOYER_ADDRESS, leave DEPLOYER_PRIVATE_KEY unset
DEPLOYER_ADDRESS=0x<your_ledger_address>

# PATH B (burner EOA): set DEPLOYER_PRIVATE_KEY, leave DEPLOYER_ADDRESS unset
# DEPLOYER_PRIVATE_KEY=0x<64 hex chars>

# --- BopsterFactory constructor args -------------------------------
# Canonical native USDC on Base - DO NOT use the bridged USDbC
TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# Reality.eth ERC20 v3 on Base - VERIFY in the realityeth monorepo
# (https://github.com/RealityETH/reality-eth-monorepo) before deploy
REALITY_ADDRESS=0x<verified_reality_address>

# Treasury - receives protocol fees. IMMUTABLE after deploy.
# Use a multisig or cold wallet, NOT the admin Safe and NOT the deployer.
TREASURY_ADDRESS=0x<your_treasury_address>

# Admin - becomes factory.owner() at deploy. Should be a multisig (Safe).
# See MULTISIG_GUIDE.md for setup.
ADMIN_ADDRESS=0x<your_admin_safe_address>

# --- Fee schedule (basis points; sum must be <= 1000) ---------------
# Example: 1.00% + 1.00% + 0.50% = 2.50% total cuts.
# Pick values that fit your business model - these are IMMUTABLE.
PROTOCOL_FEE_BPS=100
CREATOR_FEE_BPS=100
RESOLVER_REWARD_BPS=50

# --- Block explorer (Basescan) -------------------------------------
# https://basescan.org/myapikey
BASESCAN_API_KEY=<YOUR_BASESCAN_API_KEY>
```

### 7.1 What each variable does

| Variable | Where it comes from | Effect if wrong |
|----------|---------------------|------------------|
| `TARGET_CHAIN` | Label only, you choose | Confusing logs |
| `CHAIN_ID` | Spec (8453 for Base) | Hardhat may reject the network or broadcast wrong |
| `RPC_URL` | Your provider | Deploy hangs / fails / wrong chain |
| `RPC_URL_FALLBACK` | Your second provider | Used only if you swap manually |
| `RPC_URL_SEPOLIA` | Provider's testnet endpoint | Dry-run on testnet fails |
| `DEPLOYER_ADDRESS` (Path A) | Ledger Live | Hardhat asks the wrong Ledger account; deploy aborts |
| `DEPLOYER_PRIVATE_KEY` (Path B) | `cast wallet new` | If leaked -> deployer key compromised |
| `TOKEN_ADDRESS` | Circle (USDC) | Markets credit the wrong token - catastrophic |
| `REALITY_ADDRESS` | Reality.eth monorepo | Markets can never resolve |
| `TREASURY_ADDRESS` | Your treasury wallet | Fees go to the wrong place forever (immutable) |
| `ADMIN_ADDRESS` | Your Safe | Wrong party controls pause/unpause |
| `PROTOCOL_FEE_BPS` | You decide | Fee splits permanent - no setter |
| `CREATOR_FEE_BPS` | You decide | Same |
| `RESOLVER_REWARD_BPS` | You decide | Same; sum <= 1000 strictly |
| `BASESCAN_API_KEY` | basescan.org account | Verification fails (deploy still succeeds) |

### 7.2 Common mistakes to check before saving

- ✅ All addresses start with `0x` and are 42 chars total (`0x` + 40 hex)
- ✅ The sum `PROTOCOL_FEE_BPS + CREATOR_FEE_BPS + RESOLVER_REWARD_BPS <= 1000`
- ✅ `TREASURY_ADDRESS != ADMIN_ADDRESS != DEPLOYER_ADDRESS`
- ✅ `RPC_URL` is from a paid provider, not `https://mainnet.base.org`
- ✅ The Reality address was verified against the realityeth monorepo (not pasted from a tutorial blog)
- ✅ The USDC address is **native** (`0x833589...02913`), not bridged (`0xd9aA...`)
- ✅ `.env.production` does NOT appear in `git status`

---

## 8. `hardhat.config.js` - Base network entry

Overwrite the existing `hardhat.config.js` with:

```js
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("dotenv").config({ path: ".env.production" });

// Uncomment if using Path A (Ledger):
// require("@nomicfoundation/hardhat-ledger");

const {
    RPC_URL,
    RPC_URL_SEPOLIA,
    DEPLOYER_PRIVATE_KEY,
    DEPLOYER_ADDRESS,
    BASESCAN_API_KEY,
} = process.env;

const accountsConfig = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];
const ledgerAccountsConfig = DEPLOYER_ADDRESS ? [DEPLOYER_ADDRESS] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: {
        version: "0.8.26",
        settings: {
            // Pinned to "paris" to avoid PUSH0 (Shanghai+).
            // Base supports PUSH0; we keep paris for portability across forks.
            evmVersion: "paris",
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
        },
    },
    networks: {
        hardhat: {
            // Local test network - used by `npx hardhat test`
        },

        // Base mainnet
        base: {
            url: RPC_URL || "https://mainnet.base.org",
            chainId: 8453,
            accounts: accountsConfig,
            // For Path A, comment out `accounts` above and uncomment:
            // ledgerAccounts: ledgerAccountsConfig,
        },

        // Base Sepolia testnet - fork-based dry-runs and pre-deploy tests
        baseSepolia: {
            url: RPC_URL_SEPOLIA || "https://sepolia.base.org",
            chainId: 84532,
            accounts: accountsConfig,
            // ledgerAccounts: ledgerAccountsConfig,
        },
    },
    etherscan: {
        // hardhat-verify uses the "etherscan" config block for ALL explorers
        apiKey: {
            base: BASESCAN_API_KEY || "",
            baseSepolia: BASESCAN_API_KEY || "",
        },
        customChains: [
            {
                network: "base",
                chainId: 8453,
                urls: {
                    apiURL: "https://api.basescan.org/api",
                    browserURL: "https://basescan.org",
                },
            },
            {
                network: "baseSepolia",
                chainId: 84532,
                urls: {
                    apiURL: "https://api-sepolia.basescan.org/api",
                    browserURL: "https://sepolia.basescan.org",
                },
            },
        ],
    },
};
```

### 8.1 If you're using Path A (Ledger)

Uncomment these two lines and comment out the `accounts:` lines:

```js
require("@nomicfoundation/hardhat-ledger");
// ...
networks: {
    base: {
        url: RPC_URL,
        chainId: 8453,
        // accounts: accountsConfig, <- comment this out
        ledgerAccounts: ledgerAccountsConfig,  // <- use this
    },
}
```

### 8.2 Quick smoke test of the config

Run a no-op call to confirm Hardhat sees Base:

```bash
HARDHAT_NETWORK=base npx hardhat console --no-compile
# Inside the console:
> const block = await ethers.provider.getBlockNumber()
> console.log("Base block:", block)
> .exit
```

You should see a recent block number (well into the millions). If you
see `0` or an error, the RPC URL is wrong.

---

## 9. The deploy script

Create the script directory and the deploy file:

```bash
mkdir -p scripts
```

Write `scripts/deploy.js`:

```js
require("dotenv").config({ path: ".env.production" });
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    const net = hre.network;
    const [deployer] = await hre.ethers.getSigners();
    const balance = await hre.ethers.provider.getBalance(deployer.address);

    console.log("=".repeat(70));
    console.log("Bopster - BopsterFactory deploy");
    console.log("=".repeat(70));
    console.log("Network:    ", net.name, "(chainId", net.config.chainId + ")");
    console.log("Deployer:   ", deployer.address);
    console.log("Balance:    ", hre.ethers.formatEther(balance), "ETH");

    const args = [
        process.env.TOKEN_ADDRESS,
        process.env.REALITY_ADDRESS,
        process.env.TREASURY_ADDRESS,
        process.env.ADMIN_ADDRESS,
        Number(process.env.PROTOCOL_FEE_BPS),
        Number(process.env.CREATOR_FEE_BPS),
        Number(process.env.RESOLVER_REWARD_BPS),
    ];

    // Defensive arg validation - mirrors the constructor checks.
    const addrNames = ["TOKEN_ADDRESS","REALITY_ADDRESS","TREASURY_ADDRESS","ADMIN_ADDRESS"];
    for (let i = 0; i < 4; i++) {
        if (!args[i] || !/^0x[a-fA-F0-9]{40}$/.test(args[i])) {
            throw new Error(`${addrNames[i]} is missing or malformed`);
        }
        if (args[i].toLowerCase() === hre.ethers.ZeroAddress) {
            throw new Error(`${addrNames[i]} is the zero address`);
        }
    }
    const totalBps = args[4] + args[5] + args[6];
    if (totalBps > 1000) throw new Error(`Total fee bps ${totalBps} > 1000`);

    console.log("\nConstructor args:");
    console.log("  token (USDC)      :", args[0]);
    console.log("  reality           :", args[1]);
    console.log("  treasury          :", args[2]);
    console.log("  admin (Safe)      :", args[3]);
    console.log("  protocolFeeBps    :", args[4]);
    console.log("  creatorFeeBps     :", args[5]);
    console.log("  resolverRewardBps :", args[6]);
    console.log("  TOTAL bps         :", totalBps,
                "(", (totalBps / 100).toFixed(2), "%)");
    console.log("=".repeat(70));

    if (process.env.SKIP_CONFIRM !== "1") {
        console.log("\n⚠  About to deploy. Press Ctrl+C to abort. Continuing in 10s...");
        await new Promise(r => setTimeout(r, 10000));
    }

    const Factory = await hre.ethers.getContractFactory("BopsterFactory");
    const factory = await Factory.deploy(...args);
    console.log("\nDeploy tx broadcast. Waiting for confirmation...");
    await factory.waitForDeployment();
    const address = await factory.getAddress();
    const deployTx = factory.deploymentTransaction();
    const receipt = await deployTx.wait();

    console.log("\n✓ BopsterFactory deployed");
    console.log("  address  :", address);
    console.log("  tx hash  :", deployTx.hash);
    console.log("  block    :", receipt.blockNumber);
    console.log("  gas used :", receipt.gasUsed.toString());

    // Write a deployment record
    const record = {
        chain: net.name,
        chainId: net.config.chainId,
        deployedAt: new Date().toISOString(),
        deployedBy: deployer.address,
        commit: require("child_process").execSync("git rev-parse HEAD").toString().trim(),
        compiler: {
            version: hre.config.solidity.compilers[0].version,
            evmVersion: hre.config.solidity.compilers[0].settings.evmVersion,
            optimizer: hre.config.solidity.compilers[0].settings.optimizer,
            viaIR: hre.config.solidity.compilers[0].settings.viaIR,
        },
        addresses: {
            BopsterFactory: address,
            token: args[0],
            reality: args[1],
            treasury: args[2],
            admin: args[3],
        },
        constructorArgs: args,
        deployTxHash: deployTx.hash,
        deployBlock: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
    };
    const outDir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${net.name}-${Date.now()}.json`);
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    console.log("  record   :", outFile);

    // Print the verify command for the next step
    const argsString = args
        .map(a => typeof a === "string" ? `"${a}"` : a)
        .join(" ");
    console.log("\nTo verify on Basescan:");
    console.log(`  npx hardhat verify --network ${net.name} ${address} ${argsString}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

### 9.1 What the script does

1. Loads `.env.production` (paths assume you run from repo root)
2. Resolves the deployer signer (Hardhat handles Ledger vs raw key transparently)
3. Validates constructor args (matches the contract's own checks)
4. Prints a 10-second countdown so you can Ctrl+C if anything looks wrong
5. Deploys, waits for confirmation, prints tx details
6. Writes a JSON deployment record to `deployments/<network>-<timestamp>.json`
7. Prints the exact `verify` command you'll run in section 11

---

## 10. Deployment procedure

### 10.1 Dry-run on Base Sepolia first

**Always test on Sepolia before mainnet.** Same procedure, free coins,
catches 95% of mistakes.

1. Get test ETH on Base Sepolia from the Coinbase faucet:
   https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
2. Set `RPC_URL_SEPOLIA` in `.env.production` (an Alchemy testnet
   endpoint).
3. Update `TOKEN_ADDRESS` and `REALITY_ADDRESS` to the Base Sepolia
   variants if you want a real e2e test. For a basic deploy test, you
   can use the mainnet addresses (they exist on testnet too in some
   cases; otherwise, deploy mocks).
4. Run:

```bash
HARDHAT_NETWORK=baseSepolia SKIP_CONFIRM=1 npx hardhat run scripts/deploy.js
```

Verify the address shows up on https://sepolia.basescan.org and that
constructor args decode correctly.

### 10.2 Lock the build (one final time)

```bash
cd bopster-market-contract
git status                                # clean
git rev-parse HEAD                        # record
rm -rf node_modules artifacts cache
npm ci
npx hardhat clean
npx hardhat compile
shasum -a 256 artifacts/contracts/BopsterFactory.sol/BopsterFactory.json
shasum -a 256 artifacts/contracts/BopsterMarket.sol/BopsterMarket.json
```

Save the hashes.

### 10.3 Dry-run on a mainnet fork (final pre-flight)

This catches RPC, gas, and constructor issues using mainnet state without
spending real money.

Terminal A (forked node):
```bash
npx hardhat node --fork $(grep ^RPC_URL= .env.production | cut -d= -f2-)
```

Terminal B (deploy against the fork):
```bash
HARDHAT_NETWORK=localhost SKIP_CONFIRM=1 npx hardhat run scripts/deploy.js
```

Confirm the output:
- Deployer balance dropped by the expected gas
- Factory address printed (random for the fork, but a valid contract)
- All constructor args printed match `.env.production`

If anything is off - STOP. Fix the env or code; do NOT mainnet-deploy a
"fixed" version on a hunch.

### 10.4 Deploy to Base mainnet

For Path B (burner EOA), this is just one command:

```bash
HARDHAT_NETWORK=base npx hardhat run scripts/deploy.js
```

For Path A (Ledger):
1. Connect Ledger via USB
2. Unlock with PIN
3. Open the **Ethereum** app on the device
4. Ensure **Blind signing** is enabled in app settings
5. Run the same command
6. The device will prompt you to **review and approve** the deploy tx -
   verify the chain and "Contract creation" appears, then approve

Expected output (Base mainnet, ~3M gas):

```
======================================================================
Bopster - BopsterFactory deploy
======================================================================
Network:     base (chainId 8453)
Deployer:    0xAbCd...1234
Balance:     0.01 ETH

Constructor args:
  token (USDC)      : 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  reality           : 0x...
  treasury          : 0x...
  admin (Safe)      : 0x...
  protocolFeeBps    : 100
  creatorFeeBps     : 100
  resolverRewardBps : 50
  TOTAL bps         : 250 ( 2.50 %)
======================================================================

⚠  About to deploy. Press Ctrl+C to abort. Continuing in 10s...

Deploy tx broadcast. Waiting for confirmation...

✓ BopsterFactory deployed
  address  : 0xFaCt...0001
  tx hash  : 0x...
  block    : 12345678
  gas used : 3041234
  record   : deployments/base-1718000000000.json

To verify on Basescan:
  npx hardhat verify --network base 0xFaCt...0001 "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" "0x..." "0x..." "0x..." 100 100 50
```

Copy and save:
- The factory address (`0xFaCt...0001`)
- The tx hash
- The verify command

### 10.5 Confirm on chain

```bash
RPC=$(grep ^RPC_URL= .env.production | cut -d= -f2-)
FACTORY=0x<deployed_factory_address>

cast call $FACTORY "owner()(address)" --rpc-url $RPC
# Should return ADMIN_ADDRESS

cast call $FACTORY "treasury()(address)" --rpc-url $RPC
# Should return TREASURY_ADDRESS

cast call $FACTORY "token()(address)" --rpc-url $RPC
# Should return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

cast call $FACTORY "protocolFeeBps()(uint16)" --rpc-url $RPC
cast call $FACTORY "creatorFeeBps()(uint16)" --rpc-url $RPC
cast call $FACTORY "resolverRewardBps()(uint16)" --rpc-url $RPC

cast call $FACTORY "paused()(bool)" --rpc-url $RPC
# Should return false

cast call $FACTORY "marketsCount()(uint256)" --rpc-url $RPC
# Should return 0
```

If any value mismatches, STOP. Investigate before any further action.

### 10.6 Alternative: Path C (Foundry one-shot)

If you didn't update `hardhat.config.js` for deployment and want to use
Foundry directly with Ledger:

```bash
source .env.production
forge create contracts/BopsterFactory.sol:BopsterFactory \
  --rpc-url $RPC_URL \
  --ledger \
  --constructor-args \
    $TOKEN_ADDRESS $REALITY_ADDRESS $TREASURY_ADDRESS $ADMIN_ADDRESS \
    $PROTOCOL_FEE_BPS $CREATOR_FEE_BPS $RESOLVER_REWARD_BPS \
  --verify --etherscan-api-key $BASESCAN_API_KEY
```

This deploys AND verifies in one command. The Ledger prompts to sign.

---

## 11. Verification on Basescan

If your deploy script printed a `verify` command (it should have), run
it. Otherwise, construct it manually:

```bash
npx hardhat verify --network base <FACTORY_ADDRESS> \
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" \
  "<REALITY_ADDRESS>" \
  "<TREASURY_ADDRESS>" \
  "<ADMIN_ADDRESS>" \
  100 100 50
```

Expected:
```
Successfully submitted source code for contract
contracts/BopsterFactory.sol:BopsterFactory at <FACTORY_ADDRESS>
for verification on the block explorer. Waiting for verification result...

Successfully verified contract BopsterFactory on the block explorer.
https://basescan.org/address/<FACTORY_ADDRESS>#code
```

Open the link. Confirm:
- Source code is visible and matches `contracts/BopsterFactory.sol`
- Constructor args decode to the expected addresses + bps
- Compiler version is `0.8.26`, optimizer enabled, runs 200
- "viaIR" is set
- `BopsterMarket.sol` is also visible as an imported file

If verification fails, see section 15.4.

---

## 12. Live smoke test

End-to-end test on Base mainnet with a small position. This proves the
factory deploys functional markets.

You need:
- A separate test EOA (NOT the deployer, NOT the admin)
- ~5 USDC on Base in that EOA
- A Reality question created off-chain (your backend can do this; for a
  one-off test, use the Reality.eth UI to create one manually:
  https://reality.eth.limo)

Steps:

1. Note the Reality `questionId` from your question creation tx
2. Create a market:
   ```bash
   FACTORY=0x<deployed>
   QID=0x<your_question_id>
   END=$(($(date +%s) + 86400))           # 24h from now
   RESOLVE=$(($END + 21600))              # +6h after end

   cast send $FACTORY \
     "createMarket(bytes32,string,uint64,uint64)" \
     $QID "ipfs://smoke-test" $END $RESOLVE \
     --rpc-url $RPC --private-key <TEST_EOA_KEY>
   ```
3. Get the market address from the tx logs (the first indexed topic of
   `MarketCreated` is the market address, or use the deployment record):
   ```bash
   MARKET=$(cast call $FACTORY "allMarkets(uint256)(address)" 0 --rpc-url $RPC)
   ```
4. Approve USDC + position:
   ```bash
   USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
   cast send $USDC "approve(address,uint256)" $MARKET 1000000 \
     --rpc-url $RPC --private-key <TEST_EOA_KEY>
   cast send $MARKET "positionYes(uint256)" 1000000 \
     --rpc-url $RPC --private-key <TEST_EOA_KEY>
   ```
5. Check state:
   ```bash
   cast call $MARKET "totalYes()(uint256)" --rpc-url $RPC
   # 1000000  (= 1 USDC)
   ```

You can leave the market running through its full lifecycle to validate
finalize() + claim() end-to-end, or you can stop here. Document what
worked.

---

## 13. Hand over admin to the multisig

If you deployed with `_admin = <SAFE_ADDRESS>`, the multisig is **already**
the owner - the constructor uses `Ownable(_admin)` which sets owner
directly. No acceptance step needed at deploy time.

Verify:
```bash
cast call $FACTORY "owner()(address)" --rpc-url $RPC
# Should match ADMIN_ADDRESS exactly

cast call $FACTORY "pendingOwner()(address)" --rpc-url $RPC
# Should return 0x0000000000000000000000000000000000000000
```

### 13.1 Recovery: if you accidentally deployed with the deployer EOA as admin

This can happen if you typed the wrong `ADMIN_ADDRESS`. Recover:

1. From the deployer EOA, transfer ownership to the Safe:
   ```bash
   cast send $FACTORY "transferOwnership(address)" $SAFE_ADDRESS \
     --rpc-url $RPC --private-key $DEPLOYER_PRIVATE_KEY
   ```
2. From inside the Safe (see `MULTISIG_GUIDE.md` section 6), build and
   execute a tx calling `factory.acceptOwnership()`:
   - Target: `<FACTORY>`
   - Selector: `0x79ba5097`
   - 3 signers sign, one executes
3. Verify:
   ```bash
   cast call $FACTORY "owner()(address)" --rpc-url $RPC
   # = SAFE_ADDRESS
   cast call $FACTORY "pendingOwner()(address)" --rpc-url $RPC
   # = 0x0
   ```

### 13.2 Test pause from the Safe

Do this BEFORE going live - see `MULTISIG_GUIDE.md` section 6.2. Pause,
verify, unpause, verify. Confirms your multisig is correctly wired.

---

## 14. Post-deployment monitoring

### 14.1 Document the addresses

Commit (in a separate, clean commit) the `deployments/base-<timestamp>.json`
file the script wrote. This is your source of truth for the deployed
addresses. Anyone joining the team should be able to find it.

```bash
git checkout -b deploy/base-mainnet-v1
git add deployments/
git commit -m "deploy: base mainnet v1.0.0 factory at 0x..."
git push origin deploy/base-mainnet-v1
```

Tag the deploy:
```bash
git tag -a v1.0.0-base -m "Base mainnet deploy"
git push --tags
```

### 14.2 Update frontend / backend envs

Wherever your application reads `FACTORY_ADDRESS`, set it to the new
value. Same for the indexer config (subgraph, Ponder, etc.).

### 14.3 Set up event monitoring

Subscribe to these factory events as critical alerts:
- `Paused(address)` - anyone called pause()
- `Unpaused(address)` - anyone called unpause()
- `OwnershipTransferStarted(...)` - someone initiated ownership transfer
- `OwnershipTransferred(...)` - ownership actually changed

And these as informational:
- `MarketCreated(...)` - index each new market

Per-market events (informational):
- `Resolved`, `Claimed`, `EmergencyRefundEnabled`, `DustSwept`

Tooling: Tenderly, OpenZeppelin Defender, Forta, or a homebuilt poller.

### 14.4 Treasury balance

Daily cron checking that USDC accumulates correctly:
```bash
cast call $USDC "balanceOf(address)(uint256)" $TREASURY_ADDRESS --rpc-url $RPC
```

---

## 15. Troubleshooting

### 15.1 `.env` and config

**"Cannot find module 'dotenv'"** - `npm install --save-dev dotenv`.

**`.env.production` values not loaded** - `dotenv.config()` defaults to
`.env`. The deploy script calls it with `path: ".env.production"`. If you
copy code elsewhere, pass the path explicitly.

**`process.env.RPC_URL` is undefined** - `.env.production` is in the
wrong location, or the dotenv call is missing. Confirm with:
```bash
node -e "require('dotenv').config({path:'.env.production'}); console.log(process.env.RPC_URL)"
```

### 15.2 Compile / build issues

**`Error HH600: Compilation failed`** - Wipe and rebuild:
```bash
rm -rf node_modules artifacts cache && npm ci && npx hardhat clean && npx hardhat compile
```

**`Error: invalid evmVersion "paris"`** - Compiler is too old. Confirm
`hardhat.config.js` uses `0.8.26`.

### 15.3 Wallet / signing

**Hardhat says "no signer for network"** (Path A or B) - `accounts:` or
`ledgerAccounts:` is empty. Re-check `.env.production` values; for Path A,
make sure `DEPLOYER_ADDRESS` is set and `hardhat-ledger` is `require`d.

**Ledger doesn't prompt** - Make sure the Ethereum app is OPEN on the
device. Lock screen, Bitcoin app, or "Apps" menu won't trigger prompts.

**Ledger prompt is "Tx data" with unrecognized values** - Enable Blind
signing in Ethereum app settings on the device. Without it, contract
creation txs can't be signed.

**"This transaction has already been mined" / nonce errors** - The
deployer EOA has pending txs. Wait for them to confirm or replace them.
For burner EOAs this is rare; only happens if you killed a previous run.

**Cast wallet new doesn't exist** - Install Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.

### 15.4 Verification fails

**"Compiled bytecode does not match deployed bytecode"**

Most common causes (in order):

1. `viaIR` mismatch. Confirm `hardhat.config.js` has `viaIR: true`.
2. Compiler version mismatch. Hardhat may have downloaded the wrong patch.
   Force re-download:
   ```bash
   rm -rf ~/.cache/hardhat-nodejs/compilers
   npx hardhat clean
   npx hardhat compile
   ```
3. `optimizer.runs` differs from when you deployed (must be `200`).
4. `evmVersion` differs (must be `paris`).
5. Constructor args don't match. Run:
   ```bash
   cast abi-encode "constructor(address,address,address,address,uint16,uint16,uint16)" \
     <token> <reality> <treasury> <admin> 100 100 50
   ```
   Compare against the constructor calldata on Basescan (top of the
   "Code" tab -> "Constructor Arguments"). Mismatch means you typed
   the wrong arg into `npx hardhat verify`.

**Rate-limited by Basescan** - Wait 5-10 minutes; try again. If repeated,
use a different API key.

**"Unable to locate ContractCode"** - The deploy hasn't been indexed by
Basescan yet. Wait 30s and retry.

### 15.5 Constructor reverts

**`BadAddress()`** - One of token / reality / treasury / admin is zero.
Re-check `.env.production` values.

**`BadFees()`** - `PROTOCOL + CREATOR + RESOLVER > 1000`. Add them up
manually.

**`OwnableInvalidOwner(0x0)`** - Same as BadAddress for the admin arg.

### 15.6 Smoke test issues

**`createMarket` reverts with `EndTimeTooSoon`** - `endTime` is < 15 min
in the future. Bump it.

**`createMarket` reverts with `BadTimes`** - Confirm `endTime < resolveTime`
and both are non-zero.

**`positionYes` reverts with `SafeERC20FailedOperation`** - USDC
allowance or balance is insufficient. Check both.

**`finalize` reverts with `RealityNotFinalized`** - Reality hasn't
finalized the answer yet. The bond timeout for your question hasn't
elapsed. Wait. Confirm question status on https://reality.eth.limo.

### 15.7 Multisig hand-over

**`acceptOwnership` reverts with `OwnableUnauthorizedAccount`** - The
caller isn't the `pendingOwner`. Re-check `pendingOwner()` on chain and
verify your Safe address.

**Safe tx execution fails** - See `MULTISIG_GUIDE.md` sections 12 and 15.

---

## 16. Best practices

### 16.1 Deployment hygiene

- **Hardware wallet > raw private key.** Always Path A when possible.
- **Fresh deployer EOA per chain.** Never reuse across Base + Polygon +
  Arbitrum etc.
- **Lock the lockfile.** `npm ci` not `npm install`.
- **Record the build fingerprint** (shasum) before broadcasting.
- **Run on testnet first.** Base Sepolia is free.
- **Run on a mainnet fork** as final pre-flight.
- **Test the verification command** on Sepolia before mainnet - catches
  config issues that hide in dry-runs.

### 16.2 Risk reduction

- **Don't deploy on a Friday.** If something breaks, you're on call all
  weekend.
- **Cap the first markets via the UI.** Even though the contract has no
  position cap, enforce one frontend-side during the soft launch.
- **Have an unpause runbook ready** before going live. See
  `MULTISIG_GUIDE.md` section 13.
- **Stagger chains.** Deploy to Base first, run 2 weeks, then add others.

### 16.3 Things NOT to do

- **Don't deploy from inside the multisig** (Safe -> CREATE). Add
  unnecessary complexity. Use a plain EOA, hand over later.
- **Don't change fees by re-deploying without announcing.** Frontends and
  users approve USDC to a specific factory; switching breaks their
  workflow.
- **Don't promise the resolver reward to a specific user** - it's
  permissionless and races to the first finalize().
- **Don't echo `DEPLOYER_PRIVATE_KEY` in shell history** -
  `set +o history` before working with it, or `unset HISTFILE`.

### 16.4 After every deploy

- Tag the git commit
- Commit the deployment record JSON
- Update frontend / backend / indexer env
- Announce the address in your team channel
- Confirm the announced address matches the explorer

---

## 17. Appendix - quick command reference

```bash
# -- Build --
npm ci
npx hardhat clean
npx hardhat compile
npx hardhat test

# -- Generate burner EOA (Path B) --
cast wallet new

# -- Get an address from a private key --
cast wallet address --private-key 0x<hex>

# -- Get balance on Base --
cast balance <ADDR> --rpc-url https://base-mainnet.g.alchemy.com/v2/<KEY>

# -- Fork-dry-run (Terminal A) --
npx hardhat node --fork $RPC_URL

# -- Fork-dry-run (Terminal B) --
HARDHAT_NETWORK=localhost SKIP_CONFIRM=1 npx hardhat run scripts/deploy.js

# -- Deploy to Base Sepolia (testnet) --
HARDHAT_NETWORK=baseSepolia npx hardhat run scripts/deploy.js

# -- Deploy to Base mainnet --
HARDHAT_NETWORK=base npx hardhat run scripts/deploy.js

# -- Verify on Basescan --
npx hardhat verify --network base <FACTORY_ADDRESS> <ARG1> <ARG2> ...

# -- Read factory state --
cast call <FACTORY> "owner()(address)" --rpc-url $RPC
cast call <FACTORY> "paused()(bool)" --rpc-url $RPC
cast call <FACTORY> "marketsCount()(uint256)" --rpc-url $RPC

# -- Foundry one-shot deploy (Path C - Ledger) --
forge create contracts/BopsterFactory.sol:BopsterFactory \
  --rpc-url $RPC_URL --ledger \
  --constructor-args <token> <reality> <treasury> <admin> 100 100 50 \
  --verify --etherscan-api-key $BASESCAN_API_KEY
```

---

## 18. Appendix - deployment record template

Saved to `deployments/<network>-<timestamp>.json` by the script. Hand-rolled
version:

```json
{
  "chain": "base",
  "chainId": 8453,
  "deployedAt": "2026-06-13T12:00:00Z",
  "deployedBy": "0x<deployer EOA address>",
  "commit": "<git rev-parse HEAD output>",
  "gitTag": "v1.0.0-base",
  "compiler": {
    "version": "0.8.26",
    "evmVersion": "paris",
    "optimizer": { "enabled": true, "runs": 200 },
    "viaIR": true
  },
  "artifactSha256": {
    "BopsterFactory.json": "<sha256>",
    "BopsterMarket.json":  "<sha256>"
  },
  "addresses": {
    "BopsterFactory":  "0x<factory>",
    "token (USDC)":    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "reality":         "0x<reality>",
    "treasury":        "0x<treasury>",
    "admin (multisig)":"0x<safe>"
  },
  "constructorArgs": [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "0x<reality>",
    "0x<treasury>",
    "0x<safe>",
    100,
    100,
    50
  ],
  "deployTxHash": "0x<tx>",
  "deployBlock": 12345678,
  "gasUsed": "3041234",
  "explorerUrl": "https://basescan.org/address/0x<factory>"
}
```

Commit this file to the repo under `deployments/`. It is your single source
of truth for "what's currently deployed on Base".
