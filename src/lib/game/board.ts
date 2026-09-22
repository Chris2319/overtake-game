import type { Ability, BoardLayer, Tile, TileEffect } from "./types";

export const BOARD_ROWS = 10;
export const BOARD_COLS = 10;
export const BOARD_SIZE = BOARD_ROWS * BOARD_COLS;

export const MAIN_LAYER_ID = "layer-0";

/** Classic ladders (climb up), by tile position. */
const LADDERS: [from: number, to: number][] = [
  [4, 25],
  [13, 46],
  [33, 49],
  [42, 63],
  [50, 69],
  [62, 81],
  [74, 92],
];

/** Trap doors drop a token straight down to the same column, one row below.
 * Each entry is a column plus the topmost row of a run of consecutive rows
 * that all carry a trap door there — a run of N rows means landing on the
 * top one chains N levels down in a single fall, since each trap door's
 * target is itself the next trap door in the run, until the row below the
 * run's bottom (a plain tile) is reached. Runs top out at 4 rows deep. */
const TRAPDOOR_RUNS: { col: number; topRow: number; depth: number }[] = [
  { col: 4, topRow: 9, depth: 4 }, // deepest run: rows 9,8,7,6 -> lands on row 5
  { col: 7, topRow: 7, depth: 3 }, // rows 7,6,5 -> lands on row 4
  { col: 2, topRow: 8, depth: 2 }, // rows 8,7 -> lands on row 6
  { col: 6, topRow: 3, depth: 1 }, // single trap door: row 3 -> row 2
  { col: 7, topRow: 9, depth: 1 }, // single trap door: row 9 -> row 8
  { col: 2, topRow: 9, depth: 1 }, // single trap door: row 9 -> row 8
  { col: 2, topRow: 3, depth: 1 }, // single trap door: row 3 -> row 2
  { col: 2, topRow: 2, depth: 1 }, // single trap door: row 2 -> row 1
  { col: 2, topRow: 1, depth: 1 }, // single trap door: row 1 -> row 0
];

/** Ability tiles are a stub for future special-power squares. */
export const ABILITIES: Ability[] = [
  {
    id: "extra-turn",
    name: "Extra Turn",
    description: "Roll again immediately.",
  },
];

const ABILITY_TILES: [position: number, abilityId: string][] = [
  [17, "extra-turn"],
  [59, "extra-turn"],
];

/** Spiked "damage" tiles: still landable, but weaken every number card in the
 * landing player's hand by 1 (a +5 becomes +4, a -1 becomes -2). Positions
 * listed here, one per entry. */
const DAMAGE_TILES: number[] = [5, 23, 47, 71, 88,  89];

function idForPosition(layerId: string, position: number) {
  return `${layerId}-tile-${position}`;
}

/** Boustrophedon (snake) numbering: row 0 left-to-right, row 1 right-to-left, etc. */
function positionToRowCol(position: number) {
  const index = position - 1;
  const row = Math.floor(index / BOARD_COLS);
  const indexInRow = index % BOARD_COLS;
  const col = row % 2 === 0 ? indexInRow : BOARD_COLS - 1 - indexInRow;
  return { row, col };
}

/** Inverse of `positionToRowCol`. */
export function rowColToPosition(row: number, col: number) {
  const indexInRow = row % 2 === 0 ? col : BOARD_COLS - 1 - col;
  return row * BOARD_COLS + indexInRow + 1;
}

export function generateLayer(
  id: string,
  index: number,
  yOffset: number,
): { layer: BoardLayer; tiles: Tile[] } {
  const layer: BoardLayer = {
    id,
    index,
    rows: BOARD_ROWS,
    cols: BOARD_COLS,
    yOffset,
  };

  const effectByPosition = new Map<number, TileEffect>();
  for (const [from, to] of LADDERS) {
    effectByPosition.set(from, { type: "ladder", targetTileId: idForPosition(id, to) });
  }
  for (const { col, topRow, depth } of TRAPDOOR_RUNS) {
    for (let row = topRow; row > topRow - depth; row--) {
      effectByPosition.set(rowColToPosition(row, col), {
        type: "trapdoor",
        targetTileId: idForPosition(id, rowColToPosition(row - 1, col)),
      });
    }
  }
  for (const [position, abilityId] of ABILITY_TILES) {
    if (!effectByPosition.has(position)) {
      effectByPosition.set(position, { type: "ability", abilityId });
    }
  }
  for (const position of DAMAGE_TILES) {
    if (!effectByPosition.has(position)) {
      effectByPosition.set(position, { type: "damage" });
    }
  }

  const tiles: Tile[] = Array.from({ length: BOARD_SIZE }, (_, i) => {
    const position = i + 1;
    const { row, col } = positionToRowCol(position);
    return {
      id: idForPosition(id, position),
      layerId: id,
      position,
      row,
      col,
      effect: effectByPosition.get(position) ?? { type: "none" },
    };
  });

  return { layer, tiles };
}

export function generateBoard() {
  const { layer, tiles } = generateLayer(MAIN_LAYER_ID, 0, 0);
  return { layers: [layer], tiles, abilities: ABILITIES };
}

export function findTile(tiles: Tile[], tileId: string): Tile {
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) throw new Error(`Unknown tile id: ${tileId}`);
  return tile;
}

export function tileAtPosition(tiles: Tile[], layerId: string, position: number): Tile {
  return findTile(tiles, idForPosition(layerId, position));
}
