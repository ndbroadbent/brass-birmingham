// ============================================================================
// Brass: Birmingham - Rule-based AI Player
// ----------------------------------------------------------------------------
// A lightweight decision engine for AI-controlled seats. It does NOT play
// optimally — it makes sensible, legal moves so games can run start to finish.
// The AI reuses the same GameLogic validation the human UI uses, so it can
// never make an illegal move.
//
// Strategies are pluggable so different play styles can be pitted against each
// other in the simulation harness (see sim/runner.js). A strategy is mostly
// data: a priority order over the seven actions, plus a build-target scoring
// function. The default ("balanced") preserves the original behaviour the UI
// relies on.
// ============================================================================

// ----------------------------------------------------------------------------
// Build-target scoring helpers. Lower score = more desirable (picked first).
// Each receives a build target from getValidBuildTargets() which carries
// { cityId, slotIndex, industryType, tileData, cost }.
// ----------------------------------------------------------------------------
const BUILD_SCORERS = {
    // Resource mines first (they feed the whole board), then cheapest.
    minesCheapest: (t) => {
        const isMine = t.industryType === INDUSTRY_TYPES.COAL_MINE ||
            t.industryType === INDUSTRY_TYPES.IRON_WORKS;
        return (isMine ? -100 : 0) + (t.cost ? t.cost.total : 0);
    },
    // Highest victory-point tiles first.
    highVP: (t) => -((t.tileData ? t.tileData.vp : 0) * 10) + (t.cost ? t.cost.total : 0),
    // Highest income tiles first (snowball economy).
    highIncome: (t) => -((t.tileData ? t.tileData.income : 0) * 10) + (t.cost ? t.cost.total : 0),
    // Sellable industries first (cotton / pottery / manufacturer / iron-ish).
    sellableFirst: (t) => (isSellableIndustry(t.industryType) ? -100 : 0) + (t.cost ? t.cost.total : 0),
    // Plain cheapest build.
    cheapest: (t) => (t.cost ? t.cost.total : 0),
};

// ----------------------------------------------------------------------------
// optimal_a tuning weights. Everything is expressed in "victory-point
// equivalents" so all action types can be compared on one scale. These were
// tuned against the `builder` strategy via sim/simulate.js.
//
// Domain facts this encodes (see js/gameState.js scoring):
//   - An industry tile scores its VP ONLY when flipped; unflipped = 0 VP.
//   - Flipping also raises income; income is paid each round AND added 1:1 to
//     VP at game end, so it's doubly valuable.
//   - Coal/iron tiles flip automatically when their cubes are consumed (by
//     anyone), so they almost always score — and they feed your own builds.
//   - Links score the linkVP of flipped adjacent tiles + 2 per adjacent
//     merchant, at era end.
//   - A level-1 tile that is canal-only blocks building that type in the rail
//     era until developed away.
// ----------------------------------------------------------------------------
const OPT_A = {
    // Income caps at 30 and every player reaches it, so it's barely a
    // differentiator — keep its weight low. Industry VP (from FLIPPED tiles)
    // and link VP are what actually decide games here.
    incomeVP: 0.3,      // value of +1 income (mostly cash flow; caps at 30)
    linkVP: 1.1,        // value of +1 linkVP once the tile is flipped
    moneyVP: 0.1,       // VP value of £1 (cash is rarely the binding constraint)
    buildTempo: 0.3,    // small flat value of advancing the engine
    mineCube: 0.2,      // value per coal/iron cube produced (fuels your network)
    sellRealize: 1.0,   // multiplier on VP realized by flipping via a sale
    sellFlat: 1.0,      // small flat bonus for a sell (merchant bonus etc.)
    brewerySynergy: 3.5, // beer unlocks selling (flipping) your high-VP goods
    // How much of a tile's VP counts up front vs. only once flipped. VP always
    // counts strongly (markets open up over the game); flippable kinds count full.
    vpBase: 0.6, vpFlip: 0.4,
    incBase: 0.4, incFlip: 0.6,
    // Probability a built tile eventually flips (and thus scores), by kind.
    flip: { coal: 0.95, iron: 0.95, brewery: 0.7, sellableConnected: 0.95, sellableUnconnected: 0.7, other: 0.7 },
    openMarket: 4.0,    // bonus for a link that first connects you to a merchant
    reachCube: 0.4,     // value of an empty adjacent slot (future build reach)
    develBase: 0.3,
    develUnlockRail: 5.0,   // clear a canal-only tile to unblock the type in rail
    develCanalLate: 1.2,    // clearing canal-only tiles during the canal era
    develRevealGain: 0.5,   // per VP the revealed next tile beats the removed one
    lowCashBoost: 3.0,      // extra loan value when nearly broke
    scoutVP: 1.5,
    passVP: -3.0,
};

