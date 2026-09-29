"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { GameState, MoveStep, PlayerId } from "@/lib/game/types";
import {
  tileWorldPosition,
  computeLadderWaypoints,
  computeLadderTreads,
  computeLadderRisers,
  CELL,
  TILE_HEIGHT,
} from "@/lib/game/geometry";
import { createDroid, DROID_RING_PULSE_SPEED } from "@/lib/game/droid";

/** Lets the player free-orbit the camera (mouse drag/scroll) instead of the
 * scripted follow-camera, toggled from the HUD or by pressing "o". */
const ORBIT_DEBUG_ENABLED = true;
const ORBIT_DEBUG_TOGGLE_KEY = "o";

/** Step size for the HUD's rotate/tilt buttons (see `orbitBy` on
 * `SceneHandle`) — each click/hold-tick nudges the orbit camera by this
 * many degrees around its target. */
const ORBIT_BUTTON_ROTATE_DEG = 18;
const ORBIT_BUTTON_TILT_DEG = 10;
/** Keeps the orbit camera's tilt from flipping past straight up/down, where
 * the azimuth becomes undefined and the view snaps. */
const ORBIT_MIN_POLAR_RAD = 0.05;
const ORBIT_MAX_POLAR_RAD = Math.PI - 0.05;
/** Time constant (ms) for easing the camera toward an `orbitBy` step instead
 * of snapping straight there — smaller is snappier, larger is floatier. */
const ORBIT_BUTTON_EASE_MS = 140;
/** Below this angular distance (radians) a button-triggered orbit animation
 * is considered settled and stops overriding the camera each frame. */
const ORBIT_BUTTON_SETTLE_RAD = 0.0005;
/** Below this world-space distance a button-triggered pan animation is
 * considered settled and stops overriding the camera each frame. */
const PAN_BUTTON_SETTLE_UNITS = 0.001;

const TOKEN_RADIUS = 0.22;
const ARROW_SIZE = 0.42;
const STEP_DURATION_MS = 220;
const BOUNCE_HEIGHT = 0.35;
/** Duration of a single stair-to-stair hop while climbing a flight of stairs
 * (a ladder, or the permanent stairs bridging one row to the next) —
 * shorter than a normal board step so a multi-stair climb still feels
 * brisk. */
const STAIR_STEP_DURATION_MS = 130;
const STAIR_BOUNCE_HEIGHT = 0.12;
/** A trapdoor drop (row-trap/column-trap) can plunge a player many rows in
 * a single MoveStep — playing that at the flat `STEP_DURATION_MS` used for
 * an ordinary one-tile hop makes the fall cover the whole distance so fast
 * it reads as an instant teleport. Scale the fall's duration by how many
 * rows it crosses instead, so a bigger drop takes visibly longer. */
const FALL_DURATION_PER_ROW_MS = 90;
const FALL_BOUNCE_HEIGHT = 0.5;
/** Tiny press-down-and-back played by a tile itself when a player lands on
 * it — distinct from the token's own mid-hop arc. */
const TILE_BOUNCE_DURATION_MS = 200;
const TILE_BOUNCE_DEPTH = 0.05;
/** Neon glow: tiles have no fill at all — just a bright edge outline — which
 * sits at a low idle opacity, then flares brighter (feeding the bloom pass)
 * in sync with the same press-down-and-back a landing triggers, so the edge
 * pulses with the bounce instead of just the geometry moving. */
const TILE_EDGE_OPACITY_IDLE = 0.55;
const TILE_EDGE_OPACITY_BOUNCE_PEAK = 1;
/** Game-start intro: every tile starts stacked this far above its own resting
 * spot (world units, scaled off CELL so it clears the visible row band
 * regardless of which row a tile is on) and drops in once `playTileDropIn`
 * fires — see `SceneHandle.playTileDropIn`. Each tile's own fall is staggered
 * by a random delay up to `TILE_DROP_STAGGER_MAX_MS` so the whole board
 * doesn't land in one flat, robotic beat. */
const TILE_DROP_HEIGHT = CELL * 9;
const TILE_DROP_DURATION_MS = 550;
const TILE_DROP_STAGGER_MAX_MS = 900;
/** A trapdoor tile's top face is split into two hinged panels (hinge at
 * each outer edge) that swing down and open past vertical, like a real
 * double trapdoor falling open, instead of just tinting a flat tile.
 * Matches TILE_HEIGHT so a closed trapdoor reads as a normal tile: same
 * thickness, top flush with every other tile's top. */
const TRAPDOOR_PANEL_THICKNESS = TILE_HEIGHT;
const TRAPDOOR_OPEN_ANGLE_RAD = (108 * Math.PI) / 180;
const TRAPDOOR_SWING_MS = 420;
/** How long a trapdoor stays open after a player falls through it before
 * swinging shut again on its own. A manual toggle (debug button) instead
 * holds it open/closed until toggled again. */
const TRAPDOOR_HOLD_MS = 550;

/** Builds a mesh in the board's shared neon-wireframe style: a bright
 * additive edge outline, around either an invisible anchor (no fill) or —
 * when `blurred` is set — an actual frosted-glass fill using real light
 * transmission, so you can see straight through the tile but everything
 * behind it comes out soft/blurred rather than crisp, like sandblasted
 * glass. `dim` lowers the outline's opacity, used for stairs so a whole
 * flight of stacked treads/risers doesn't wash out into a solid bright
 * block. The outline is stashed on `userData.outline` so the landing bounce
 * can flare it. */
function createGlassMesh(
  geometry: THREE.BufferGeometry,
  color: number,
  dim: boolean = false,
  blurred: boolean = false,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    geometry,
    blurred
      ? new THREE.MeshPhysicalMaterial({
          color,
          transparent: true,
          transmission: 1,
          // High roughness on a transmissive material is what actually
          // scatters/blurs whatever is behind it, instead of a clear pane
          // you could see sharply through.
          roughness: 0.65,
          thickness: 0.6,
          ior: 1.2,
          metalness: 0,
          emissive: color,
          emissiveIntensity: 0.05,
          clearcoat: 0.3,
          clearcoatRoughness: 0.6,
          // Adjacent tiles/treads/risers butt up edge-to-edge, so their
          // faces are coincident at the seams — without an offset those
          // faces z-fight with each other (and with the outline) at
          // grazing angles, breaking the border up into flickering chunks.
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        })
      : new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );

  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: dim ? 0.35 : TILE_EDGE_OPACITY_IDLE,
      blending: THREE.AdditiveBlending,
      depthTest: true,
    }),
  );
  outline.renderOrder = 0;
  mesh.add(outline);
  mesh.userData.outline = outline;
  mesh.userData.idleOutlineColor = outline.material.color.clone();
  // Kept alongside `idleOutlineColor` (which a frozen hazard mutates while
  // active — see the `state.frozenTiles`-driven effect below) so a tile can
  // be restored to its own genuine idle color once the hazard clears,
  // rather than a fixed "freeze" color that wouldn't fit every tile type.
  mesh.userData.baseOutlineColor = outline.material.color.clone();
  return mesh;
}

/** Trailing exhaust particles left behind a moving player token — spawned
 * from the hover ring while the token is mid-hop, in that player's own glow
 * color, fading out and shrinking over their short lifetime. Each player
 * gets a fixed-size ring-buffer point cloud (see `createTrailSystem`)
 * rather than spawning/destroying individual objects, so the cost stays flat
 * regardless of how long a game runs. */
const TRAIL_MAX_PARTICLES = 18;
const TRAIL_SPAWN_INTERVAL_MS = 55;
const TRAIL_PARTICLE_LIFETIME_MS = 320;
const TRAIL_PARTICLE_SIZE_START = 7;
const TRAIL_PARTICLE_SIZE_END = 1;

interface TrailSystem {
  points: THREE.Points;
  positions: Float32Array;
  ages: Float32Array;
  positionAttr: THREE.BufferAttribute;
  ageAttr: THREE.BufferAttribute;
  nextIndex: number;
  spawnTimer: number;
  /** Local-space offset (from the token group's origin) this trail spawns
   * from each tick, e.g. one of the twin stabilizer fins — so a token leaves
   * a pair of side-by-side trails rather than one down its center. */
  localOffset: THREE.Vector3;
}

/** One token spawns a trail from each of these local-space points — the
 * left/right stabilizer fins (see their placement in `createPlayerToken`,
 * `±r * 1.0` on X) — so it leaves a pair of engine-exhaust-style trails
 * instead of a single center one. */
const TRAIL_LOCAL_OFFSETS: [number, number, number][] = [
  [-TOKEN_RADIUS * 1.0, -TOKEN_RADIUS * 0.9, 0],
  [TOKEN_RADIUS * 1.0, -TOKEN_RADIUS * 0.9, 0],
];

