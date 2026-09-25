import { generateBoard, MAIN_LAYER_ID, tileAtPosition, findTile, rowColToPosition } from "./board";
import type { Card, CardId, CardOffer, GameState, MoveResult, MoveStep, Player, PlayerId, Team, TeamId, Tile, TileId } from "./types";

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
export const OFFER_TIMEOUT_SECONDS = 8;

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

/** How many tiles a "freeze" card advances the mover — the tile they leave
 * behind becomes a standing frozen hazard (see `computeFreezeCardPlay`). */
const FREEZE_VALUE = 1;
/** As rare as a team-advance/team-retreat card. */
const FREEZE_COPIES = 4;

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
  for (let i = 0; i < FREEZE_COPIES; i++) {
    deck.push({ id: `card-${cardIdCounter++}`, type: "freeze", value: FREEZE_VALUE });
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
        frozenTileId: null,
        frozenSkipPending: false,
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
    frozenTiles: [],
  };
}

export function currentPlayer(state: GameState): Player {
  return state.players[state.currentPlayerIndex];
}

interface EffectChainResult {
  landingTile: Tile;
  path: MoveStep[];
  /** Set (and the chain stops there) if the chain's landing tile is already
   * a frozen hazard (see `GameState.frozenTiles`) — the mover gets stuck
   * instead of chaining further. */
  stuckTileId: TileId | null;
}

/** Walks the ladder/trapdoor chain starting at `startTile` itself (not just
 * its eventual target) — so a tile arrived at from elsewhere (a dice
 * landing, or an ad-hoc drop like `computeRowColumnTrap`) still falls/climbs
 * through however many effects it chains into. `frozenTiles` is the current
 * set of already-active frozen hazards (planted by a played "freeze" card —
 * see `computeFreezeCardPlay`); landing on one of those stops the chain dead
 * (the mover is stuck, not bounced further). `visited` guards against a
 * cycle looping forever. */
function resolveEffectChain(
  state: GameState,
  startTile: Tile,
  frozenTiles: ReadonlySet<TileId>,
): EffectChainResult {
  const path: MoveStep[] = [];
  let landingTile = startTile;
  let stuckTileId: TileId | null = null;
  const visited = new Set<string>();

  while (!visited.has(landingTile.id)) {
    visited.add(landingTile.id);

    if (frozenTiles.has(landingTile.id)) {
      stuckTileId = landingTile.id;
      break;
    }

    if (
      (landingTile.effect.type === "ladder" || landingTile.effect.type === "trapdoor") &&
      landingTile.effect.targetTileId
    ) {
      const cause = landingTile.effect.type;
      landingTile = findTile(state.tiles, landingTile.effect.targetTileId);
      path.push({ tileId: landingTile.id, cause });
      continue;
    }

    break;
  }

  return { landingTile, path, stuckTileId };
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
  const { landingTile, path: chainPath, stuckTileId } = resolveEffectChain(
    state,
    initialLandingTile,
    new Set(state.frozenTiles),
  );
  path.push(...chainPath);

  const wins = landingTile.position === maxPosition;

  return {
    playerId,
    path,
    finalTileId: landingTile.id,
    wins,
    newlyFrozenTileIds: [],
    stuckTileId,
  };
}

/** Pure computation of a "freeze" card play: the mover advances `FREEZE_VALUE`
 * tile(s) forward (chaining through any further ladder/trapdoor/hazard the
 * bonus step lands on, same as an ordinary move), and the tile they started
 * this play on — the one now "behind" them — becomes a standing frozen
 * hazard added to `GameState.frozenTiles` once applied. If the mover has
 * nowhere left to advance to (already on the final tile), only the freeze
 * itself happens. */
export function computeFreezeCardPlay(state: GameState, playerId: PlayerId): MoveResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const startTile = findTile(state.tiles, player.currentTileId);
  const maxPosition = state.tiles.filter((t) => t.layerId === startTile.layerId).length;
  const bonusPosition = Math.min(startTile.position + FREEZE_VALUE, maxPosition);

  const path: MoveStep[] = [];
  let landingTile = startTile;
  let stuckTileId: TileId | null = null;

  if (bonusPosition !== startTile.position) {
    const bonusTile = tileAtPosition(state.tiles, startTile.layerId, bonusPosition);
    path.push({ tileId: bonusTile.id, cause: "step" });
    const chain = resolveEffectChain(state, bonusTile, new Set(state.frozenTiles));
    path.push(...chain.path);
    landingTile = chain.landingTile;
    stuckTileId = chain.stuckTileId;
  }

  return {
    playerId,
    path,
    finalTileId: landingTile.id,
    wins: landingTile.position === maxPosition,
    newlyFrozenTileIds: [startTile.id],
    stuckTileId,
  };
}