// optimal_b — forked from optimal_a, then tuned head-to-head against it via
// sim/simulate.js. The decisive win came from DOUBLE-DEVELOP: clearing two
// tiles in a single action rips through low-value level-1/2 tiles (and the
// canal-only ones that would otherwise block the rail era), reaching high-VP
// tiles far faster. Era-end boosts add a little; develop-to-dig was tested and
// dropped (it over-developed and hurt). Beats optimal_a ~61% head-to-head.
const OPT_B = {
    ...OPT_A,
    lateEraSellBoost: 1.3,     // value flips more as era-end scoring approaches
    lateEraNetworkBoost: 1.3,  // value links more as era-end scoring approaches
    digFactor: 0.0,            // (tested, dropped — over-developed)
    doubleDevelop: true,       // remove two tiles in one develop action
    doubleDevelopBonus: 2.0,   // strongly favour double over single develop
};

// ----------------------------------------------------------------------------
// Strategy registry. Add new entries here to make them available to both the
// UI (by name) and the simulation harness.
//   priority      - order the seven actions are attempted in
//   buildScore    - key into BUILD_SCORERS for choosing which tile to build
//   loanThreshold - take a loan only when money is below this (0 = never)
//   scout         - whether the bot will scout a weak hand for wild cards
//   custom        - optional chooseMove(ai, playerId) overriding everything
// ----------------------------------------------------------------------------
const STRATEGIES = {
    balanced: {
        name: 'balanced',
        priority: ['sell', 'build', 'network', 'develop', 'loan'],
        buildScore: 'minesCheapest',
        loanThreshold: 15,
    },
    builder: {
        name: 'builder',
        priority: ['build', 'sell', 'network', 'develop', 'loan'],
        buildScore: 'highVP',
        loanThreshold: 30,
    },
    networker: {
        name: 'networker',
        priority: ['network', 'sell', 'build', 'develop', 'loan'],
        buildScore: 'minesCheapest',
        loanThreshold: 15,
    },
    merchant: {
        name: 'merchant',
        priority: ['sell', 'build', 'network', 'develop', 'loan'],
        buildScore: 'sellableFirst',
        loanThreshold: 15,
    },
    economist: {
        name: 'economist',
        priority: ['sell', 'build', 'network', 'develop', 'loan'],
        buildScore: 'highIncome',
        loanThreshold: 10,
    },
    random: {
        name: 'random',
        custom: (ai, playerId) => ai.randomMove(playerId),
    },
    // Advanced strategy: scores every legal move on one VP-equivalent scale and
    // plays the best, with heuristics that look ahead (flip prospects, link
    // build-up, develop-to-unlock, market access). See AIPlayer.optimalMove.
    optimal_a: {
        name: 'optimal_a',
        custom: (ai, playerId) => ai.optimalMove(playerId, OPT_A),
    },
    // optimal_b: forked from optimal_a, adds era-end awareness, develop-to-dig
    // toward high-VP tiles, and double-develop. Tuned by playing vs optimal_a.
    optimal_b: {
        name: 'optimal_b',
        custom: (ai, playerId) => ai.optimalMove(playerId, OPT_B),
    },
};

