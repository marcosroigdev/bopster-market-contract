const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_YES = ethers.zeroPadValue(ethers.toBeHex(1), 32);
const ANSWER_NO = ethers.zeroPadValue(ethers.toBeHex(0), 32);

const ONE_USDC = ethers.parseUnits("1", 6);
const HUNDRED_USDC = ethers.parseUnits("100", 6);
const SUPPLY = ethers.parseUnits("1000000", 6);

const QUESTION_ID = ethers.encodeBytes32String("q-sec");
const ONE_YEAR = 365 * 24 * 60 * 60;

const PROTOCOL_FEE_BPS = 200;
const CREATOR_FEE_BPS = 100;
const RESOLVER_BPS = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — standard ERC20 setup (mirrors BopsterMarket.test.js)
// ─────────────────────────────────────────────────────────────────────────────

async function deployAll(overrides = {}) {
    const [deployer, creator, alice, bob, carol, treasury, resolver] =
        await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDC", "mUSDC", SUPPLY);

    await token.transfer(alice.address, ethers.parseUnits("10000", 6));
    await token.transfer(bob.address, ethers.parseUnits("10000", 6));
    await token.transfer(carol.address, ethers.parseUnits("10000", 6));
    await token.transfer(resolver.address, ethers.parseUnits("1000", 6));

    const MockReality = await ethers.getContractFactory("MockReality");
    const reality = await MockReality.deploy();

    const now = await time.latest();
    const endTime = overrides.endTime ?? now + 3600;
    const resolveTime = overrides.resolveTime ?? endTime + 3600;

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
        overrides.protocolFeeBps ?? PROTOCOL_FEE_BPS,
        overrides.creatorFeeBps ?? CREATOR_FEE_BPS,
        overrides.resolverBps ?? RESOLVER_BPS,
    );

    return { token, reality, market, deployer, creator, alice, bob, carol, treasury, resolver, endTime, resolveTime };
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — malicious (reentrant) token setup
// ─────────────────────────────────────────────────────────────────────────────

