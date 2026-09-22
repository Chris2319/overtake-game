import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/ws");
let state = null;
let controlledIds = [];
let turns = 0;

function log(...args) {
  console.log(...args);
}

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      action: "create_qa_game",
      players: [
        { name: "Tester", teamId: "blue" },
        { name: "Opponent", teamId: "red" },
      ],
    }),
  );
});

function act() {
  if (!state || state.status === "finished") return;
  const current = state.players[state.currentPlayerIndex];
  if (!controlledIds.includes(current.id)) return;
  if (state.cardOffer) return;
  turns++;
  if (turns > 200) {
    log("giving up, no retreat card drawn");
    ws.close();
    return;
  }
  const retreat = current.hand.find((c) => c.type === "team-retreat");
  if (retreat) {
    log("PLAYING team-retreat card", retreat.id, "hand:", current.hand.map((c) => `${c.type}:${c.value}`));
    ws.send(JSON.stringify({ action: "play_card", cardId: retreat.id }));
    return;
  }
  // play the lowest-progress-value card to cycle hand fast without winning immediately
  const card = current.hand[0];
  ws.send(JSON.stringify({ action: "play_card", cardId: card.id }));
}

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "game_created") {
    controlledIds = msg.controlledPlayerIds;
    state = msg.gameState;
    log("created, players:", state.players.map((p) => ({ id: p.id, hand: p.hand.map((c) => `${c.type}:${c.value}`) })));
    act();
  } else if (msg.event === "await_target") {
    log("await_target received for", msg.playerId, "card", msg.card);
    if (controlledIds.includes(msg.playerId)) {
      const mover = state.players.find((p) => p.id === msg.playerId);
      const teamId = state.teams.find((t) => t.id !== mover.teamId).id;
      log("sending select_retreat_target ->", teamId);
      ws.send(JSON.stringify({ action: "select_retreat_target", teamId }));
    }
  } else if (msg.event === "card_played") {
    state = msg.state;
    log("card_played, moves:", JSON.stringify(msg.moves), "status:", state.status);
    if (state.status === "finished") { log("FINISHED winner", state.winnerId); ws.close(); return; }
    act();
  } else if (msg.event === "offer_updated") {
    state = msg.state;
    if (!state.cardOffer) act();
  } else if (msg.event === "error") {
    log("ERROR", msg.message);
  }
});
ws.on("close", () => log("closed"));
