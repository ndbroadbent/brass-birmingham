// ============================================================================
// Brass: Birmingham - Seeded RNG
// ----------------------------------------------------------------------------
// All game randomness (currently deck/tile shuffling) goes through a seeded
// pseudo-random generator so any game can be reproduced exactly from its seed.
// A game with no explicit seed picks a random one and stores it, so even
// "random" games can be replayed later if you note the seed.
// ============================================================================

// mulberry32: a tiny, fast, well-distributed 32-bit PRNG. Given the same
// numeric seed it always yields the same sequence of floats in [0, 1).
function makeRNG(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Turn any seed (number or string) into a uint32 the PRNG can use.
// Strings are hashed so human-friendly seeds like "test-123" work too.
function normalizeSeed(seed) {
    if (typeof seed === 'number' && Number.isFinite(seed)) {
        return seed >>> 0;
    }
    const str = String(seed);
    // FNV-1a hash
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// Pick a fresh random uint32 seed (used when no seed is supplied). This is the
// only place a non-seeded Math.random is allowed — it just chooses the seed,
// after which everything is deterministic.
function randomSeed() {
    return (Math.random() * 0x100000000) >>> 0;
}

// Export for Node-based simulations while staying a plain global in the browser.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { makeRNG, normalizeSeed, randomSeed };
}
