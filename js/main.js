// ============================================================================
// Brass: Birmingham - Main Entry Point
// ============================================================================

let gameState = null;
let gameLogic = null;
let boardRenderer = null;
let uiManager = null;

// ============================================================================
// Setup Screen
// ============================================================================

function initSetup() {
    let playerCount = 3;
    let aiCount = 0;

    const playerSelector = document.getElementById('player-count-selector');
    const aiSelector = document.getElementById('ai-count-selector');

    // Grey out invalid options on both selectors based on the current selection.
    // Constraint: at least one human player, so aiCount <= playerCount - 1.
    function updateConstraints() {
        // AI buttons: disable any AI count that would leave no human players.
        aiSelector.querySelectorAll('.count-btn').forEach(b => {
            b.disabled = parseInt(b.dataset.aiCount) > playerCount - 1;
        });
        // Player buttons: disable any total that can't fit the chosen AI players + 1 human.
        playerSelector.querySelectorAll('.count-btn').forEach(b => {
            b.disabled = parseInt(b.dataset.count) <= aiCount;
        });
    }

    function setActive(selector, btn) {
        selector.querySelectorAll('.count-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    }

    // Player count buttons
    playerSelector.querySelectorAll('.count-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            setActive(playerSelector, btn);
            playerCount = parseInt(btn.dataset.count);
            // Clamp AI count down if it no longer leaves a human player.
            if (aiCount > playerCount - 1) {
                aiCount = playerCount - 1;
                const aiBtn = aiSelector.querySelector(`.count-btn[data-ai-count="${aiCount}"]`);
                setActive(aiSelector, aiBtn);
            }
            updateConstraints();
            renderPlayerInputs(playerCount, aiCount);
        });
    });

    // AI count buttons
    aiSelector.querySelectorAll('.count-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            setActive(aiSelector, btn);
            aiCount = parseInt(btn.dataset.aiCount);
            updateConstraints();
            renderPlayerInputs(playerCount, aiCount);
        });
    });

    // Initialize with default counts
    updateConstraints();
    renderPlayerInputs(playerCount, aiCount);

    // Start game button
    document.getElementById('start-game-btn').addEventListener('click', () => {
        const names = [];
        document.querySelectorAll('.player-name-input input').forEach(input => {
            names.push(input.value || input.placeholder);
        });
        startGame(playerCount, names, aiCount);
    });
}

function renderPlayerInputs(count, aiCount = 0) {
    const container = document.querySelector('.player-name-inputs');
    container.innerHTML = '';

    const defaultNames = ['Alice', 'Bob', 'Carol', 'Dave'];
    const aiNames = ['CPU Alice', 'CPU Bob', 'CPU Carol', 'CPU Dave'];
    const firstAiIndex = count - aiCount; // trailing players are AI

    for (let i = 0; i < count; i++) {
        const isAI = i >= firstAiIndex;
        const div = document.createElement('div');
        div.className = 'player-name-input' + (isAI ? ' ai-player' : '');
        div.innerHTML = `
            <div class="color-swatch" style="background: ${PLAYER_COLORS[i]}"></div>
            <input type="text" placeholder="${isAI ? aiNames[i] : defaultNames[i]}" maxlength="20" ${isAI ? 'disabled' : ''}>
            ${isAI ? '<span class="ai-badge">AI</span>' : ''}
        `;
        container.appendChild(div);
    }
}

// ============================================================================
// Game Initialization
// ============================================================================

function startGame(numPlayers, playerNames, aiCount = 0) {
    // Switch screens
    document.getElementById('setup-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');

    // Create game state
    gameState = new GameState(numPlayers, playerNames, aiCount);

    // Create game logic
    gameLogic = new GameLogic(gameState);

    // Create board renderer
    const svg = document.getElementById('game-board');
    boardRenderer = new BoardRenderer(svg);
    boardRenderer.render(gameState);

    // Create UI manager
    uiManager = new UIManager();
    uiManager.init(gameState, gameLogic, boardRenderer);

    // Expose state for testing
    window.render_game_to_text = () => JSON.stringify(gameState.toJSON(), null, 2);
    window.gameState = gameState;
    window.gameLogic = gameLogic;
}

// ============================================================================
// Initialize
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    initSetup();
});
