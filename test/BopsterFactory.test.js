const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const QUESTION_ID   = ethers.encodeBytes32String("factory-q1");
const METADATA_URI  = "ipfs://bafybeitest";
const SUPPLY        = ethers.parseUnits("1000000", 6);

const PROTOCOL_FEE_BPS = 200;
const CREATOR_FEE_BPS  = 100;
const RESOLVER_BPS     = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function deployFactory(overrides = {}) {
    const [deployer, treasury, alice, admin] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Mock USDC", "mUSDC", SUPPLY);

    const MockReality = await ethers.getContractFactory("MockReality");
    const reality = await MockReality.deploy();

    const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
    const factory = await BopsterFactory.deploy(
        overrides.token    ?? await token.getAddress(),
        overrides.reality  ?? await reality.getAddress(),
        overrides.treasury ?? treasury.address,
        overrides.admin    ?? admin.address,
        overrides.protocolFeeBps ?? PROTOCOL_FEE_BPS,
        overrides.creatorFeeBps  ?? CREATOR_FEE_BPS,
        overrides.resolverBps    ?? RESOLVER_BPS,
    );

    return { factory, token, reality, deployer, treasury, alice, admin };
}

async function createMarketDefaults(factory, caller, overrides = {}) {
    const now = await time.latest();
    return factory.connect(caller).createMarket(
        overrides.questionId   ?? QUESTION_ID,
        overrides.metadataURI  ?? METADATA_URI,
        overrides.endTime      ?? (now + 3600),
        overrides.resolveTime  ?? (now + 7200),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

describe("BopsterFactory", function () {

    // ─────────────────────────────────────────────────────────────────
    // DEPLOYMENT
    // ─────────────────────────────────────────────────────────────────

    describe("Deployment", function () {

        it("stores immutable config correctly", async function () {
            const { factory, token, reality, treasury } = await deployFactory();
            expect(await factory.token()).to.equal(await token.getAddress());
            expect(await factory.reality()).to.equal(await reality.getAddress());
            expect(await factory.treasury()).to.equal(treasury.address);
            expect(await factory.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);
            expect(await factory.creatorFeeBps()).to.equal(CREATOR_FEE_BPS);
            expect(await factory.resolverRewardBps()).to.equal(RESOLVER_BPS);
        });

        it("starts with zero markets", async function () {
            const { factory } = await deployFactory();
            expect(await factory.marketsCount()).to.equal(0);
        });

        it("reverts BadAddress if token is zero", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, treasury, , admin] = await ethers.getSigners();
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();
            await expect(BopsterFactory.deploy(
                ethers.ZeroAddress, await reality.getAddress(), treasury.address, admin.address,
                100, 100, 100
            )).to.be.revertedWithCustomError({ interface: BopsterFactory.interface }, "BadAddress");
        });

        it("reverts BadAddress if reality is zero", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, treasury, , admin] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            await expect(BopsterFactory.deploy(
                await token.getAddress(), ethers.ZeroAddress, treasury.address, admin.address,
                100, 100, 100
            )).to.be.revertedWithCustomError({ interface: BopsterFactory.interface }, "BadAddress");
        });

        it("reverts BadAddress if treasury is zero", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, , , admin] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();
            await expect(BopsterFactory.deploy(
                await token.getAddress(), await reality.getAddress(), ethers.ZeroAddress, admin.address,
                100, 100, 100
            )).to.be.revertedWithCustomError({ interface: BopsterFactory.interface }, "BadAddress");
        });

        // F4: admin must not be zero
        it("reverts when admin is zero address (OpenZeppelin OwnableInvalidOwner)", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, treasury] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();
            // Ownable in OZ v5 reverts with OwnableInvalidOwner before our BadAddress check.
            await expect(BopsterFactory.deploy(
                await token.getAddress(), await reality.getAddress(), treasury.address, ethers.ZeroAddress,
                100, 100, 100
            )).to.be.reverted;
        });

        it("reverts BadFees if total fees exceed 10%", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, treasury, , admin] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();
            await expect(BopsterFactory.deploy(
                await token.getAddress(), await reality.getAddress(), treasury.address, admin.address,
                500, 400, 200 // total = 1100 bps
            )).to.be.revertedWithCustomError({ interface: BopsterFactory.interface }, "BadFees");
        });

        it("accepts fees exactly at 10% boundary", async function () {
            const BopsterFactory = await ethers.getContractFactory("BopsterFactory");
            const [, treasury, , admin] = await ethers.getSigners();
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const token = await MockERC20.deploy("t", "T", SUPPLY);
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = await MockReality.deploy();
            await expect(BopsterFactory.deploy(
                await token.getAddress(), await reality.getAddress(), treasury.address, admin.address,
                400, 300, 300 // total = 1000 bps exactly
            )).to.not.be.reverted;
        });

        // F4: owner() is set to _admin
        it("sets owner() to the _admin parameter", async function () {
            const { factory, admin } = await deployFactory();
            expect(await factory.owner()).to.equal(admin.address);
        });

        // F4: paused() defaults to false
        it("starts unpaused", async function () {
            const { factory } = await deployFactory();
            expect(await factory.paused()).to.be.false;
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // createMarket — validation
    // ─────────────────────────────────────────────────────────────────

    describe("createMarket() — validation", function () {

        it("reverts BadQuestion if questionId is zero", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                ethers.ZeroHash, METADATA_URI, now + 3600, now + 7200
            )).to.be.revertedWithCustomError(factory, "BadQuestion");
        });

        it("reverts BadURI if metadataURI is empty", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, "", now + 3600, now + 7200
            )).to.be.revertedWithCustomError(factory, "BadURI");
        });

        it("reverts BadTimes if endTime is zero", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, 0, now + 7200
            )).to.be.revertedWithCustomError(factory, "BadTimes");
        });

        it("reverts BadTimes if resolveTime is zero", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, now + 3600, 0
            )).to.be.revertedWithCustomError(factory, "BadTimes");
        });

        it("reverts BadTimes if endTime >= resolveTime", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, now + 3600, now + 3600
            )).to.be.revertedWithCustomError(factory, "BadTimes");
        });

        it("reverts BadTimes if endTime > resolveTime", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, now + 7200, now + 3600
            )).to.be.revertedWithCustomError(factory, "BadTimes");
        });

        // ── Market duration validation (MIGRATION: Phase 4) ──

        it("reverts EndTimeTooSoon if endTime < block.timestamp (strictly past)", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                now - 1,       // endTime in the past
                now + 7200,
            )).to.be.revertedWithCustomError(factory, "EndTimeTooSoon");
        });

        it("reverts EndTimeTooSoon if endTime == block.timestamp (edge case)", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await time.increase(1);
            const ts = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                ts,            // endTime == block.timestamp
                ts + 7200,
            )).to.be.revertedWithCustomError(factory, "EndTimeTooSoon");
        });

        it("reverts EndTimeTooSoon if endTime is only 10 minutes away", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                now + 600,     // 10 minutes < MIN_MARKET_DURATION (15 min)
                now + 7200,
            )).to.be.revertedWithCustomError(factory, "EndTimeTooSoon");
        });

        it("accepts endTime exactly at the minimum (15 minutes)", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            // +901 accounts for Hardhat's 1s block.timestamp auto-increment.
            // endTime = now+901 → block.timestamp ≈ now+1 → duration ≈ 900s (15 min).
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                now + 901,
                now + 901 + 3600,
            )).to.not.be.reverted;
        });

        it("accepts endTime exactly at the maximum (10 days)", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const MAX_DURATION = 10 * 86400;
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                now + MAX_DURATION,     // exactly MAX_MARKET_DURATION
                now + MAX_DURATION + 3600,
            )).to.not.be.reverted;
        });

        it("reverts EndTimeTooFar if endTime exceeds 10 days", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const MAX_DURATION = 10 * 86400;
            // +2 accounts for Hardhat's 1s block.timestamp auto-increment,
            // so endTime > block.timestamp + MAX_DURATION is reliably true.
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                now + MAX_DURATION + 2,
                now + MAX_DURATION + 3602,
            )).to.be.revertedWithCustomError(factory, "EndTimeTooFar");
        });

        // ── Resolution window validation (F2) ──

        it("reverts ResolutionWindowTooLarge if (resolveTime - endTime) > 30 days", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const THIRTY_DAYS = 30 * 86400;
            const endTime = now + 3600;
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                endTime,
                endTime + THIRTY_DAYS + 1, // 1 second over the bound
            )).to.be.revertedWithCustomError(factory, "ResolutionWindowTooLarge");
        });

        it("accepts (resolveTime - endTime) exactly at the maximum (30 days)", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const THIRTY_DAYS = 30 * 86400;
            const endTime = now + 3600;
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                endTime,
                endTime + THIRTY_DAYS,
            )).to.not.be.reverted;
        });

        it("accepts a small resolution window (5 minutes) — current frontend default", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const endTime = now + 3600;
            await expect(factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI,
                endTime,
                endTime + 300, // 5 minutes
            )).to.not.be.reverted;
        });

        it("exposes MAX_RESOLUTION_WINDOW via getter", async function () {
            const { factory } = await deployFactory();
            expect(await factory.MAX_RESOLUTION_WINDOW()).to.equal(30 * 86400);
            expect(await factory.maxResolutionWindow()).to.equal(30 * 86400);
        });

        it("exposes MIN_MARKET_DURATION via the minMarketDuration() helper", async function () {
            const { factory } = await deployFactory();
            expect(await factory.MIN_MARKET_DURATION()).to.equal(15 * 60);
            expect(await factory.minMarketDuration()).to.equal(15 * 60);
        });

        it("exposes MAX_MARKET_DURATION via the maxMarketDuration() helper", async function () {
            const { factory } = await deployFactory();
            expect(await factory.MAX_MARKET_DURATION()).to.equal(10 * 86400);
            expect(await factory.maxMarketDuration()).to.equal(10 * 86400);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // createMarket — successful deployment
    // ─────────────────────────────────────────────────────────────────

    describe("createMarket() — successful deployment", function () {

        it("deploys a BopsterMarket and returns its address", async function () {
            const { factory, alice } = await deployFactory();
            const tx = await createMarketDefaults(factory, alice);
            const receipt = await tx.wait();
            // Check that a contract was deployed (market address is non-zero)
            const marketAddr = await factory.allMarkets(0);
            expect(marketAddr).to.not.equal(ethers.ZeroAddress);
            expect(await ethers.provider.getCode(marketAddr)).to.not.equal("0x");
        });

        it("increments marketsCount", async function () {
            const { factory, alice } = await deployFactory();
            expect(await factory.marketsCount()).to.equal(0);
            await createMarketDefaults(factory, alice);
            expect(await factory.marketsCount()).to.equal(1);
            await createMarketDefaults(factory, alice);
            expect(await factory.marketsCount()).to.equal(2);
        });

        it("emits MarketCreated event with correct parameters", async function () {
            const { factory, alice } = await deployFactory();
            const now = await time.latest();
            const endTime    = now + 3600;
            const resolveTime = now + 7200;

            const tx = await factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, endTime, resolveTime
            );
            const receipt = await tx.wait();
            const marketAddr = await factory.allMarkets(0);

            await expect(tx)
                .to.emit(factory, "MarketCreated")
                .withArgs(marketAddr, alice.address, QUESTION_ID, endTime, resolveTime, METADATA_URI);
        });

        it("deployed market has correct config from factory defaults", async function () {
            const { factory, alice, token, reality, treasury } = await deployFactory();
            await createMarketDefaults(factory, alice);
            const marketAddr = await factory.allMarkets(0);
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const market = BopsterMarket.attach(marketAddr);

            expect(await market.token()).to.equal(await token.getAddress());
            expect(await market.reality()).to.equal(await reality.getAddress());
            expect(await market.treasury()).to.equal(treasury.address);
            expect(await market.creator()).to.equal(alice.address);
            expect(await market.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);
            expect(await market.creatorFeeBps()).to.equal(CREATOR_FEE_BPS);
            expect(await market.resolverRewardBps()).to.equal(RESOLVER_BPS);
            expect(await market.questionId()).to.equal(QUESTION_ID);
        });

        it("deployed market starts in OPEN status", async function () {
            const { factory, alice } = await deployFactory();
            await createMarketDefaults(factory, alice);
            const marketAddr = await factory.allMarkets(0);
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const market = BopsterMarket.attach(marketAddr);
            expect(await market.status()).to.equal(0); // OPEN
        });

        it("anyone can create a market (permissionless)", async function () {
            const { factory, alice } = await deployFactory();
            // alice is not the factory deployer
            await expect(createMarketDefaults(factory, alice)).to.not.be.reverted;
        });

        it("tracks all deployed markets in allMarkets array", async function () {
            const { factory, alice } = await deployFactory();
            await createMarketDefaults(factory, alice);
            await createMarketDefaults(factory, alice);
            await createMarketDefaults(factory, alice);
            expect(await factory.marketsCount()).to.equal(3);

            for (let i = 0; i < 3; i++) {
                const addr = await factory.allMarkets(i);
                expect(addr).to.not.equal(ethers.ZeroAddress);
                expect(await ethers.provider.getCode(addr)).to.not.equal("0x");
            }
        });

        // ─── getMarkets — paginated view ───────────────────────────────
        describe("getMarkets (pagination)", function () {

            it("returns empty array when start >= total", async function () {
                const { factory, alice } = await deployFactory();
                await createMarketDefaults(factory, alice);
                expect((await factory.getMarkets(1, 10)).length).to.equal(0);
                expect((await factory.getMarkets(99, 10)).length).to.equal(0);
            });

            it("returns empty array when registry is empty", async function () {
                const { factory } = await deployFactory();
                expect((await factory.getMarkets(0, 10)).length).to.equal(0);
            });

            it("returns the requested slice when fully in range", async function () {
                const { factory, alice } = await deployFactory();
                const addrs = [];
                for (let i = 0; i < 5; i++) {
                    await createMarketDefaults(factory, alice);
                    addrs.push(await factory.allMarkets(i));
                }
                const slice = await factory.getMarkets(1, 3);
                expect(slice.length).to.equal(3);
                expect(slice[0]).to.equal(addrs[1]);
                expect(slice[1]).to.equal(addrs[2]);
                expect(slice[2]).to.equal(addrs[3]);
            });

            it("truncates the slice when count overshoots the array end", async function () {
                const { factory, alice } = await deployFactory();
                await createMarketDefaults(factory, alice);
                await createMarketDefaults(factory, alice);
                const slice = await factory.getMarkets(0, 99);
                expect(slice.length).to.equal(2);
                expect(slice[0]).to.equal(await factory.allMarkets(0));
                expect(slice[1]).to.equal(await factory.allMarkets(1));
            });

            it("returns empty array when count is 0", async function () {
                const { factory, alice } = await deployFactory();
                await createMarketDefaults(factory, alice);
                expect((await factory.getMarkets(0, 0)).length).to.equal(0);
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // F4 — Pausable
    // ─────────────────────────────────────────────────────────────────

    describe("Pausable", function () {

        it("only the admin (owner) can pause", async function () {
            const { factory, alice, admin } = await deployFactory();
            await expect(factory.connect(alice).pause())
                .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            await expect(factory.connect(admin).pause()).to.not.be.reverted;
        });

        it("only the admin (owner) can unpause", async function () {
            const { factory, alice, admin } = await deployFactory();
            await factory.connect(admin).pause();
            await expect(factory.connect(alice).unpause())
                .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            await expect(factory.connect(admin).unpause()).to.not.be.reverted;
        });

        it("paused() reflects state correctly", async function () {
            const { factory, admin } = await deployFactory();
            expect(await factory.paused()).to.be.false;
            await factory.connect(admin).pause();
            expect(await factory.paused()).to.be.true;
            await factory.connect(admin).unpause();
            expect(await factory.paused()).to.be.false;
        });

        it("createMarket() reverts EnforcedPause when paused", async function () {
            const { factory, alice, admin } = await deployFactory();
            await factory.connect(admin).pause();
            await expect(createMarketDefaults(factory, alice))
                .to.be.revertedWithCustomError(factory, "EnforcedPause");
        });

        it("createMarket() works again after unpause", async function () {
            const { factory, alice, admin } = await deployFactory();
            await factory.connect(admin).pause();
            await factory.connect(admin).unpause();
            await expect(createMarketDefaults(factory, alice)).to.not.be.reverted;
        });

        it("emits Paused / Unpaused events from OpenZeppelin Pausable", async function () {
            const { factory, admin } = await deployFactory();
            await expect(factory.connect(admin).pause())
                .to.emit(factory, "Paused")
                .withArgs(admin.address);
            await expect(factory.connect(admin).unpause())
                .to.emit(factory, "Unpaused")
                .withArgs(admin.address);
        });

        it("pausing the factory does NOT affect already-deployed markets", async function () {
            const { factory, token, alice, treasury, admin } = await deployFactory();
            const [deployer, , , , bob] = await ethers.getSigners();

            // Create a market BEFORE pausing
            await token.mint(alice.address, ethers.parseUnits("1000", 6));
            await token.mint(bob.address,   ethers.parseUnits("1000", 6));

            const now = await time.latest();
            await factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, now + 3600, now + 7200
            );
            const marketAddr = await factory.allMarkets(0);
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const market = BopsterMarket.attach(marketAddr);

            // Pause factory
            await factory.connect(admin).pause();

            // Existing market still accepts positions
            await token.connect(alice).approve(marketAddr, ethers.parseUnits("100", 6));
            await expect(market.connect(alice).positionYes(ethers.parseUnits("100", 6)))
                .to.not.be.reverted;
        });

        it("admin can transfer ownership via the Ownable2Step two-step flow", async function () {
            const { factory, alice, admin } = await deployFactory();

            // Step 1: current admin nominates alice. Ownership has NOT moved yet.
            await factory.connect(admin).transferOwnership(alice.address);
            expect(await factory.pendingOwner()).to.equal(alice.address);
            expect(await factory.owner()).to.equal(admin.address);

            // Admin still controls pause until alice accepts.
            await expect(factory.connect(alice).pause())
                .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");

            // Step 2: alice accepts and becomes the owner.
            await factory.connect(alice).acceptOwnership();
            expect(await factory.owner()).to.equal(alice.address);
            expect(await factory.pendingOwner()).to.equal(ethers.ZeroAddress);

            // Now alice can pause.
            await expect(factory.connect(alice).pause()).to.not.be.reverted;
        });

        it("renounceOwnership is disabled and reverts", async function () {
            const { factory, admin } = await deployFactory();
            await expect(factory.connect(admin).renounceOwnership())
                .to.be.revertedWithCustomError(factory, "RenounceOwnershipDisabled");
            // Owner is unchanged
            expect(await factory.owner()).to.equal(admin.address);
        });

        it("non-owner cannot trigger renounceOwnership (reverts on auth, not on disable)", async function () {
            const { factory, alice } = await deployFactory();
            await expect(factory.connect(alice).renounceOwnership())
                .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // Factory → Market integration
    // ─────────────────────────────────────────────────────────────────

    describe("Factory → Market integration", function () {

        it("market deployed via factory is fully functional (positions + finalize + claim)", async function () {
            const { factory, token, alice, treasury } = await deployFactory();
            const MockReality = await ethers.getContractFactory("MockReality");
            const reality = MockReality.attach(await factory.reality());
            const [, , , , bob, resolver] = await ethers.getSigners();

            // Give alice and bob tokens
            await token.mint(alice.address, ethers.parseUnits("1000", 6));
            await token.mint(bob.address,   ethers.parseUnits("1000", 6));

            const now = await time.latest();
            const endTime     = now + 3600;
            const resolveTime = now + 7200;

            await factory.connect(alice).createMarket(
                QUESTION_ID, METADATA_URI, endTime, resolveTime
            );
            const marketAddr = await factory.allMarkets(0);
            const BopsterMarket = await ethers.getContractFactory("BopsterMarket");
            const market = BopsterMarket.attach(marketAddr);
            const ANSWER_YES = ethers.zeroPadValue(ethers.toBeHex(1), 32);

            // Place positions
            await token.connect(alice).approve(marketAddr, ethers.parseUnits("100", 6));
            await market.connect(alice).positionYes(ethers.parseUnits("100", 6));
            await token.connect(bob).approve(marketAddr, ethers.parseUnits("200", 6));
            await market.connect(bob).positionNo(ethers.parseUnits("200", 6));

            // Lock
            await time.increaseTo(endTime + 1);
            await market.lock();

            // Resolve
            const realityMock = await ethers.getContractFactory("MockReality");
            const realityContract = realityMock.attach(await factory.reality());
            await realityContract.setResult(QUESTION_ID, ANSWER_YES, true);
            await time.increaseTo(resolveTime + 1);
            await market.connect(resolver).finalize();

            // Claim
            const before = await token.balanceOf(alice.address);
            await market.connect(alice).claim();
            expect(await token.balanceOf(alice.address)).to.be.gt(before);
        });
    });
});