/** Pure computation of a "team-advance" card: every player on `teamId`
 * advances `amount` tiles from wherever they currently stand, each resolved
 * independently through `computeMove` — so a teammate who lands on a
 * ladder/trapdoor still chains through it exactly like a normal move. */
export function computeTeamAdvance(state: GameState, teamId: TeamId, amount: number): MoveResult[] {
  // A player currently stuck in a freeze episode (awaiting or having served
  // their skipped turn, but not yet moved off the hazard) sits out
  // team-advance/team-retreat cards entirely — those only move teammates
  // who are actually free to move.
  return state.players
    .filter((p) => p.teamId === teamId && !p.frozenTileId)
    .map((p) => computeMove(state, p.id, amount));
}

/** Every tile a "row-trap"/"column-trap" card played from `playerId`'s
 * current tile would drop (the whole row or column except row 0, the
 * bottom/start row, which can never be trapped) — regardless of whether
 * anyone is actually standing on it right now. `computeRowColumnTrap` uses
 * this to know which tiles to check for occupants; the UI also uses it
 * directly to show every floor along the row/column giving way, not just
 * the ones a player happens to be on. */
export function trapCardTileIds(state: GameState, playerId: PlayerId, mode: "row" | "column"): TileId[] {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const originTile = findTile(state.tiles, player.currentTileId);
  return state.tiles
    .filter((t) => t.layerId === originTile.layerId && t.row > 0)
    .filter((t) => (mode === "row" ? t.row === originTile.row : t.col === originTile.col))
    .map((t) => t.id);
}

/** Pure computation of a "row-trap"/"column-trap" card: every tile in the
 * mover's current row (or column) — except row 0, the bottom/start row,
 * which can never be trapped — falls straight down, same column, exactly
 * like stepping on a trapdoor (and can chain through a further
 * ladder/trapdoor there just the same). A "row-trap" drops one row; a
 * "column-trap" drops all the way to row 0, the bottom of the column.
 * Anyone standing on one of those tiles right now, including the mover,
 * falls immediately; this is a one-time drop, not a change to the tiles'
 * own `effect` — a future player who lands there later is unaffected. */
export interface RowColumnTrapResult {
  results: MoveResult[];
  /** Frozen hazard tiles caught in the row/column and destroyed outright —
   * gone from `GameState.frozenTiles` regardless of whether anyone was
   * standing on them. If a player was mid-freeze there and hadn't yet
   * served their skipped turn, the penalty is cancelled too (as if the
   * freeze never happened); if they'd already served it, only the tile
   * itself is cleared (they may still fall through it like any other
   * trapped tile). */
  destroyedFrozenTileIds: TileId[];
}