class AIPlayer {
    // strategy: a name in STRATEGIES, or a strategy object. rng: deterministic
    // [0,1) generator (defaults to the game's seeded RNG) used by stochastic
    // strategies so simulations stay reproducible.
    constructor(state, logic, strategy = 'balanced', rng = null) {
        this.state = state;
        this.logic = logic;
        this.strategy = typeof strategy === 'string' ? (STRATEGIES[strategy] || STRATEGIES.balanced) : strategy;
        this.rng = rng || (() => (state.rng ? state.rng() : Math.random()));
    }

    // Decide the move for the given player. Returns a move descriptor the
    // UIManager / sim runner executes, or null if the player cannot act.
    chooseMove(playerId) {
        const player = this.state.players[playerId];
        if (!player || player.hand.length === 0) return null;

        if (this.strategy.custom) return this.strategy.custom(this, playerId);

        for (const action of this.strategy.priority) {
            const move = this.tryAction(action, playerId);
            if (move) return move;
        }
        // Never pass: scout to refresh the hand into wilds when possible,
        // otherwise take a loan (always legal with a card in hand).
        return this.fallbackMove(playerId);
    }

    // The universal "always do something useful" fallback. Scouting trades a
    // weak hand for wild cards (which unlock builds); a loan is the guaranteed
    // legal action when scouting isn't possible. The AI never passes.
    fallbackMove(playerId) {
        if (this.logic.canScout(playerId)) {
            return { action: ACTIONS.SCOUT, pendingData: {}, scoutCards: [0, 1], cardIndex: 2 };
        }
        return { action: ACTIONS.LOAN, pendingData: {}, cardIndex: this.pickDiscardCard(playerId) };
    }

    // Attempt a single action by key; return a move descriptor or null.
    tryAction(action, playerId) {
        switch (action) {
            case 'sell': return this.moveSell(playerId);
            case 'build': return this.moveBuild(playerId);
            case 'network': return this.moveNetwork(playerId);
            case 'develop': return this.moveDevelop(playerId);
            case 'loan': return this.moveLoan(playerId);
            case 'scout': return this.moveScout(playerId);
            default: return null;
        }
    }

    // ---- individual action builders ----------------------------------------

    moveSell(playerId) {
        const targets = this.logic.getValidSellTargets(playerId);
        if (targets.length === 0) return null;
        return {
            action: ACTIONS.SELL,
            pendingData: { tileKeys: targets.map(t => t.key) },
            cardIndex: this.pickDiscardCard(playerId),
        };
    }

    moveBuild(playerId) {
        const targets = this.logic.getValidBuildTargets(playerId);
        if (targets.length === 0) return null;
        const target = this.pickBuildTarget(targets);
        const validCards = this.logic.getValidCardsForAction(playerId, ACTIONS.BUILD, target);
        if (validCards.length === 0) return null;
        return {
            action: ACTIONS.BUILD,
            pendingData: {
                cityId: target.cityId,
                slotIndex: target.slotIndex,
                industryType: target.industryType,
            },
            cardIndex: this.pickBuildCard(playerId, validCards),
        };
    }

    moveNetwork(playerId) {
        const targets = this.logic.getValidNetworkTargets(playerId);
        if (targets.length === 0) return null;
        const target = [...targets].sort((a, b) => a.cost - b.cost)[0];
        return {
            action: ACTIONS.NETWORK,
            pendingData: { connectionId: target.connectionId },
            cardIndex: this.pickDiscardCard(playerId),
        };
    }

    moveDevelop(playerId) {
        if (!this.logic.canDevelop(playerId)) return null;
        const types = [...this.logic.getDevelopableTypes(playerId)].sort((a, b) => a.level - b.level);
        return {
            action: ACTIONS.DEVELOP,
            pendingData: { industryType1: types[0].type, industryType2: null },
            cardIndex: this.pickDiscardCard(playerId),
        };
    }

