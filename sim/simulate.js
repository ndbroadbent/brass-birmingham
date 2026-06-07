#!/usr/bin/env node
// ============================================================================
// Brass: Birmingham - Strategy Simulation CLI
// ----------------------------------------------------------------------------
// Pit AI strategies against each other over many seeded games and report which
// wins most. Fully reproducible: the same flags always produce the same table.
//
// Usage:
//   node sim/simulate.js [options]
//
// Options:
//   --players N        seats at the table            (default 4)
//   --games G          games to play                 (default 500)
//   --field a,b,c,...  strategies in play            (default: all, capped to N)
//   --seed S           base seed                     (default 12345)
//   --matrix           head-to-head grid of every strategy pair at N seats
//   --list             list available strategies and exit
//   --help             show this help
//
// Examples:
//   node sim/simulate.js --list
//   node sim/simulate.js --players 4 --games 1000 --field balanced,builder,networker,merchant
//   node sim/simulate.js --players 2 --games 400 --field builder,economist --seed 7
//   node sim/simulate.js --matrix --players 4 --games 300
// ============================================================================

const { createContext, listStrategies, runTournament } = require('./harness');

function parseArgs(argv) {
    const args = { players: 4, games: 500, seed: 12345, field: null, matrix: false, list: false, help: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--players': args.players = parseInt(argv[++i], 10); break;
            case '--games': args.games = parseInt(argv[++i], 10); break;
            case '--seed': args.seed = parseInt(argv[++i], 10) >>> 0; break;
            case '--field': args.field = argv[++i].split(',').map(s => s.trim()).filter(Boolean); break;
            case '--matrix': args.matrix = true; break;
            case '--list': args.list = true; break;
            case '--help': case '-h': args.help = true; break;
            default: console.error(`Unknown option: ${a}`); process.exit(1);
        }
    }
    return args;
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function printTournament(result) {
    console.log(`\n${result.numPlayers}-player table  ·  ${result.games} games  ·  seats: [${result.baseSeats.join(', ')}]`);
    console.log(`completed: ${result.completed}/${result.games}` +
        (result.totalStalls ? `  ·  recovered stalls: ${result.totalStalls}` : ''));
    console.log('');
    console.log(`  ${pad('strategy', 12)} ${padL('winShare', 9)} ${padL('wins', 6)} ${padL('avgVP', 8)} ${padL('avgRank', 8)}`);
    console.log(`  ${'-'.repeat(12)} ${'-'.repeat(9)} ${'-'.repeat(6)} ${'-'.repeat(8)} ${'-'.repeat(8)}`);
    for (const row of result.table) {
        console.log(`  ${pad(row.strategy, 12)} ${padL(pct(row.winShare), 9)} ${padL(row.wins, 6)} ` +
            `${padL(row.avgVP.toFixed(1), 8)} ${padL(row.avgRank.toFixed(2), 8)}`);
    }
    const total = Object.values(result.actionTotals).reduce((a, b) => a + b, 0);
    const mix = Object.entries(result.actionTotals).sort((a, b) => b[1] - a[1])
        .map(([a, n]) => `${a} ${pct(n / total)}`).join('  ');
    console.log(`\n  action mix: ${mix}`);
    console.log(`  seat wins:  ${result.seatWins.map((w, i) => `seat${i} ${w}`).join('  ')}`);
}

// Head-to-head grid: each cell is row-strategy's win share vs column-strategy
// at the given player count (seats split evenly between the two).
function runMatrix(ctx, field, players, games, seed) {
    const n = field.length;
    const grid = field.map(() => field.map(() => null));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const res = runTournament(ctx, { numPlayers: players, field: [field[i], field[j]], games, seed });
            const get = (name) => (res.table.find(r => r.strategy === name) || { winShare: 0 }).winShare;
            grid[i][j] = get(field[i]);
            grid[j][i] = get(field[j]);
        }
    }

    console.log(`\nHead-to-head win share  ·  ${players}-player  ·  ${games} games/pair  ·  seed ${seed}`);
    console.log('(cell = row strategy\'s share of games won vs column strategy)\n');
    const w = Math.max(10, ...field.map(s => s.length + 1));
    console.log(' '.repeat(w) + field.map(s => padL(s, 10)).join(''));
    for (let i = 0; i < n; i++) {
        let line = pad(field[i], w);
        for (let j = 0; j < n; j++) {
            line += padL(i === j ? '·' : pct(grid[i][j]), 10);
        }
        console.log(line);
    }
}

function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(fsHelp());
        return;
    }

    const ctx = createContext();
    const all = listStrategies(ctx);

    if (args.list) {
        console.log('Available strategies:\n  ' + all.join('\n  '));
        return;
    }

    // Default field: all strategies, trimmed to the table size.
    let field = args.field || all.slice();
    const unknown = field.filter(s => !all.includes(s));
    if (unknown.length) {
        console.error(`Unknown strategies: ${unknown.join(', ')}\nAvailable: ${all.join(', ')}`);
        process.exit(1);
    }

    if (args.matrix) {
        runMatrix(ctx, field, args.players, args.games, args.seed);
        return;
    }

    // For a straight tournament, cap the field to the number of seats so each
    // strategy gets exactly one seat (cleanest comparison). Smaller fields are
    // cycled to fill the table by the engine.
    if (field.length > args.players) field = field.slice(0, args.players);

    const result = runTournament(ctx, {
        numPlayers: args.players,
        field,
        games: args.games,
        seed: args.seed,
    });
    printTournament(result);
}

function fsHelp() {
    return require('fs').readFileSync(__filename, 'utf8')
        .split('\n').filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
}

main();