export function computeRowColumnTrap(
  state: GameState,
  playerId: PlayerId,
  mode: "row" | "column",
): RowColumnTrapResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Unknown player id: ${playerId}`);

  const originTile = findTile(state.tiles, player.currentTileId);
  const maxPosition = state.tiles.filter((t) => t.layerId === originTile.layerId).length;
  const trappedTileIds = new Set(trapCardTileIds(state, playerId, mode));

  const destroyedFrozenTileIds = state.frozenTiles.filter((id) => trappedTileIds.has(id));
  // The chain a falling tile lands through shouldn't treat its own
  // just-destroyed hazard as still active.
  const remainingFrozenTiles = new Set(
    state.frozenTiles.filter((id) => !destroyedFrozenTileIds.includes(id)),
  );

  const results: MoveResult[] = [];
  for (const p of state.players) {
    const tile = findTile(state.tiles, p.currentTileId);
    if (!trappedTileIds.has(tile.id)) continue;

    const dropRow = mode === "column" ? 0 : tile.row - 1;
    const dropTile = tileAtPosition(state.tiles, tile.layerId, rowColToPosition(dropRow, tile.col));
    const { landingTile, path: chainPath, stuckTileId } = resolveEffectChain(state, dropTile, remainingFrozenTiles);

    results.push({
      playerId: p.id,
      path: [{ tileId: dropTile.id, cause: "trapdoor" }, ...chainPath],
      finalTileId: landingTile.id,
      wins: landingTile.position === maxPosition,
      newlyFrozenTileIds: [],
      stuckTileId,
    });
  }

  return { results, destroyedFrozenTileIds };
}

/** Dev-only test harness for the column-trap fall animation: teleports the
 * current player to the top row of the board (same column they're already
 * in, so the drop still spans the full height once the card is played) and
 * slots a fresh "column-trap" card into the hand of both the current player
 * and the next one in turn order — so either can immediately play it and
 * watch the multi-row fall without waiting to draw one. Wired to a
 * dev-mode-only button in the UI; never reachable from normal play. */
export function setupColumnTrapDevTest(state: GameState): GameState {
  const mover = currentPlayer(state);
  const moverTile = findTile(state.tiles, mover.currentTileId);
  const topRow = state.layers.find((l) => l.id === moverTile.layerId)!.rows - 1;
  const topTile = tileAtPosition(state.tiles, moverTile.layerId, rowColToPosition(topRow, moverTile.col));

  const next = state.players[(state.currentPlayerIndex + 1) % state.players.length];
  const targetIds = new Set([mover.id, next.id]);

  const players = state.players.map((p) => {
    if (!targetIds.has(p.id)) return p;
    const withCard = [{ id: `card-dev-${cardIdCounter++}`, type: "column-trap" as const, value: 0 }, ...p.hand.slice(1)];
    return p.id === mover.id ? { ...p, currentTileId: topTile.id, hand: withCard } : { ...p, hand: withCard };
  });

  return { ...state, players };
}

/** Advances the turn from `fromIndex`, skipping over any player who still
 * owes a freeze penalty (`frozenSkipPending`) — that skip is consumed
 * (cleared) the moment it would have been their turn, and play passes on to
 * whoever comes after them. Returns the possibly-updated players array
 * alongside the resulting index, since consuming a pending skip mutates
 * that player's state. Bounded to one full lap so an (unrealistic) board
 * where every player is simultaneously frozen can't loop forever. */
function advanceTurnIndex(players: Player[], fromIndex: number): { players: Player[]; index: number } {
  let index = fromIndex;
  let updated = players;
  for (let i = 0; i < players.length; i++) {
    index = (index + 1) % players.length;
    const candidate = updated[index];
    if (!candidate.frozenSkipPending) break;
    updated = updated.map((p) => (p.id === candidate.id ? { ...p, frozenSkipPending: false } : p));
  }
  return { players: updated, index };
}

/** Applies a move's freeze bookkeeping to the mover: if the move ended stuck
 * on an already-frozen hazard, marks them as owing a skipped turn there; if
 * they just moved *off* the tile they were previously stuck on, clears that
 * so the tile can be freed. Returns the updated player plus the tile id (if
 * any) that should now be dropped from `GameState.frozenTiles`. */
function applyFreezeToPlayer(
  player: Player,
  prevTileId: TileId,
  result: Pick<MoveResult, "stuckTileId">,
): { player: Player; unfrozenTileId: TileId | null } {
  if (player.frozenTileId && player.frozenTileId === prevTileId) {
    return {
      player: { ...player, frozenTileId: null, frozenSkipPending: false },
      unfrozenTileId: player.frozenTileId,
    };
  }
  if (result.stuckTileId) {
    return {
      player: { ...player, frozenTileId: result.stuckTileId, frozenSkipPending: true },
      unfrozenTileId: null,
    };
  }
  return { player, unfrozenTileId: null };
}

/** Removes `destroyedFrozenTileIds` from `frozenTiles` and, for any player
 * still stuck on one of them, clears their freeze state — cancelling the
 * pending skip entirely if they hadn't served it yet ("like nothing
 * happened"), or just freeing the (already-vacated-of-penalty) tile if they
 * had. */
function destroyFrozenTiles(
  frozenTiles: TileId[],
  players: Player[],
  destroyedFrozenTileIds: TileId[],
): { frozenTiles: TileId[]; players: Player[] } {
  if (destroyedFrozenTileIds.length === 0) return { frozenTiles, players };
  const destroyed = new Set(destroyedFrozenTileIds);
  return {
    frozenTiles: frozenTiles.filter((id) => !destroyed.has(id)),
    players: players.map((p) =>
      p.frozenTileId && destroyed.has(p.frozenTileId)
        ? { ...p, frozenTileId: null, frozenSkipPending: false }
        : p,
    ),
  };
}

/** Weakens every "move" card in a hand by 1 (a +5 becomes +4, a -1 becomes
 * -2) — the effect of landing on a spiked "damage" tile. Other card types
 * (team-advance, team-retreat, row-trap, column-trap) carry no player-facing
 * number and are left untouched. */
function applyDamageToHand(hand: Card[]): Card[] {
  return hand.map((card) => (card.type === "move" ? { ...card, value: card.value - 1 } : card));
}

/** Applies an already-computed move result and advances the turn. Ability
 * tiles are exposed via the returned `abilityId` hook for callers to react
 * to (e.g. grant an extra turn) without the engine needing UI concerns. */
export function applyMoveResult(state: GameState, result: MoveResult): GameState {
  const landingTile = findTile(state.tiles, result.finalTileId);
  const grantsExtraTurn =
    landingTile.effect.type === "ability" && landingTile.effect.abilityId === "extra-turn";
  const dealsDamage = landingTile.effect.type === "damage";

  const mover = state.players.find((p) => p.id === result.playerId)!;
  const prevTileId = mover.currentTileId;
  const { player: movedMover, unfrozenTileId } = applyFreezeToPlayer(
    { ...mover, currentTileId: result.finalTileId, hand: dealsDamage ? applyDamageToHand(mover.hand) : mover.hand },
    prevTileId,
    result,
  );
  const players = state.players.map((p) => (p.id === result.playerId ? movedMover : p));

  const frozenTiles = [
    ...state.frozenTiles.filter((id) => id !== unfrozenTileId),
    ...result.newlyFrozenTileIds.filter((id) => !state.frozenTiles.includes(id)),
  ];

  const { players: rotatedPlayers, index: nextPlayerIndex } = grantsExtraTurn
    ? { players, index: state.currentPlayerIndex }
    : advanceTurnIndex(players, state.currentPlayerIndex);

  return {
    ...state,
    players: rotatedPlayers,
    currentPlayerIndex: nextPlayerIndex,
    turnCount: state.turnCount + 1,
    status: result.wins ? "finished" : "idle",
    winnerId: result.wins ? result.playerId : state.winnerId,
    frozenTiles,
  };
}

/** Applies a team-advance's per-member move results and advances the turn.
 * Unlike a single move, this never grants an extra turn (which teammate's
 * ability tile would even own it is ambiguous) — it just moves everyone and
 * passes play on. */
export function applyTeamAdvance(
  state: GameState,
  results: MoveResult[],
  destroyedFrozenTileIds: TileId[] = [],
): GameState {
  let players = state.players;
  let frozenTiles = state.frozenTiles;
  let winnerId = state.winnerId;
  let wins = false;

  for (const result of results) {
    const landingTile = findTile(state.tiles, result.finalTileId);
    const dealsDamage = landingTile.effect.type === "damage";
    const mover = players.find((p) => p.id === result.playerId)!;
    const prevTileId = mover.currentTileId;
    const { player: movedMover, unfrozenTileId } = applyFreezeToPlayer(
      { ...mover, currentTileId: result.finalTileId, hand: dealsDamage ? applyDamageToHand(mover.hand) : mover.hand },
      prevTileId,
      result,
    );
    players = players.map((p) => (p.id === result.playerId ? movedMover : p));
    frozenTiles = [
      ...frozenTiles.filter((id) => id !== unfrozenTileId),
      ...result.newlyFrozenTileIds.filter((id) => !frozenTiles.includes(id)),
    ];
    if (result.wins) {
      winnerId = result.playerId;
      wins = true;
    }
  }

  ({ frozenTiles, players } = destroyFrozenTiles(frozenTiles, players, destroyedFrozenTileIds));

  const { players: rotatedPlayers, index: nextPlayerIndex } = advanceTurnIndex(
    players,
    state.currentPlayerIndex,
  );

  return {
    ...state,
    players: rotatedPlayers,
    currentPlayerIndex: nextPlayerIndex,
    turnCount: state.turnCount + 1,
    status: wins ? "finished" : state.status,
    winnerId,
    frozenTiles,
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
    cardOffer = {
      playerId,
      offered: offer.drawn,
      picksRemaining: Math.min(REDRAW_COUNT, offer.drawn.length),
      deadline: Date.now() + OFFER_TIMEOUT_SECONDS * 1000,
    };
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
    cardOffer: { ...offer, offered: remainingOffered, picksRemaining, deadline: Date.now() + OFFER_TIMEOUT_SECONDS * 1000 },
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
  destroyedFrozenTileIds: TileId[] = [],
): GameState {
  return finalizeCardPlay(
    state,
    applyTeamAdvance(state, results, destroyedFrozenTileIds),
    playerId,
    cardId,
  );
}
