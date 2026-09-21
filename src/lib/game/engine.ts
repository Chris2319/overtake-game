import { generateBoard, MAIN_LAYER_ID, tileAtPosition, findTile, rowColToPosition } from "./board";
import type { Card, CardId, CardOffer, GameState, MoveResult, MoveStep, Player, PlayerId, Team, TeamId, Tile } from "./types";

/** The five team color identities available today. Order also picks the
 * default team for a config that doesn't specify a color. */
export const TEAM_COLORS: { id: TeamId; name: string; color: number }[] = [
  { id: "blue", name: "Blue", color: 0x3d7bff },
  { id: "red", name: "Red", color: 0xff4d4d },
  { id: "green", name: "Green", color: 0x3ddc6b },
  { id: "yellow", name: "Yellow", color: 0xffd93d },
  { id: "purple", name: "Purple", color: 0xb14bff },
];

/** Number of teams in a game. */
export const TEAM_COUNT = 3;

/** Number of players on each team. */
export const PLAYERS_PER_TEAM = 4;

/** A player's hand caps at this many cards. Whenever it drops to
 * `REDRAW_THRESHOLD` or fewer after a play, `OFFER_SIZE` cards are fanned
 * out for the player to pick `REDRAW_COUNT` of (see `CardOffer`), rather
 * than drawing blind. */
export const HAND_SIZE = 5;
export const REDRAW_THRESHOLD = 2;
export const REDRAW_COUNT = 3;
export const OFFER_SIZE = 5;
/** Seconds a player has to pick before the offer auto-resolves randomly. */
export const OFFER_TIMEOUT_SECONDS = 5;

const FORWARD_VALUES = [1, 2, 3, 4, 5, 6];
const COPIES_PER_VALUE = 10;

/** Rarer "move back" cards, so drawing one is less likely than a forward move. */
const BACKWARD_VALUES = [-1, -2, -3];
const BACKWARD_COPIES_PER_VALUE = 3;

/** How many tiles a "team-advance" card moves each teammate. */
const TEAM_ADVANCE_VALUE = 1;
/** Sized against the rest of the deck so a "team-advance" card comes up
 * roughly 5% of the time (4 / (60 + 9 + 4) ≈ 5.5%). */
const TEAM_ADVANCE_COPIES = 4;

/** How many tiles a "team-retreat" card moves each member of the chosen
 * opposing team (negative = backward). */
const TEAM_RETREAT_VALUE = -1;
/** As rare as a "team-advance" card. */
const TEAM_RETREAT_COPIES = 4;

/** "row-trap"/"column-trap" cards carry no numeric value — the whole
 * row/column they hit is fixed by the mover's own position. As disruptive as
 * team cards, so kept just as rare. */
const ROW_TRAP_COPIES = 2;
const COLUMN_TRAP_COPIES = 2;

export interface PlayerConfig {
  id: PlayerId;
  name: string;
}

export interface TeamConfig {
  id: TeamId;
  name: string;
  color?: number;
  players: PlayerConfig[];
}

let cardIdCounter = 0;

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Builds a shuffled card deck: forward move cards (values 1-6,
 * `COPIES_PER_VALUE` each), rarer backward cards (`BACKWARD_VALUES`,
 * `BACKWARD_COPIES_PER_VALUE` each), and a handful of "team-advance"
 * specials. Further special card types will get their own entries here
 * later. */
function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const value of FORWARD_VALUES) {
    for (let i = 0; i < COPIES_PER_VALUE; i++) {
      deck.push({ id: `card-${cardIdCounter++}`, type: "move", value });
    }
  }
  for (const value of BACKWARD_VALUES) {
    for (let i = 0; i < BACKWARD_COPIES_PER_VALUE; i++) {
      deck.push({ id: `card-${cardIdCounter++}`, type: "move", value });
    }
  }
  for (let i = 0; i < TEAM_ADVANCE_COPIES; i++) {
    deck.push({ id: `card-${cardIdCounter++}`, type: "team-advance", value: TEAM_ADVANCE_VALUE });
  }
  for (let i = 0; i < TEAM_RETREAT_COPIES; i++) {
    deck.push({ id: `card-${cardIdCounter++}`, type: "team-retreat", value: TEAM_RETREAT_VALUE });
  }
  for (let i = 0; i < ROW_TRAP_COPIES; i++) {
    deck.push({ id: `card-${cardIdCounter++}`, type: "row-trap", value: 0 });
  }
  for (let i = 0; i < COLUMN_TRAP_COPIES; i++) {
    deck.push({ id: `card-${cardIdCounter++}`, type: "column-trap", value: 0 });
  }
  return shuffle(deck);
}

