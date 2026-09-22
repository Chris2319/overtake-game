import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import {
  applyCardPlay,
  applyTeamAdvanceCardPlay,
  chooseOfferCard,
  computeMove,
  computeRowColumnTrap,
  computeTeamAdvance,
  createInitialState,
  currentPlayer,
  OFFER_TIMEOUT_SECONDS,
  resolveOfferTimeout,
  setupColumnTrapDevTest,
  TEAM_COLORS,
} from "../../../lib/game/engine";
import type { TeamConfig } from "../../../lib/game/engine";
import type {
  Card,
  CardId,
  GameState,
  LobbyTeam,
  PendingMove,
  Player,
  PlayerId,
  QaPlayerConfig,
  TeamId,
  WsClientAction,
  WsServerEvent,
} from "../../../lib/game/types";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

/** Seats available per team, matching the lobby's 5-team x 5-slot grid. */
const SLOTS_PER_TEAM = 5;
const TEAM_IDS: TeamId[] = TEAM_COLORS.map((t) => t.id);

/** Max total players a single QA-mode client can seat and drive itself. */
const MAX_QA_PLAYERS = 5;

type ClientSocket = WebSocket & {
  gameId?: string;
  playerId?: string;
  /** In QA mode, every player id this socket drives directly (a normal seat
   * just has one). Checked instead of `playerId` wherever a message must be
   * attributed to whichever in-game player it acts for. */
  controlledPlayerIds?: Set<PlayerId>;
  isAlive?: boolean;
};

function controlsPlayer(ws: ClientSocket, playerId: PlayerId): boolean {
  return ws.controlledPlayerIds ? ws.controlledPlayerIds.has(playerId) : ws.playerId === playerId;
}

interface RoomPlayer {
  name: string;
  ws: ClientSocket;
}

interface PendingRetreat {
  playerId: PlayerId;
  card: Card;
}

interface Room {
  gameId: string;
  phase: "lobby" | "playing";
  hostPlayerId: PlayerId;
  players: Map<PlayerId, RoomPlayer>;
  seats: Record<TeamId, (PlayerId | null)[]>;
  gameState: GameState | null;
  pendingRetreat: PendingRetreat | null;
  offerTimer: NodeJS.Timeout | null;
  nextPlayerSeq: number;
}

const rooms = new Map<string, Room>();

