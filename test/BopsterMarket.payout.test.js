const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const ANSWER_YES = ethers.zeroPadValue(ethers.toBeHex(1), 32);
const ANSWER_NO = ethers.zeroPadValue(ethers.toBeHex(0), 32);
const ANSWER_INVALID = ethers.zeroPadValue("0x" + "f".repeat(64), 32);

const QUESTION_ID = ethers.encodeBytes32String("sim");

// Production fees from .env
const PROTOCOL_FEE_BPS = 200;
const CREATOR_FEE_BPS = 100;
const RESOLVER_REWARD_BPS = 20;

const SUPPLY = ethers.parseUnits("50000000", 6); // 50M USDC
const USER_FUNDING = ethers.parseUnits("500000", 6); // 500K USDC per user

// ─────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────

function computeFees(poolTotal) {
    const p = BigInt(poolTotal);
    const protocol = (p * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
    const creator = (p * BigInt(CREATOR_FEE_BPS)) / 10000n;
    const resolver = (p * BigInt(RESOLVER_REWARD_BPS)) / 10000n;
    return { protocol, creator, resolver, cuts: protocol + creator + resolver };
}

function computePayout(stake, netPool, winningSide) {
    return (BigInt(stake) * BigInt(netPool)) / BigInt(winningSide);
}

function toUSDC(baseUnits) {
    return ethers.formatUnits(baseUnits, 6);
}

// ─────────────────────────────────────────────────────────────────────────
// Fixture — deploys a fresh market with production fees
// ─────────────────────────────────────────────────────────────────────────

async function deployFixture() {
    const signers = await ethers.getSigners();
    const [deployer, creator, treasury, resolver,
        alice, bob, carol, dave, eve, frank, grace, henry, ivy, jack] = signers;

    // Deploy mock token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDC", "mUSDC", SUPPLY);

    // Fund all users + resolver
    const allUsers = [alice, bob, carol, dave, eve, frank, grace, henry, ivy, jack, resolver];
    for (const u of allUsers) {
        await token.transfer(u.address, USER_FUNDING);
    }

    // Deploy mock Reality
    const MockReality = await ethers.getContractFactory("MockReality");
    const reality = await MockReality.deploy();

    const now = await time.latest();
    const endTime = now + 3600;
    const resolveTime = endTime + 3600;

    const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
    const market = await BopsterMarket.deploy(
        await token.getAddress(),
        await reality.getAddress(),
        treasury.address,
        creator.address,
        QUESTION_ID,
        "ipfs://sim-metadata",
        endTime,
        resolveTime,
        PROTOCOL_FEE_BPS,
        CREATOR_FEE_BPS,
        RESOLVER_REWARD_BPS,
    );

    const users = { alice, bob, carol, dave, eve, frank, grace, henry, ivy, jack };

    return { token, reality, market, users, deployer, creator, treasury, resolver, endTime, resolveTime };
}

// ─────────────────────────────────────────────────────────────────────────
// Position & lifecycle helpers (mirror existing test helpers)
// ─────────────────────────────────────────────────────────────────────────

async function placeYes(token, market, user, amount) {
    await token.connect(user).approve(await market.getAddress(), amount);
    return market.connect(user).positionYes(amount);
}

async function placeNo(token, market, user, amount) {
    await token.connect(user).approve(await market.getAddress(), amount);
    return market.connect(user).positionNo(amount);
}

async function advanceAndLock(market, endTime) {
    await time.increaseTo(endTime + 1);
    await market.lock();
}

async function resolveMarket(reality, market, questionId, answer, resolveTime, caller) {
    await reality.setResult(questionId, answer, true);
    await time.increaseTo(resolveTime + 1);
    return market.connect(caller).finalize();
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers: claim winner + verify expected payout
// ─────────────────────────────────────────────────────────────────────────

async function claimAndVerify(market, token, user, expectedPayout) {
    const before = await token.balanceOf(user.address);
    await market.connect(user).claim();
    const got = await token.balanceOf(user.address) - before;
    expect(got).to.equal(expectedPayout);
    return got;
}

async function refundAndVerify(market, token, user, expectedRefund) {
    const before = await token.balanceOf(user.address);
    await market.connect(user).claimRefund();
    const got = await token.balanceOf(user.address) - before;
    expect(got).to.equal(expectedRefund);
    return got;
}

// ─────────────────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────────────────

describe("BopsterMarket — Payout Simulation (10 Markets)", function () {

    const report = [];

    // =====================================================================
    // MARKET 1 — Balanced 50/50, YES wins, 5 users (1 hedger)
    // =====================================================================

    it("Market 1: Balanced 50/50 pools, YES wins, 5 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, treasury, creator, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave, eve } = users;

        await placeYes(token, market, alice, 5000000n);
        await placeNo(token, market, alice, 1000000n);
        await placeYes(token, market, bob, 3000000n);
        await placeYes(token, market, carol, 2000000n);
        await placeNo(token, market, dave, 4000000n);
        await placeNo(token, market, eve, 5000000n);

        const totalYes = 10000000n;
        const totalNo = 10000000n;
        expect(await market.totalYes()).to.equal(totalYes);
        expect(await market.totalNo()).to.equal(totalNo);

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { protocol, creator: crFee, resolver: rwFee, cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;

        expect(await market.netPayoutPool()).to.equal(netPool);
        expect(await market.totalWinningSide()).to.equal(totalYes);
        expect(await market.outcomeYes()).to.be.true;

        // Fee recipients receive exact amounts
        const treasuryBal = await token.balanceOf(treasury.address);
        const creatorBal = await token.balanceOf(creator.address);
        const resolverBal = await token.balanceOf(resolver.address);
        expect(treasuryBal).to.equal(protocol);
        expect(creatorBal).to.equal(crFee);
        // Resolver already had funding — verify increase
        expect(resolverBal).to.equal(USER_FUNDING + rwFee);

        // Claim winners
        const aliceWin = computePayout(5000000n, netPool, totalYes);
        const bobWin = computePayout(3000000n, netPool, totalYes);
        const carolWin = computePayout(2000000n, netPool, totalYes);

        await claimAndVerify(market, token, alice, aliceWin); // 9,680,000
        await claimAndVerify(market, token, bob, bobWin); // 5,808,000
        await claimAndVerify(market, token, carol, carolWin); // 3,872,000

        // Losers cannot claim
        await expect(market.connect(dave).claim()).to.be.revertedWithCustomError(market, "NothingToClaim");
        await expect(market.connect(eve).claim()).to.be.revertedWithCustomError(market, "NothingToClaim");

        // Invariant
        const totalPaid = aliceWin + bobWin + carolWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);
        expect(await token.balanceOf(await market.getAddress())).to.equal(dust);

        report.push({
            id: 1, name: "Balanced 50/50, YES", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 2 — Balanced 50/50, NO wins
    // =====================================================================

    it("Market 2: Balanced 50/50 pools, NO wins, 4 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave } = users;

        await placeYes(token, market, alice, 1500000n);
        await placeYes(token, market, bob, 3500000n);
        await placeNo(token, market, carol, 2000000n);
        await placeNo(token, market, dave, 3000000n);

        const totalYes = 5000000n;
        const totalNo = 5000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_NO, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;

        expect(await market.outcomeYes()).to.be.false;
        expect(await market.outcomeInvalid()).to.be.false;

        const carolWin = computePayout(2000000n, netPool, totalNo);
        const daveWin = computePayout(3000000n, netPool, totalNo);

        await claimAndVerify(market, token, carol, carolWin); // 3,872,000
        await claimAndVerify(market, token, dave, daveWin); // 5,808,000

        const totalPaid = carolWin + daveWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 2, name: "Balanced 50/50, NO", outcome: "NO",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 3 — YES dominant 80/20, YES wins
    // =====================================================================

    it("Market 3: YES dominant 80/20, YES wins, 5 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave, eve } = users;

        await placeYes(token, market, alice, 30000000n);
        await placeYes(token, market, bob, 25000000n);
        await placeYes(token, market, carol, 15000000n);
        await placeYes(token, market, dave, 10000000n);
        await placeNo(token, market, dave, 5000000n);
        await placeNo(token, market, eve, 15000000n);

        const totalYes = 80000000n;
        const totalNo = 20000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;
        expect(await market.totalWinningSide()).to.equal(totalYes);

        const aliceWin = computePayout(30000000n, netPool, totalYes);
        const bobWin = computePayout(25000000n, netPool, totalYes);
        const carolWin = computePayout(15000000n, netPool, totalYes);
        const daveWin = computePayout(10000000n, netPool, totalYes);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);
        await claimAndVerify(market, token, carol, carolWin);
        await claimAndVerify(market, token, dave, daveWin);

        const totalPaid = aliceWin + bobWin + carolWin + daveWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 3, name: "YES dominant 80/20", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 4 — NO dominant 83/17, NO wins
    // =====================================================================

    it("Market 4: NO dominant 83/17, NO wins, 4 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave } = users;

        await placeYes(token, market, alice, 7000000n);
        await placeNo(token, market, alice, 20000000n);
        await placeYes(token, market, bob, 3000000n);
        await placeNo(token, market, carol, 20000000n);
        await placeNo(token, market, dave, 10000000n);

        const totalYes = 10000000n;
        const totalNo = 50000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_NO, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;
        expect(await market.totalWinningSide()).to.equal(totalNo);

        const aliceWin = computePayout(20000000n, netPool, totalNo);
        const carolWin = computePayout(20000000n, netPool, totalNo);
        const daveWin = computePayout(10000000n, netPool, totalNo);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, carol, carolWin);
        await claimAndVerify(market, token, dave, daveWin);

        const totalPaid = aliceWin + carolWin + daveWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 4, name: "NO dominant 83/17", outcome: "NO",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 5 — One-sided pool (only YES), YES wins
    // =====================================================================

    it("Market 5: One-sided pool (only YES), YES wins, 2 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob } = users;

        await placeYes(token, market, alice, 60000000n);
        await placeYes(token, market, bob, 40000000n);

        const totalYes = 100000000n;
        const totalNo = 0n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;
        expect(await market.totalWinningSide()).to.equal(totalYes);

        const aliceWin = computePayout(60000000n, netPool, totalYes);
        const bobWin = computePayout(40000000n, netPool, totalYes);

        // Both users LOSE money — their payouts are less than their deposits (fees)
        expect(aliceWin).to.be.lt(60000000n);
        expect(bobWin).to.be.lt(40000000n);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);

        const totalPaid = aliceWin + bobWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 5, name: "One-sided (only YES)", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 6 — Oracle INVALID → refund path
    // =====================================================================

    it("Market 6: Oracle INVALID → full refund, no fees, 3 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol } = users;

        await placeYes(token, market, alice, 25000000n);
        await placeYes(token, market, bob, 25000000n);
        await placeNo(token, market, bob, 10000000n);
        await placeNo(token, market, carol, 40000000n);

        const totalYes = 50000000n;
        const totalNo = 50000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_INVALID, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        expect(await market.outcomeInvalid()).to.be.true;
        expect(await market.totalWinningSide()).to.equal(0);
        expect(await market.netPayoutPool()).to.equal(poolTotal);

        // Full refund = YES + NO stake
        await refundAndVerify(market, token, alice, 25000000n);
        await refundAndVerify(market, token, bob, 35000000n);
        await refundAndVerify(market, token, carol, 40000000n);

        const totalPaid = 25000000n + 35000000n + 40000000n;
        const dust = poolTotal - totalPaid;
        expect(dust).to.equal(0n);
        expect(await token.balanceOf(await market.getAddress())).to.equal(0n);

        report.push({
            id: 6, name: "INVALID (refund path)", outcome: "REFUND",
            poolTotal, fees: 0n, netPool: poolTotal, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 7 — Multiple hedgers, YES wins
    // =====================================================================

    it("Market 7: Multiple hedgers, YES wins, 4 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave } = users;

        await placeYes(token, market, alice, 8000000n);
        await placeNo(token, market, alice, 4000000n);
        await placeYes(token, market, bob, 5000000n);
        await placeNo(token, market, bob, 3000000n);
        await placeYes(token, market, carol, 7000000n);
        await placeNo(token, market, carol, 3000000n);
        await placeNo(token, market, dave, 10000000n);

        const totalYes = 20000000n;
        const totalNo = 20000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;
        expect(await market.totalWinningSide()).to.equal(totalYes);

        const aliceWin = computePayout(8000000n, netPool, totalYes);
        const bobWin = computePayout(5000000n, netPool, totalYes);
        const carolWin = computePayout(7000000n, netPool, totalYes);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);
        await claimAndVerify(market, token, carol, carolWin);

        // Dave's NO is lost
        await expect(market.connect(dave).claim()).to.be.revertedWithCustomError(market, "NothingToClaim");

        const totalPaid = aliceWin + bobWin + carolWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 7, name: "Multiple hedgers, YES", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 8 — Small amounts, dust test
    // =====================================================================

    it("Market 8: Small amounts (dust test), YES wins, 10 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave, eve, frank, grace, henry, ivy, jack } = users;

        // 5 YES users with small base-unit amounts
        await placeYes(token, market, alice, 100n);
        await placeYes(token, market, bob, 150n);
        await placeYes(token, market, carol, 77n);
        await placeYes(token, market, dave, 93n);
        await placeYes(token, market, eve, 105n);

        // 5 NO users
        await placeNo(token, market, frank, 88n);
        await placeNo(token, market, grace, 111n);
        await placeNo(token, market, henry, 99n);
        await placeNo(token, market, ivy, 144n);
        await placeNo(token, market, jack, 83n);

        const totalYes = 525n;
        const totalNo = 525n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo; // 1050
        const { cuts } = computeFees(poolTotal); // protocol=21, creator=10, resolver=2
        const netPool = poolTotal - cuts; // 1017
        expect(await market.totalWinningSide()).to.equal(totalYes);

        const aliceWin = computePayout(100n, netPool, totalYes);
        const bobWin = computePayout(150n, netPool, totalYes);
        const carolWin = computePayout(77n, netPool, totalYes);
        const daveWin = computePayout(93n, netPool, totalYes);
        const eveWin = computePayout(105n, netPool, totalYes);

        expect(aliceWin).to.equal(193n);
        expect(bobWin).to.equal(290n);
        expect(carolWin).to.equal(149n);
        expect(daveWin).to.equal(180n);
        expect(eveWin).to.equal(203n);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);
        await claimAndVerify(market, token, carol, carolWin);
        await claimAndVerify(market, token, dave, daveWin);
        await claimAndVerify(market, token, eve, eveWin);

        const totalPaid = aliceWin + bobWin + carolWin + daveWin + eveWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(2n); // Expected dust from integer division
        expect(await token.balanceOf(await market.getAddress())).to.equal(dust);

        report.push({
            id: 8, name: "Small amounts (dust test)", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 9 — Floating amounts (1.5, 0.75, 3.25 USDC), YES wins
    // =====================================================================

    it("Market 9: Floating amounts (1.5 / 0.75 / 3.25 USDC), YES wins, 5 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave, eve } = users;

        await placeYes(token, market, alice, 1500000n); // 1.5 USDC
        await placeYes(token, market, bob, 750000n); // 0.75 USDC
        await placeYes(token, market, carol, 3250000n); // 3.25 USDC
        await placeNo(token, market, carol, 1000000n); // 1.0 USDC hedge
        await placeNo(token, market, dave, 2750000n); // 2.75 USDC
        await placeNo(token, market, eve, 1750000n); // 1.75 USDC

        const totalYes = 5500000n;
        const totalNo = 5500000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

        const poolTotal = totalYes + totalNo;
        const { cuts } = computeFees(poolTotal);
        const netPool = poolTotal - cuts;
        expect(await market.totalWinningSide()).to.equal(totalYes);

        const aliceWin = computePayout(1500000n, netPool, totalYes);
        const bobWin = computePayout(750000n, netPool, totalYes);
        const carolWin = computePayout(3250000n, netPool, totalYes);

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);
        await claimAndVerify(market, token, carol, carolWin);

        const totalPaid = aliceWin + bobWin + carolWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(0n);

        report.push({
            id: 9, name: "Floating amounts", outcome: "YES",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // MARKET 10 — Large unequal pools 35/65, NO wins
    // =====================================================================

    it("Market 10: Large unequal pools 35/65, NO wins, 4 users", async function () {
        const ctx = await deployFixture();
        const { token, reality, market, users, resolver, endTime, resolveTime } = ctx;
        const { alice, bob, carol, dave } = users;

        await placeYes(token, market, alice, 150000000n);
        await placeNo(token, market, alice, 200000000n);
        await placeYes(token, market, bob, 200000000n);
        await placeNo(token, market, bob, 150000000n);
        await placeNo(token, market, carol, 200000000n);
        await placeNo(token, market, dave, 100000000n);

        const totalYes = 350000000n;
        const totalNo = 650000000n;

        await advanceAndLock(market, endTime);
        await resolveMarket(reality, market, QUESTION_ID, ANSWER_NO, resolveTime, resolver);

        const poolTotal = totalYes + totalNo; // 1,000,000,000
        const { cuts } = computeFees(poolTotal); // 32,000,000
        const netPool = poolTotal - cuts; // 968,000,000
        expect(await market.totalWinningSide()).to.equal(totalNo);
        expect(await market.outcomeYes()).to.be.false;

        const aliceWin = computePayout(200000000n, netPool, totalNo);
        const bobWin = computePayout(150000000n, netPool, totalNo);
        const carolWin = computePayout(200000000n, netPool, totalNo);
        const daveWin = computePayout(100000000n, netPool, totalNo);

        // Verify division produces non-zero dust
        // 200M * 968M / 650M = 297,846,153 (floor)
        // 150M * 968M / 650M = 223,384,615 (floor)
        // 100M * 968M / 650M = 148,923,076 (floor)

        await claimAndVerify(market, token, alice, aliceWin);
        await claimAndVerify(market, token, bob, bobWin);
        await claimAndVerify(market, token, carol, carolWin);
        await claimAndVerify(market, token, dave, daveWin);

        const totalPaid = aliceWin + bobWin + carolWin + daveWin;
        const dust = netPool - totalPaid;
        expect(dust).to.equal(3n); // Expected 3 base-unit dust from integer division
        expect(await token.balanceOf(await market.getAddress())).to.equal(dust);

        report.push({
            id: 10, name: "Large unequal 35/65, NO", outcome: "NO",
            poolTotal, fees: cuts, netPool, paid: totalPaid, dust,
        });
    });

    // =====================================================================
    // FINAL REPORT
    // =====================================================================

    after(function () {
        console.log("\n" + "=".repeat(96));
        console.log("  PAYOUT SIMULATION REPORT — 10 Markets");
        console.log("  Fees: Protocol 2.00% + Creator 1.00% + Resolver 0.20% = 3.20%");
        console.log("=".repeat(96));
        console.table(report.map((r) => {
            const invOk = r.poolTotal === r.paid + r.fees + r.dust;
            return {
                "#": r.id,
                "Scenario": r.name,
                "Outcome": r.outcome,
                "Pool Total": toUSDC(r.poolTotal) + " USDC",
                "Fees": toUSDC(r.fees) + " USDC",
                "Net Pool": toUSDC(r.netPool) + " USDC",
                "Paid Out": toUSDC(r.paid) + " USDC",
                "Dust (base units)": Number(r.dust),
                "Verdict": invOk ? "PASS" : "FAIL",
            };
        }));

        const allPass = report.every(r => r.poolTotal === r.paid + r.fees + r.dust);
        if (allPass) {
            console.log("\n  VERDICT: All 10 markets pass the invariant check.");
            console.log("  poolTotal = paidOut + fees + dust holds for every scenario.\n");
        } else {
            console.log("\n  VERDICT: SOME MARKETS FAILED the invariant check!\n");
        }
    });
});