/** Draws `count` cards, reshuffling the discard pile back into the draw pile
 * mid-draw if it runs out. */
function drawCards(
  drawPile: Card[],
  discardPile: Card[],
  count: number,
): { drawn: Card[]; drawPile: Card[]; discardPile: Card[] } {
  let pile = [...drawPile];
  let discard = [...discardPile];
  const drawn: Card[] = [];

  for (let i = 0; i < count; i++) {
    if (pile.length === 0) {
      if (discard.length === 0) break;
      pile = shuffle(discard);
      discard = [];
    }
    drawn.push(pile.shift()!);
  }

  return { drawn, drawPile: pile, discardPile: discard };
}

export function createInitialState(teamConfigs: TeamConfig[]): GameState {
  const { layers, tiles, abilities } = generateBoard();
  const startTile = tileAtPosition(tiles, MAIN_LAYER_ID, 1);

  let drawPile = createDeck();
  let discardPile: Card[] = [];

  const teams: Team[] = teamConfigs.map((config, i) => ({
    id: config.id,
    name: config.name,
    color: config.color ?? TEAM_COLORS[i % TEAM_COLORS.length].color,
  }));

  const playersByTeam: Player[][] = teamConfigs.map((config, i) => {
    const team = teams[i];
    return config.players.map((playerConfig) => {
      const dealt = drawCards(drawPile, discardPile, HAND_SIZE);
      drawPile = dealt.drawPile;
      discardPile = dealt.discardPile;

      return {
        id: playerConfig.id,
        name: playerConfig.name,
        teamId: team.id,
        color: team.color,
        currentTileId: startTile.id,
        abilities: [],
        hand: dealt.drawn,
      };
    });
  });

  // Interleave one player per team per round (Team A p1, Team B p1, Team C
  // p1, Team A p2, ...) so `currentPlayerIndex + 1` rotates turns across
  // teams instead of exhausting one team before moving to the next.
  const maxRosterSize = Math.max(...playersByTeam.map((roster) => roster.length));
  const players: Player[] = [];
  for (let round = 0; round < maxRosterSize; round++) {
    for (const roster of playersByTeam) {
      if (roster[round]) players.push(roster[round]);
    }
  }

  return {
    boardId: "shutes-and-ladders-3d",
    layers,
    tiles,
    abilities,
    teams,
    players,
    currentPlayerIndex: 0,
    turnCount: 0,
    status: "idle",
    drawPile,
    discardPile,
    lastPlayedCard: null,
    winnerId: null,
    cardOffer: null,
  };
}

export function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

/** Walks the ladder/trapdoor chain starting at `startTile` itself (not just
 * its eventual target) — so a tile arrived at from elsewhere (a dice
 * landing, or an ad-hoc drop like `computeRowColumnTrap`) still falls/climbs
 * through however many effects it chains into. `visited` guards against a
 * cycle looping forever. */
function resolveEffectChain(state: GameState, startTile: Tile): { landingTile: Tile; path: MoveStep[] } {
  const path: MoveStep[] = [];
  let landingTile = startTile;
  const visited = new Set<string>();
  while (
    (landingTile.effect.type === "ladder" || landingTile.effect.type === "trapdoor") &&
    landingTile.effect.targetTileId &&
    !visited.has(landingTile.id)
  ) {
    visited.add(landingTile.id);
    const cause = landingTile.effect.type;
    landingTile = findTile(state.tiles, landingTile.effect.targetTileId);
    path.push({ tileId: landingTile.id, cause });
  }
  return { landingTile, path };
}

/** Pure computation of where a roll takes a player, including any chained
 * ladder/trapdoor effect. A negative roll (from a "move back" card) walks
 * backward instead, clamped so it can never go past the start of the board.
 * Does not mutate `state` — callers apply the result (see `applyMoveResult`)
 * once any animation has finished. */
