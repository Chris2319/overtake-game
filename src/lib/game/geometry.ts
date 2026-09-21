import type { BoardLayer, Tile } from "./types";

export const TILE_SIZE = 1;
export const TILE_GAP = 0.08;
export const CELL = TILE_SIZE + TILE_GAP;

/** Thickness of a board tile — stair treads and landings render at this same
 * thickness so a flight of stairs reads as part of the same set as the
 * board, not as a separate, chunkier piece of scenery. */
export const TILE_HEIGHT = 0.15;

/** Maps a tile + its layer to a world-space position. Columns run left-to-right
 * (x), rows stack upward (y), and `layer.yOffset` stacks whole layers on top
 * of one another for future multi-layer boards. */
export function tileWorldPosition(tile: Tile, layer: BoardLayer): [number, number, number] {
  const x = (tile.col - (layer.cols - 1) / 2) * CELL;
  const y = tile.row * CELL + layer.yOffset;
  return [x, y, 0];
}

/** How much vertical rise each stair aims for — used to pick how many stairs
 * a given flight needs. */
const STAIR_RISE = CELL * 0.4;
const STAIR_MIN_STEPS = 3;
const STAIR_MAX_STEPS = 6;

/** Treads are square in footprint, the same size as a board tile — so a
 * flight of stairs reads as tiles turned on their side, not a separate kind
 * of piece — and no swap is needed between a flight heading along x versus
 * one heading along z. */
export const STAIR_TREAD_SIZE = CELL * 0.92;

/** How far each step advances horizontally (into -z for a flight, sideways
 * for a landing) — one cell, the same spacing tiles themselves use. Large
 * enough that even the flush first/last step — which doesn't rise at all —
 * clears the board tile's own footprint plus half a tread, instead of
 * overlapping it. */
const STAIR_STEP_RUN = CELL;
const STAIR_LANDING_STEP = CELL;

/** A thin vertical wall bridging one tread to the next — as wide as a tread
 * (so it reads as a continuous riser face, not a floating peg) but thin
 * along the direction of travel, sitting in the gap between the two treads
 * it connects. */
const STAIR_RISER_THICKNESS = CELL * 0.06;
const STAIR_RISER_MIN_HEIGHT = 0.03;

export interface StairTread {
  center: [number, number, number];
  size: [number, number, number];
}

function stepsForRise(rise: number): number {
  return Math.min(
    STAIR_MAX_STEPS,
    Math.max(STAIR_MIN_STEPS, Math.round(Math.abs(rise) / STAIR_RISE)),
  );
}

/** Total horizontal distance (and so how far back into -z a flight's landing
 * sits) covered by a flight's flush edge step plus its climbing steps, each
 * advancing by `STAIR_STEP_RUN` — taller climbs naturally push further back
 * since they need more steps. */
function recessDepthForRise(totalRise: number): number {
  const stepsPerFlight = stepsForRise(totalRise / 2) + 1;
  return STAIR_STEP_RUN * stepsPerFlight;
}

function lerpAtFractions(
  from: [number, number, number],
  to: [number, number, number],
  fractions: number[],
): [number, number, number][] {
  return fractions.map((t) => [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ]);
}

function evenFractions(steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => (i + 1) / steps);
}

/** Cumulative fractions (0,1] along a flight's rise. The step at `edge` (the
 * one right off the source tile, or the one right before the destination
 * tile) carries no rise at all — it sits flush at that tile's own
 * level, same as the tile itself, and only shifts horizontally — while the
 * remaining steps share the entire climb evenly between them. */
function flightStepFractions(totalRise: number, edge: "start" | "end"): number[] {
  const rise = Math.abs(totalRise);
  if (rise < 1e-6) return [1];

  const climbSteps = stepsForRise(totalRise);
  const perStep = rise / climbSteps;

  const deltas: number[] = [];
  if (edge === "start") deltas.push(0);
  for (let i = 0; i < climbSteps; i++) deltas.push(perStep);
  if (edge === "end") deltas.push(0);

  let cumulative = 0;
  return deltas.map((d) => (cumulative += d) / rise);
}

/** Points along one straight climbing flight, from `from` to `to`. Horizontal
 * position (x/z) advances in even steps — a normal-sized run each time — while
 * height advances on the edge-constrained schedule from `flightStepFractions`.
 * Keeping these independent means the small first/last riser doesn't also
 * shrink that step's horizontal run: the first tread lands a full step away
 * from the source tile, not stacked on top of it. */
function flightPoints(
  from: [number, number, number],
  to: [number, number, number],
  edge: "start" | "end",
): [number, number, number][] {
  const verticalFractions = flightStepFractions(to[1] - from[1], edge);
  const horizontalFractions = evenFractions(verticalFractions.length);
  return verticalFractions.map((vf, i) => {
    const hf = horizontalFractions[i];
    return [
      from[0] + (to[0] - from[0]) * hf,
      from[1] + (to[1] - from[1]) * vf,
      from[2] + (to[2] - from[2]) * hf,
    ];
  });
}

/** Waypoints (including both endpoints) tracing a flight of stairs from a
 * ladder's source tile position to its target tile position. Rather than a
 * single diagonal ramp, the path only ever moves along one axis at a time —
 * a flight climbs straight back in -z, a flat landing jogs sideways to the
 * destination column, then a second flight climbs the rest of the way back
 * to z=0 — so every turn a token walks is a right angle, the way a real
 * staircase with a landing works. */