async function deployWithMaliciousToken(overrides = {}) {
    const [deployer, creator, attacker, treasury, resolver] = await ethers.getSigners();

    const MaliciousToken = await ethers.getContractFactory("MaliciousToken");
    const token = await MaliciousToken.deploy(SUPPLY);

    await token.transfer(attacker.address, ethers.parseUnits("10000", 6));
    await token.transfer(resolver.address, ethers.parseUnits("1000", 6));

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
        "ipfs://test-metadata",
        endTime,
        resolveTime,
        overrides.protocolFeeBps ?? 0,
        overrides.creatorFeeBps ?? 0,
        overrides.resolverBps ?? 0,
    );

    await token.setTarget(await market.getAddress());

    return { token, reality, market, deployer, creator, attacker, treasury, resolver, endTime, resolveTime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reentrancy protection (ERC777 / callback-token threat model)
// ─────────────────────────────────────────────────────────────────────────────

describe("BopsterMarket — reentrancy protection", function () {

    it("blocks reentrancy into positionYes() during transferFrom callback", async function () {
        const ctx = await deployWithMaliciousToken();
        await ctx.token.connect(ctx.attacker).approve(await ctx.market.getAddress(), HUNDRED_USDC);
        await ctx.token.setAttackMode(3); // re-enter positionYes during transferFrom

        await expect(
            ctx.market.connect(ctx.attacker).positionYes(HUNDRED_USDC),
        ).to.be.revertedWithCustomError(ctx.market, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrancy into claim() during payout transfer", async function () {
        const ctx = await deployWithMaliciousToken();
        await ctx.token.connect(ctx.attacker).approve(await ctx.market.getAddress(), HUNDRED_USDC);
        await ctx.market.connect(ctx.attacker).positionYes(HUNDRED_USDC);

        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        await ctx.token.setAttackMode(1); // re-enter claim() during the payout transfer

        await expect(
            ctx.market.connect(ctx.attacker).claim(),
        ).to.be.revertedWithCustomError(ctx.market, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrancy into claimRefund() during refund transfer", async function () {
        const ctx = await deployWithMaliciousToken();
        await ctx.token.connect(ctx.attacker).approve(await ctx.market.getAddress(), HUNDRED_USDC);
        await ctx.market.connect(ctx.attacker).positionYes(HUNDRED_USDC);

        await advanceAndLock(ctx.market, ctx.endTime);
        // INVALID-style answer (max uint) → refund path
        const ANSWER_INVALID = ethers.zeroPadValue(
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            32,
        );
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_INVALID, ctx.resolveTime, ctx.resolver);

        await ctx.token.setAttackMode(2); // re-enter claimRefund() during the refund transfer

        await expect(
            ctx.market.connect(ctx.attacker).claimRefund(),
        ).to.be.revertedWithCustomError(ctx.market, "ReentrancyGuardReentrantCall");
    });

    it("blocks reentrancy into sweepDust() during the sweep transfer", async function () {
        const ctx = await deployWithMaliciousToken();
        await ctx.token.connect(ctx.attacker).approve(await ctx.market.getAddress(), HUNDRED_USDC);
        await ctx.market.connect(ctx.attacker).positionYes(HUNDRED_USDC);

        await advanceAndLock(ctx.market, ctx.endTime);
        // No winner → leaves the whole pool as residual to be swept later
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_NO, ctx.resolveTime, ctx.resolver);

        await time.increaseTo(ctx.resolveTime + ONE_YEAR + 1);
        await ctx.token.setAttackMode(4); // re-enter sweepDust() during the sweep transfer

        await expect(ctx.market.sweepDust()).to.be.revertedWithCustomError(
            ctx.market,
            "ReentrancyGuardReentrantCall",
        );
    });

    it("a non-attacking malicious token behaves like a normal ERC20 (control)", async function () {
        const ctx = await deployWithMaliciousToken();
        await ctx.token.connect(ctx.attacker).approve(await ctx.market.getAddress(), HUNDRED_USDC);
        // attackMode stays 0 → no reentry attempted
        await expect(ctx.market.connect(ctx.attacker).positionYes(HUNDRED_USDC)).to.not.be.reverted;
        expect(await ctx.market.totalYes()).to.equal(HUNDRED_USDC);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Binary answer resolving to an unbacked side (winning side empty)
// ─────────────────────────────────────────────────────────────────────────────

describe("BopsterMarket — binary outcome with an empty winning side", function () {

    it("YES wins but only NO was bet → refund path, outcomeInvalid stays false", async function () {
        const ctx = await deployAll();
        await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        // Binary outcome recorded, but nobody backed the winning side.
        expect(await ctx.market.outcomeYes()).to.be.true;
        expect(await ctx.market.outcomeInvalid()).to.be.false;
        expect(await ctx.market.totalWinningSide()).to.equal(0);
        // Full pool stays claimable as refund (no fees taken).
        expect(await ctx.market.netPayoutPool()).to.equal(HUNDRED_USDC);
    });

    it("no fees are taken when the winning side is empty", async function () {
        const ctx = await deployAll();
        await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
        const treasuryBefore = await ctx.token.balanceOf(ctx.treasury.address);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);
        expect(await ctx.token.balanceOf(ctx.treasury.address)).to.equal(treasuryBefore);
    });

    it("the unbacked-side loser recovers the full stake via claimRefund()", async function () {
        const ctx = await deployAll();
        await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        const before = await ctx.token.balanceOf(ctx.bob.address);
        await ctx.market.connect(ctx.bob).claimRefund();
        expect(await ctx.token.balanceOf(ctx.bob.address) - before).to.equal(HUNDRED_USDC);
    });

    it("claim() reverts with NothingToClaim when the winning side is empty", async function () {
        const ctx = await deployAll();
        await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        await expect(ctx.market.connect(ctx.bob).claim())
            .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
    });

    it("symmetric case: NO wins but only YES was bet → full refund", async function () {
        const ctx = await deployAll();
        await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_NO, ctx.resolveTime, ctx.resolver);

        expect(await ctx.market.totalWinningSide()).to.equal(0);
        const before = await ctx.token.balanceOf(ctx.alice.address);
        await ctx.market.connect(ctx.alice).claimRefund();
        expect(await ctx.token.balanceOf(ctx.alice.address) - before).to.equal(HUNDRED_USDC);
    });

    it("contract is fully drained after every loser refunds on an empty-winning-side market", async function () {
        const ctx = await deployAll();
        await placeNo(ctx.token, ctx.market, ctx.bob, HUNDRED_USDC);
        await placeNo(ctx.token, ctx.market, ctx.carol, HUNDRED_USDC * 2n);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        await ctx.market.connect(ctx.bob).claimRefund();
        await ctx.market.connect(ctx.carol).claimRefund();
        expect(await ctx.token.balanceOf(await ctx.market.getAddress())).to.equal(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pro-rata payout that rounds down to zero (dust winner)
// ─────────────────────────────────────────────────────────────────────────────

describe("BopsterMarket — payout rounding to zero", function () {

    it("a winner whose pro-rata payout rounds to 0 reverts with NothingToClaim", async function () {
        // Fees shrink netPayoutPool below totalWinningSide, so a 1-wei winning
        // stake against a large winning side rounds to a 0 payout.
        const ctx = await deployAll({
            protocolFeeBps: 500,
            creatorFeeBps: 300,
            resolverBps: 200,
        }); // 10% total fees

        // Large winning stake from alice, 1-wei winning stake from bob.
        await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
        await placeYes(ctx.token, ctx.market, ctx.bob, 1n);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        // bob: payout = 1 * netPayoutPool / totalWinningSide
        //            = 1 * (~90.00009 USDC) / (100.000001 USDC) = 0  (integer division)
        const net = await ctx.market.netPayoutPool();
        const winning = await ctx.market.totalWinningSide();
        expect((1n * net) / winning).to.equal(0n); // sanity: it really rounds to 0

        await expect(ctx.market.connect(ctx.bob).claim())
            .to.be.revertedWithCustomError(ctx.market, "NothingToClaim");
    });

    it("the large winner in the same market still claims successfully", async function () {
        const ctx = await deployAll({
            protocolFeeBps: 500,
            creatorFeeBps: 300,
            resolverBps: 200,
        });
        await placeYes(ctx.token, ctx.market, ctx.alice, HUNDRED_USDC);
        await placeYes(ctx.token, ctx.market, ctx.bob, 1n);
        await advanceAndLock(ctx.market, ctx.endTime);
        await resolveMarket(ctx.reality, ctx.market, QUESTION_ID, ANSWER_YES, ctx.resolveTime, ctx.resolver);

        const before = await ctx.token.balanceOf(ctx.alice.address);
        await ctx.market.connect(ctx.alice).claim();
        expect(await ctx.token.balanceOf(ctx.alice.address)).to.be.gt(before);
    });
});
