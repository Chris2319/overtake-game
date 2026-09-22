import WebSocket from "ws";

// Smoke test for QA mode: one client seats and drives multiple players
// itself (no bots) and plays the game to completion.
const ws = new WebSocket("ws://localhost:3000/ws");

let state = null;
let controlledIds = [];
let turns = 0;
const maxTurns = 500;

function log(...args) {
  console.log(...args);
}

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      action: "create_qa_game",
      players: [
        { name: "Tester1", teamId: "blue" },
        { name: "Tester2", teamId: "red" },
        { name: "Tester3", teamId: "green" },
      ],
    }),
  );
});

function maybePlay() {
  if (!state || state.status === "finished") return;
  const current = state.players[state.currentPlayerIndex];
  if (!controlledIds.includes(current.id)) return;
  if (state.cardOffer) return;
  turns++;
  if (turns > maxTurns) {
    log("Too many turns, aborting");
    ws.close();
    return;
  }
  const card = current.hand.reduce((best, c) => (c.value > best.value ? c : best), current.hand[0]);
  ws.send(JSON.stringify({ action: "play_card", cardId: card.id }));
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "game_created") {
    controlledIds = msg.controlledPlayerIds;
    state = msg.gameState;
    log("game_created", { gameId: msg.gameId, controlledIds, players: state.players.map((p) => ({ id: p.id, name: p.name, teamId: p.teamId })) });
    log("first player:", state.players[state.currentPlayerIndex].id);
    maybePlay();
  } else if (msg.event === "card_played") {
    state = msg.state;
    log("card_played by", msg.moves.map((m) => m.playerId).join(","), "-> status:", state.status, "current:", state.players[state.currentPlayerIndex]?.id);
    if (state.status === "finished") {
      log("WINNER:", state.winnerId);
      ws.close();
      return;
    }
    maybePlay();
  } else if (msg.event === "await_target") {
    log("await_target for", msg.playerId);
    if (controlledIds.includes(msg.playerId)) {
      const mover = state.players.find((p) => p.id === msg.playerId);
      const teamId = state.teams.find((t) => t.id !== mover.teamId).id;
      ws.send(JSON.stringify({ action: "select_retreat_target", teamId }));
    }
  } else if (msg.event === "offer_updated") {
    state = msg.state;
    log("offer_updated, cardOffer:", state.cardOffer ? state.cardOffer.playerId : null);
    if (!state.cardOffer) maybePlay();
  } else if (msg.event === "error") {
    log("ERROR:", msg.message);
  }
});

ws.on("error", (e) => log("ws error", e));
ws.on("close", () => log("closed"));
