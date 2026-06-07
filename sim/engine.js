// ============================================================================
// Brass: Birmingham - Simulation Engine
// ----------------------------------------------------------------------------
// Runs INSIDE the sandbox created by sim/harness.js, alongside the real game
// code (GameState, GameLogic, AIPlayer, ACTIONS, STRATEGIES, ...). It plays
// full games headlessly by driving the same GameLogic the UI uses, and
// aggregates results into a tournament table. Everything is deterministic for
// a given seed, so any reported result can be reproduced exactly.
// ============================================================================

// Apply a chosen move via the game logic. Mirrors UIManager.processActionStep
// minus all the DOM/animation work.
function __executeMove(logic, pid, move) {
    switch (move.action) {
        case ACTIONS.BUILD:
            return logic.executeBuild(pid, move.pendingData.cityId, move.pendingData.slotIndex, move.pendingData.industryType, move.cardIndex);
        case ACTIONS.NETWORK:
            return logic.executeNetwork(pid, move.pendingData.connectionId, move.cardIndex);
        case ACTIONS.DEVELOP:
            return logic.executeDevelop(pid, move.pendingData.industryType1, move.pendingData.industryType2, move.cardIndex);
        case ACTIONS.SELL:
            return logic.executeSell(pid, move.pendingData.tileKeys, move.cardIndex);
        case ACTIONS.LOAN:
            return logic.executeLoan(pid, move.cardIndex);
        case ACTIONS.SCOUT:
            return logic.executeScout(pid, [...move.scoutCards, move.cardIndex]);
        case ACTIONS.PASS:
            return logic.executePass(pid, move.cardIndex);
        default:
            return { success: false };
    }
}

// Brass ranking: most VP wins; ties broken by income, then cash.
function __rank(players) {
    return [...players].sort((a, b) => b.vp - a.vp || b.income - a.income || b.money - a.money);
}

// Play one complete game. seatStrategies is an array (length numPlayers) of
// strategy names assigned to each seat. Returns per-seat results + the winner.
function playGame(opts) {
    const numPlayers = opts.numPlayers;
    const seatStrategies = opts.seatStrategies;
    const maxSteps = opts.maxSteps || 200000;

    const names = seatStrategies.map((s, i) => `${s}#${i}`);
    // All seats AI-controlled; the seeded GameState makes the shuffle reproducible.
    const state = new GameState(numPlayers, names, numPlayers, opts.seed);
    const logic = new GameLogic(state);
    const ais = seatStrategies.map(s => new AIPlayer(state, logic, s));

    let steps = 0;
    let stalls = 0;
    const actionCounts = {};

    while (!state.gameOver && steps < maxSteps) {
        steps++;
        const pid = state.currentPlayerId;
        const ai = ais[pid];

        const move = ai.chooseMove(pid);
        // No move only happens with an empty hand; just advance the turn (the
        // turn machinery skips/redeals empty-handed players).
        if (!move) {
            const tr0 = state.advanceTurn();
            if (tr0 === 'endCanalEra') state.endCanalEra();
            else if (tr0 === 'endGame') { state.endGame(); break; }
            continue;
        }

        const res = __executeMove(logic, pid, move);
        actionCounts[move.action] = (actionCounts[move.action] || 0) + 1;

        // Defensive: a validated move should never fail, but if one does, take a
        // loan (always legal) so the turn still advances instead of looping.
        if (!res || !res.success) {
            stalls++;
            logic.executeLoan(pid, ai.pickDiscardCard(pid));
        }

        const tr = state.advanceTurn();
        if (tr === 'endCanalEra') state.endCanalEra();
        else if (tr === 'endGame') { state.endGame(); break; }
    }

    const players = state.players.map((p, i) => ({
        seat: i, strategy: seatStrategies[i], vp: p.vp, income: p.income, money: p.money,
    }));
    const ranked = __rank(players);

    return {
        seed: state.seed,
        steps,
        completed: state.gameOver,
        stalls,
        actionCounts,
        players,
        winnerSeat: ranked[0].seat,
    };
}

// Run a tournament: `games` games among `field` strategies at `numPlayers`
// seats. If the field is smaller than the table it's cycled to fill seats.
// Seat assignments are rotated every game so each strategy visits every seat,
// cancelling first-player/turn-order bias. Seeds are baseSeed + gameIndex.
function tournament(cfg) {
    const numPlayers = cfg.numPlayers;
    const field = cfg.field;
    const games = cfg.games;
    const baseSeed = (cfg.seed >>> 0);

    // Base seat layout (cycled if field is smaller than the table).
    const baseSeats = [];
    for (let i = 0; i < numPlayers; i++) baseSeats.push(field[i % field.length]);

    const stats = {};
    const ensure = (s) => (stats[s] || (stats[s] = { name: s, instances: 0, wins: 0, vpSum: 0, rankSum: 0 }));
    const seatWins = new Array(numPlayers).fill(0);
    const actionTotals = {};
    let completed = 0;
    let totalStalls = 0;

    for (let g = 0; g < games; g++) {
        // Cyclically rotate seats so every strategy plays every seat over time.
        const rot = g % numPlayers;
        const seatStrategies = baseSeats.map((_, i) => baseSeats[(i + rot) % numPlayers]);

        const r = playGame({ numPlayers, seatStrategies, seed: baseSeed + g });
        if (r.completed) completed++;
        totalStalls += r.stalls;
        seatWins[r.winnerSeat]++;

        const ranked = __rank(r.players);
        ranked.forEach((p, idx) => { ensure(p.strategy).rankSum += idx + 1; });
        r.players.forEach((p) => {
            const st = ensure(p.strategy);
            st.instances++;
            st.vpSum += p.vp;
        });
        ensure(r.players[r.winnerSeat].strategy).wins++;

        for (const [a, n] of Object.entries(r.actionCounts)) {
            actionTotals[a] = (actionTotals[a] || 0) + n;
        }
    }

    const table = Object.values(stats).map((s) => ({
        strategy: s.name,
        instances: s.instances,
        wins: s.wins,
        winShare: games ? s.wins / games : 0,       // share of all games won (sums to 1)
        avgVP: s.instances ? s.vpSum / s.instances : 0,
        avgRank: s.instances ? s.rankSum / s.instances : 0,
    })).sort((a, b) => b.winShare - a.winShare || b.avgVP - a.avgVP);

    return { numPlayers, games, completed, totalStalls, seatWins, baseSeats, actionTotals, table };
}