export function computeMove(state: GameState, playerId: PlayerId, roll: number): MoveResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const startTile = findTile(state.tiles, player.currentTileId);
  const maxPosition = state.tiles.filter((t) => t.layerId === startTile.layerId).length;

  const path: MoveStep[] = [];

  // Overshooting the final tile bounces back by the overshoot amount rather
  // than just landing on the final tile — a roll must land exactly on the
  // final tile to win.
  const rawTarget = startTile.position + roll;
  const overshoot = Math.max(rawTarget - maxPosition, 0);
  let targetPosition = Math.max(Math.min(rawTarget, maxPosition), 1);
  const step = roll >= 0 ? 1 : -1;

  for (let pos = startTile.position + step; step > 0 ? pos <= targetPosition : pos >= targetPosition; pos += step) {
    path.push({ tileId: tileAtPosition(state.tiles, startTile.layerId, pos).id, cause: "step" });
  }

  if (overshoot > 0) {
    const bouncePosition = Math.max(targetPosition - overshoot, 1);
    for (let pos = targetPosition - 1; pos >= bouncePosition; pos--) {
      path.push({ tileId: tileAtPosition(state.tiles, startTile.layerId, pos).id, cause: "step" });
    }
    targetPosition = bouncePosition;
  }

  const initialLandingTile = tileAtPosition(state.tiles, startTile.layerId, targetPosition);
  const { landingTile, path: chainPath } = resolveEffectChain(state, initialLandingTile);
  path.push(...chainPath);

  const wins = landingTile.position === maxPosition;

  return {
    playerId,
    path,
    finalTileId: landingTile.id,
    wins,
  };
}

/** Pure computation of a "team-advance" card: every player on `teamId`
 * advances `amount` tiles from wherever they currently stand, each resolved
 * independently through `computeMove` — so a teammate who lands on a
 * ladder/trapdoor still chains through it exactly like a normal move. */
export function computeTeamAdvance(state: GameState, teamId: TeamId, amount: number): MoveResult[] {
  return state.players.filter((p) => p.teamId === teamId).map((p) => computeMove(state, p.id, amount));
}

/** Pure computation of a "row-trap"/"column-trap" card: every tile in the
 * mover's current row (or column) — except row 0, the bottom/start row,
 * which can never be trapped — drops straight down one row, same column,
 * exactly like stepping on a trapdoor (and can chain through a further
 * ladder/trapdoor there just the same). Anyone standing on one of those
 * tiles right now, including the mover, falls immediately; this is a
 * one-time drop, not a change to the tiles' own `effect` — a future player
 * who lands there later is unaffected. */
export function computeRowColumnTrap(state: GameState, playerId: PlayerId, mode: "row" | "column"): MoveResult[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const originTile = findTile(state.tiles, player.currentTileId);
  const maxPosition = state.tiles.filter((t) => t.layerId === originTile.layerId).length;

  const trappedTileIds = new Set(
    state.tiles
      .filter((t) => t.layerId === originTile.layerId && t.row > 0)
      .filter((t) => (mode === "row" ? t.row === originTile.row : t.col === originTile.col))
      .map((t) => t.id),
  );

  const results: MoveResult[] = [];
  for (const p of state.players) {
    const tile = findTile(state.tiles, p.currentTileId);
    if (!trappedTileIds.has(tile.id)) continue;

    const dropTile = tileAtPosition(state.tiles, tile.layerId, rowColToPosition(tile.row - 1, tile.col));
    const { landingTile, path: chainPath } = resolveEffectChain(state, dropTile);

    results.push({
      playerId: p.id,
      path: [{ tileId: dropTile.id, cause: "trapdoor" }, ...chainPath],
      finalTileId: landingTile.id,
      wins: landingTile.position === maxPosition,
    });
  }

  return results;
}

/** Applies an already-computed move result and advances the turn. Ability
 * tiles are exposed via the returned `abilityId` hook for callers to react
 * to (e.g. grant an extra turn) without the engine needing UI concerns. */
export function applyMoveResult(state: GameState, result: MoveResult): GameState {
  const landingTile = findTile(state.tiles, result.finalTileId);
  const grantsExtraTurn =
    landingTile.effect.type === "ability" && landingTile.effect.abilityId === "extra-turn";

  const players = state.players.map((p) =>
    p.id === result.playerId ? { ...p, currentTileId: result.finalTileId } : p,
  );

  const nextPlayerIndex = grantsExtraTurn
    ? state.currentPlayerIndex
    : (state.currentPlayerIndex + 1) % state.players.length;

  return {
    ...state,
    players,
    currentPlayerIndex: nextPlayerIndex,
    turnCount: state.turnCount + 1,
    status: result.wins ? "finished" : "idle",
    winnerId: result.wins ? result.playerId : state.winnerId,
  };
}

/** Applies a team-advance's per-member move results and advances the turn.
 * Unlike a single move, this never grants an extra turn (which teammate's
 * ability tile would even own it is ambiguous) — it just moves everyone and
 * passes play on. */
export function applyTeamAdvance(state: GameState, results: MoveResult[]): GameState {
  let players = state.players;
  let winnerId = state.winnerId;
  let wins = false;

  for (const result of results) {
    players = players.map((p) => (p.id === result.playerId ? { ...p, currentTileId: result.finalTileId } : p));
    if (result.wins) {
      winnerId = result.playerId;
      wins = true;
    }
  }

  return {
    ...state,
    players,
    currentPlayerIndex: (state.currentPlayerIndex + 1) % state.players.length,
    turnCount: state.turnCount + 1,
    status: wins ? "finished" : state.status,
    winnerId,
  };
}

