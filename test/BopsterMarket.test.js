const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_YES     = ethers.zeroPadValue(ethers.toBeHex(1), 32);
const ANSWER_NO      = ethers.zeroPadValue(ethers.toBeHex(0), 32);
const ANSWER_INVALID = ethers.zeroPadValue("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", 32);

const ONE_USDC   = ethers.parseUnits("1",   6);
const TEN_USDC   = ethers.parseUnits("10",  6);
const HUNDRED_USDC = ethers.parseUnits("100", 6);
const SUPPLY     = ethers.parseUnits("1000000", 6);

const QUESTION_ID = ethers.encodeBytes32String("q1");

// Fees: 2% protocol, 1% creator, 1% resolver (total 4%)
const PROTOCOL_FEE_BPS  = 200;
const CREATOR_FEE_BPS   = 100;
const RESOLVER_BPS      = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function deployAll(overrides = {}) {
    const [deployer, creator, alice, bob, carol, treasury, resolver] =
        await ethers.getSigners();

    // Deploy mock token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDC", "mUSDC", SUPPLY);

    // Distribute tokens
    await token.transfer(alice.address,   ethers.parseUnits("10000", 6));
    await token.transfer(bob.address,     ethers.parseUnits("10000", 6));
    await token.transfer(carol.address,   ethers.parseUnits("10000", 6));
    await token.transfer(resolver.address, ethers.parseUnits("1000", 6));

    // Deploy mock Reality
    const MockReality = await ethers.getContractFactory("MockReality");
    const reality = await MockReality.deploy();

    // Time anchors
    const now = await time.latest();
    const endTime     = overrides.endTime     ?? (now + 3600);       // 1h from now
    const resolveTime = overrides.resolveTime ?? (endTime + 3600);   // 1h after end

    // Deploy market directly (bypassing factory for unit tests)
    const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
    const market = await BopsterMarket.deploy(
        await token.getAddress(),
        await reality.getAddress(),
        treasury.address,
        creator.address,
        QUESTION_ID,
        "ipfs://test-metadata",
        endTime,
        resolveTime,
        overrides.protocolFeeBps  ?? PROTOCOL_FEE_BPS,
        overrides.creatorFeeBps   ?? CREATOR_FEE_BPS,
        overrides.resolverBps     ?? RESOLVER_BPS,
    );

    return { token, reality, market, deployer, creator, alice, bob, carol, treasury, resolver, endTime, resolveTime };
}

// Approve and place a YES position
async function placeYes(token, market, user, amount) {
    await token.connect(user).approve(await market.getAddress(), amount);
    return market.connect(user).positionYes(amount);
}

// Approve and place a NO position
async function placeNo(token, market, user, amount) {
    await token.connect(user).approve(await market.getAddress(), amount);
    return market.connect(user).positionNo(amount);
}

// Advance time past endTime and lock market
async function advanceAndLock(market, endTime) {
    await time.increaseTo(endTime + 1);
    await market.lock();
}