/** Builds one player's exhaust-trail point cloud: a fixed pool of
 * `TRAIL_MAX_PARTICLES` points, all parked (age = lifetime, invisible) until
 * `spawnTrailParticle` recycles the oldest slot into a fresh particle at the
 * token's current position. Positions are world-space and the points object
 * is added directly to the scene (not parented to the token), so a particle
 * stays put where it was dropped instead of riding along with the token. */
function createTrailSystem(color: number, localOffset: THREE.Vector3): TrailSystem {
  const positions = new Float32Array(TRAIL_MAX_PARTICLES * 3);
  const ages = new Float32Array(TRAIL_MAX_PARTICLES).fill(TRAIL_PARTICLE_LIFETIME_MS);

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  const ageAttr = new THREE.BufferAttribute(ages, 1);
  ageAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttr);
  geometry.setAttribute("aAge", ageAttr);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uLifetime: { value: TRAIL_PARTICLE_LIFETIME_MS },
      uSizeStart: { value: TRAIL_PARTICLE_SIZE_START },
      uSizeEnd: { value: TRAIL_PARTICLE_SIZE_END },
    },
    vertexShader: `
      attribute float aAge;
      varying float vAgeT;
      uniform float uLifetime;
      uniform float uSizeStart;
      uniform float uSizeEnd;
      void main() {
        vAgeT = clamp(aAge / uLifetime, 0.0, 1.0);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float size = mix(uSizeStart, uSizeEnd, vAgeT);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying float vAgeT;
      uniform vec3 uColor;
      void main() {
        if (vAgeT >= 1.0) discard;
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = (1.0 - vAgeT) * smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(uColor, alpha * 0.35);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return { points, positions, ages, positionAttr, ageAttr, nextIndex: 0, spawnTimer: 0, localOffset };
}

/** Recycles the oldest slot in a trail's ring buffer into a fresh particle
 * dropped at `pos`. */
function spawnTrailParticle(trail: TrailSystem, pos: THREE.Vector3) {
  const idx = trail.nextIndex;
  trail.positions[idx * 3] = pos.x;
  trail.positions[idx * 3 + 1] = pos.y;
  trail.positions[idx * 3 + 2] = pos.z;
  trail.ages[idx] = 0;
  trail.nextIndex = (idx + 1) % TRAIL_MAX_PARTICLES;
}

/** Builds the player token droid at the board's token scale. Character
 * geometry/materials live in `@/lib/game/droid` so the same droid can be
 * reused outside the game scene (e.g. the start screen). */
function createPlayerToken(initialColor: number): THREE.Group {
  return createDroid(initialColor, TOKEN_RADIUS);
}

/** Follow-camera framing: fixed field of view, sized so ROWS_VISIBLE rows
 * are always in frame, panning vertically to keep the followed player in
 * view with at least MIN_ROWS_BELOW rows of board visible beneath them. */
const CAMERA_FOV_DEG = 50;
/** Extra row-height of breathing room pushed to the bottom of the frame
 * (below the MIN_ROWS_BELOW row), so the hand-of-cards HUD overlay never
 * clips a board row mid-tile. */
const HUD_BUFFER_ROWS = 2;
const ROWS_VISIBLE = 8 + HUD_BUFFER_ROWS;
const MIN_ROWS_BELOW = 3;
/** Keeps row 0 from sitting flush against the bottom edge of the frame. */
const BOTTOM_MARGIN = CELL * 0.5;
const CAMERA_DISTANCE =
  (ROWS_VISIBLE * CELL) / (2 * Math.tan((CAMERA_FOV_DEG * Math.PI) / 180 / 2));
/** How far the camera pitches down from a flat, eye-level view toward a
 * bird's-eye one. 0 = level with the board, 90 = straight down. The camera
 * orbits the followed point on an arc at a fixed CAMERA_DISTANCE, so this
 * only changes viewing angle, not how many rows are in frame. */
const CAMERA_TILT_DEG = 18;
const CAMERA_TILT_RAD = (CAMERA_TILT_DEG * Math.PI) / 180;

/** Ordinary movement tiles: a smoky charcoal-grey outline (dim, like the
 * stairs) so they recede into the background, leaving the neon colors for
 * stairs, trapdoors, and ability tiles to stand out. The tile itself (fill
 * and idle outline) always stays this black/grey — the blue/pink alternation
 * only shows up as the landing-bounce bloom flash, see TILE_FLASH_COLOR_A/B
 * below. */
const TILE_COLOR = 0x3a4250;
const STAIR_COLOR = 0x22e3ff;
const TRAPDOOR_COLOR = 0xff2d95;
const ABILITY_COLOR = 0xe6ff2e;
const DAMAGE_COLOR = 0xff5a1f;
const SPECIAL_COLOR = 0x2ecc40;
/** A "freeze" card play turns whatever tile the mover was standing on into a
 * standing hazard (see `GameState.frozenTiles`) — any ordinary tile's
 * outline brightens to this color while it's active, without changing
 * geometry (see the `state.frozenTiles`-driven effect below), then eases
 * back to that tile's own normal color once the hazard clears. */
const FROZEN_HAZARD_COLOR = 0xe8fbff;
/** Landing-bounce bloom colors: an ordinary tile's outline flashes to one of
 * these (alternating by column, same as the old alternating tile fill did)
 * instead of just brightening its own grey — the tile stays black at rest
 * and only pops with color the instant a player lands on it. */
const TILE_FLASH_COLOR_A = 0x22e3ff;
const TILE_FLASH_COLOR_B = 0xff2d95;

/** In-scene "FLOOR NN" signage: real world geometry (canvas-texture glass
 * tags, same bracket look as a card face) floating beside the board at each
 * floor's actual row height — not a screen-pinned HUD, and not billboarded
 * to the camera either, so it keeps a fixed orientation like any other
 * static piece of scenery and picks up normal perspective foreshortening as
 * the (debug) camera orbits, instead of always facing the viewer dead-on.
 * Every floor gets a tag, stacked directly above one another, offset far
 * enough past the board's edge to clear the row-transition staircases. */
const FLOOR_TAG_WIDTH = CELL * 1.5;
const FLOOR_TAG_HEIGHT = CELL * 0.42;
/** How far to the side of the board (beyond its right edge) the tags float. */
const FLOOR_HUD_X_MARGIN = CELL * 3;

/** Resolves the `--font-retro` CSS variable (the 8-bit "Press Start 2P" font
 * used across the HUD) to a plain font-family string a canvas 2D context can
 * use directly — canvas `font` doesn't understand CSS custom properties. */
function retroFontFamily(): string {
  if (typeof document === "undefined") return "monospace";
  const value = getComputedStyle(document.documentElement).getPropertyValue("--font-retro").trim();
  return value || "monospace";
}

/** Draws one floor tag's face — a clipped-corner bracket with a "FLOOR NN"
 * label — to a canvas, used as the tag mesh's texture. The current floor
 * gets a bright glowing border and white text; the rest sit dim in the
 * background. */
function createFloorTagTexture(label: string, current: boolean): THREE.CanvasTexture {
  const w = 512;
  const h = 144;
  const cut = 30;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(cut, 3);
  ctx.lineTo(w - 3, 3);
  ctx.lineTo(w - 3, h - cut);
  ctx.lineTo(w - cut, h - 3);
  ctx.lineTo(3, h - 3);
  ctx.lineTo(3, cut);
  ctx.closePath();
  ctx.fillStyle = current ? "rgba(34, 227, 255, 0.18)" : "rgba(6, 12, 24, 0.55)";
  ctx.fill();
  ctx.lineWidth = current ? 5 : 4;
  ctx.strokeStyle = current ? "#a8eaf5" : "rgba(34, 227, 255, 0.55)";
  if (current) {
    ctx.shadowColor = "#22e3ff";
    ctx.shadowBlur = 12;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = current ? "#dffbff" : "rgba(34, 227, 255, 0.75)";
  ctx.font = `34px ${retroFontFamily()}`;
  ctx.textBaseline = "middle";
  ctx.fillText(label, 42, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

interface StairFlight {
  targetTileId: string;
  /** waypoints of the physical flight of stairs, source tile to destination
   * tile inclusive, for the token to climb one hop at a time */
  waypoints: THREE.Vector3[];
}

interface AnimationJob {
  playerId: PlayerId;
  steps: MoveStep[];
  stepIndex: number;
  elapsed: number;
  fromPos: THREE.Vector3;
  /** tile the current step started from, used to tell whether this hop
   * crosses a row boundary (and which edge to loop around) */
  prevTileId: string;
  /** linear (un-bounced, un-looped) interpolated y for this step, used to
   * drive the follow-camera so it tracks row progress, not the hop's arc */
  cleanY: number;
  /** when the current step is a ladder climb with a physical staircase,
   * the remaining waypoints to hop through before the step is complete */
  waypoints: THREE.Vector3[] | null;
  waypointIndex: number;
  /** how long the current (non-staircase) step's lerp should take; usually
   * `STEP_DURATION_MS`, but scaled up for a multi-row trapdoor fall so the
   * distance it covers doesn't fly by in the time of a single tile hop */
  stepDurationMs: number;
}

interface TileBounceJob {
  tileId: string;
  elapsed: number;
}

/** One tile's fall-into-place at game start — see `TILE_DROP_HEIGHT` and
 * `SceneHandle.playTileDropIn`. `delay` counts down first (each tile's own
 * random stagger) before `elapsed` starts advancing toward `duration`. */
interface TileDropJob {
  tileId: string;
  delay: number;
  elapsed: number;
  duration: number;
  restY: number;
}

interface TrapdoorPanels {
  left: THREE.Group;
  right: THREE.Group;
}

interface TrapdoorState {
  /** 0 = fully closed, 1 = fully open; animates toward `target`. */
  progress: number;
  target: number;
  /** Set while an auto-triggered (landed-on) open is waiting to swing
   * shut again on its own; null for a manual toggle, which holds. */
  holdRemaining: number | null;
}

/** A trapdoor built on the fly (a "row-trap"/"column-trap" card) on a tile
 * that has no permanent trapdoor effect of its own — its panels and
 * registration in `trapdoorPanels`/`trapdoorState` are torn down again once
 * it's swung fully shut, restoring the tile to its normal look, rather than
 * staying a hole forever like a real board trapdoor. */
interface TemporaryTrapdoor {
  panels: TrapdoorPanels;
  originalMaterial: THREE.Material;
  hiddenChildren: THREE.Object3D[];
  /** Set once this temp trapdoor has actually swung open — cleanup only
   * fires after that, so a drop that never gets triggered (e.g. the tile
   * had no one standing on it) doesn't get torn down mid-open by mistake. */
  hasOpened: boolean;
}

export interface SceneHandle {
  animateMove: (playerId: PlayerId, steps: MoveStep[]) => Promise<void>;
  /** Projects a player's current token position to viewport pixel
   * coordinates, for UI overlays (e.g. the played-card animation) that need
   * to land "on" the player. Null if the player or canvas isn't ready. */
  getPlayerScreenPosition: (playerId: PlayerId) => { x: number; y: number } | null;
  /** Debug/demo hook: flips every trapdoor on the board open or shut,
   * holding there until toggled again (independent of the auto
   * open-then-close a player landing on one triggers). */
  toggleTrapdoors: () => void;
  /** Builds a real (temporary) trapdoor — door panels and all — on each
   * given tile ahead of an `animateMove` call whose path falls through it,
   * for tiles that aren't already a permanent board trapdoor. Once the door
   * swings shut again after the fall, it's torn down and the tile reverts to
   * its normal look. Tiles that are already a real trapdoor are left alone. */
  prepareTrapdoorDrop: (tileIds: string[]) => void;
  /** Swings open every one of the given tiles' trapdoors (already built by
   * `prepareTrapdoorDrop`, or a permanent board trapdoor) together, right as
   * a row/column-trap card's fall begins — so the whole row/column reads as
   * one floor giving way, not just the tile(s) a player happens to be
   * standing on. Each door still closes and (if temporary) tears itself
   * down on its own after the usual hold. */
  openTrapdoors: (tileIds: string[]) => void;
  /** Switches between the scripted follow-camera and free orbit (mouse
   * drag/scroll). Entering orbit mode re-centers the orbit target on
   * wherever the follow-camera was last looking, so the view doesn't jump. */
  setOrbitMode: (enabled: boolean) => void;
  /** Rotates the orbit camera by a fixed step — `azimuthDeg` spins it
   * around the target, `polarDeg` tilts it up/down. Switches into orbit
   * mode first if it isn't already active. */
  orbitBy: (azimuthDeg: number, polarDeg: number) => void;
  /** Slides the orbit camera and its look-at target up/down together by a
   * fixed world-space step — a straight pan, unlike `orbitBy`'s tilt, which
   * rotates the viewing angle instead of the framing. Switches into orbit
   * mode first if it isn't already active. */
  panBy: (deltaY: number) => void;
  /** Game-start intro: snaps every tile up to `TILE_DROP_HEIGHT` above its
   * resting spot, then lets each one fall back into place on its own random
   * delay/duration. Meant to fire right as the HUD powers on, once the scene
   * layer is actually visible. */
  playTileDropIn: () => void;
}

interface SceneProps {
  state: GameState;
  handleRef: React.MutableRefObject<SceneHandle | null>;
  /** Fired whenever orbit mode is entered/exited, whether triggered from the
   * HUD or the "o" key shortcut, so the caller's UI can stay in sync. */
  onOrbitModeChange?: (enabled: boolean) => void;
}

/** Same hue/saturation as the tile, shifted lighter or darker (away from
 * whichever end it's already closer to) so the arrow reads against the dark
 * scene background instead of disappearing into it — a bright tile gets a
 * darker arrow, a dark/smoky one gets a lighter one. */
function arrowColorFor(tileColor: number): number {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(tileColor).getHSL(hsl);
  const targetL = hsl.l > 0.5 ? Math.max(0, hsl.l - 0.28) : Math.min(1, hsl.l + 0.28);
  return new THREE.Color().setHSL(hsl.h, hsl.s, targetL).getHex();
}

/** Draws the "x2" label used on an ability ("roll again") tile — plain
 * glowing text on a transparent background, decal-style like the row
 * arrows, rather than a bracketed tag like the floor signage. */
function createAbilityLabelTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "800 140px sans-serif";
  ctx.shadowColor = "#e6ff2e";
  ctx.shadowBlur = 1;
  ctx.fillStyle = "#eff49f";
  ctx.fillText("x2", size / 2, size / 2 + 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A flat chevron pointing along local +X, meant to be laid on a horizontal
 * surface (decal-style) rather than extruded into a 3D arrow. */
function createArrowGeometry(): THREE.ShapeGeometry {
  const s = ARROW_SIZE;
  const shape = new THREE.Shape();
  shape.moveTo(-s * 0.5, s * 0.45);
  shape.lineTo(s * 0.5, 0);
  shape.lineTo(-s * 0.5, -s * 0.45);
  shape.lineTo(-s * 0.18, 0);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function playerOffset(index: number, total: number): [number, number] {
  if (total <= 1) return [0, 0];
  const angle = (index / total) * Math.PI * 2;
  const r = 0.22;
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/** Yaws a player token so its visor faces (dx, dz) in world space — the same
 * direction a hop or hover ring is actually pointing. No-op for a
 * negligible/zero vector (staying put keeps whatever facing it already had). */
function faceDirection(mesh: THREE.Object3D, dx: number, dz: number) {
  if (Math.hypot(dx, dz) < 1e-6) return;
  mesh.rotation.y = Math.atan2(dx, dz);
}

/** A row's arrow decal points +x on an even row, -x on an odd one (see the
 * arrow mesh's own `rotateZ` below) — the same left/right a token walking
 * along that row is heading, used to orient an idle/resting token to match. */
function rowFacingX(row: number): number {
  return row % 2 === 0 ? 1 : -1;
}

export default function Scene({ state, handleRef, onOrbitModeChange }: SceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onOrbitModeChangeRef = useRef(onOrbitModeChange);
  useEffect(() => {
    onOrbitModeChangeRef.current = onOrbitModeChange;
  }, [onOrbitModeChange]);
  const tileWorldPositionsRef = useRef(new Map<string, THREE.Vector3>());
  const tileRowsRef = useRef(new Map<string, number>());
  const tileMeshesRef = useRef(new Map<string, THREE.Mesh>());
  const laddersRef = useRef(new Map<string, StairFlight>());
  const rowStairsRef = useRef(new Map<string, StairFlight>());
  const playerMeshesRef = useRef(new Map<PlayerId, THREE.Group>());
  const trailSystemsRef = useRef(new Map<PlayerId, TrailSystem[]>());
  const activeJobsRef = useRef<AnimationJob[]>([]);
  const tileBounceJobsRef = useRef<TileBounceJob[]>([]);
  const tileDropJobsRef = useRef<TileDropJob[]>([]);
  const trapdoorPanelsRef = useRef(new Map<string, TrapdoorPanels>());
  const trapdoorStateRef = useRef(new Map<string, TrapdoorState>());
  const temporaryTrapdoorsRef = useRef(new Map<string, TemporaryTrapdoor>());
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Board is built once on mount from the initial state — only players move
  // after that, which the effects below keep in sync / animate.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020309);
    new THREE.TextureLoader().load("/background360.png", (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = texture;
    });

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );

    const initialState = stateRef.current;
    const layer = initialState.layers[0];
    const layersById = new Map(initialState.layers.map((l) => [l.id, l]));

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Bloom is what actually sells the "neon" look — it bleeds the tiles'
    // emissive glow (and its bounce-triggered flare) into the surrounding
    // dark scene rather than leaving it a flat bright color.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      1.0,
      0.22,
      0.32,
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const orbitControls = ORBIT_DEBUG_ENABLED ? new OrbitControls(camera, renderer.domElement) : null;
    if (orbitControls) {
      orbitControls.enabled = false;
      orbitControls.enableDamping = true;
    }
    const setOrbitMode = (enabled: boolean) => {
      if (!orbitControls || orbitControls.enabled === enabled) return;
      orbitControls.enabled = enabled;
      if (enabled) orbitControls.target.copy(camera.position).setZ(0);
      else {
        orbitAnimTargetRef.current = null;
        panAnimTargetRef.current = null;
      }
      onOrbitModeChangeRef.current?.(enabled);
    };
    const handleOrbitToggleKey = (e: KeyboardEvent) => {
      if (!orbitControls || e.key.toLowerCase() !== ORBIT_DEBUG_TOGGLE_KEY) return;
      setOrbitMode(!orbitControls.enabled);
    };
    if (orbitControls) window.addEventListener("keydown", handleOrbitToggleKey);
    // Target spherical offset (from `orbitControls.target`) a button-driven
    // `orbitBy` step is easing toward; consumed/animated in the render loop
    // below instead of applied instantly, so repeated taps/holds read as a
    // smooth sweep rather than a snap. Null when no button animation is in
    // flight (a mouse drag just drives `orbitControls` directly).
    const orbitAnimTargetRef = { current: null as THREE.Spherical | null };
    // Target world-space Y a button-driven `panBy` step is easing toward,
    // for `orbitControls.target.y` (and `camera.position.y` moves by the
    // same delta to keep the viewing angle fixed). Same easing scheme as
    // `orbitAnimTargetRef`, just for a straight slide instead of a tilt.
    const panAnimTargetRef = { current: null as number | null };
    // A manual drag should take over immediately rather than fight a
    // leftover button-driven ease.
    orbitControls?.addEventListener("start", () => {
      orbitAnimTargetRef.current = null;
      panAnimTargetRef.current = null;
    });

    // Nudges the orbit camera by a fixed step (azimuth around, polar
    // up/down), entering orbit mode first if needed — used by the HUD's
    // rotate/tilt buttons. Builds on the in-flight animation's target (if
    // any) rather than the camera's current (still-easing) position, so
    // repeated clicks/holds compound smoothly instead of jittering.
    const orbitBy = (azimuthDeg: number, polarDeg: number) => {
      if (!orbitControls) return;
      setOrbitMode(true);
      const spherical =
        orbitAnimTargetRef.current?.clone() ??
        new THREE.Spherical().setFromVector3(camera.position.clone().sub(orbitControls.target));
      spherical.theta += THREE.MathUtils.degToRad(azimuthDeg);
      spherical.phi = THREE.MathUtils.clamp(
        spherical.phi + THREE.MathUtils.degToRad(polarDeg),
        ORBIT_MIN_POLAR_RAD,
        ORBIT_MAX_POLAR_RAD,
      );
      orbitAnimTargetRef.current = spherical;
    };

    // Slides the orbit camera and its target up/down together by a fixed
    // step, entering orbit mode first if needed — used by the HUD's
    // pan-up/pan-down buttons. Builds on the in-flight animation's target
    // (if any), same as `orbitBy`, so repeated clicks/holds compound
    // smoothly.
    const panBy = (deltaY: number) => {
      if (!orbitControls) return;
      setOrbitMode(true);
      const base = panAnimTargetRef.current ?? orbitControls.target.y;
      panAnimTargetRef.current = base + deltaY;
    };

    // Kept dim on purpose — the tiles are meant to read as self-lit neon
    // signage (emissive + bloom) rather than diffuse surfaces lit from
    // outside, so strong ambient/directional light would wash that out.
    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight.position.set(4, 8, 5);
    scene.add(dirLight);

    const tileWorldPositions = tileWorldPositionsRef.current;
    const tileMeshes = tileMeshesRef.current;
    const ladders = laddersRef.current;
    const rowStairs = rowStairsRef.current;
    const trapdoorPanels = trapdoorPanelsRef.current;
    const trapdoorState = trapdoorStateRef.current;
    const temporaryTrapdoors = temporaryTrapdoorsRef.current;
    tileWorldPositions.clear();
    tileMeshes.clear();
    ladders.clear();
    rowStairs.clear();
    trapdoorPanels.clear();
    trapdoorState.clear();
    temporaryTrapdoors.clear();

    const arrowGeometry = createArrowGeometry();
    const abilityLabelGeometry = new THREE.PlaneGeometry(CELL * 0.5, CELL * 0.5);
    // A single spike for a "damage" tile — several are scattered across the
    // tile top below, standing in for the spikes cutting into a landing
    // player's number cards.
    const spikeGeometry = new THREE.ConeGeometry(CELL * 0.09, CELL * 0.22, 4);
    const abilityLabelTexture = createAbilityLabelTexture();
    const totalTiles = initialState.tiles.length;
    // Board row a tile sits on, used to drive the floor indicator (each row
    // reads as one "floor") and which way a player token on that row faces.
    const tileRows = tileRowsRef.current;
    tileRows.clear();

    for (const tile of initialState.tiles) {
      const tileLayer = layersById.get(tile.layerId) ?? layer;
      const [x, y, z] = tileWorldPosition(tile, tileLayer);
      tileWorldPositions.set(tile.id, new THREE.Vector3(x, y, z));
      tileRows.set(tile.id, tile.row);

      const isAbility = tile.effect.type === "ability";
      const isDamage = tile.effect.type === "damage";
      const isSpecial = tile.effect.type === "special";
      const color = isAbility ? ABILITY_COLOR : isDamage ? DAMAGE_COLOR : isSpecial ? SPECIAL_COLOR : TILE_COLOR;

      const isTrapdoor = tile.effect.type === "trapdoor";
      const tileGeometry = new THREE.BoxGeometry(CELL * 0.92, TILE_HEIGHT, CELL * 0.92);
      // A trapdoor tile has no visible body of its own — only its two door
      // panels (added below) are visible, so opening them looks like
      // falling through a hole rather than uncovering another solid tile.
      // Kept as an (invisible) mesh, rather than skipping it, purely as the
      // anchor the panels and the tile-position bookkeeping hang off.
      const mesh = isTrapdoor
        ? new THREE.Mesh(
            tileGeometry,
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
          )
        : createGlassMesh(tileGeometry, color, !isAbility, true);
      mesh.position.set(x, y - TILE_HEIGHT / 2, z);
      // Landing-bounce flash color: ability tiles just flare their own
      // color brighter, ordinary tiles pop to blue/pink alternating by
      // column even though they sit black at rest.
      mesh.userData.flashColor = new THREE.Color(
        isAbility
          ? ABILITY_COLOR
          : isDamage
            ? DAMAGE_COLOR
            : isSpecial
              ? SPECIAL_COLOR
              : tile.col % 2 === 0
                ? TILE_FLASH_COLOR_A
                : TILE_FLASH_COLOR_B,
      );
      scene.add(mesh);
      tileMeshes.set(tile.id, mesh);

      // "x2" decal on an ability tile — the effect is currently always
      // "roll again", read at a glance without needing to land on it.
      if (isAbility) {
        const label = new THREE.Mesh(
          abilityLabelGeometry,
          new THREE.MeshBasicMaterial({
            map: abilityLabelTexture,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide,
          }),
        );
        label.position.set(0, TILE_HEIGHT / 2 + 0.015, 0);
        label.rotateX(-Math.PI / 2);
        mesh.add(label);
      }

      // A small cluster of spikes on a "damage" tile — still landable, but
      // the spikes read at a glance as "this will hurt your hand". Built in
      // the same frosted-glass/neon-outline style as the rest of the board
      // (see createGlassMesh) rather than a flat emissive solid, so they
      // read as part of the same material language instead of a bolt-on.
      if (isDamage) {
        const offsets: [number, number][] = [
          [-0.22, -0.22],
          [0.22, -0.22],
          [0, 0],
          [-0.22, 0.22],
          [0.22, 0.22],
        ];
        for (const [ox, oz] of offsets) {
          const spike = createGlassMesh(spikeGeometry, DAMAGE_COLOR, false, true);
          spike.position.set(ox * CELL, TILE_HEIGHT / 2 + (CELL * 0.22) / 2, oz * CELL);
          mesh.add(spike);
        }
      }

      if (isTrapdoor) {
        // Two panels, split down the middle, each hinged at its own outer
        // edge — the hinge stays put while the panel's inner edge swings
        // down and past vertical when the door opens, exposing the empty
        // space behind the (invisible) tile body as the "hole".
        const half = CELL * 0.46;
        const panelGeometry = new THREE.BoxGeometry(half, TRAPDOOR_PANEL_THICKNESS, CELL * 0.92);

        // Hinged at the panel's bottom-outer edge (tile's underside), not
        // the top: opening rotates the leaf down and under, so it sweeps
        // through the empty hole below rather than swinging its far edge
        // up past vertical and poking through the tile plane / neighbors.
        const leftPivot = new THREE.Group();
        leftPivot.position.set(-half, -TILE_HEIGHT / 2, 0);
        const leftPanel = createGlassMesh(panelGeometry.clone(), TRAPDOOR_COLOR, false, true);
        leftPanel.position.set(half / 2, TRAPDOOR_PANEL_THICKNESS / 2, 0);
        leftPivot.add(leftPanel);
        mesh.add(leftPivot);

        const rightPivot = new THREE.Group();
        rightPivot.position.set(half, -TILE_HEIGHT / 2, 0);
        const rightPanel = createGlassMesh(panelGeometry.clone(), TRAPDOOR_COLOR, false, true);
        rightPanel.position.set(-half / 2, TRAPDOOR_PANEL_THICKNESS / 2, 0);
        rightPivot.add(rightPanel);
        mesh.add(rightPivot);

        trapdoorPanels.set(tile.id, { left: leftPivot, right: rightPivot });
        trapdoorState.set(tile.id, { progress: 0, target: 0, holdRemaining: null });
      }

      // Flat arrow decal on top of the tile, hinting which way along the row
      // (left/right) this tile leads — every row-end just keeps pointing the
      // way that row runs, since the snake turn is obvious from the layout.
      // Skipped for trapdoors: there's no solid tile top for it to sit on,
      // and it would float oddly above the hole once the doors open. Also
      // skipped for damage tiles: the spike cluster is already the tile's
      // read-at-a-glance cue, and the arrow only cluttered it.
      if (!isTrapdoor && !isDamage && tile.position < totalTiles) {
        const arrow = new THREE.Mesh(
          arrowGeometry,
          new THREE.MeshStandardMaterial({
            color: arrowColorFor(color),
            side: THREE.DoubleSide,
          }),
        );
        // Parented to the tile (local coords, relative to the tile's
        // center) so it rides along with the tile's landing bounce.
        arrow.position.set(0, TILE_HEIGHT / 2 + 0.01, 0);
        arrow.rotateX(-Math.PI / 2);
        if (tile.row % 2 !== 0) arrow.rotateZ(Math.PI);
        mesh.add(arrow);
      }
    }

    // Now that every tile's world position is known, build a permanent
    // flight of stairs between two tile positions and record its waypoints
    // so climbing tokens can walk it one hop at a time.
    const buildStairFlight = (
      targetTileId: string,
      fromPos: THREE.Vector3,
      toPos: THREE.Vector3,
      sameColumnJogSign: 1 | -1 = 1,
    ): StairFlight => {
      const waypointTuples = computeLadderWaypoints(
        [fromPos.x, fromPos.y, fromPos.z],
        [toPos.x, toPos.y, toPos.z],
        sameColumnJogSign,
      );
      for (const tread of computeLadderTreads(waypointTuples)) {
        const stairMesh = createGlassMesh(
          new THREE.BoxGeometry(...tread.size),
          STAIR_COLOR,
          true,
          true,
        );
        stairMesh.position.set(...tread.center);
        scene.add(stairMesh);
      }
      for (const riser of computeLadderRisers(waypointTuples)) {
        const riserMesh = createGlassMesh(
          new THREE.BoxGeometry(...riser.size),
          STAIR_COLOR,
          true,
          true,
        );
        riserMesh.position.set(...riser.center);
        scene.add(riserMesh);
      }
      return {
        targetTileId,
        waypoints: waypointTuples.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      };
    };

    // Second pass: one flight of stairs per ladder connection.
    for (const tile of initialState.tiles) {
      if (tile.effect.type !== "ladder" || !tile.effect.targetTileId) continue;
      const fromPos = tileWorldPositions.get(tile.id);
      const toPos = tileWorldPositions.get(tile.effect.targetTileId);
      if (!fromPos || !toPos) continue;
      ladders.set(tile.id, buildStairFlight(tile.effect.targetTileId, fromPos, toPos));
    }

    // Third pass: rows stack directly above one another, so every row
    // boundary gets its own permanent flight of stairs bridging the last
    // tile of one row to the first tile of the next — replacing the old
    // loop-around hop. A normal move only climbs a given flight as part of
    // stepping onto its top tile, so a move that keeps going past it climbs
    // without stopping, while one that ends elsewhere on the flight's own
    // (lower) row never triggers it at all.
    const tilesByPosition = [...initialState.tiles].sort((a, b) => a.position - b.position);
    for (let i = 0; i < tilesByPosition.length - 1; i++) {
      const curr = tilesByPosition[i];
      const next = tilesByPosition[i + 1];
      if (curr.layerId !== next.layerId || curr.row === next.row) continue;
      const fromPos = tileWorldPositions.get(curr.id);
      const toPos = tileWorldPositions.get(next.id);
      if (!fromPos || !toPos) continue;
      // Jog out past whichever edge the row ends at, away from the rest of
      // the board, rather than into it.
      const tileLayer = layersById.get(curr.layerId) ?? layer;
      const jogSign: 1 | -1 = curr.col === tileLayer.cols - 1 ? 1 : -1;
      rowStairs.set(curr.id, buildStairFlight(next.id, fromPos, toPos, jogSign));
    }

    // Floor indicator signage: real glass tags floating beside the board, at
    // the actual world height of the row each one labels, added straight to
    // `scene` — not parented to the camera, and not billboarded — so it's
    // genuine, fixed-orientation scenery. Every floor gets a tag, built once
    // up front; only the highlighted ("current") floor's texture is swapped
    // as the current player's row changes.
    const totalFloors = layer.rows;
    const floorIndicatorX = ((layer.cols - 1) / 2) * CELL + FLOOR_HUD_X_MARGIN;
    const floorIndicatorGroup = new THREE.Group();
    scene.add(floorIndicatorGroup);
    const floorTagMeshes = new Map<number, THREE.Mesh>();
    for (let floor = 1; floor <= totalFloors; floor++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(FLOOR_TAG_WIDTH, FLOOR_TAG_HEIGHT),
        new THREE.MeshBasicMaterial({
          map: createFloorTagTexture(`FLOOR ${String(floor).padStart(2, "0")}`, false),
          transparent: true,
          depthWrite: false,
          toneMapped: false,
          side: THREE.DoubleSide,
        }),
      );
      const row = floor - 1;
      mesh.position.set(floorIndicatorX, row * CELL + layer.yOffset, 0);
      floorIndicatorGroup.add(mesh);
      floorTagMeshes.set(floor, mesh);
    }
    let lastIndicatedFloor: number | null = null;
    const setIndicatedFloor = (currentFloor: number) => {
      if (currentFloor === lastIndicatedFloor) return;
      const updateTag = (floor: number, isCurrent: boolean) => {
        const mesh = floorTagMeshes.get(floor);
        if (!mesh) return;
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.map?.dispose();
        material.map = createFloorTagTexture(`FLOOR ${String(floor).padStart(2, "0")}`, isCurrent);
        material.needsUpdate = true;
      };
      if (lastIndicatedFloor !== null) updateTag(lastIndicatedFloor, false);
      updateTag(currentFloor, true);
      lastIndicatedFloor = currentFloor;
    };

    const playerMeshes = playerMeshesRef.current;
    playerMeshes.clear();

    const placePlayerAtTile = (mesh: THREE.Group, tileId: string, index: number, total: number) => {
      const base = tileWorldPositions.get(tileId);
      if (!base) return;
      const [ox, oz] = playerOffset(index, total);
      mesh.position.set(base.x + ox, base.y + TOKEN_RADIUS, base.z + oz);
      const row = tileRows.get(tileId);
      if (row !== undefined) faceDirection(mesh, rowFacingX(row), 0);
    };

    const trailSystems = trailSystemsRef.current;
    trailSystems.clear();

    initialState.players.forEach((player, i) => {
      const mesh = createPlayerToken(player.color);
      placePlayerAtTile(mesh, player.currentTileId, i, initialState.players.length);
      scene.add(mesh);
      playerMeshes.set(player.id, mesh);

      const trails = TRAIL_LOCAL_OFFSETS.map((offset) => {
        const trail = createTrailSystem(player.color, new THREE.Vector3(...offset));
        scene.add(trail.points);
        return trail;
      });
      trailSystems.set(player.id, trails);
    });

    const activeJobs = activeJobsRef.current;
    const tileBounceJobs = tileBounceJobsRef.current;
    const tileDropJobs = tileDropJobsRef.current;
    /** A step climbs a physical staircase only when its source tile has a
     * recorded flight of stairs (a ladder hop, or a plain step that happens
     * to cross a row boundary) leading to that exact destination (guards
     * against a future ladder chain retargeting). */
    const prepareStep = (job: AnimationJob) => {
      const step = job.steps[job.stepIndex];
      const flight =
        step?.cause === "ladder"
          ? ladders.get(job.prevTileId)
          : step?.cause === "step"
            ? rowStairs.get(job.prevTileId)
            : undefined;
      job.waypoints =
        flight && flight.targetTileId === step.tileId ? flight.waypoints.slice(1) : null;
      job.waypointIndex = 0;
      // The step about to play hops onto a trapdoor tile — pop it open now,
      // at the start of that hop, so it's already swinging while the token
      // is still airborne on the way in rather than snapping open only
      // after it lands (and has already started falling through).
      if (step && trapdoorState.has(step.tileId)) triggerTrapdoorOpen(step.tileId);
      // A "trapdoor" step is a fall that *originates* from a trapdoor —
      // open the door under the player's feet as the fall begins, and
      // stretch the fall's duration by how many rows it drops so a
      // column-trap plunging to the bottom floor doesn't cover that whole
      // distance in the time of an ordinary one-tile hop.
      if (step?.cause === "trapdoor") {
        triggerTrapdoorOpen(job.prevTileId);
        const fromRow = tileRows.get(job.prevTileId);
        const toRow = tileRows.get(step.tileId);
        const rowSpan = fromRow !== undefined && toRow !== undefined ? Math.abs(fromRow - toRow) : 1;
        job.stepDurationMs = Math.max(STEP_DURATION_MS, rowSpan * FALL_DURATION_PER_ROW_MS);
      } else {
        job.stepDurationMs = STEP_DURATION_MS;
      }
    };
    const triggerTileBounce = (tileId: string) => {
      const existing = tileBounceJobs.find((j) => j.tileId === tileId);
      if (existing) {
        existing.elapsed = 0;
      } else {
        tileBounceJobs.push({ tileId, elapsed: 0 });
      }
    };
    /** Opens the trapdoor a player is falling through, then lets it swing
     * shut again on its own after a short hold. */
    const triggerTrapdoorOpen = (tileId: string) => {
      const doorState = trapdoorState.get(tileId);
      if (!doorState) return;
      doorState.target = 1;
      doorState.holdRemaining = TRAPDOOR_HOLD_MS;
      const temp = temporaryTrapdoors.get(tileId);
      if (temp) temp.hasOpened = true;
    };
    /** Disposes a mesh (and its descendants') geometry/material — used to
     * clean up a temporary trapdoor's panels once they're torn down, rather
     * than leaving orphaned GPU resources behind every time a row/column-trap
     * card is played. */
    const disposeObject3D = (obj: THREE.Object3D) => {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of mats) mat.dispose();
        }
      });
    };
    /** Turns an ordinary tile into a real (temporary) trapdoor: swaps its
     * body for the same invisible material a permanent trapdoor uses, hides
     * whatever decal it was showing (arrow/ability label/outline), and grafts
     * on the same hinged door panels built for the static board trapdoors —
     * so it's indistinguishable from one once `triggerTrapdoorOpen` swings it
     * open. No-ops for a tile that's already a real trapdoor. */
    const prepareTemporaryTrapdoor = (tileId: string) => {
      if (trapdoorState.has(tileId)) return;
      const tileMesh = tileMeshes.get(tileId);
      if (!tileMesh) return;

      const hiddenChildren = tileMesh.children.filter((child) => child.visible);
      for (const child of hiddenChildren) child.visible = false;
      const originalMaterial = tileMesh.material as THREE.Material;
      tileMesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });

      const half = CELL * 0.46;
      const panelGeometry = new THREE.BoxGeometry(half, TRAPDOOR_PANEL_THICKNESS, CELL * 0.92);

      const leftPivot = new THREE.Group();
      leftPivot.position.set(-half, -TILE_HEIGHT / 2, 0);
      const leftPanel = createGlassMesh(panelGeometry.clone(), TRAPDOOR_COLOR, false, true);
      leftPanel.position.set(half / 2, TRAPDOOR_PANEL_THICKNESS / 2, 0);
      leftPivot.add(leftPanel);
      tileMesh.add(leftPivot);

      const rightPivot = new THREE.Group();
      rightPivot.position.set(half, -TILE_HEIGHT / 2, 0);
      const rightPanel = createGlassMesh(panelGeometry.clone(), TRAPDOOR_COLOR, false, true);
      rightPanel.position.set(-half / 2, TRAPDOOR_PANEL_THICKNESS / 2, 0);
      rightPivot.add(rightPanel);
      tileMesh.add(rightPivot);

      const panels: TrapdoorPanels = { left: leftPivot, right: rightPivot };
      trapdoorPanels.set(tileId, panels);
      trapdoorState.set(tileId, { progress: 0, target: 0, holdRemaining: null });
      temporaryTrapdoors.set(tileId, { panels, originalMaterial, hiddenChildren, hasOpened: false });
    };
    /** Reverses `prepareTemporaryTrapdoor` once its door has swung fully
     * shut again: removes and disposes the panels, restores the tile's
     * original material, and un-hides whatever decal it had. */
    const removeTemporaryTrapdoor = (tileId: string) => {
      const temp = temporaryTrapdoors.get(tileId);
      const tileMesh = tileMeshes.get(tileId);
      if (temp && tileMesh) {
        tileMesh.remove(temp.panels.left, temp.panels.right);
        disposeObject3D(temp.panels.left);
        disposeObject3D(temp.panels.right);
        (tileMesh.material as THREE.Material).dispose();
        tileMesh.material = temp.originalMaterial;
        for (const child of temp.hiddenChildren) child.visible = true;
      }
      trapdoorPanels.delete(tileId);
      trapdoorState.delete(tileId);
      temporaryTrapdoors.delete(tileId);
    };
    handleRef.current = {
      animateMove: (playerId, steps) =>
        new Promise((resolve) => {
          const mesh = playerMeshes.get(playerId);
          if (!mesh || steps.length === 0) {
            resolve();
            return;
          }
          const startTileId =
            stateRef.current.players.find((p) => p.id === playerId)?.currentTileId ?? "";
          const job: AnimationJob = {
            playerId,
            steps,
            stepIndex: 0,
            elapsed: 0,
            fromPos: mesh.position.clone(),
            prevTileId: startTileId,
            cleanY: mesh.position.y,
            waypoints: null,
            waypointIndex: 0,
            stepDurationMs: STEP_DURATION_MS,
          };
          prepareStep(job);
          activeJobs.push(job);
          const check = () => {
            if (activeJobs.some((j) => j.playerId === playerId)) {
              requestAnimationFrame(check);
            } else {
              resolve();
            }
          };
          requestAnimationFrame(check);
        }),
      getPlayerScreenPosition: (playerId) => {
        const mesh = playerMeshes.get(playerId);
        if (!mesh || !container) return null;
        const projected = mesh.position.clone().project(camera);
        const rect = container.getBoundingClientRect();
        return {
          x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
          y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
        };
      },
      toggleTrapdoors: () => {
        // Base the flip on whichever way most doors are currently headed,
        // so one click reliably reverses direction even mid-swing.
        const opening = [...trapdoorState.values()].filter((s) => s.target === 1).length;
        const nextTarget = opening * 2 >= trapdoorState.size ? 0 : 1;
        for (const doorState of trapdoorState.values()) {
          doorState.target = nextTarget;
          doorState.holdRemaining = null;
        }
      },
      prepareTrapdoorDrop: (tileIds) => {
        for (const tileId of tileIds) prepareTemporaryTrapdoor(tileId);
      },
      openTrapdoors: (tileIds) => {
        for (const tileId of tileIds) triggerTrapdoorOpen(tileId);
      },
      setOrbitMode,
      orbitBy,
      panBy,
      playTileDropIn: () => {
        tileDropJobs.length = 0;
        for (const [tileId, restPos] of tileWorldPositions) {
          const tileMesh = tileMeshes.get(tileId);
          if (!tileMesh) continue;
          const restY = restPos.y - TILE_HEIGHT / 2;
          tileMesh.position.y = restY + TILE_DROP_HEIGHT;
          tileDropJobs.push({
            tileId,
            delay: Math.random() * TILE_DROP_STAGGER_MAX_MS,
            elapsed: 0,
            duration: TILE_DROP_DURATION_MS,
            restY,
          });
        }
      },
    };

    let frameId: number;
    let lastTime = performance.now();
    const animate = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;

      for (let i = activeJobs.length - 1; i >= 0; i--) {
        const job = activeJobs[i];
        const mesh = playerMeshes.get(job.playerId);
        if (!mesh) {
          activeJobs.splice(i, 1);
          continue;
        }
        const step = job.steps[job.stepIndex];

        if (job.waypoints) {
          job.elapsed += dt;
          const t = Math.min(job.elapsed / STAIR_STEP_DURATION_MS, 1);
          const playerIndex = stateRef.current.players.findIndex((p) => p.id === job.playerId);
          const [ox, oz] = playerOffset(playerIndex, stateRef.current.players.length);
          const wp = job.waypoints[job.waypointIndex];
          const target = new THREE.Vector3(wp.x + ox, wp.y + TOKEN_RADIUS, wp.z + oz);
          faceDirection(mesh, target.x - job.fromPos.x, target.z - job.fromPos.z);

          job.cleanY = THREE.MathUtils.lerp(job.fromPos.y, target.y, t);
          mesh.position.lerpVectors(job.fromPos, target, t);
          mesh.position.y += Math.sin(t * Math.PI) * STAIR_BOUNCE_HEIGHT;

          if (t >= 1) {
            mesh.position.copy(target);
            job.fromPos = target.clone();
            job.elapsed = 0;
            job.waypointIndex += 1;
            if (job.waypointIndex >= job.waypoints.length) {
              // Reached the top of the flight — this MoveStep (the ladder
              // hop) is complete, land on the destination tile as usual.
              triggerTileBounce(step.tileId);
              job.stepIndex += 1;
              job.prevTileId = step.tileId;
              if (job.stepIndex < job.steps.length) {
                prepareStep(job);
              } else {
                activeJobs.splice(i, 1);
              }
            }
          }
          continue;
        }

        job.elapsed += dt;
        const t = Math.min(job.elapsed / job.stepDurationMs, 1);
        const targetBase = tileWorldPositions.get(step.tileId);
        if (targetBase) {
          const playerIndex = stateRef.current.players.findIndex((p) => p.id === job.playerId);
          const [ox, oz] = playerOffset(playerIndex, stateRef.current.players.length);
          const target = new THREE.Vector3(
            targetBase.x + ox,
            targetBase.y + TOKEN_RADIUS,
            targetBase.z + oz,
          );
          faceDirection(mesh, target.x - job.fromPos.x, target.z - job.fromPos.z);
          job.cleanY = THREE.MathUtils.lerp(job.fromPos.y, target.y, t);
          mesh.position.lerpVectors(job.fromPos, target, t);
          const bounceHeight = step.cause === "trapdoor" ? FALL_BOUNCE_HEIGHT : BOUNCE_HEIGHT;
          mesh.position.y += Math.sin(t * Math.PI) * bounceHeight;

          if (t >= 1) {
            mesh.position.copy(target);
            triggerTileBounce(step.tileId);
            job.stepIndex += 1;
            job.elapsed = 0;
            job.fromPos = target.clone();
            job.prevTileId = step.tileId;
            if (job.stepIndex < job.steps.length) {
              prepareStep(job);
            } else {
              activeJobs.splice(i, 1);
            }
          }
        } else {
          activeJobs.splice(i, 1);
        }
      }

      // Exhaust trail: while a player's token is mid-hop, periodically drop
      // a particle at its current (bounced/looped) position; every trail's
      // particles keep aging (and fading) regardless of whether their owner
      // is currently moving, so a token that just stopped still leaves its
      // last few particles to fade out naturally instead of vanishing.
      const trailSpawnPos = new THREE.Vector3();
      for (const [playerId, trails] of trailSystems) {
        const mesh = playerMeshes.get(playerId);
        const isMoving = activeJobs.some((j) => j.playerId === playerId);
        for (const trail of trails) {
          if (mesh && isMoving) {
            trail.spawnTimer += dt;
            while (trail.spawnTimer >= TRAIL_SPAWN_INTERVAL_MS) {
              trail.spawnTimer -= TRAIL_SPAWN_INTERVAL_MS;
              mesh.updateWorldMatrix(true, false);
              trailSpawnPos.copy(trail.localOffset);
              mesh.localToWorld(trailSpawnPos);
              spawnTrailParticle(trail, trailSpawnPos);
            }
          } else {
            trail.spawnTimer = 0;
          }
          for (let i = 0; i < TRAIL_MAX_PARTICLES; i++) {
            if (trail.ages[i] < TRAIL_PARTICLE_LIFETIME_MS) trail.ages[i] += dt;
          }
          trail.positionAttr.needsUpdate = true;
          trail.ageAttr.needsUpdate = true;
        }
      }

      // Game-start intro: tiles still stacked above their resting spot
      // (see `playTileDropIn`) count down their own random delay, then fall
      // the rest of the way in, easing out so the landing reads as a soft
      // touchdown rather than a linear slide. Feeds into the same
      // press-and-glow `triggerTileBounce` plays for a player landing, so
      // the touchdown gets that same squish/flash instead of a bare stop.
      for (let i = tileDropJobs.length - 1; i >= 0; i--) {
        const dropJob = tileDropJobs[i];
        const tileMesh = tileMeshes.get(dropJob.tileId);
        if (!tileMesh) {
          tileDropJobs.splice(i, 1);
          continue;
        }
        if (dropJob.delay > 0) {
          dropJob.delay -= dt;
          continue;
        }
        dropJob.elapsed += dt;
        const dt2 = Math.min(dropJob.elapsed / dropJob.duration, 1);
        const eased = 1 - Math.pow(1 - dt2, 3);
        tileMesh.position.y = THREE.MathUtils.lerp(
          dropJob.restY + TILE_DROP_HEIGHT,
          dropJob.restY,
          eased,
        );
        if (dt2 >= 1) {
          tileMesh.position.y = dropJob.restY;
          triggerTileBounce(dropJob.tileId);
          tileDropJobs.splice(i, 1);
        }
      }

      // Tiles press down slightly and spring back when a player lands on
      // them, independent of the token's own hop arc.
      for (let i = tileBounceJobs.length - 1; i >= 0; i--) {
        const bounceJob = tileBounceJobs[i];
        if (trapdoorState.has(bounceJob.tileId)) {
          // A trapdoor's own body is invisible on purpose (see above) — its
          // landing feedback is the door swing, not a press-and-glow, which
          // would otherwise flash the hidden body briefly visible.
          tileBounceJobs.splice(i, 1);
          continue;
        }
        const tileMesh = tileMeshes.get(bounceJob.tileId);
        const restY = tileWorldPositions.get(bounceJob.tileId)?.y;
        if (!tileMesh || restY === undefined) {
          tileBounceJobs.splice(i, 1);
          continue;
        }
        bounceJob.elapsed += dt;
        const bt = Math.min(bounceJob.elapsed / TILE_BOUNCE_DURATION_MS, 1);
        const glowCurve = Math.sin(bt * Math.PI);
        tileMesh.position.y = restY - TILE_HEIGHT / 2 - glowCurve * TILE_BOUNCE_DEPTH;
        const outline = tileMesh.userData.outline as THREE.LineSegments | undefined;
        const outlineMaterial = outline?.material as THREE.LineBasicMaterial | undefined;
        const idleOutlineColor = tileMesh.userData.idleOutlineColor as THREE.Color | undefined;
        const flashColor = tileMesh.userData.flashColor as THREE.Color | undefined;
        if (outlineMaterial) {
          outlineMaterial.opacity =
            TILE_EDGE_OPACITY_IDLE + glowCurve * (TILE_EDGE_OPACITY_BOUNCE_PEAK - TILE_EDGE_OPACITY_IDLE);
          // The tile's outline (and the bloom it feeds) briefly pops to its
          // blue/pink flash color on landing, then fades back to the tile's
          // own black/grey idle color — the tile itself never changes color,
          // only this transient bounce does.
          if (idleOutlineColor && flashColor) {
            outlineMaterial.color.copy(idleOutlineColor).lerp(flashColor, glowCurve);
          }
        }
        if (bt >= 1) {
          tileMesh.position.y = restY - TILE_HEIGHT / 2;
          if (outlineMaterial) {
            outlineMaterial.opacity = TILE_EDGE_OPACITY_IDLE;
            if (idleOutlineColor) outlineMaterial.color.copy(idleOutlineColor);
          }
          tileBounceJobs.splice(i, 1);
        }
      }

      // Trapdoor panels ease open/shut toward their target progress; a
      // landed-on trapdoor also counts down its hold before swinging shut
      // again on its own (a manual toggle instead holds until re-toggled).
      // Any temporary trapdoor that's back to fully closed after having
      // actually opened is torn back down once the loop below is done with
      // it (mutating `trapdoorState` mid-iteration would skip entries).
      const closedTemporaryTileIds: string[] = [];
      for (const [tileId, doorState] of trapdoorState) {
        if (doorState.holdRemaining !== null) {
          doorState.holdRemaining -= dt;
          if (doorState.holdRemaining <= 0) {
            doorState.holdRemaining = null;
            doorState.target = 0;
          }
        }
        if (doorState.progress !== doorState.target) {
          const step = dt / TRAPDOOR_SWING_MS;
          doorState.progress =
            doorState.target > doorState.progress
              ? Math.min(doorState.target, doorState.progress + step)
              : Math.max(doorState.target, doorState.progress - step);
          const panels = trapdoorPanels.get(tileId);
          if (panels) {
            panels.left.rotation.z = -TRAPDOOR_OPEN_ANGLE_RAD * doorState.progress;
            panels.right.rotation.z = TRAPDOOR_OPEN_ANGLE_RAD * doorState.progress;
          }
        }
        const temp = temporaryTrapdoors.get(tileId);
        if (temp?.hasOpened && doorState.progress === 0 && doorState.target === 0 && doorState.holdRemaining === null) {
          closedTemporaryTileIds.push(tileId);
        }
      }
      for (const tileId of closedTemporaryTileIds) removeTemporaryTrapdoor(tileId);

      if (orbitControls?.enabled) {
        // Debug mode: let the developer freely orbit instead of scripting
        // the camera. Handles mouse-drag damping.
        orbitControls.update();

        // Ease toward any pending button-driven `orbitBy` step on top of
        // that, so it reads as a smooth sweep instead of snapping there in
        // one frame.
        const target = orbitAnimTargetRef.current;
        if (target) {
          const offset = camera.position.clone().sub(orbitControls.target);
          const current = new THREE.Spherical().setFromVector3(offset);
          const t = 1 - Math.exp(-dt / ORBIT_BUTTON_EASE_MS);
          current.theta = THREE.MathUtils.lerp(current.theta, target.theta, t);
          current.phi = THREE.MathUtils.lerp(current.phi, target.phi, t);
          current.radius = target.radius;
          offset.setFromSpherical(current);
          camera.position.copy(orbitControls.target).add(offset);
          camera.lookAt(orbitControls.target);
          if (
            Math.abs(current.theta - target.theta) < ORBIT_BUTTON_SETTLE_RAD &&
            Math.abs(current.phi - target.phi) < ORBIT_BUTTON_SETTLE_RAD
          ) {
            orbitAnimTargetRef.current = null;
          }
        }

        // Ease toward any pending button-driven `panBy` step — a straight
        // vertical slide of both the camera and its target, so the viewing
        // angle stays fixed while the framing moves.
        const panTargetY = panAnimTargetRef.current;
        if (panTargetY !== null) {
          const t = 1 - Math.exp(-dt / ORBIT_BUTTON_EASE_MS);
          const newY = THREE.MathUtils.lerp(orbitControls.target.y, panTargetY, t);
          camera.position.y += newY - orbitControls.target.y;
          orbitControls.target.y = newY;
          if (Math.abs(panTargetY - newY) < PAN_BUTTON_SETTLE_UNITS) {
            panAnimTargetRef.current = null;
          }
        }
      } else {
        // Follow the actively moving player, or whoever's turn it is when
        // idle. Uses the job's linear cleanY (or the player's resting tile)
        // rather than the token's animated position, so hop bounces/loops
        // never shake the camera — it tracks row progress only.
        let followedY = 0;
        if (activeJobs[0]) {
          followedY = activeJobs[0].cleanY - TOKEN_RADIUS;
        } else {
          const player = stateRef.current.players[stateRef.current.currentPlayerIndex];
          const base = player ? tileWorldPositions.get(player.currentTileId) : undefined;
          if (base) followedY = base.y;
        }
        const bottomOfView =
          Math.max(-BOTTOM_MARGIN, followedY - MIN_ROWS_BELOW * CELL) - HUD_BUFFER_ROWS * CELL;
        const targetY = bottomOfView + (ROWS_VISIBLE * CELL) / 2;
        camera.position.set(
          0,
          targetY + CAMERA_DISTANCE * Math.sin(CAMERA_TILT_RAD),
          CAMERA_DISTANCE * Math.cos(CAMERA_TILT_RAD)
        );
        camera.lookAt(0, targetY, 0);
      }

      // Brighten the hover ring under whichever token belongs to the current
      // player, pulsing it so it's obvious which token is about to move;
      // every other token's ring stays at its idle glow.
      const activePlayerId = stateRef.current.players[stateRef.current.currentPlayerIndex]?.id;
      const ringPulse = (Math.sin(now * 0.001 * DROID_RING_PULSE_SPEED) + 1) / 2;
      for (const [playerId, mesh] of playerMeshes) {
        const setRingActive = mesh.userData.setRingActive as
          | ((active: boolean, pulseT: number) => void)
          | undefined;
        setRingActive?.(playerId === activePlayerId, ringPulse);
      }

      // Re-highlight the floor indicator whenever the current player's floor
      // changes.
      const floorPlayer = stateRef.current.players[stateRef.current.currentPlayerIndex];
      const floorRow = floorPlayer ? tileRows.get(floorPlayer.currentTileId) : undefined;
      if (floorRow !== undefined) setIndicatedFloor(floorRow + 1);

      composer.render();
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      composer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      if (orbitControls) {
        window.removeEventListener("keydown", handleOrbitToggleKey);
        orbitControls.dispose();
      }
      container.removeChild(renderer.domElement);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of materials) {
            if ("map" in material) (material.map as THREE.Texture | null)?.dispose();
            material.dispose();
          }
        }
      });
      for (const trails of trailSystems.values()) {
        for (const trail of trails) {
          trail.points.geometry.dispose();
          (trail.points.material as THREE.Material).dispose();
        }
      }
      composer.dispose();
      renderer.dispose();
      handleRef.current = null;
    };
    // Board + starting tokens are built once; player moves are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep non-animating player tokens glued to their current tile whenever
  // state changes for a reason other than an in-flight animated move (e.g.
  // an ability effect applied without going through animateMove).
  useEffect(() => {
    const tileWorldPositions = tileWorldPositionsRef.current;
    const tileRows = tileRowsRef.current;
    const playerMeshes = playerMeshesRef.current;
    const trailSystems = trailSystemsRef.current;
    const activeJobs = activeJobsRef.current;
    const total = state.players.length;

    state.players.forEach((player, i) => {
      const mesh = playerMeshes.get(player.id);
      if (!mesh) return;

      (mesh.userData.setColor as (color: number) => void)(player.color);
      for (const trail of trailSystems.get(player.id) ?? []) {
        (trail.points.material as THREE.ShaderMaterial).uniforms.uColor.value.set(player.color);
      }

      if (activeJobs.some((j) => j.playerId === player.id)) return;
      const base = tileWorldPositions.get(player.currentTileId);
      if (!base) return;
      const [ox, oz] = playerOffset(i, total);
      mesh.position.set(base.x + ox, base.y + TOKEN_RADIUS, base.z + oz);
      const row = tileRows.get(player.currentTileId);
      if (row !== undefined) faceDirection(mesh, rowFacingX(row), 0);
    });
  }, [state]);

  // Brightens whichever tile a "freeze" card just planted a hazard on (in
  // `state.frozenTiles`) and eases it back to its own normal color once the
  // hazard clears — the same outline/idleOutlineColor userData every tile
  // already carries, just recolored, so no extra geometry is needed to make
  // "this one currently costs a turn" readable at a glance.
  const frozenHazardTileIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const tileMeshes = tileMeshesRef.current;
    const prev = frozenHazardTileIdsRef.current;
    const next = new Set(state.frozenTiles);

    for (const tileId of next) {
      if (prev.has(tileId)) continue;
      const mesh = tileMeshes.get(tileId);
      const outline = mesh?.userData.outline as THREE.LineSegments | undefined;
      if (!mesh || !outline) continue;
      const material = outline.material as THREE.LineBasicMaterial;
      material.color.set(FROZEN_HAZARD_COLOR);
      material.opacity = TILE_EDGE_OPACITY_BOUNCE_PEAK;
      mesh.userData.idleOutlineColor = material.color.clone();
    }
    for (const tileId of prev) {
      if (next.has(tileId)) continue;
      const mesh = tileMeshes.get(tileId);
      const outline = mesh?.userData.outline as THREE.LineSegments | undefined;
      const baseColor = mesh?.userData.baseOutlineColor as THREE.Color | undefined;
      if (!mesh || !outline || !baseColor) continue;
      const material = outline.material as THREE.LineBasicMaterial;
      material.color.copy(baseColor);
      material.opacity = TILE_EDGE_OPACITY_IDLE;
      mesh.userData.idleOutlineColor = baseColor.clone();
    }
    frozenHazardTileIdsRef.current = next;
  }, [state.frozenTiles]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
