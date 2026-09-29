// Core data model for the 3D Chutes & Ladders game.
// Everything is id-referenced and array-based so new content (extra layers,
// players, abilities, tile effects) can be added without changing shapes.

export type TileId = string;
export type LayerId = string;
export type PlayerId = string;
export type AbilityId = string;
export type TeamId = string;

/** A horizontal board level. Only one exists today, but tiles already carry
 * a layerId and layers carry a `yOffset`, so stacking boards vertically later
 * is just adding another entry here. */
export interface BoardLayer {
  id: LayerId;
  index: number;
  rows: number;
  cols: number;
  /** vertical offset in world units, for stacking layers in 3D */
  yOffset: number;
}

export type TileEffectType = "none" | "ladder" | "trapdoor" | "ability" | "damage" | "special";

export interface TileEffect {
  type: TileEffectType;
  /** destination tile for "ladder" / "trapdoor" effects. A trapdoor's
   * target always sits one layer down, at the same row/col — if that tile
   * is itself a trapdoor, the engine keeps falling through the chain. */
  targetTileId?: TileId;
  /** ability granted/triggered for "ability" effects */
  abilityId?: AbilityId;
}

export interface Tile {
  id: TileId;
  layerId: LayerId;
  /** 1-based sequential position along the board's path, continuous across
   * every stacked layer (e.g. layer 0 ends at 100, layer 1 runs 101-200) */
  position: number;
  row: number;
  col: number;
  effect: TileEffect;
}

export interface Ability {
  id: AbilityId;
  name: string;
  description: string;
}

export type CardId = string;

/** "move" cards (values 1-6, replacing the dice roll) are the bulk of the
 * deck. "team-advance" moves every player on the mover's team forward by
 * `value` tiles at once. "team-retreat" is a two-step card: the mover picks
 * an opposing team (see the UI's target-selection overlay) before it moves
 * that team's players back by `value` tiles. "row-trap"/"column-trap" drop
 * every tile in the mover's current row/column (except the bottom row) like
 * a one-time trapdoor — anyone standing there right now, including the
 * mover, falls immediately. "row-trap" drops one level down; "column-trap"
 * falls all the way to the bottom of the column (row 0). "freeze" advances
 * the mover 1 tile and turns the tile they just left into a standing frozen
 * hazard for the rest of the game — whoever later lands exactly on it loses
 * their next turn (see `GameState.frozenTiles`). The type tag lets further
 * special cards slot in later without changing the hand/deck plumbing. */
export type CardType = "move" | "team-advance" | "team-retreat" | "row-trap" | "column-trap" | "freeze";

/** The outcomes a "special" tile's Fortune Wheel can land on (see
 * `GameState.pendingWheelSpin`). Each is a fixed, non-random magnitude —
 * only which segment the spin lands on is random. */
export type WheelOutcomeType = "advance" | "retreat" | "swap" | "wildcard" | "freeze" | "drop";

export interface Card {
  id: CardId;
  type: CardType;
  /** Tiles to move (a "move" card's roll, or a "team-advance"/"team-retreat"
   * card's per-member advance, negative for "team-retreat"). */
  value: number;
}

/** A group of players sharing a color identity. Every player on the team
 * renders in this same color — this is where custom avatars will attach
 * later. */
export interface Team {
  id: TeamId;
  name: string;
  color: number;
}

/** A pending "choose your redraw" offer: `offered` cards are fanned out
 * face-up for `playerId` to pick `picksRemaining` of, with the rest shuffled
 * back into the draw pile once the pick count (or a timeout) resolves it. */
export interface CardOffer {
  playerId: PlayerId;
  offered: Card[];
  picksRemaining: number;
  /** Server epoch-ms timestamp the pick timer auto-resolves at. Clients
   * derive their countdown display directly from this instead of timing
   * their own local deadline off whenever they happen to receive the
   * offer, which drifted out of sync with the server's actual timeout. */
  deadline: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  teamId: TeamId;
  /** this player's team's color — every teammate's token shares it, so the
   * glowing hover ring (see Scene) is what actually tells them apart */
  color: number;
  currentTileId: TileId;
  abilities: AbilityId[];
  hand: Card[];
  /** Tile this player is currently stuck on after landing on a frozen
   * hazard, from the moment they land until they finally move off it again
   * (see `frozenSkipPending` and `GameState.frozenTiles`). Null the rest of
   * the time. */
  frozenTileId: TileId | null;
  /** True while this player still owes the "lose your next turn" penalty
   * for `frozenTileId` — cleared (without unfreezing the tile) the moment
   * their turn comes up and is skipped, so the *following* turn is the one
   * where they actually get to move off it. */
  frozenSkipPending: boolean;
}

export type GameStatus = "idle" | "moving" | "finished";

