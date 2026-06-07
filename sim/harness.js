// ============================================================================
// Brass: Birmingham - Simulation Harness (Node)
// ----------------------------------------------------------------------------
// Loads the real browser game code into an isolated VM sandbox so it can be
// driven headlessly from Node, then exposes thin wrappers over the in-sandbox
// engine (sim/engine.js). The game files declare globals (no module system),
// so a VM context is the cleanest way to run them unchanged.
// ============================================================================

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Load order matters: data + rng before state, state before logic, etc.
const GAME_FILES = [
    'js/gameData.js',
    'js/rng.js',
    'js/gameState.js',
    'js/gameLogic.js',
    'js/aiPlayer.js',
];

// Build a fresh sandbox with the full game + simulation engine loaded.
function createContext() {
    const ctx = {};
    vm.createContext(ctx);
    for (const f of GAME_FILES) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'), ctx, { filename: 'sim/engine.js' });
    return ctx;
}

// Names of all registered strategies.
function listStrategies(ctx) {
    return JSON.parse(vm.runInContext('JSON.stringify(Object.keys(STRATEGIES))', ctx));
}

// Run a tournament; returns the aggregated result object from engine.tournament.
function runTournament(ctx, cfg) {
    ctx.__cfg = cfg;
    return JSON.parse(vm.runInContext('JSON.stringify(tournament(__cfg))', ctx));
}

// Play a single game; returns the per-game result object from engine.playGame.
function runGame(ctx, opts) {
    ctx.__opts = opts;
    return JSON.parse(vm.runInContext('JSON.stringify(playGame(__opts))', ctx));
}

module.exports = { createContext, listStrategies, runTournament, runGame };