// Full resolution helper
async function resolveMarket(reality, market, questionId, answer, resolveTime, caller) {
    await reality.setResult(questionId, answer, true);
    await time.increaseTo(resolveTime + 1);
    return market.connect(caller).finalize();
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

describe("BopsterMarket", function () {

    // ─────────────────────────────────────────────────────────────────
    // DEPLOYMENT
    // ─────────────────────────────────────────────────────────────────

    describe("Deployment", function () {

        it("stores immutable config correctly", async function () {
            const { token, reality, market, creator, treasury, endTime, resolveTime } = await deployAll();
            expect(await market.token()).to.equal(await token.getAddress());
            expect(await market.reality()).to.equal(await reality.getAddress());
            expect(await market.creator()).to.equal(creator.address);
            expect(await market.treasury()).to.equal(treasury.address);
            expect(await market.endTime()).to.equal(endTime);
            expect(await market.resolveTime()).to.equal(resolveTime);
            expect(await market.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);
            expect(await market.creatorFeeBps()).to.equal(CREATOR_FEE_BPS);
            expect(await market.resolverRewardBps()).to.equal(RESOLVER_BPS);
            expect(await market.questionId()).to.equal(QUESTION_ID);
        });

        it("starts with status OPEN", async function () {
            const { market } = await deployAll();
            expect(await market.status()).to.equal(0); // Status.OPEN
        });

        it("starts with zero pools", async function () {
            const { market } = await deployAll();
            expect(await market.totalYes()).to.equal(0);
            expect(await market.totalNo()).to.equal(0);
        });

        it("reverts if endTime is in the past", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            // Deploy a valid market to get an interface reference for custom error matching
            const { market: refMarket } = await deployAll();

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                now - 1,          // endTime in the past
                now + 7200,
                100, 100, 100,
            )).to.be.revertedWithCustomError(refMarket, "EndTimeInPast");
        });

        it("reverts if endTime >= resolveTime", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            const { market: refMarket } = await deployAll();

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                now + 3600,
                now + 3600,  // resolveTime == endTime
                100, 100, 100,
            )).to.be.revertedWithCustomError(refMarket, "InvalidTimeOrder");
        });

        it("reverts if total fees exceed 10%", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            const { market: refMarket } = await deployAll();

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                now + 3600, now + 7200,
                500, 400, 200,  // total = 1100 bps > 1000
            )).to.be.revertedWithCustomError(refMarket, "FeesTooHigh");
        });

        // ── F2: defense-in-depth resolution window bound on direct deploy ──

        it("reverts ResolutionWindowTooLarge on direct deploy when (resolveTime - endTime) > 30 days", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            const { market: refMarket } = await deployAll();
            const THIRTY_DAYS = 30 * 86400;
            const endTime = now + 3600;

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                endTime,
                endTime + THIRTY_DAYS + 1, // exceeds the cap
                100, 100, 100,
            )).to.be.revertedWithCustomError(refMarket, "ResolutionWindowTooLarge");
        });

        it("accepts direct deploy with resolution window exactly at 30 days", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            const THIRTY_DAYS = 30 * 86400;
            const endTime = now + 3600;

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                endTime,
                endTime + THIRTY_DAYS,
                100, 100, 100,
            )).to.not.be.reverted;
        });

        it("accepts fees exactly at 10%", async function () {
            const now = await time.latest();
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const [, , , , treasury, creator] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();

            await expect(BopsterMarket.deploy(
                await token.getAddress(), await reality.getAddress(),
                treasury.address, creator.address, QUESTION_ID, "uri",
                now + 3600, now + 7200,
                400, 300, 300,  // total = 1000 bps exactly
            )).to.not.be.reverted;
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // POSITIONING — positionYes / positionNo
    // ─────────────────────────────────────────────────────────────────

    describe("Positioning", function () {

        it("accepts a YES position and updates state", async function () {
            const { token, market, alice } = await deployAll();
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);
            await market.connect(alice).positionYes(TEN_USDC);

            expect(await market.yesPosition(alice.address)).to.equal(TEN_USDC);
            expect(await market.totalYes()).to.equal(TEN_USDC);
            expect(await market.totalNo()).to.equal(0);
        });

        it("accepts a NO position and updates state", async function () {
            const { token, market, bob } = await deployAll();
            await token.connect(bob).approve(await market.getAddress(), TEN_USDC);
            await market.connect(bob).positionNo(TEN_USDC);

            expect(await market.noPosition(bob.address)).to.equal(TEN_USDC);
            expect(await market.totalNo()).to.equal(TEN_USDC);
            expect(await market.totalYes()).to.equal(0);
        });

        it("accumulates multiple positions from the same user", async function () {
            const { token, market, alice } = await deployAll();
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC * 3n);
            await market.connect(alice).positionYes(TEN_USDC);
            await market.connect(alice).positionYes(TEN_USDC * 2n);

            expect(await market.yesPosition(alice.address)).to.equal(TEN_USDC * 3n);
            expect(await market.totalYes()).to.equal(TEN_USDC * 3n);
        });

        it("accumulates positions from multiple users", async function () {
            const { token, market, alice, bob } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            await placeNo(token, market, bob, TEN_USDC * 2n);

            expect(await market.totalYes()).to.equal(TEN_USDC);
            expect(await market.totalNo()).to.equal(TEN_USDC * 2n);
        });

        it("emits PositionPlaced on YES", async function () {
            const { token, market, alice } = await deployAll();
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);
            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.emit(market, "PositionPlaced")
                .withArgs(alice.address, true, TEN_USDC);
        });

        it("emits PositionPlaced on NO", async function () {
            const { token, market, bob } = await deployAll();
            await token.connect(bob).approve(await market.getAddress(), TEN_USDC);
            await expect(market.connect(bob).positionNo(TEN_USDC))
                .to.emit(market, "PositionPlaced")
                .withArgs(bob.address, false, TEN_USDC);
        });

        it("transfers tokens from user to market contract", async function () {
            const { token, market, alice } = await deployAll();
            const marketAddr = await market.getAddress();
            const before = await token.balanceOf(alice.address);
            await placeYes(token, market, alice, TEN_USDC);
            expect(await token.balanceOf(alice.address)).to.equal(before - TEN_USDC);
            expect(await token.balanceOf(marketAddr)).to.equal(TEN_USDC);
        });

        it("reverts with NotOpen if amount is zero", async function () {
            const { market, alice } = await deployAll();
            await expect(market.connect(alice).positionYes(0))
                .to.be.revertedWithCustomError(market, "InvalidAmount");
            await expect(market.connect(alice).positionNo(0))
                .to.be.revertedWithCustomError(market, "InvalidAmount");
        });

        it("reverts with NotOpen if market is LOCKED", async function () {
            const { token, market, alice, endTime } = await deployAll();
            await advanceAndLock(market, endTime);
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);
            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.be.revertedWithCustomError(market, "NotOpen");
        });

        it("reverts with NotOpen if block.timestamp >= endTime (no side effects)", async function () {
            const { token, market, alice, endTime } = await deployAll();
            // Advance to exactly endTime
            await time.increaseTo(endTime);
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);

            // Should fail cleanly
            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.be.revertedWithCustomError(market, "NotOpen");

            // CRITICAL: market status must remain OPEN — no premature state mutation
            expect(await market.status()).to.equal(0); // OPEN
        });

        it("reverts with NotOpen if block.timestamp > endTime (no side effects)", async function () {
            const { token, market, alice, endTime } = await deployAll();
            await time.increaseTo(endTime + 100);
            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);

            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.be.revertedWithCustomError(market, "NotOpen");

            // status must still be OPEN — lock() was NOT called
            expect(await market.status()).to.equal(0); // OPEN
            // totalYes must be zero — no pool mutation
            expect(await market.totalYes()).to.equal(0);
        });

        it("reverts with NotOpen if market is RESOLVED", async function () {
            const { token, reality, market, alice, resolver, endTime, resolveTime } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            await advanceAndLock(market, endTime);
            await resolveMarket(reality, market, QUESTION_ID, ANSWER_YES, resolveTime, resolver);

            await token.connect(alice).approve(await market.getAddress(), TEN_USDC);
            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.be.revertedWithCustomError(market, "NotOpen");
        });

        it("reverts if token transferFrom fails (no allowance)", async function () {
            const { market, alice } = await deployAll();
            // No approve — transferFrom should fail via SafeERC20
            await expect(market.connect(alice).positionYes(TEN_USDC))
                .to.be.reverted;
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // LOCK
    // ─────────────────────────────────────────────────────────────────

    describe("lock()", function () {

        it("locks the market after endTime and emits Locked", async function () {
            const { token, market, alice, endTime } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            await time.increaseTo(endTime + 1);

            await expect(market.lock())
                .to.emit(market, "Locked")
                .withArgs(TEN_USDC, 0);

            expect(await market.status()).to.equal(1); // LOCKED
        });

        it("reverts with TooEarly if endTime has not passed", async function () {
            const { market } = await deployAll();
            await expect(market.lock())
                .to.be.revertedWithCustomError(market, "TooEarly");
        });

        it("reverts with NotOpen if already LOCKED", async function () {
            const { market, endTime } = await deployAll();
            await time.increaseTo(endTime + 1);
            await market.lock();
            await expect(market.lock())
                .to.be.revertedWithCustomError(market, "NotOpen");
        });

        it("anyone can call lock()", async function () {
            const { market, alice, endTime } = await deployAll();
            await time.increaseTo(endTime + 1);
            await expect(market.connect(alice).lock()).to.not.be.reverted;
        });

        it("lock emits correct pool totals", async function () {
            const { token, market, alice, bob, endTime } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            await placeNo(token, market, bob, TEN_USDC * 3n);
            await time.increaseTo(endTime + 1);

            await expect(market.lock())
                .to.emit(market, "Locked")
                .withArgs(TEN_USDC, TEN_USDC * 3n);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // FINALIZE — resolver reward model
    // ─────────────────────────────────────────────────────────────────

    describe("finalize()", function () {

        async function setupForFinalize(answer) {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, answer, true);
            await time.increaseTo(ctx.resolveTime + 1);
            return ctx;
        }

        it("reverts with TooEarly if called before endTime", async function () {
            const { market } = await deployAll();
            await expect(market.finalize())
                .to.be.revertedWithCustomError(market, "TooEarly");
        });

        it("reverts with TooEarly if called before resolveTime (market already locked)", async function () {
            const { market, endTime, resolveTime, reality } = await deployAll();
            await time.increaseTo(endTime + 1);
            await market.lock();
            await reality.setResult(QUESTION_ID, ANSWER_YES, true);
            // resolveTime has NOT passed yet
            await expect(market.finalize())
                .to.be.revertedWithCustomError(market, "TooEarly");
        });

        it("reverts with RealityNotFinalized if oracle not finalized yet", async function () {
            const { market, endTime, resolveTime } = await deployAll();
            await advanceAndLock(market, endTime);
            await time.increaseTo(resolveTime + 1);
            // reality NOT set
            await expect(market.finalize())
                .to.be.revertedWithCustomError(market, "RealityNotFinalized");
        });

        it("reverts with NotLocked if market is RESOLVED already", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            await ctx.market.connect(ctx.resolver).finalize();
            await expect(ctx.market.finalize())
                .to.be.revertedWithCustomError(ctx.market, "NotLocked");
        });

        it("auto-transitions OPEN → LOCKED → RESOLVED in a single finalize() call", async function () {
            const { token, reality, market, alice, resolver, endTime, resolveTime } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            // do NOT call lock() explicitly — let finalize() handle it
            await time.increaseTo(resolveTime + 1);
            await reality.setResult(QUESTION_ID, ANSWER_YES, true);

            await expect(market.connect(resolver).finalize())
                .to.emit(market, "Locked")
                .and.to.emit(market, "Resolved");

            expect(await market.status()).to.equal(2); // RESOLVED
        });

        it("marks market as RESOLVED on YES outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.market.status()).to.equal(2);
            expect(await ctx.market.outcomeYes()).to.be.true;
            expect(await ctx.market.outcomeInvalid()).to.be.false;
        });

        it("marks market as RESOLVED on NO outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_NO);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.market.status()).to.equal(2);
            expect(await ctx.market.outcomeYes()).to.be.false;
            expect(await ctx.market.outcomeInvalid()).to.be.false;
        });

        it("marks market as RESOLVED on INVALID outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_INVALID);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.market.status()).to.equal(2);
            expect(await ctx.market.outcomeInvalid()).to.be.true;
        });

        it("unknown answer resolves to refund path (not revert)", async function () {
            const { token, reality, market, alice, resolver, endTime, resolveTime } = await deployAll();
            await placeYes(token, market, alice, TEN_USDC);
            await advanceAndLock(market, endTime);
            const weirdAnswer = ethers.encodeBytes32String("UNKNOWN");
            await reality.setResult(QUESTION_ID, weirdAnswer, true);
            await time.increaseTo(resolveTime + 1);
            // Must NOT revert — resolves with refund path
            await expect(market.connect(resolver).finalize()).to.not.be.reverted;
            expect(await market.status()).to.equal(2); // RESOLVED
            expect(await market.outcomeInvalid()).to.be.true;
            expect(await market.totalWinningSide()).to.equal(0);
            expect(await market.netPayoutPool()).to.equal(TEN_USDC);
        });

        // --- resolver reward model ---

        it("resolver reward goes to msg.sender of finalize() (permissionless)", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            const before = await ctx.token.balanceOf(ctx.resolver.address);
            await ctx.market.connect(ctx.resolver).finalize();
            const after = await ctx.token.balanceOf(ctx.resolver.address);

            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            const expectedReward = (poolTotal * BigInt(RESOLVER_BPS)) / 10000n;
            expect(after - before).to.equal(expectedReward);
        });

        it("a random third party (not creator or treasury) gets the resolver reward", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            // carol is a complete stranger — not creator, not treasury
            const before = await ctx.token.balanceOf(ctx.carol.address);
            await ctx.market.connect(ctx.carol).finalize();
            const after = await ctx.token.balanceOf(ctx.carol.address);

            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            const expectedReward = (poolTotal * BigInt(RESOLVER_BPS)) / 10000n;
            expect(after - before).to.equal(expectedReward);
        });

        it("distributes protocol fee to treasury", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            const before = await ctx.token.balanceOf(ctx.treasury.address);
            await ctx.market.connect(ctx.resolver).finalize();
            const after = await ctx.token.balanceOf(ctx.treasury.address);

            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            const expected = (poolTotal * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
            expect(after - before).to.equal(expected);
        });

        it("distributes creator fee to creator", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            const before = await ctx.token.balanceOf(ctx.creator.address);
            await ctx.market.connect(ctx.resolver).finalize();
            const after = await ctx.token.balanceOf(ctx.creator.address);

            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            const expected = (poolTotal * BigInt(CREATOR_FEE_BPS)) / 10000n;
            expect(after - before).to.equal(expected);
        });

        it("emits Resolved event with correct parameters (YES outcome)", async function () {
            const ctx = await setupForFinalize(ANSWER_YES);
            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            const protocolFee    = (poolTotal * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
            const creatorFee     = (poolTotal * BigInt(CREATOR_FEE_BPS))   / 10000n;
            const resolverReward = (poolTotal * BigInt(RESOLVER_BPS))      / 10000n;
            const netPool        = poolTotal - protocolFee - creatorFee - resolverReward;

            await expect(ctx.market.connect(ctx.resolver).finalize())
                .to.emit(ctx.market, "Resolved")
                .withArgs(ANSWER_YES, poolTotal, netPool, protocolFee, creatorFee, resolverReward);
        });

        it("no fees and no resolver reward on INVALID outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_INVALID);
            const resolverBefore  = await ctx.token.balanceOf(ctx.resolver.address);
            const treasuryBefore  = await ctx.token.balanceOf(ctx.treasury.address);
            const creatorBefore   = await ctx.token.balanceOf(ctx.creator.address);

            await ctx.market.connect(ctx.resolver).finalize();

            expect(await ctx.token.balanceOf(ctx.resolver.address)).to.equal(resolverBefore);
            expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(treasuryBefore);
            expect(await ctx.token.balanceOf(ctx.creator.address)).to.equal(creatorBefore);
        });

        it("netPayoutPool equals full pool on INVALID outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_INVALID);
            await ctx.market.connect(ctx.resolver).finalize();
            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            expect(await ctx.market.netPayoutPool()).to.equal(poolTotal);
        });

        it("totalWinningSide is zero on INVALID outcome", async function () {
            const ctx = await setupForFinalize(ANSWER_INVALID);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.market.totalWinningSide()).to.equal(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // CLAIM — winner payouts
    // ─────────────────────────────────────────────────────────────────

    describe("claim()", function () {

        async function setupResolved(answer) {
            const ctx = await deployAll();
            // alice: 100 YES, bob: 200 NO
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, answer, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();
            return ctx;
        }

        it("allows the winning side to claim and receive payout", async function () {
            // YES wins → alice claims
            const ctx = await setupResolved(ANSWER_YES);
            const marketAddr = await ctx.market.getAddress();

            const poolTotal = HUNDRED_USDC * 3n;
            const cuts = (poolTotal * BigInt(PROTOCOL_FEE_BPS + CREATOR_FEE_BPS + RESOLVER_BPS)) / 10000n;
            const netPool = poolTotal - cuts;

            const aliceBefore = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claim();
            const aliceAfter = await ctx.token.balanceOf(ctx.alice.address);

            // alice owns 100% of winning side → gets full netPool
            expect(aliceAfter - aliceBefore).to.equal(netPool);
            expect(await ctx.market.claimed(ctx.alice.address)).to.be.true;
        });

        it("proportional claim when multiple winners", async function () {
            const ctx = await deployAll();
            // alice: 100 YES, carol: 300 YES — bob: 200 NO
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeYes(ctx.token, ctx.market, ctx.carol, HUNDRED_USDC * 3n);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            const poolTotal = HUNDRED_USDC * 6n;
            const cuts = (poolTotal * BigInt(PROTOCOL_FEE_BPS + CREATOR_FEE_BPS + RESOLVER_BPS)) / 10000n;
            const netPool = poolTotal - cuts;
            const totalWin = HUNDRED_USDC * 4n; // alice+carol YES

            // alice has 100/400 = 25% of winning side
            const aliceBefore = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claim();
            const aliceExpected = (HUNDRED_USDC * netPool) / totalWin;
            expect(await ctx.token.balanceOf(ctx.alice.address) - aliceBefore).to.equal(aliceExpected);

            // carol has 300/400 = 75% of winning side
            const carolBefore = await ctx.token.balanceOf(ctx.carol.address);
            await ctx.market.connect(ctx.carol).claim();
            const carolExpected = (HUNDRED_USDC * 3n * netPool) / totalWin;
            expect(await ctx.token.balanceOf(ctx.carol.address) - carolBefore).to.equal(carolExpected);
        });

        it("emits Claimed event", async function () {
            const ctx = await setupResolved(ANSWER_YES);
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.emit(ctx.market, "Claimed")
                .withArgs(ctx.alice.address, ctx.market.netPayoutPool());
        });

        it("reverts with NotResolved if market not resolved", async function () {
            const { market, alice } = await deployAll();
            await expect(market.connect(alice).claim())
                .to.be.revertedWithCustomError(market, "NotResolved");
        });

        it("reverts with NothingToClaim on second claim (double-claim prevention)", async function () {
            const ctx = await setupResolved(ANSWER_YES);
            await ctx.market.connect(ctx.alice).claim();
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("reverts with NothingToClaim for the losing side", async function () {
            // YES wins → bob (NO) cannot claim
            const ctx = await setupResolved(ANSWER_YES);
            await expect(ctx.market.connect(ctx.bob).claim())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("reverts with NothingToClaim for address with no position", async function () {
            const ctx = await setupResolved(ANSWER_YES);
            await expect(ctx.market.connect(ctx.carol).claim())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("reverts with NothingToClaim on claim() if outcome is INVALID (use claimRefund)", async function () {
            const ctx = await setupResolved(ANSWER_INVALID);
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // CLAIM REFUND — invalid outcome
    // ─────────────────────────────────────────────────────────────────

    describe("claimRefund()", function () {

        async function setupInvalid() {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();
            return ctx;
        }

        it("refunds full stake to YES user on INVALID", async function () {
            const ctx = await setupInvalid();
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            const after = await ctx.token.balanceOf(ctx.alice.address);
            expect(after - before).to.equal(HUNDRED_USDC);
        });

        it("refunds full stake to NO user on INVALID", async function () {
            const ctx = await setupInvalid();
            const before = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.bob).claimRefund();
            const after = await ctx.token.balanceOf(ctx.bob.address);
            expect(after - before).to.equal(HUNDRED_USDC * 2n);
        });

        it("refunds combined YES+NO stake if user had both sides", async function () {
            const ctx = await deployAll();
            // alice goes both sides
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC * 2n);
        });

        it("emits Claimed event", async function () {
            const ctx = await setupInvalid();
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.emit(ctx.market, "Claimed")
                .withArgs(ctx.alice.address, HUNDRED_USDC);
        });

        it("reverts with NotResolved if market not resolved", async function () {
            const { market, alice } = await deployAll();
            await expect(market.connect(alice).claimRefund())
                .to.be.revertedWithCustomError(market, "NotResolved");
        });

        it("reverts with NothingToClaim on double refund", async function () {
            const ctx = await setupInvalid();
            await ctx.market.connect(ctx.alice).claimRefund();
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("reverts with NotResolved when market has a winner (must use claim)", async function () {
            // claimRefund() only works when: RESOLVED+no-winners OR EMERGENCY_REFUND
            // When there IS a winner, neither condition is met → NotResolved
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NotResolved");
        });

        it("reverts with NothingToClaim for address with no stake", async function () {
            const ctx = await setupInvalid();
            await expect(ctx.market.connect(ctx.carol).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("claim() and claimRefund() are mutually exclusive (shared claimed flag)", async function () {
            const ctx = await deployAll();
            // carol takes a YES position
            await placeYes(ctx.token, ctx.market, ctx.carol, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            // First refund succeeds
            await ctx.market.connect(ctx.carol).claimRefund();
            // Second attempt (any path) fails
            await expect(ctx.market.connect(ctx.carol).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // FULL FLOW — end-to-end happy paths
    // ─────────────────────────────────────────────────────────────────

    describe("Full flow — end-to-end", function () {

        it("complete YES-wins flow: position → lock → finalize → claim", async function () {
            const { token, reality, market, alice, bob, carol, treasury, creator, resolver, endTime, resolveTime } = await deployAll();

            // Positions
            await placeYes(token, market, alice, HUNDRED_USDC);        // 100 YES
            await placeNo(token, market, bob, HUNDRED_USDC * 2n);      // 200 NO
            await placeYes(token, market, carol, HUNDRED_USDC * 3n);   // 300 YES

            expect(await market.totalYes()).to.equal(HUNDRED_USDC * 4n);
            expect(await market.totalNo()).to.equal(HUNDRED_USDC * 2n);

            // Lock
            await time.increaseTo(endTime + 1);
            await market.lock();
            expect(await market.status()).to.equal(1); // LOCKED

            // Finalize
            await reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(resolveTime + 1);
            await market.connect(resolver).finalize();
            expect(await market.status()).to.equal(2); // RESOLVED

            // Accounting check
            const poolTotal = HUNDRED_USDC * 6n;
            const protocolFee    = (poolTotal * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
            const creatorFeeAmt  = (poolTotal * BigInt(CREATOR_FEE_BPS))  / 10000n;
            const resolverReward = (poolTotal * BigInt(RESOLVER_BPS))     / 10000n;
            const netPool = poolTotal - protocolFee - creatorFeeAmt - resolverReward;
            const totalWin = HUNDRED_USDC * 4n;

            expect(await market.netPayoutPool()).to.equal(netPool);
            expect(await market.totalWinningSide()).to.equal(totalWin);

            // Claims
            const aliceBefore = await token.balanceOf(alice.address);
            await market.connect(alice).claim();
            const aliceGot = await token.balanceOf(alice.address) - aliceBefore;
            expect(aliceGot).to.equal((HUNDRED_USDC * netPool) / totalWin);

            const carolBefore = await token.balanceOf(carol.address);
            await market.connect(carol).claim();
            const carolGot = await token.balanceOf(carol.address) - carolBefore;
            expect(carolGot).to.equal((HUNDRED_USDC * 3n * netPool) / totalWin);

            // Bob (loser) cannot claim
            await expect(market.connect(bob).claim())
                .to.be.revertedWithCustomError(market, "NothingToClaim");

            // Market contract should be empty (or near zero due to rounding)
            const remaining = await token.balanceOf(await market.getAddress());
            expect(remaining).to.be.lessThanOrEqual(2n); // at most 2 units rounding dust
        });

        it("complete INVALID flow: position → lock → finalize → claimRefund", async function () {
            const { token, reality, market, alice, bob, resolver, endTime, resolveTime } = await deployAll();

            await placeYes(token, market, alice, HUNDRED_USDC);
            await placeNo(token, market, bob, HUNDRED_USDC * 2n);

            await time.increaseTo(endTime + 1);
            await market.lock();
            await reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(resolveTime + 1);
            await market.connect(resolver).finalize();

            const aliceBefore = await token.balanceOf(alice.address);
            const bobBefore   = await token.balanceOf(bob.address);

            await market.connect(alice).claimRefund();
            await market.connect(bob).claimRefund();

            expect(await token.balanceOf(alice.address) - aliceBefore).to.equal(HUNDRED_USDC);
            expect(await token.balanceOf(bob.address)   - bobBefore).to.equal(HUNDRED_USDC * 2n);

            // Market should be empty
            expect(await token.balanceOf(await market.getAddress())).to.equal(0);
        });

        it("zero-fee market: full pool goes to winners", async function () {
            const now = await time.latest();
            const ctx = await deployAll({ protocolFeeBps: 0, creatorFeeBps: 0, resolverBps: 0 });
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            // alice wins and gets full 200 USDC (no fees)
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claim();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC * 2n);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // EDGE CASES
    // ─────────────────────────────────────────────────────────────────

    describe("Edge cases", function () {

        it("market with zero YES positions: NO wins and bob claims normally", async function () {
            const ctx = await deployAll();
            // Only NO positions — no YES
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_NO, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            // winning = totalNo (100 USDC), totalWinningSide is non-zero → normal claim path
            // With zero fees (resolverBps/protocol/creator all produce 0 fees here since
            // no-fee market is used by full-flow test). Here fees apply but pool is only
            // one side, so winners still get netPool via claim().
            expect(await ctx.market.totalWinningSide()).to.equal(HUNDRED_USDC);
            expect(await ctx.market.outcomeYes()).to.be.false;

            const poolTotal = HUNDRED_USDC;
            const cuts = (poolTotal * BigInt(PROTOCOL_FEE_BPS + CREATOR_FEE_BPS + RESOLVER_BPS)) / 10000n;
            const netPool = poolTotal - cuts;

            const before = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.bob).claim();
            expect(await ctx.token.balanceOf(ctx.bob.address) - before).to.equal(netPool);
        });

        it("market with zero total pool: resolves with no fees and empty pools", async function () {
            const ctx = await deployAll();
            // No positions at all
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            expect(await ctx.market.netPayoutPool()).to.equal(0);
            expect(await ctx.market.totalWinningSide()).to.equal(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2 — REALITY ANSWER HANDLING (all final answers)
    // ─────────────────────────────────────────────────────────────────

    describe("finalize() — Reality answer handling (Phase 2)", function () {

        // Helper: place both sides, lock, set Reality answer, advance past resolveTime
        async function setupAndFinalize(answer, { setTooSoon = false } = {}) {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, answer, true);
            if (setTooSoon) await ctx.reality.setSettledTooSoon(QUESTION_ID, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();
            return ctx;
        }

        // ── ANSWER_YES ───────────────────────────────────────────────

        it("ANSWER_YES → outcomeYes=true, outcomeInvalid=false, normal payout", async function () {
            const ctx = await setupAndFinalize(ANSWER_YES);
            expect(await ctx.market.outcomeYes()).to.be.true;
            expect(await ctx.market.outcomeInvalid()).to.be.false;
            expect(await ctx.market.totalWinningSide()).to.equal(HUNDRED_USDC);
            expect(await ctx.market.status()).to.equal(2); // RESOLVED
        });

        it("ANSWER_YES → finalAnswer stored correctly", async function () {
            const ctx = await setupAndFinalize(ANSWER_YES);
            expect(await ctx.market.finalAnswer()).to.equal(ANSWER_YES);
        });

        it("ANSWER_YES → claim() succeeds for YES user", async function () {
            const ctx = await setupAndFinalize(ANSWER_YES);
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claim();
            expect(await ctx.token.balanceOf(ctx.alice.address)).to.be.gt(before);
        });

        it("ANSWER_YES → claimRefund() reverts for YES user (NotResolved, winner exists)", async function () {
            const ctx = await setupAndFinalize(ANSWER_YES);
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NotResolved");
        });

        // ── ANSWER_NO ────────────────────────────────────────────────

        it("ANSWER_NO → outcomeYes=false, outcomeInvalid=false, normal payout", async function () {
            const ctx = await setupAndFinalize(ANSWER_NO);
            expect(await ctx.market.outcomeYes()).to.be.false;
            expect(await ctx.market.outcomeInvalid()).to.be.false;
            expect(await ctx.market.totalWinningSide()).to.equal(HUNDRED_USDC * 2n);
            expect(await ctx.market.status()).to.equal(2); // RESOLVED
        });

        it("ANSWER_NO → finalAnswer stored correctly", async function () {
            const ctx = await setupAndFinalize(ANSWER_NO);
            expect(await ctx.market.finalAnswer()).to.equal(ANSWER_NO);
        });

        it("ANSWER_NO → claim() succeeds for NO user", async function () {
            const ctx = await setupAndFinalize(ANSWER_NO);
            const before = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.bob).claim();
            expect(await ctx.token.balanceOf(ctx.bob.address)).to.be.gt(before);
        });

        // ── ANSWER_INVALID ───────────────────────────────────────────

        it("ANSWER_INVALID → outcomeInvalid=true, refund path", async function () {
            const ctx = await setupAndFinalize(ANSWER_INVALID);
            expect(await ctx.market.outcomeInvalid()).to.be.true;
            expect(await ctx.market.totalWinningSide()).to.equal(0);
            const poolTotal = HUNDRED_USDC * 3n;
            expect(await ctx.market.netPayoutPool()).to.equal(poolTotal);
        });

        it("ANSWER_INVALID → finalAnswer stored as ANSWER_INVALID", async function () {
            const ctx = await setupAndFinalize(ANSWER_INVALID);
            expect(await ctx.market.finalAnswer()).to.equal(ANSWER_INVALID);
        });

        it("ANSWER_INVALID → claimRefund() works for YES user", async function () {
            const ctx = await setupAndFinalize(ANSWER_INVALID);
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC);
        });

        it("ANSWER_INVALID → claimRefund() works for NO user", async function () {
            const ctx = await setupAndFinalize(ANSWER_INVALID);
            const before = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.bob).claimRefund();
            expect(await ctx.token.balanceOf(ctx.bob.address) - before).to.equal(HUNDRED_USDC * 2n);
        });

        it("ANSWER_INVALID → claim() reverts with NothingToClaim (no winners)", async function () {
            const ctx = await setupAndFinalize(ANSWER_INVALID);
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("ANSWER_INVALID → no fees or resolver reward paid", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(ctx.resolveTime + 1);

            const resolverBefore  = await ctx.token.balanceOf(ctx.resolver.address);
            const treasuryBefore  = await ctx.token.balanceOf(ctx.treasury.address);
            const creatorBefore   = await ctx.token.balanceOf(ctx.creator.address);

            await ctx.market.connect(ctx.resolver).finalize();

            expect(await ctx.token.balanceOf(ctx.resolver.address)).to.equal(resolverBefore);
            expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(treasuryBefore);
            expect(await ctx.token.balanceOf(ctx.creator.address)).to.equal(creatorBefore);
        });

        // ── ANSWER_TOO_SOON ──────────────────────────────────────────

        it("ANSWER_TOO_SOON → refund path (not a revert)", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
            await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
            await ctx.reality.setSettledTooSoon(QUESTION_ID, true);
            await time.increaseTo(ctx.resolveTime + 1);

            await expect(ctx.market.connect(ctx.resolver).finalize()).to.not.be.reverted;
            expect(await ctx.market.outcomeInvalid()).to.be.true;
            expect(await ctx.market.totalWinningSide()).to.equal(0);
        });

        it("ANSWER_TOO_SOON → finalAnswer stored as ANSWER_TOO_SOON", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
            await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            expect(await ctx.market.finalAnswer()).to.equal(ANSWER_TOO_SOON);
        });

        it("ANSWER_TOO_SOON → claimRefund() works for all users", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
            await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            const aliceBefore = await ctx.token.balanceOf(ctx.alice.address);
            const bobBefore   = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            await ctx.market.connect(ctx.bob).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - aliceBefore).to.equal(HUNDRED_USDC);
            expect(await ctx.token.balanceOf(ctx.bob.address)   - bobBefore).to.equal(HUNDRED_USDC * 2n);
        });

        it("ANSWER_TOO_SOON → no fees or resolver reward paid", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
            await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
            await time.increaseTo(ctx.resolveTime + 1);

            const resolverBefore = await ctx.token.balanceOf(ctx.resolver.address);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.token.balanceOf(ctx.resolver.address)).to.equal(resolverBefore);
        });

        // ── Arbitrary unknown bytes32 ────────────────────────────────

        it("any other bytes32 final answer → refund path, not a revert", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            // completely arbitrary value
            const randomAnswer = ethers.keccak256(ethers.toUtf8Bytes("some_oracle_weirdness"));
            await ctx.reality.setResult(QUESTION_ID, randomAnswer, true);
            await time.increaseTo(ctx.resolveTime + 1);

            await expect(ctx.market.connect(ctx.resolver).finalize()).to.not.be.reverted;
            expect(await ctx.market.outcomeInvalid()).to.be.true;
            expect(await ctx.market.totalWinningSide()).to.equal(0);
            expect(await ctx.market.netPayoutPool()).to.equal(HUNDRED_USDC);
        });

        it("arbitrary answer → finalAnswer is stored correctly", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            const randomAnswer = ethers.keccak256(ethers.toUtf8Bytes("arbitrary"));
            await ctx.reality.setResult(QUESTION_ID, randomAnswer, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();
            expect(await ctx.market.finalAnswer()).to.equal(randomAnswer);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2 — triggerEmergencyRefund()
    // ─────────────────────────────────────────────────────────────────

    describe("triggerEmergencyRefund()", function () {

        const EMERGENCY_DELAY = 90 * 24 * 60 * 60;

        async function setupForEmergency() {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            // Do NOT call finalize — market stays LOCKED
            return ctx;
        }

        it("reverts NotLocked if status is OPEN", async function () {
            const { market } = await deployAll();
            await expect(market.triggerEmergencyRefund())
                .to.be.revertedWithCustomError(market, "NotLocked");
        });

        it("reverts NotLocked if status is RESOLVED", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.finalize();
            // Advance well past delay too
            await time.increase(EMERGENCY_DELAY + 1);
            await expect(ctx.market.triggerEmergencyRefund())
                .to.be.revertedWithCustomError(ctx.market, "NotLocked");
        });

        it("reverts NotLocked if already EMERGENCY_REFUND", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            await expect(ctx.market.triggerEmergencyRefund())
                .to.be.revertedWithCustomError(ctx.market, "NotLocked");
        });

        it("reverts EmergencyRefundNotYetAvailable before delay expires", async function () {
            const ctx = await setupForEmergency();
            // resolveTime has passed but delay has NOT
            await time.increaseTo(ctx.resolveTime + 1);
            await expect(ctx.market.triggerEmergencyRefund())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundNotYetAvailable");
        });

        it("reverts EmergencyRefundNotYetAvailable well before delay expires", async function () {
            // Contract condition: block.timestamp < resolveTime + EMERGENCY_REFUND_DELAY → revert
            // We advance to halfway through the delay to avoid block-mining boundary issues.
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + Math.floor(EMERGENCY_DELAY / 2));
            await expect(ctx.market.triggerEmergencyRefund())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundNotYetAvailable");
        });

        it("succeeds at exactly resolveTime + delay", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY);
            await expect(ctx.market.triggerEmergencyRefund()).to.not.be.reverted;
        });

        it("succeeds after delay has expired", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1000);
            await expect(ctx.market.triggerEmergencyRefund()).to.not.be.reverted;
        });

        it("changes status to EMERGENCY_REFUND (index 3)", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            expect(await ctx.market.status()).to.equal(3); // EMERGENCY_REFUND
        });

        it("sets totalWinningSide to zero", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            expect(await ctx.market.totalWinningSide()).to.equal(0);
        });

        it("sets netPayoutPool to full pool (yesTotal + noTotal)", async function () {
            const ctx = await setupForEmergency();
            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            expect(await ctx.market.netPayoutPool()).to.equal(poolTotal);
        });

        it("sets outcomeInvalid to true", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            expect(await ctx.market.outcomeInvalid()).to.be.true;
        });

        it("finalAnswer remains bytes32(0) when Reality was never consulted", async function () {
            const ctx = await setupForEmergency();
            // Reality was never called — finalAnswer stays at default
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            expect(await ctx.market.finalAnswer()).to.equal(ethers.ZeroHash);
        });

        it("emits EmergencyRefundEnabled with correct poolTotal", async function () {
            const ctx = await setupForEmergency();
            const poolTotal = HUNDRED_USDC + HUNDRED_USDC * 2n;
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await expect(ctx.market.triggerEmergencyRefund())
                .to.emit(ctx.market, "EmergencyRefundEnabled")
                .withArgs(poolTotal);
        });

        it("is permissionless — anyone can trigger it", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            // carol is a random stranger
            await expect(ctx.market.connect(ctx.carol).triggerEmergencyRefund()).to.not.be.reverted;
        });

        it("no fees paid to treasury, creator, or resolver on emergency refund", async function () {
            const ctx = await setupForEmergency();
            const resolverBefore  = await ctx.token.balanceOf(ctx.resolver.address);
            const treasuryBefore  = await ctx.token.balanceOf(ctx.treasury.address);
            const creatorBefore   = await ctx.token.balanceOf(ctx.creator.address);

            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();

            expect(await ctx.token.balanceOf(ctx.resolver.address)).to.equal(resolverBefore);
            expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(treasuryBefore);
            expect(await ctx.token.balanceOf(ctx.creator.address)).to.equal(creatorBefore);
        });

        it("blocks finalize() after emergency refund is triggered", async function () {
            const ctx = await setupForEmergency();
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();

            // Now try to finalize — must fail because status is EMERGENCY_REFUND not LOCKED
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await expect(ctx.market.finalize())
                .to.be.revertedWithCustomError(ctx.market, "NotLocked");
        });

        it("EMERGENCY_REFUND_DELAY constant is 90 days (7776000 seconds)", async function () {
            const { market } = await deployAll();
            expect(await market.EMERGENCY_REFUND_DELAY()).to.equal(EMERGENCY_DELAY);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2 — claim() guarded against EMERGENCY_REFUND
    // ─────────────────────────────────────────────────────────────────

    describe("claim() — EMERGENCY_REFUND guard", function () {

        async function setupEmergencyActive() {
            const EMERGENCY_DELAY = 90 * 24 * 60 * 60;
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            return ctx;
        }

        it("reverts EmergencyRefundActive when status is EMERGENCY_REFUND", async function () {
            const ctx = await setupEmergencyActive();
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
        });

        it("reverts EmergencyRefundActive even for a user with large YES position", async function () {
            const ctx = await setupEmergencyActive();
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
        });

        it("reverts EmergencyRefundActive for NO user too", async function () {
            const ctx = await setupEmergencyActive();
            await expect(ctx.market.connect(ctx.bob).claim())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2 — claimRefund() in both paths
    // ─────────────────────────────────────────────────────────────────

    describe("claimRefund() — Phase 2 (both refund paths)", function () {

        const EMERGENCY_DELAY = 90 * 24 * 60 * 60;

        async function setupEmergencyActive() {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            return ctx;
        }

        // ── EMERGENCY_REFUND path ─────────────────────────────────────

        it("claimRefund works on EMERGENCY_REFUND — YES user gets full stake back", async function () {
            const ctx = await setupEmergencyActive();
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC);
        });

        it("claimRefund works on EMERGENCY_REFUND — NO user gets full stake back", async function () {
            const ctx = await setupEmergencyActive();
            const before = await ctx.token.balanceOf(ctx.bob.address);
            await ctx.market.connect(ctx.bob).claimRefund();
            expect(await ctx.token.balanceOf(ctx.bob.address) - before).to.equal(HUNDRED_USDC * 2n);
        });

        it("claimRefund on EMERGENCY_REFUND leaves market contract empty after all claims", async function () {
            const ctx = await setupEmergencyActive();
            await ctx.market.connect(ctx.alice).claimRefund();
            await ctx.market.connect(ctx.bob).claimRefund();
            expect(await ctx.token.balanceOf(await ctx.market.getAddress())).to.equal(0);
        });

        it("double claimRefund on EMERGENCY_REFUND reverts NothingToClaim", async function () {
            const ctx = await setupEmergencyActive();
            await ctx.market.connect(ctx.alice).claimRefund();
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("claimRefund on EMERGENCY_REFUND — no stake user reverts NothingToClaim", async function () {
            const ctx = await setupEmergencyActive();
            await expect(ctx.market.connect(ctx.carol).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });

        it("emits Claimed event on EMERGENCY_REFUND claimRefund", async function () {
            const ctx = await setupEmergencyActive();
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.emit(ctx.market, "Claimed")
                .withArgs(ctx.alice.address, HUNDRED_USDC);
        });

        // ── RESOLVED (no-winners) path still works ───────────────────

        it("claimRefund still works on RESOLVED+no-winners path (INVALID outcome)", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.finalize();
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC);
        });

        it("claimRefund still works on RESOLVED+no-winners (TOO_SOON outcome)", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
            await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.finalize();
            const before = await ctx.token.balanceOf(ctx.alice.address);
            await ctx.market.connect(ctx.alice).claimRefund();
            expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC);
        });

        // ── shared claimed flag: mutual exclusion preserved ──────────

        it("claim() and claimRefund() mutually exclusive on EMERGENCY_REFUND", async function () {
            const ctx = await setupEmergencyActive();
            // claim() reverts with EmergencyRefundActive
            await expect(ctx.market.connect(ctx.alice).claim())
                .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
            // claimRefund() succeeds
            await ctx.market.connect(ctx.alice).claimRefund();
            // Second claimRefund reverts
            await expect(ctx.market.connect(ctx.alice).claimRefund())
                .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 2 — Full flow end-to-end with emergency
    // ─────────────────────────────────────────────────────────────────

    describe("Full flow — emergency refund end-to-end", function () {

        const EMERGENCY_DELAY = 90 * 24 * 60 * 60;

        it("stuck market: LOCKED → 30d no resolution → emergency → all users refunded", async function () {
            const { token, market, alice, bob, treasury, creator, resolver, endTime, resolveTime } = await deployAll();

            // Place positions
            await placeYes(token, market, alice, HUNDRED_USDC);
            await placeNo(token, market, bob, HUNDRED_USDC * 2n);
            const poolTotal = HUNDRED_USDC * 3n;

            // Lock
            await time.increaseTo(endTime + 1);
            await market.lock();
            expect(await market.status()).to.equal(1); // LOCKED

            // Reality never responds — 90 days pass
            await time.increaseTo(resolveTime + EMERGENCY_DELAY + 1);

            // Verify finalize is still blocked (Reality not finalized)
            await expect(market.finalize()).to.be.revertedWithCustomError(market, "RealityNotFinalized");

            // Trigger emergency
            await expect(market.triggerEmergencyRefund())
                .to.emit(market, "EmergencyRefundEnabled")
                .withArgs(poolTotal);
            expect(await market.status()).to.equal(3); // EMERGENCY_REFUND

            // Both users recover full stake
            const aliceBefore = await token.balanceOf(alice.address);
            const bobBefore   = await token.balanceOf(bob.address);
            await market.connect(alice).claimRefund();
            await market.connect(bob).claimRefund();
            expect(await token.balanceOf(alice.address) - aliceBefore).to.equal(HUNDRED_USDC);
            expect(await token.balanceOf(bob.address)   - bobBefore).to.equal(HUNDRED_USDC * 2n);

            // Contract is empty
            expect(await token.balanceOf(await market.getAddress())).to.equal(0);

            // Treasury, creator, resolver untouched
            // (baseline: they may have received tokens from prior tests in other contexts)
        });

        it("emergency refund does NOT distribute fees or resolver reward", async function () {
            const { token, market, alice, bob, treasury, creator, resolver, endTime, resolveTime } = await deployAll();

            await placeYes(token, market, alice, HUNDRED_USDC);
            await placeNo(token, market, bob, HUNDRED_USDC * 2n);

            await time.increaseTo(endTime + 1);
            await market.lock();

            const resolverBefore  = await token.balanceOf(resolver.address);
            const treasuryBefore  = await token.balanceOf(treasury.address);
            const creatorBefore   = await token.balanceOf(creator.address);

            await time.increaseTo(resolveTime + EMERGENCY_DELAY + 1);
            await market.connect(resolver).triggerEmergencyRefund();

            // No balances changed for fee recipients
            expect(await token.balanceOf(resolver.address)).to.equal(resolverBefore);
            expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore);
            expect(await token.balanceOf(creator.address)).to.equal(creatorBefore);
        });

        it("finalize blocked after emergency, even if Reality subsequently finalizes", async function () {
            const { reality, market, alice, token, endTime, resolveTime } = await deployAll();

            await placeYes(token, market, alice, HUNDRED_USDC);
            await time.increaseTo(endTime + 1);
            await market.lock();
            await time.increaseTo(resolveTime + EMERGENCY_DELAY + 1);
            await market.triggerEmergencyRefund();

            // Reality finalizes AFTER emergency (too late)
            await reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await expect(market.finalize())
                .to.be.revertedWithCustomError(market, "NotLocked");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // PHASE 3 — Final Hardening
    // ─────────────────────────────────────────────────────────────────

    describe("Phase 3 — Final Hardening", function () {

        const EMERGENCY_DELAY = 90 * 24 * 60 * 60;

        // ── Constructor custom errors ─────────────────────────────────

        describe("Constructor — custom error validation", function () {

            async function deployTokenAndReality() {
                const MockERC20 = await ethers.getContractFactory("MockERC20");
                const token = await MockERC20.deploy("t", "T", SUPPLY);
                const MockReality = await ethers.getContractFactory("MockReality");
                const reality = await MockReality.deploy();
                return { token, reality };
            }

            it("reverts ZeroToken if token is address(0)", async function () {
                const { reality } = await deployTokenAndReality();
                const [, , , , treasury, creator] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    ethers.ZeroAddress, await reality.getAddress(),
                    treasury.address, creator.address, QUESTION_ID, "uri",
                    now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "ZeroToken");
            });

            it("reverts ZeroReality if reality is address(0)", async function () {
                const { token } = await deployTokenAndReality();
                const [, , , , treasury, creator] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    await token.getAddress(), ethers.ZeroAddress,
                    treasury.address, creator.address, QUESTION_ID, "uri",
                    now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "ZeroReality");
            });

            it("reverts ZeroTreasury if treasury is address(0)", async function () {
                const { token, reality } = await deployTokenAndReality();
                const [, , , , , creator] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    await token.getAddress(), await reality.getAddress(),
                    ethers.ZeroAddress, creator.address, QUESTION_ID, "uri",
                    now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "ZeroTreasury");
            });

            it("reverts ZeroCreator if creator is address(0)", async function () {
                const { token, reality } = await deployTokenAndReality();
                const [, , , , treasury] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    await token.getAddress(), await reality.getAddress(),
                    treasury.address, ethers.ZeroAddress, QUESTION_ID, "uri",
                    now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "ZeroCreator");
            });

            it("reverts ZeroQuestionId if questionId is bytes32(0)", async function () {
                const { token, reality } = await deployTokenAndReality();
                const [, , , , treasury, creator] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    await token.getAddress(), await reality.getAddress(),
                    treasury.address, creator.address,
                    ethers.ZeroHash,  // zero questionId
                    "uri", now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "ZeroQuestionId");
            });

            it("reverts EmptyMetadataURI if metadataURI is empty string", async function () {
                const { token, reality } = await deployTokenAndReality();
                const [, , , , treasury, creator] = await ethers.getSigners();
                const now = await time.latest();
                const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
                const { market: ref } = await deployAll();

                await expect(BopsterMarket.deploy(
                    await token.getAddress(), await reality.getAddress(),
                    treasury.address, creator.address,
                    QUESTION_ID,
                    "",               // empty metadataURI
                    now + 3600, now + 7200, 100, 100, 100,
                )).to.be.revertedWithCustomError(ref, "EmptyMetadataURI");
            });

        });

        // ── triggerEmergencyRefund() — RealityAlreadyFinalized blocker ──

        describe("triggerEmergencyRefund() — RealityAlreadyFinalized guard", function () {

            it("reverts RealityAlreadyFinalized if Reality is already finalized", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await advanceAndLock(ctx.market, ctx.endTime);

                // Reality finalizes with YES answer
                await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
                // Advance past emergency delay
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);

                // triggerEmergencyRefund must revert — Reality is finalized,
                // the correct action is to call finalize()
                await expect(ctx.market.triggerEmergencyRefund())
                    .to.be.revertedWithCustomError(ctx.market, "RealityAlreadyFinalized");
            });

            it("reverts RealityAlreadyFinalized even if finalize() has not been called yet", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
                await advanceAndLock(ctx.market, ctx.endTime);

                // Reality answers INVALID (refund path), but it IS finalized
                await ctx.reality.setResult(QUESTION_ID, ANSWER_INVALID, true);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);

                // Market is still LOCKED (finalize not called), delay elapsed,
                // but Reality IS finalized — emergency must be blocked
                await expect(ctx.market.triggerEmergencyRefund())
                    .to.be.revertedWithCustomError(ctx.market, "RealityAlreadyFinalized");
            });

            it("succeeds when Reality is NOT finalized after delay", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await advanceAndLock(ctx.market, ctx.endTime);
                // Reality never answers
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);

                await expect(ctx.market.triggerEmergencyRefund()).to.not.be.reverted;
                expect(await ctx.market.status()).to.equal(3); // EMERGENCY_REFUND
            });

        });

        // ── Emergency refund state consistency ───────────────────────

        describe("triggerEmergencyRefund() — state consistency", function () {

            async function triggerEmergency() {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();
                return ctx;
            }

            it("outcomeYes is explicitly false after triggerEmergencyRefund()", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.outcomeYes()).to.be.false;
            });

            it("outcomeInvalid is true after triggerEmergencyRefund()", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.outcomeInvalid()).to.be.true;
            });

            it("totalWinningSide is 0 after triggerEmergencyRefund()", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.totalWinningSide()).to.equal(0);
            });

            it("netPayoutPool equals full pool after triggerEmergencyRefund()", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.netPayoutPool()).to.equal(HUNDRED_USDC * 3n);
            });

            it("status is EMERGENCY_REFUND (3) after triggerEmergencyRefund()", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.status()).to.equal(3);
            });

            it("finalAnswer stays bytes32(0) — Reality was never consulted", async function () {
                const ctx = await triggerEmergency();
                expect(await ctx.market.finalAnswer()).to.equal(ethers.ZeroHash);
            });

        });

        // ── claim() reverts EmergencyRefundActive ────────────────────

        describe("claim() — EmergencyRefundActive in Phase 3 context", function () {

            it("claim() reverts EmergencyRefundActive for a user with only YES stake", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC * 5n);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();

                await expect(ctx.market.connect(ctx.alice).claim())
                    .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
            });

            it("claim() reverts EmergencyRefundActive even with NO position only", async function () {
                const ctx = await deployAll();
                await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 3n);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();

                await expect(ctx.market.connect(ctx.bob).claim())
                    .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
            });

        });

        // ── claimRefund() in emergency path ─────────────────────────

        describe("claimRefund() — emergency path correctness", function () {

            it("user with both YES and NO stake gets full combined refund on emergency", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await placeNo(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC * 2n);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();

                const before = await ctx.token.balanceOf(ctx.alice.address);
                await ctx.market.connect(ctx.alice).claimRefund();
                const got = await ctx.token.balanceOf(ctx.alice.address) - before;
                expect(got).to.equal(HUNDRED_USDC * 3n);
            });

            it("contract is empty after all users claim refund on emergency", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();

                await ctx.market.connect(ctx.alice).claimRefund();
                await ctx.market.connect(ctx.bob).claimRefund();

                expect(await ctx.token.balanceOf(await ctx.market.getAddress())).to.equal(0);
            });

            it("claimRefund after emergency cannot be followed by claim()", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await advanceAndLock(ctx.market, ctx.endTime);
                await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
                await ctx.market.triggerEmergencyRefund();

                // claimRefund works
                await ctx.market.connect(ctx.alice).claimRefund();

                // Subsequent claim() is still blocked (shared claimed flag)
                await expect(ctx.market.connect(ctx.alice).claim())
                    .to.be.revertedWithCustomError(ctx.market, "EmergencyRefundActive");
            });

        });

        // ── isSettledTooSoon no longer called ────────────────────────

        describe("finalize() — isSettledTooSoon removed (no external call)", function () {

            it("ANSWER_TOO_SOON still goes to refund path without any extra Reality call", async function () {
                const ctx = await deployAll();
                await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
                await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
                await advanceAndLock(ctx.market, ctx.endTime);
                const ANSWER_TOO_SOON = await ctx.market.ANSWER_TOO_SOON();
                await ctx.reality.setResult(QUESTION_ID, ANSWER_TOO_SOON, true);
                // setSettledTooSoon is NOT called — contract must not rely on it
                await time.increaseTo(ctx.resolveTime + 1);

                await expect(ctx.market.connect(ctx.resolver).finalize()).to.not.be.reverted;
                expect(await ctx.market.outcomeInvalid()).to.be.true;
                expect(await ctx.market.outcomeYes()).to.be.false;
                expect(await ctx.market.totalWinningSide()).to.equal(0);
                expect(await ctx.market.netPayoutPool()).to.equal(HUNDRED_USDC * 2n);
            });

        });

    });

    // ─────────────────────────────────────────────────────────────────
    // F3 — sweepDust()
    // ─────────────────────────────────────────────────────────────────

    describe("sweepDust()", function () {

        const ONE_YEAR = 365 * 24 * 60 * 60;
        const EMERGENCY_DELAY = 90 * 24 * 60 * 60;

        async function resolvedYesContext() {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);
            return ctx;
        }

        async function emergencyContext() {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();
            return ctx;
        }

        it("exposes SWEEP_DUST_DELAY = 365 days", async function () {
            const { market } = await deployAll();
            expect(await market.SWEEP_DUST_DELAY()).to.equal(ONE_YEAR);
        });

        it("reverts NotResolved if status is OPEN", async function () {
            const { market } = await deployAll();
            await expect(market.sweepDust())
                .to.be.revertedWithCustomError(market, "NotResolved");
        });

        it("reverts NotResolved if status is LOCKED", async function () {
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await advanceAndLock(ctx.market, ctx.endTime);
            await expect(ctx.market.sweepDust())
                .to.be.revertedWithCustomError(ctx.market, "NotResolved");
        });

        it("reverts SweepDustNotYetAvailable before delay expires (RESOLVED)", async function () {
            const ctx = await resolvedYesContext();
            await time.increase(ONE_YEAR - 100);
            await expect(ctx.market.sweepDust())
                .to.be.revertedWithCustomError(ctx.market, "SweepDustNotYetAvailable");
        });

        it("reverts SweepDustNotYetAvailable before delay expires (EMERGENCY_REFUND)", async function () {
            // Build emergency context but do not advance time arbitrarily —
            // we want to be strictly < resolveTime + SWEEP_DUST_DELAY.
            const ctx = await deployAll();
            await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
            await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC * 2n);
            await advanceAndLock(ctx.market, ctx.endTime);
            await time.increaseTo(ctx.resolveTime + EMERGENCY_DELAY + 1);
            await ctx.market.triggerEmergencyRefund();

            // Time is now ≈ resolveTime + 90 days; still well below 365 days.
            await expect(ctx.market.sweepDust())
                .to.be.revertedWithCustomError(ctx.market, "SweepDustNotYetAvailable");
        });

        it("reverts NoDust when no residual exists (no positions, no winnings)", async function () {
            const ctx = await deployAll();
            // Lock and resolve a YES market with no positions placed
            await time.increaseTo(ctx.endTime + 1);
            await ctx.reality.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(ctx.resolveTime + 1);
            await ctx.market.connect(ctx.resolver).finalize();

            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);
            await expect(ctx.market.sweepDust())
                .to.be.revertedWithCustomError(ctx.market, "NoDust");
        });

        it("sweeps only integer-division dust when all winners have claimed", async function () {
            // Use carefully chosen amounts that produce non-zero dust.
            // Pool = 3 wei (1 yes, 2 no), fees zero for simplicity.
            const ctx = await deployAll({ protocolFeeBps: 0, creatorFeeBps: 0, resolverBps: 0 });
            const tiny = 3n;
            await placeYes(ctx.token, ctx.market, ctx.alice, tiny);
            await placeYes(ctx.token, ctx.market, ctx.bob,   tiny);
            await placeYes(ctx.token, ctx.market, ctx.carol, tiny);
            await placeNo(ctx.token, ctx.market, ctx.bob, 10n); // ensure pool is mixed
            await advanceAndLock(ctx.market, ctx.endTime);
            await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

            await ctx.market.connect(ctx.alice).claim();
            await ctx.market.connect(ctx.bob).claim();
            await ctx.market.connect(ctx.carol).claim();

            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            const treasuryBefore = await ctx.token.balanceOf(ctx.treasury.address);
            await expect(ctx.market.sweepDust()).to.not.be.reverted;
            const treasuryAfter = await ctx.token.balanceOf(ctx.treasury.address);
            expect(treasuryAfter - treasuryBefore).to.be.gt(0);

            // Contract is fully emptied
            expect(await ctx.token.balanceOf(await ctx.market.getAddress())).to.equal(0);
        });

        it("sweeps tokens transferred directly to the contract bypassing positions", async function () {
            const ctx = await resolvedYesContext();
            // alice transfers tokens directly to the market contract
            const directAmount = HUNDRED_USDC * 5n;
            await ctx.token.connect(ctx.alice).transfer(await ctx.market.getAddress(), directAmount);

            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            const treasuryBefore = await ctx.token.balanceOf(ctx.treasury.address);
            await ctx.market.sweepDust();
            const treasuryAfter = await ctx.token.balanceOf(ctx.treasury.address);

            // The directAmount must have ended up in treasury.
            // (There may be additional minor division dust on top.)
            expect(treasuryAfter - treasuryBefore).to.be.gte(directAmount);
        });

        it("unclaimed users forfeit their payout after sweep (documented behaviour)", async function () {
            // After SWEEP_DUST_DELAY, a user who has not claimed loses access
            // to their payout. This is the conscious trade-off documented in
            // the contract NatSpec.
            const ctx = await resolvedYesContext();
            // alice (winner) has NOT claimed yet
            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            await ctx.market.sweepDust();

            // alice's claim will now revert because the contract is empty
            // and safeTransfer cannot transfer the expected payout.
            await expect(ctx.market.connect(ctx.alice).claim()).to.be.reverted;
        });

        it("destination is always treasury and is immutable", async function () {
            const ctx = await resolvedYesContext();
            // Direct dust deposit
            await ctx.token.connect(ctx.alice).transfer(await ctx.market.getAddress(), HUNDRED_USDC);
            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            // Even when carol (random caller) sweeps, dust goes to treasury
            const treasuryBefore = await ctx.token.balanceOf(ctx.treasury.address);
            const carolBefore    = await ctx.token.balanceOf(ctx.carol.address);
            await ctx.market.connect(ctx.carol).sweepDust();
            const treasuryAfter = await ctx.token.balanceOf(ctx.treasury.address);
            const carolAfter    = await ctx.token.balanceOf(ctx.carol.address);

            expect(treasuryAfter).to.be.gt(treasuryBefore);
            expect(carolAfter).to.equal(carolBefore);
        });

        it("is permissionless — anyone can call sweepDust()", async function () {
            const ctx = await resolvedYesContext();
            await ctx.token.connect(ctx.alice).transfer(await ctx.market.getAddress(), HUNDRED_USDC);
            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);
            await expect(ctx.market.connect(ctx.carol).sweepDust()).to.not.be.reverted;
        });

        it("emits DustSwept(treasury, amount)", async function () {
            const ctx = await resolvedYesContext();
            const directAmount = HUNDRED_USDC * 7n;
            await ctx.token.connect(ctx.alice).transfer(await ctx.market.getAddress(), directAmount);
            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            await expect(ctx.market.sweepDust())
                .to.emit(ctx.market, "DustSwept")
                .withArgs(ctx.treasury.address, anyValueGte(directAmount));
        });

        it("subsequent sweepDust() reverts NoDust once balance is fully drained", async function () {
            const ctx = await resolvedYesContext();
            // Everyone claims first so balance shrinks deterministically
            await ctx.market.connect(ctx.alice).claim();
            await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);

            // Add direct-transfer dust
            await ctx.token.connect(ctx.bob).transfer(await ctx.market.getAddress(), HUNDRED_USDC);

            await ctx.market.sweepDust();
            // Contract empty now
            expect(await ctx.token.balanceOf(await ctx.market.getAddress())).to.equal(0);

            await expect(ctx.market.sweepDust())
                .to.be.revertedWithCustomError(ctx.market, "NoDust");
        });

    });
});

// Custom matcher: amount >= expected (used for DustSwept exact amount may
// include integer-division dust on top of the directly-transferred amount).
function anyValueGte(expected) {
    return (actual) => {
        const a = typeof actual === "bigint" ? actual : BigInt(actual);
        const e = typeof expected === "bigint" ? expected : BigInt(expected);
        if (a < e) {
            throw new Error(`expected swept amount >= ${e}, got ${a}`);
        }
        return true;
    };
}