    moveLoan(playerId) {
        const player = this.state.players[playerId];
        const threshold = this.strategy.loanThreshold || 0;
        if (player.money >= threshold) return null;
        return { action: ACTIONS.LOAN, pendingData: {}, cardIndex: this.pickDiscardCard(playerId) };
    }

    moveScout(playerId) {
        if (!this.logic.canScout(playerId)) return null;
        return { action: ACTIONS.SCOUT, pendingData: {}, scoutCards: [0, 1], cardIndex: 2 };
    }

    // ---- "random" strategy --------------------------------------------------

    // Pick uniformly at random among the actions that are currently legal.
    randomMove(playerId) {
        const builders = ['build', 'network', 'develop', 'sell', 'loan', 'scout'];
        const moves = [];
        for (const a of builders) {
            // Bypass strategy gates (loanThreshold/scout flag) for a true random baseline.
            let move = null;
            if (a === 'loan') move = { action: ACTIONS.LOAN, pendingData: {}, cardIndex: this.pickDiscardCard(playerId) };
            else if (a === 'scout') move = this.logic.canScout(playerId)
                ? { action: ACTIONS.SCOUT, pendingData: {}, scoutCards: [0, 1], cardIndex: 2 } : null;
            else move = this.tryAction(a, playerId);
            if (move) moves.push(move);
        }
        if (moves.length === 0) return this.fallbackMove(playerId);
        return moves[Math.floor(this.rng() * moves.length)];
    }

    // ---- target / card selection helpers -----------------------------------

    pickBuildTarget(targets) {
        const scorer = BUILD_SCORERS[this.strategy.buildScore] || BUILD_SCORERS.minesCheapest;
        return [...targets].sort((a, b) => scorer(a) - scorer(b))[0];
    }

    // For a build, prefer a concrete card over a wild so wilds are saved.
    pickBuildCard(playerId, validCards) {
        const player = this.state.players[playerId];
        const nonWild = validCards.find(idx => !this.isWild(player.hand[idx]));
        return nonWild !== undefined ? nonWild : validCards[0];
    }

    // When a card just has to be discarded, throw away a plain card before a wild.
    pickDiscardCard(playerId, exclude = []) {
        const player = this.state.players[playerId];
        const usable = (i) => !exclude.includes(i);
        for (let i = 0; i < player.hand.length; i++) {
            if (usable(i) && !this.isWild(player.hand[i])) return i;
        }
        for (let i = 0; i < player.hand.length; i++) {
            if (usable(i)) return i;
        }
        return 0;
    }

    isWild(card) {
        return card.type === CARD_TYPES.WILD_LOCATION || card.type === CARD_TYPES.WILD_INDUSTRY;
    }

    // ========================================================================
    // optimal_a / optimal_b — score every legal move on one VP-equivalent scale
    // and play the best. Behaviour is driven entirely by the weights/config
    // object `w` (OPT_A or OPT_B), so both strategies share this engine.
    // ========================================================================