export function computeLadderWaypoints(
  from: [number, number, number],
  to: [number, number, number],
  /** Which way to step out when `from`/`to` share a column (see below) —
   * pick the direction the source tile's own arrow decal already points,
   * e.g. the way its row would keep going. Ignored otherwise. */
  sameColumnJogSign: 1 | -1 = 1,
): [number, number, number][] {
  const dy = to[1] - from[1];

  // When `from` and `to` share a column — a row boundary, where the next
  // row's tile sits directly above this one, in line with this tile's own
  // arrow decal pointing the way the row would keep going — there's no
  // sideways distance to spread a normal two-flight-and-landing shape over.
  // Spiral instead: step flat off the tile in the arrow's own direction
  // first (no real tile sits one column past either edge, so there's
  // nothing to clip through), then climb one step at a time, turning right
  // after each one — the way a real spiral staircase winds around a shaft
  // as it rises — until the whole rise is climbed.
  // The spiral doesn't generally cancel out back to the start column, so
  // finish with up to two flat corrective jogs (one per axis, each its own
  // right angle) to land exactly on `to`.
  if (Math.abs(to[0] - from[0]) < 1e-6) {
    const totalRise = dy;
    // The flat step below already turns into the climb, so it covers one of
    // the flight's steps itself — one fewer explicit climbing step is needed.
    const totalSteps = stepsForRise(totalRise) - 1;
    const risePerStep = totalRise / totalSteps;

    let dir: [number, number] = [sameColumnJogSign, 0];
    let pos: [number, number, number] = [
      from[0] + dir[0] * STAIR_STEP_RUN,
      from[1],
      from[2] + dir[1] * STAIR_STEP_RUN,
    ];
    const waypoints: [number, number, number][] = [from, pos];
    dir = [dir[1], -dir[0]]; // turn right

    for (let stepsClimbed = 0; stepsClimbed < totalSteps; stepsClimbed++) {
      pos = [
        pos[0] + dir[0] * STAIR_STEP_RUN,
        pos[1] + risePerStep,
        pos[2] + dir[1] * STAIR_STEP_RUN,
      ];
      waypoints.push(pos);
      dir = [dir[1], -dir[0]]; // turn right
    }

    const needsXFix = Math.abs(to[0] - pos[0]) > 1e-6;
    const needsZFix = Math.abs(to[2] - pos[2]) > 1e-6;
    if (needsXFix) waypoints.push((pos = [to[0], pos[1], pos[2]]));
    if (needsZFix) waypoints.push((pos = [pos[0], pos[1], to[2]]));
    // The last corrective jog (if either fired) already lands on `to`'s
    // exact x/z — snap it to `to` outright rather than pushing a duplicate
    // point, which also irons out any float drift in the climbed y.
    if (needsXFix || needsZFix) waypoints[waypoints.length - 1] = to;
    else waypoints.push(to);
    return waypoints;
  }

  const recessDepth = recessDepthForRise(dy);
  const midY = from[1] + dy / 2;
  const corner1: [number, number, number] = [from[0], midY, -recessDepth];
  const corner2: [number, number, number] = [to[0], midY, -recessDepth];

  const dx = Math.abs(corner2[0] - corner1[0]);
  const landingSteps = dx < 1e-6 ? 0 : Math.max(1, Math.round(dx / STAIR_LANDING_STEP));

  const waypoints: [number, number, number][] = [from];
  waypoints.push(...flightPoints(from, corner1, "start"));
  if (landingSteps > 0) {
    waypoints.push(...lerpAtFractions(corner1, corner2, evenFractions(landingSteps)));
  }
  waypoints.push(...flightPoints(corner2, to, "end"));
  return waypoints;
}

/** Solid stair-block placements for the permanent staircase mesh — one per
 * interior waypoint. The two endpoints are the source/destination tiles
 * themselves and need no tread. Each tread is flush-thin like a board tile
 * (see `TILE_HEIGHT`) rather than a tall riser block, and is oriented across
 * whichever axis its segment travels along. */
export function computeLadderTreads(waypoints: [number, number, number][]): StairTread[] {
  const treads: StairTread[] = [];
  for (let i = 1; i < waypoints.length - 1; i++) {
    const [x, y, z] = waypoints[i];
    treads.push({
      center: [x, y - TILE_HEIGHT / 2, z],
      size: [STAIR_TREAD_SIZE, TILE_HEIGHT, STAIR_TREAD_SIZE],
    });
  }
  return treads;
}

/** Full-width riser walls bridging each tread to the one before it, closing
 * both the horizontal and vertical gap between them so a flight reads as one
 * connected staircase rather than a row of floating platforms. Skips the
 * first tread — flush with the source tile, so a riser there would connect
 * to a tile rather than another step — and instead runs through the last
 * tread, bridging it back to the one before it. */
export function computeLadderRisers(waypoints: [number, number, number][]): StairTread[] {
  const risers: StairTread[] = [];
  for (let i = 2; i <= waypoints.length - 2; i++) {
    const prev = waypoints[i - 1];
    const curr = waypoints[i];
    const movesAlongX = Math.abs(curr[0] - prev[0]) > Math.abs(curr[2] - prev[2]);
    const travelMid = movesAlongX ? (prev[0] + curr[0]) / 2 : (prev[2] + curr[2]) / 2;
    // Spans the full height between the two treads — from the top of the
    // upper one down to the bottom of the lower one — so it covers both
    // treads' own thickness instead of leaving a stepped notch between them.
    const top = curr[1];
    const bottom = prev[1] - TILE_HEIGHT;
    const height = Math.max(top - bottom, STAIR_RISER_MIN_HEIGHT);
    const centerY = top - height / 2;
    risers.push({
      center: movesAlongX ? [travelMid, centerY, curr[2]] : [curr[0], centerY, travelMid],
      size: movesAlongX
        ? [STAIR_RISER_THICKNESS, height, STAIR_TREAD_SIZE]
        : [STAIR_TREAD_SIZE, height, STAIR_RISER_THICKNESS],
    });
  }
  return risers;
}