export interface GameState {
  boardId: string;
  layers: BoardLayer[];
  tiles: Tile[];
  abilities: Ability[];
  teams: Team[];
  players: Player[];
  currentPlayerIndex: number;
  turnCount: number;
  status: GameStatus;
  drawPile: Card[];
  discardPile: Card[];
  lastPlayedCard: Card | null;
  winnerId: PlayerId | null;
  /** Non-null while a player is choosing (or auto-resolving) their redraw
   * from a fanned-out offer instead of drawing blind. */
  cardOffer: CardOffer | null;
  /** Tiles currently acting as a frozen hazard: whoever lands exactly on one
   * loses their next turn. A tile enters this list the first time a player
   * lands on its "freeze" effect (which also bumps that player forward 1
   * extra tile); it leaves the list once the stuck player finally moves off
   * it again, or if a row/column-trap card destroys it first. */
  frozenTiles: TileId[];
  /** Non-null while a player who just landed on a "special" (green) tile is
   * choosing (or about to auto-spin) the Fortune Wheel — the turn is held on
   * `playerId` until it resolves (see `spin_wheel`/`wheel_spun`). */
  pendingWheelSpin: { playerId: PlayerId; tileId: TileId } | null;
}

/** A single hop in an animated move: land on `tileId`, optionally via a
 * ladder/trapdoor effect (used by the renderer to distinguish a walking step
 * from a climb/fall). */
export interface MoveStep {
  tileId: TileId;
  cause: "step" | "ladder" | "trapdoor";
}

export interface MoveResult {
  playerId: PlayerId;
  path: MoveStep[];
  finalTileId: TileId;
  wins: boolean;
  /** Freeze tiles triggered for the first time by this move — landed on
   * exactly, granting the mover a bonus step and turning the tile itself
   * into a frozen hazard (see `GameState.frozenTiles`). */
  newlyFrozenTileIds: TileId[];
  /** Set when this move's final tile is an already-frozen hazard — the
   * mover gets stuck there and owes a skipped turn. */
  stuckTileId: TileId | null;
}

// --- Multiplayer / WebSocket wire types -----------------------------------
// The server (src/app/(backend)/api/server.ts) owns the authoritative
// GameState and card randomness; clients only send intents and render
// whatever the server broadcasts back.

/** A team's fixed 5 seats in the lobby; null = open slot. */
export interface LobbySeat {
  playerId: PlayerId;
  name: string;
}

export interface LobbyTeam {
  id: TeamId;
  name: string;
  color: number;
  seats: (LobbySeat | null)[];
}

export type GamePhase = "lobby" | "playing";

/** One resolved move to animate on every client before it applies `state`. */
export interface PendingMove {
  playerId: PlayerId;
  path: MoveStep[];
}

/** One seat in a QA-mode game: a human-controlled player the requesting
 * client will drive directly, on the given team. */
export interface QaPlayerConfig {
  name: string;
  teamId: TeamId;
}

export type WsClientAction =
  | {
      action: "create_game";
      name: string;
      /** Dev/scripting convenience: request a specific game code instead of a
       * random one, so a launcher script can build every player's join URL
       * up front without having to observe the host's browser. Ignored if
       * already taken. */
      gameId?: string;
    }
  | { action: "create_qa_game"; players: QaPlayerConfig[] }
  | { action: "join_game"; gameId: string; name: string }
  | { action: "select_seat"; teamId: TeamId; slotIndex: number }
  | { action: "start_game" }
  | { action: "play_card"; cardId: CardId }
  | { action: "select_retreat_target"; teamId: TeamId }
  | { action: "choose_offer_card"; cardId: CardId }
  | { action: "offer_activity" }
  /** Spins the Fortune Wheel for the pending player once `GameState.pendingWheelSpin`
   * is set — the server picks the outcome. */
  | { action: "spin_wheel" }
  /** Dev-only: sets up the column-trap fall animation test scenario (see
   * `setupColumnTrapDevTest`). Ignored by the server outside of `next dev`. */
  | { action: "dev_setup_column_trap_test" };

export type WsServerEvent =
  | {
      event: "game_created" | "game_joined";
      gameId: string;
      playerId: PlayerId;
      /** All player ids this client drives directly — just `[playerId]` for
       * a normal seat, or every QA-mode seat the client set up. */
      controlledPlayerIds: PlayerId[];
      isHost: boolean;
      phase: GamePhase;
      teams: LobbyTeam[];
      gameState: GameState | null;
    }
  | { event: "lobby_updated"; teams: LobbyTeam[]; hostPlayerId: PlayerId }
  | { event: "game_started"; state: GameState }
  | { event: "await_target"; playerId: PlayerId; card: Card }
  | { event: "card_played"; card: Card; moves: PendingMove[]; state: GameState }
  | { event: "offer_updated"; state: GameState }
  /** The Fortune Wheel's result: `segmentIndex` (into the fixed
   * `WHEEL_SEGMENTS` order every client renders the wheel in) and `outcome`
   * tell clients which wedge to spin the wheel onto before animating
   * `moves` and adopting `state`, mirroring `card_played`. */
  | {
      event: "wheel_spun";
      playerId: PlayerId;
      segmentIndex: number;
      outcome: WheelOutcomeType;
      moves: PendingMove[];
      state: GameState;
    }
  | { event: "error"; message: string }
  /** Response to `dev_setup_column_trap_test` — clients just replace their
   * local state with this, no move animation involved. */
  | { event: "dev_state_set"; state: GameState };