    optimalMove(playerId, w) {
        const ctx = this.optContext(playerId);
        const candidates = [
            this.optSell(playerId, ctx, w),
            this.optBuild(playerId, ctx, w),
            this.optNetwork(playerId, ctx, w),
            this.optDevelop(playerId, ctx, w),
            this.optLoan(playerId, ctx, w),
            this.optScout(playerId, ctx, w),
            { score: w.passVP, move: { action: ACTIONS.PASS, pendingData: {}, cardIndex: this.pickDiscardCard(playerId) } },
        ].filter(Boolean);

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].move;
    }

    // Shared per-decision context.
    optContext(playerId) {
        const player = this.state.players[playerId];
        const handsLeft = this.state.players.reduce((n, p) => n + p.hand.length, 0);
        const cardsLeft = this.state.drawDeck.length + handsLeft;
        return {
            player,
            isRail: this.state.era === ERA.RAIL,
            money: player.money,
            income: player.income,
            marketAccess: this.hasMarketAccess(playerId),
            beer: this.hasBeer(playerId),
            // Era-end proximity: links and flipped tiles score at era end, so
            // late in an era it pays to lock in sells and links. 1 = at the end.
            cardsLeft,
            lateEra: cardsLeft <= this.state.numPlayers * 4,
        };
    }

    // Does the player own a brewery (on the board or a brewery farm) that still
    // has beer cubes? Beer is required to sell most goods.
    hasBeer(playerId) {
        for (const t of Object.values(this.state.boardIndustries)) {
            if (t.playerId === playerId && t.type === INDUSTRY_TYPES.BREWERY && t.resourceCubes > 0) return true;
        }
        for (const t of Object.values(this.state.breweryFarmTiles)) {
            if (t && t.playerId === playerId && t.resourceCubes > 0) return true;
        }
        return false;
    }

    // Does the player's network connect to any merchant (i.e. can they sell)?
    hasMarketAccess(playerId) {
        const seeds = new Set();
        for (const [key, t] of Object.entries(this.state.boardIndustries)) {
            if (t.playerId === playerId) seeds.add(key.split('_')[0]);
        }
        for (const [connId, l] of Object.entries(this.state.boardLinks)) {
            if (l.playerId !== playerId) continue;
            const conn = CONNECTIONS.find(c => c.id === connId);
            if (conn) conn.cities.forEach(c => seeds.add(c));
        }
        for (const c of seeds) {
            const connected = this.state.getConnectedLocations(c);
            for (const mt of this.state.merchantTiles) {
                if (connected.has(mt.location)) return true;
            }
        }
        return false;
    }

    // Flip probability for a freshly-built tile of a given type.
    flipProb(industryType, ctx, w) {
        if (industryType === INDUSTRY_TYPES.COAL_MINE) return w.flip.coal;
        if (industryType === INDUSTRY_TYPES.IRON_WORKS) return w.flip.iron;
        if (industryType === INDUSTRY_TYPES.BREWERY) return w.flip.brewery;
        if (isSellableIndustry(industryType)) {
            // Selling most goods needs BOTH a merchant connection and beer.
            if (ctx.marketAccess && ctx.beer) return w.flip.sellableConnected;
            if (ctx.marketAccess || ctx.beer) return (w.flip.sellableConnected + w.flip.sellableUnconnected) / 2;
            return w.flip.sellableUnconnected;
        }
        return w.flip.other;
    }

    // Selling realizes the VP of otherwise-worthless unflipped tiles, plus
    // income and link potential — usually the strongest move when available.
    optSell(playerId, ctx, w) {
        const targets = this.logic.getValidSellTargets(playerId);
        if (targets.length === 0) return null;
        let score = w.sellFlat;
        for (const t of targets) {
            const td = t.tile.tileData;
            score += td.vp * w.sellRealize;
            score += td.income * w.incomeVP;
            score += td.linkVP * w.linkVP;
        }
        // Late in an era, locking in flips before scoring is extra valuable.
        if (w.lateEraSellBoost && ctx.lateEra) score *= w.lateEraSellBoost;
        return {
            score,
            move: { action: ACTIONS.SELL, pendingData: { tileKeys: targets.map(t => t.key) }, cardIndex: this.pickDiscardCard(playerId) },
        };
    }

    optBuild(playerId, ctx, w) {
        const targets = this.logic.getValidBuildTargets(playerId);
        if (targets.length === 0) return null;
        let best = null;
        for (const t of targets) {
            const validCards = this.logic.getValidCardsForAction(playerId, ACTIONS.BUILD, t);
            if (validCards.length === 0) continue;
            const score = this.buildValue(t, ctx, w);
            if (!best || score > best.score) {
                best = { score, target: t, cardIndex: this.pickBuildCard(playerId, validCards) };
            }
        }
        if (!best) return null;
        return {
            score: best.score,
            move: {
                action: ACTIONS.BUILD,
                pendingData: { cityId: best.target.cityId, slotIndex: best.target.slotIndex, industryType: best.target.industryType },
                cardIndex: best.cardIndex,
            },
        };
    }

    buildValue(t, ctx, w) {
        const td = t.tileData;
        const type = t.industryType;
        const flip = this.flipProb(type, ctx, w);
        const isMine = type === INDUSTRY_TYPES.COAL_MINE || type === INDUSTRY_TYPES.IRON_WORKS;

        let score = 0;
        // VP is the dominant term; flippable tiles count for more of it.
        score += td.vp * (w.vpBase + w.vpFlip * flip);
        score += td.income * w.incomeVP * (w.incBase + w.incFlip * flip);
        score += td.linkVP * w.linkVP * flip;
        if (isMine) score += (td.resourceCubes || 0) * w.mineCube;
        // A brewery is worth more than its own VP: its beer lets you sell (flip)
        // high-VP goods. Worth most when you don't already have beer.
        if (type === INDUSTRY_TYPES.BREWERY && !ctx.beer) score += w.brewerySynergy;
        score += w.buildTempo;
        score -= (t.cost ? t.cost.total : 0) * w.moneyVP;
        return score;
    }

    optNetwork(playerId, ctx, w) {
        const targets = this.logic.getValidNetworkTargets(playerId);
        if (targets.length === 0) return null;
        let best = null;
        for (const t of targets) {
            const score = this.networkValue(t, ctx, w);
            if (!best || score > best.score) best = { score, t };
        }
        return {
            score: best.score,
            move: { action: ACTIONS.NETWORK, pendingData: { connectionId: best.t.connectionId }, cardIndex: this.pickDiscardCard(playerId) },
        };
    }

    networkValue(t, ctx, w) {
        const conn = CONNECTIONS.find(c => c.id === t.connectionId);
        let linkPts = 0;
        let reach = 0;
        let touchesMerchant = false;
        if (conn) {
            for (const cityId of conn.cities) {
                if (isMerchantLocation(cityId)) { linkPts += 2; touchesMerchant = true; }
                if (isCity(cityId)) {
                    const city = CITIES[cityId];
                    for (let i = 0; i < city.slots.length; i++) {
                        const tile = this.state.boardIndustries[`${cityId}_${i}`];
                        if (tile) linkPts += tile.tileData.linkVP * (tile.flipped ? 1 : 0.6);
                        else reach += w.reachCube;
                    }
                }
            }
        }
        let score = linkPts * w.linkVP + reach;
        if (touchesMerchant && !ctx.marketAccess) score += w.openMarket;
        score -= (t.cost || 0) * w.moneyVP;
        score += 0.5; // base reach value
        // Links score at era end; near it, prioritise locking in connections.
        if (w.lateEraNetworkBoost && ctx.lateEra) score *= w.lateEraNetworkBoost;
        return score;
    }

    optDevelop(playerId, ctx, w) {
        if (!this.logic.canDevelop(playerId)) return null;
        const player = this.state.players[playerId];
        const types = this.logic.getDevelopableTypes(playerId);

        // Score developing one tile of each developable type.
        const scored = [];
        for (const dt of types) {
            scored.push({ type: dt.type, s: this.developTypeValue(player, dt, ctx, w) });
        }
        if (scored.length === 0) return null;
        scored.sort((a, b) => b.s - a.s);

        const ironPerTile = this.developIronCost(playerId, w);
        const top = scored[0];

        // Single develop candidate.
        let bestScore = top.s - ironPerTile;
        let move = { action: ACTIONS.DEVELOP, pendingData: { industryType1: top.type, industryType2: null }, cardIndex: this.pickDiscardCard(playerId) };

        // Double-develop (optimal_b): remove two tiles in one action to dig
        // faster, if there's enough iron and a worthwhile second tile.
        if (w.doubleDevelop && this.state.findIronSource(playerId).length >= 2) {
            const second = this.secondDevelopType(player, top.type, scored, ctx, w);
            if (second) {
                const doubleScore = top.s + second.s - 2 * ironPerTile + w.doubleDevelopBonus;
                if (doubleScore > bestScore) {
                    bestScore = doubleScore;
                    move = { action: ACTIONS.DEVELOP, pendingData: { industryType1: top.type, industryType2: second.type }, cardIndex: this.pickDiscardCard(playerId) };
                }
            }
        }

        return { score: bestScore, move };
    }

    // Value of developing (removing) the next tile of a type.
    developTypeValue(player, dt, ctx, w) {
        const tiles = player.industryTiles[dt.type];
        const removing = dt.tile;
        const idx = tiles.indexOf(removing);
        const rest = tiles.slice(idx + 1).filter(x => !x.used);
        const next = rest[0];
        const canalOnly = removing.canalEra && !removing.railEra;

        let s = w.develBase;
        if (canalOnly && ctx.isRail) s += w.develUnlockRail; // unblock type in rail era
        else if (canalOnly) s += w.develCanalLate;
        if (next) s += Math.max(0, next.vp - removing.vp) * w.develRevealGain;

        // Dig bonus (optimal_b): reward developing toward a much higher-VP tile
        // further up the stack (e.g. digging to pottery's top tile).
        if (w.digFactor && rest.length) {
            const bestAhead = Math.max(...rest.map(x => x.vp));
            s += Math.max(0, bestAhead - removing.vp) * w.digFactor;
        }
        return s;
    }

    // Pick a worthwhile second tile to develop alongside `firstType`. Prefer
    // digging the same stack further if that's where the value is.
    secondDevelopType(player, firstType, scored, ctx, w) {
        // Simulate the first removal by treating the next tile of firstType as
        // the new "next" for a re-evaluation.
        const tiles = player.industryTiles[firstType];
        const firstNextIdx = tiles.findIndex(x => !x.used);
        const afterFirst = tiles.slice(firstNextIdx + 1).find(x => !x.used);
        if (afterFirst) {
            const s = this.developTypeValue(player, { type: firstType, tile: afterFirst }, ctx, w);
            const otherBest = scored.find(x => x.type !== firstType);
            if (!otherBest || s >= otherBest.s) return { type: firstType, s };
            return otherBest;
        }
        return scored.find(x => x.type !== firstType) || null;
    }

    developIronCost(playerId, w) {
        const ironSources = this.state.findIronSource(playerId);
        const ironCost = (ironSources.length && ironSources[0].free) ? 0 : this.state.getIronPrice();
        return (Number.isFinite(ironCost) ? ironCost : 6) * w.moneyVP;
    }

    // Loans cost income (3/round + 3 VP at end), so they're only worth it when
    // cash is short enough that it's blocking better plays.
    optLoan(playerId, ctx, w) {
        let score = LOAN_AMOUNT * w.moneyVP - LOAN_INCOME_PENALTY;
        if (ctx.money < 6) score += w.lowCashBoost;
        return { score, move: { action: ACTIONS.LOAN, pendingData: {}, cardIndex: this.pickDiscardCard(playerId) } };
    }

    optScout(playerId, ctx, w) {
        if (!this.logic.canScout(playerId)) return null;
        let score = w.scoutVP;
        if (ctx.isRail) score -= 1; // less time to exploit wilds late
        return { score, move: { action: ACTIONS.SCOUT, pendingData: {}, scoutCards: [0, 1], cardIndex: 2 } };
    }
}

// Export for Node-based simulations; harmless as plain globals in the browser.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AIPlayer, STRATEGIES, BUILD_SCORERS };
}
