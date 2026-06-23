require("dotenv").config({ path: ".env.production" });
require("dotenv").config(); // fallback to .env for local dev
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

  const tokenAddr = process.env.TOKEN_ADDRESS || "";
  const realityAddr = process.env.REALITY_ADDRESS || "";
  const treasuryAddr = process.env.TREASURY_ADDRESS || "";
  const adminAddr = process.env.ADMIN_ADDRESS || "";
  const protoBps = Number(process.env.PROTOCOL_FEE_BPS || 0);
  const creatorBps = Number(process.env.CREATOR_FEE_BPS || 0);
  const resolverBps = Number(process.env.RESOLVER_REWARD_BPS || 0);

  const args = [tokenAddr, realityAddr, treasuryAddr, adminAddr, protoBps, creatorBps, resolverBps];

  // Defensive arg validation — mirrors constructor checks
  const addrNames = ["TOKEN_ADDRESS", "REALITY_ADDRESS", "TREASURY_ADDRESS", "ADMIN_ADDRESS"];
  for (let i = 0; i < 4; i++) {
    if (!args[i] || !/^0x[a-fA-F0-9]{40}$/.test(args[i])) {
      throw new Error(`${addrNames[i]} is missing or malformed: "${args[i]}"`);
    }
    if (args[i].toLowerCase() === hre.ethers.ZeroAddress) {
      throw new Error(`${addrNames[i]} is the zero address`);
    }
  }
  const totalBps = args[4] + args[5] + args[6];
  if (totalBps > 1000) throw new Error(`Total fee bps ${totalBps} > 1000 (10%)`);

  console.log("\nConstructor args:");
  console.log("  token (USDC)      :", args[0]);
  console.log("  reality           :", args[1]);
  console.log("  treasury          :", args[2]);
  console.log("  admin             :", args[3]);
  console.log("  protocolFeeBps    :", args[4]);
  console.log("  creatorFeeBps     :", args[5]);
  console.log("  resolverRewardBps :", args[6]);
  console.log("  TOTAL bps         :", totalBps, "(", (totalBps / 100).toFixed(2), "%)");
  console.log("=".repeat(70));

  if (process.env.SKIP_CONFIRM !== "1") {
    console.log("\n⚠  About to deploy. Press Ctrl+C to abort. Continuing in 10s...");
    await new Promise((r) => setTimeout(r, 10000));
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

  // Write deployment record
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse HEAD").toString().trim();
  } catch (_) { /* not a git repo or no git */ }

  const compilers = hre.config.solidity.compilers || [hre.config.solidity];
  const compiler = compilers[0] || {};
  const record = {
    chain: net.name,
    chainId: net.config.chainId,
    deployedAt: new Date().toISOString(),
    deployedBy: deployer.address,
    commit,
    compiler: {
      version: compiler.version || "unknown",
      evmVersion: compiler.settings?.evmVersion || "unknown",
      optimizer: compiler.settings?.optimizer || {},
      viaIR: compiler.settings?.viaIR || false,
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

  // Print verify command
  const argsString = args
    .map((a) => (typeof a === "string" ? `"${a}"` : a))
    .join(" ");
  console.log("\nTo verify on block explorer:");
  console.log(`  npx hardhat verify --network ${net.name} ${address} ${argsString}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