/** Shared tail end of playing a card: discards it, opens a `CardOffer` for
 * the mover to redraw from once their hand drops to `REDRAW_THRESHOLD` or
 * fewer, and records it as the last-played card. `movedState` is the result
 * of whichever move (`applyMoveResult` / `applyTeamAdvance`) the card
 * caused. */
function finalizeCardPlay(
  state: GameState,
  movedState: GameState,
  playerId: PlayerId,
  cardId: CardId,
): GameState {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const playedCard = player.hand.find((c) => c.id === cardId);
  if (!playedCard) throw new Error(`Player ${playerId} does not hold card ${cardId}`);

  const hand = movedState.players.find((p) => p.id === playerId)!.hand.filter((c) => c.id !== cardId);
  let drawPile = movedState.drawPile;
  let discardPile = [...movedState.discardPile, playedCard];
  let cardOffer: CardOffer | null = null;

  if (hand.length <= REDRAW_THRESHOLD) {
    const offer = drawCards(drawPile, discardPile, OFFER_SIZE);
    drawPile = offer.drawPile;
    discardPile = offer.discardPile;
    cardOffer = { playerId, offered: offer.drawn, picksRemaining: Math.min(REDRAW_COUNT, offer.drawn.length) };
  }

  return {
    ...movedState,
    players: movedState.players.map((p) => (p.id === playerId ? { ...p, hand } : p)),
    drawPile,
    discardPile,
    lastPlayedCard: playedCard,
    cardOffer,
  };
}

/** Inserts `cards` into `pile` at independently random positions — used to
 * shuffle a card offer's unchosen cards back into the draw pile. */
function insertRandomly(pile: Card[], cards: Card[]): Card[] {
  const result = [...pile];
  for (const card of cards) {
    const index = Math.floor(Math.random() * (result.length + 1));
    result.splice(index, 0, card);
  }
  return result;
}

/** Picks `cardId` out of the pending `cardOffer` into the offering player's
 * hand. Once `picksRemaining` reaches 0, the remaining offered cards are
 * shuffled back into the draw pile and the offer is cleared. */
export function chooseOfferCard(state: GameState, cardId: CardId): GameState {
  const offer = state.cardOffer;
  if (!offer) throw new Error("No card offer is pending");

  const chosen = offer.offered.find((c) => c.id === cardId);
  if (!chosen) throw new Error(`Card ${cardId} is not part of the pending offer`);

  const remainingOffered = offer.offered.filter((c) => c.id !== cardId);
  const picksRemaining = offer.picksRemaining - 1;
  const players = state.players.map((p) =>
    p.id === offer.playerId ? { ...p, hand: [...p.hand, chosen] } : p,
  );

  if (picksRemaining <= 0) {
    return {
      ...state,
      players,
      drawPile: insertRandomly(state.drawPile, remainingOffered),
      cardOffer: null,
    };
  }

  return {
    ...state,
    players,
    cardOffer: { ...offer, offered: remainingOffered, picksRemaining },
  };
}

/** Resolves a pending card offer once its pick timer runs out: randomly
 * fills any remaining picks, then shuffles the rest back into the draw
 * pile, same as if the player had chosen them. */
export function resolveOfferTimeout(state: GameState): GameState {
  let current = state;
  while (current.cardOffer && current.cardOffer.picksRemaining > 0 && current.cardOffer.offered.length > 0) {
    const { offered } = current.cardOffer;
    const randomCard = offered[Math.floor(Math.random() * offered.length)];
    current = chooseOfferCard(current, randomCard.id);
  }
  return current.cardOffer ? { ...current, cardOffer: null } : current;
}

/** Commits a move made by playing `cardId` from the mover's hand. */
export function applyCardPlay(
  state: GameState,
  playerId: PlayerId,
  cardId: CardId,
  result: MoveResult,
): GameState {
  return finalizeCardPlay(state, applyMoveResult(state, result), playerId, cardId);
}

/** Commits a "team-advance" card played by `playerId`: moves every result in
 * `results` (from `computeTeamAdvance`), then discards the card as usual. */
export function applyTeamAdvanceCardPlay(
  state: GameState,
  playerId: PlayerId,
  cardId: CardId,
  results: MoveResult[],
): GameState {
  return finalizeCardPlay(state, applyTeamAdvance(state, results), playerId, cardId);
}
