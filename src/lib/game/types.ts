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

export type TileEffectType = "none" | "ladder" | "trapdoor" | "ability";

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
 * every tile in the mover's current row/column (except the bottom row) one
 * level down, like a one-time trapdoor — anyone standing there right now,
 * including the mover, falls immediately. The type tag lets further special
 * cards slot in later without changing the hand/deck plumbing. */
export type CardType = "move" | "team-advance" | "team-retreat" | "row-trap" | "column-trap";

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
}