function generateGameId(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/** Lobby codes are case-insensitive; always use this for Map keys and payloads. */
function normalizeGameId(id: string | undefined): string {
  if (!id) return "";
  return id.toUpperCase();
}

function makeSeats(): Record<TeamId, (PlayerId | null)[]> {
  const seats = {} as Record<TeamId, (PlayerId | null)[]>;
  for (const id of TEAM_IDS) seats[id] = Array(SLOTS_PER_TEAM).fill(null);
  return seats;
}

function createRoom(gameId: string): Room {
  return {
    gameId,
    phase: "lobby",
    hostPlayerId: "",
    players: new Map(),
    seats: makeSeats(),
    gameState: null,
    pendingRetreat: null,
    offerTimer: null,
    nextPlayerSeq: 0,
  };
}

function nextPlayerId(room: Room): PlayerId {
  room.nextPlayerSeq += 1;
  return `${room.gameId}-p${room.nextPlayerSeq}`;
}

function buildLobbyTeams(room: Room): LobbyTeam[] {
  return TEAM_COLORS.map((team) => ({
    id: team.id,
    name: team.name,
    color: team.color,
    seats: room.seats[team.id].map((playerId) => {
      if (!playerId) return null;
      const player = room.players.get(playerId);
      return player ? { playerId, name: player.name } : null;
    }),
  }));
}

function send(ws: ClientSocket, payload: WsServerEvent) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room: Room, payload: WsServerEvent) {
  const msg = JSON.stringify(payload);
  // In QA mode several `room.players` entries share the same underlying
  // socket (one client controlling multiple seats) — send each socket the
  // message once, not once per seat.
  const sockets = new Set(Array.from(room.players.values(), (p) => p.ws));
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastLobby(room: Room) {
  broadcast(room, { event: "lobby_updated", teams: buildLobbyTeams(room), hostPlayerId: room.hostPlayerId });
}

function removeFromSeats(room: Room, playerId: PlayerId) {
  for (const teamId of TEAM_IDS) {
    const idx = room.seats[teamId].indexOf(playerId);
    if (idx !== -1) room.seats[teamId][idx] = null;
  }
}

function clearOfferTimer(room: Room) {
  if (room.offerTimer) {
    clearTimeout(room.offerTimer);
    room.offerTimer = null;
  }
}

function scheduleOfferTimeout(room: Room) {
  clearOfferTimer(room);
  room.offerTimer = setTimeout(() => {
    room.offerTimer = null;
    if (!room.gameState?.cardOffer) return;
    room.gameState = resolveOfferTimeout(room.gameState);
    broadcast(room, { event: "offer_updated", state: room.gameState });
  }, OFFER_TIMEOUT_SECONDS * 1000);
}

function finalizeCardPlay(room: Room, card: Card, moves: PendingMove[], newState: GameState) {
  room.gameState = newState;
  broadcast(room, { event: "card_played", card, moves, state: newState });
  if (newState.cardOffer) scheduleOfferTimeout(room);
}

/** Executes a card play for `player` — the same branching the `play_card`
 * handler used to do inline. */
function executeCardPlay(room: Room, player: Player, card: Card) {
  const state = room.gameState!;

  if (card.type === "team-retreat") {
    room.pendingRetreat = { playerId: player.id, card };
    broadcast(room, { event: "await_target", playerId: player.id, card });
    return;
  }

  if (card.type === "team-advance") {
    const results = computeTeamAdvance(state, player.teamId, card.value);
    const moves = results.map((r) => ({ playerId: r.playerId, path: r.path }));
    finalizeCardPlay(room, card, moves, applyTeamAdvanceCardPlay(state, player.id, card.id, results));
  } else if (card.type === "row-trap" || card.type === "column-trap") {
    const results = computeRowColumnTrap(state, player.id, card.type === "row-trap" ? "row" : "column");
    const moves = results.map((r) => ({ playerId: r.playerId, path: r.path }));
    finalizeCardPlay(room, card, moves, applyTeamAdvanceCardPlay(state, player.id, card.id, results));
  } else {
    const result = computeMove(state, player.id, card.value);
    finalizeCardPlay(room, card, [{ playerId: player.id, path: result.path }], applyCardPlay(state, player.id, card.id, result));
  }
}

function finalizeRetreat(room: Room, pending: PendingRetreat, teamId: TeamId) {
  const state = room.gameState!;
  const results = computeTeamAdvance(state, teamId, pending.card.value);
  const moves = results.map((r) => ({ playerId: r.playerId, path: r.path }));
  room.pendingRetreat = null;
  finalizeCardPlay(room, pending.card, moves, applyTeamAdvanceCardPlay(state, pending.playerId, pending.card.id, results));
}

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler();
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: ClientSocket) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      let msg: WsClientAction;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.action === "create_game") {
        const gameId = generateGameId();
        const room = createRoom(gameId);
        rooms.set(gameId, room);
        const playerId = nextPlayerId(room);
        const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : "Player";
        room.players.set(playerId, { name, ws });
        room.hostPlayerId = playerId;
        room.seats[TEAM_IDS[0]][0] = playerId;
        ws.gameId = gameId;
        ws.playerId = playerId;
        send(ws, {
          event: "game_created",
          gameId,
          playerId,
          controlledPlayerIds: [playerId],
          isHost: true,
          phase: room.phase,
          teams: buildLobbyTeams(room),
          gameState: null,
        });
      } else if (msg.action === "create_qa_game") {
        const entries: QaPlayerConfig[] = Array.isArray(msg.players) ? msg.players.slice(0, MAX_QA_PLAYERS) : [];
        if (entries.length < 1) {
          send(ws, { event: "error", message: "Need at least 1 player to start a QA game" });
          return;
        }

        const gameId = generateGameId();
        const room = createRoom(gameId);
        rooms.set(gameId, room);

        const controlledIds: PlayerId[] = [];
        const teamConfigs = new Map<TeamId, TeamConfig>();
        for (const entry of entries) {
          const team = TEAM_IDS.includes(entry.teamId) ? TEAM_COLORS.find((t) => t.id === entry.teamId)! : TEAM_COLORS[0];
          const playerId = nextPlayerId(room);
          const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "Player";
          room.players.set(playerId, { name, ws });
          controlledIds.push(playerId);
          if (!teamConfigs.has(team.id)) {
            teamConfigs.set(team.id, { id: team.id, name: team.name, color: team.color, players: [] });
          }
          teamConfigs.get(team.id)!.players.push({ id: playerId, name });
        }

        const hostPlayerId = controlledIds[0];
        room.hostPlayerId = hostPlayerId;
        ws.gameId = gameId;
        ws.playerId = hostPlayerId;
        ws.controlledPlayerIds = new Set(controlledIds);

        room.gameState = createInitialState(TEAM_COLORS.filter((t) => teamConfigs.has(t.id)).map((t) => teamConfigs.get(t.id)!));
        room.phase = "playing";
        send(ws, {
          event: "game_created",
          gameId,
          playerId: hostPlayerId,
          controlledPlayerIds: controlledIds,
          isHost: true,
          phase: room.phase,
          teams: buildLobbyTeams(room),
          gameState: room.gameState,
        });
      } else if (msg.action === "join_game") {
        const gameId = normalizeGameId(msg.gameId);
        const room = rooms.get(gameId);
        if (!room) {
          send(ws, { event: "error", message: `Game ${gameId} not found` });
          return;
        }
        if (room.phase !== "lobby") {
          send(ws, { event: "error", message: "Game has already started" });
          return;
        }
        const playerId = nextPlayerId(room);
        const name = typeof msg.name === "string" && msg.name.trim() ? msg.name.trim() : "Player";
        room.players.set(playerId, { name, ws });
        ws.gameId = gameId;
        ws.playerId = playerId;
        send(ws, {
          event: "game_joined",
          gameId,
          playerId,
          controlledPlayerIds: [playerId],
          isHost: false,
          phase: room.phase,
          teams: buildLobbyTeams(room),
          gameState: null,
        });
        broadcastLobby(room);
      } else if (msg.action === "select_seat") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "lobby" || !ws.playerId) return;
        if (!TEAM_IDS.includes(msg.teamId)) return;
        if (msg.slotIndex < 0 || msg.slotIndex >= SLOTS_PER_TEAM) return;
        if (room.seats[msg.teamId][msg.slotIndex] !== null) return;
        removeFromSeats(room, ws.playerId);
        room.seats[msg.teamId][msg.slotIndex] = ws.playerId;
        broadcastLobby(room);
      } else if (msg.action === "start_game") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "lobby" || !ws.playerId) return;
        if (room.hostPlayerId !== ws.playerId) return;
        const teamConfigs: TeamConfig[] = TEAM_COLORS.filter((team) => room.seats[team.id].some(Boolean)).map(
          (team) => ({
            id: team.id,
            name: team.name,
            color: team.color,
            players: room.seats[team.id]
              .filter((id): id is PlayerId => id !== null)
              .map((id) => ({ id, name: room.players.get(id)?.name ?? "Player" })),
          }),
        );
        if (teamConfigs.length < 2) {
          send(ws, { event: "error", message: "Need at least 2 teams with a player seated to start" });
          return;
        }
        room.gameState = createInitialState(teamConfigs);
        room.phase = "playing";
        broadcast(room, { event: "game_started", state: room.gameState });
      } else if (msg.action === "play_card") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "playing" || !room.gameState || !ws.playerId) return;
        if (room.pendingRetreat) return;
        const player = currentPlayer(room.gameState);
        if (!controlsPlayer(ws, player.id)) return;
        const card = player.hand.find((c) => c.id === msg.cardId);
        if (!card) return;
        executeCardPlay(room, player, card);
      } else if (msg.action === "select_retreat_target") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "playing" || !room.gameState || !ws.playerId) return;
        const pending = room.pendingRetreat;
        if (!pending || !controlsPlayer(ws, pending.playerId)) return;
        if (!TEAM_IDS.includes(msg.teamId)) return;
        finalizeRetreat(room, pending, msg.teamId);
      } else if (msg.action === "choose_offer_card") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "playing" || !room.gameState || !ws.playerId) return;
        const offer = room.gameState.cardOffer;
        if (!offer || !controlsPlayer(ws, offer.playerId)) return;
        if (!offer.offered.some((c: Card) => c.id === msg.cardId)) return;
        const next = chooseOfferCard(room.gameState, msg.cardId as CardId);
        room.gameState = next;
        if (next.cardOffer) scheduleOfferTimeout(room);
        else clearOfferTimer(room);
        broadcast(room, { event: "offer_updated", state: next });
      } else if (msg.action === "offer_activity") {
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "playing" || !room.gameState || !ws.playerId) return;
        const offer = room.gameState.cardOffer;
        if (!offer || !controlsPlayer(ws, offer.playerId)) return;
        // The player is still actively picking (toggling cards) — push the
        // deadline back out so the offer doesn't time out from under them
        // mid-selection. `deadline` is re-broadcast so every client's
        // countdown display (which reads it straight off the offer, not a
        // locally-guessed timer) stays in sync with the renewed timeout.
        scheduleOfferTimeout(room);
        room.gameState = { ...room.gameState, cardOffer: { ...offer, deadline: Date.now() + OFFER_TIMEOUT_SECONDS * 1000 } };
        broadcast(room, { event: "offer_updated", state: room.gameState });
      } else if (msg.action === "dev_setup_column_trap_test") {
        // Dev-only test harness — never wired into a production build (see
        // the dev-mode check around the button that sends this in GameUI).
        // Still gate it server-side too, since a client could send it by
        // hand against a prod server.
        if (!dev) return;
        const room = rooms.get(normalizeGameId(ws.gameId));
        if (!room || room.phase !== "playing" || !room.gameState) return;
        room.gameState = setupColumnTrapDevTest(room.gameState);
        broadcast(room, { event: "dev_state_set", state: room.gameState });
      }
    });

    ws.on("close", () => {
      const room = rooms.get(normalizeGameId(ws.gameId));
      if (!room || !ws.playerId) return;
      if (room.phase !== "lobby") return;
      room.players.delete(ws.playerId);
      removeFromSeats(room, ws.playerId);
      if (room.hostPlayerId === ws.playerId) {
        const nextHost = room.players.keys().next();
        room.hostPlayerId = nextHost.done ? "" : nextHost.value;
      }
      if (room.players.size === 0) {
        rooms.delete(room.gameId);
      } else {
        broadcastLobby(room);
      }
    });
  });

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url ?? "", true));
  });

  /** Below most proxy idle timeouts (Cloudflare 100s, Heroku 55s, nginx 60s default). */
  const HEARTBEAT_INTERVAL_MS = 25000;
  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients as Set<ClientSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        /* socket closing */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeatTimer));

  server.on("upgrade", (req, socket, head) => {
    if (parse(req.url ?? "").pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      handleUpgrade(req, socket, head);
    }
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
