"use client";

import { useRef, useState } from "react";
import Scene, { type SceneHandle } from "@/app/game/Scene";
import {
  SpinWheelOverlay,
  WHEEL_SPIN_MS,
  WHEEL_CELEBRATE_MS,
  WHEEL_EXIT_MS,
  type WheelOverlayPhase,
} from "@/app/game/GameUI";
import {
  createInitialState,
  computeMove,
  computeFreezeCardPlay,
  computeRowColumnTrap,
  trapCardTileIds,
  applyMoveResult,
  applyTeamAdvance,
  applyWheelOutcome,
  currentPlayer,
  rollWheelSegment,
  WHEEL_SEGMENTS,
} from "@/lib/game/engine";
import { findTile } from "@/lib/game/board";
import type { GameState } from "@/lib/game/types";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Standalone prototype of just the board/tile mechanics (ladders, trapdoor
 * runs, ability/damage tiles, freeze hazards, row/column-trap falls) —
 * reuses the real `Scene` renderer and `engine`/`board` logic directly, with
 * none of the lobby, WebSocket multiplayer, or card-hand UI the full game
 * wraps around them. */

/** One button per scenario: jumps the player straight to (or just past) the
 * tile that demonstrates the effect, by computing a move whose roll is
 * however many tiles away that target currently is — so it works from
 * wherever the player happens to be standing. */
const TILE_SCENARIOS: { label: string; targetPosition: number }[] = [
  { label: "Climb a ladder (4 → 25)", targetPosition: 4 },
  { label: "Fall down a trapdoor run (rows 9→6)", targetPosition: 96 },
  { label: "Land on an ability tile (x2)", targetPosition: 17 },
  { label: "Land on a damage tile", targetPosition: 5 },
];

export default function BoardPrototypePage() {
  const handleRef = useRef<SceneHandle | null>(null);
  const [state, setState] = useState<GameState>(() =>
    createInitialState([{ id: "test", name: "Test", players: [{ id: "p1", name: "P1" }] }]),
  );
  const [busy, setBusy] = useState(false);
  const [wheelSpin, setWheelSpin] = useState<{ segmentIndex: number } | null>(null);
  const [wheelPhase, setWheelPhase] = useState<WheelOverlayPhase>("enter");

  const playerId = state.players[0].id;

  async function runMove(roll: number) {
    if (busy) return;
    setBusy(true);
    try {
      const result = computeMove(state, playerId, roll);
      await handleRef.current?.animateMove(playerId, result.path);
      setState((prev) => applyMoveResult(prev, result));
    } finally {
      setBusy(false);
    }
  }

  async function runScenario(targetPosition: number) {
    const tile = findTile(state.tiles, state.players[0].currentTileId);
    await runMove(targetPosition - tile.position);
  }

  async function runFreeze() {
    if (busy) return;
    setBusy(true);
    try {
      const result = computeFreezeCardPlay(state, playerId);
      await handleRef.current?.animateMove(playerId, result.path);
      setState((prev) => applyMoveResult(prev, result));
    } finally {
      setBusy(false);
    }
  }

  /** Moves onto the board's one "special" (green) tile — wherever it is —
   * and, since it holds the turn just like the real multiplayer flow does,
   * arms `pendingWheelSpin` locally so `SpinWheelOverlay` appears the same
   * way it would over a WebSocket round trip. */
  async function runSpecialScenario() {
    if (busy) return;
    const specialTile = state.tiles.find((t) => t.effect.type === "special");
    if (!specialTile) return;
    setBusy(true);
    try {
      const tile = findTile(state.tiles, state.players[0].currentTileId);
      const result = computeMove(state, playerId, specialTile.position - tile.position);
      await handleRef.current?.animateMove(playerId, result.path);
      const moved = applyMoveResult(state, result, { holdTurn: true });
      const landedOnSpecial = findTile(moved.tiles, result.finalTileId).effect.type === "special";
      if (landedOnSpecial) {
        setState({ ...moved, pendingWheelSpin: { playerId, tileId: result.finalTileId } });
        setWheelPhase("enter");
        // See `GameUI`'s identical two-step: mount faded/shrunken, then flip
        // to `idle` next frame so the fade/scale-in has something to animate.
        requestAnimationFrame(() => setWheelPhase("idle"));
      } else {
        setState(moved);
      }
    } finally {
      setBusy(false);
    }
  }

  /** Local stand-in for the server's `spin_wheel` handler: rolls a segment
   * (or, for a dev "force outcome" button, lands on a specific one instead),
   * then plays the same spin-then-celebrate-then-hide-then-move-then-adopt
   * sequence `GameUI` runs off a `wheel_spun` broadcast, just without the
   * network round trip. */
  async function spinWheel(forcedSegmentIndex?: number) {
    if (!state.pendingWheelSpin) return;
    const segmentIndex = forcedSegmentIndex ?? rollWheelSegment();
    const outcome = WHEEL_SEGMENTS[segmentIndex].type;
    const moverId = state.pendingWheelSpin.playerId;
    // A "drop" outcome is a row-trap card played from the mover's own tile
    // (see `applyWheelOutcome`'s "drop" case) — figure out which row (from
    // the pre-drop state) now, but hold off actually building the trapdoors
    // until the wheel's fully hidden below, or they'd visibly appear on the
    // board while the wheel is still up.
    const dropTileIds = outcome === "drop" ? trapCardTileIds(state, moverId, "row") : null;
    setWheelSpin({ segmentIndex });
    await sleep(WHEEL_SPIN_MS);
    setWheelPhase("celebrate");
    await sleep(WHEEL_CELEBRATE_MS);
    setWheelPhase("exit");
    await sleep(WHEEL_EXIT_MS);
    setWheelSpin(null);
    if (dropTileIds) {
      handleRef.current?.prepareTrapdoorDrop(dropTileIds);
      handleRef.current?.openTrapdoors(dropTileIds);
    }
    const { state: next, moves } = applyWheelOutcome(state, moverId, outcome);
    await Promise.all(moves.map((m) => handleRef.current?.animateMove(m.playerId, m.path)));
    setState(next);
  }

  async function runTrap(mode: "row" | "column") {
    if (busy) return;
    setBusy(true);
    try {
      const tileIds = trapCardTileIds(state, playerId, mode);
      handleRef.current?.prepareTrapdoorDrop(tileIds);
      const { results, destroyedFrozenTileIds } = computeRowColumnTrap(state, playerId, mode);
      handleRef.current?.openTrapdoors(tileIds);
      await Promise.all(results.map((r) => handleRef.current?.animateMove(r.playerId, r.path)));
      setState((prev) => applyTeamAdvance(prev, results, destroyedFrozenTileIds));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (busy) return;
    setState(createInitialState([{ id: "test", name: "Test", players: [{ id: "p1", name: "P1" }] }]));
    setWheelSpin(null);
    setWheelPhase("enter");
  }

  const player = currentPlayer(state);
  const playerTile = findTile(state.tiles, player.currentTileId);
  const locked = busy || !!state.pendingWheelSpin;

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "#020309" }}>
      <Scene state={state} handleRef={handleRef} />
      {(state.pendingWheelSpin || wheelSpin) && (
        <SpinWheelOverlay
          moverName={player.name}
          isController={true}
          spinning={wheelSpin}
          phase={wheelPhase}
          onSpin={() => spinWheel()}
        />
      )}
      <div
        style={{
          position: "fixed",
          top: 16,
          left: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: 16,
          borderRadius: 12,
          border: "1px solid rgba(34, 227, 255, 0.4)",
          background: "rgba(4, 7, 13, 0.85)",
          color: "white",
          fontFamily: "sans-serif",
          fontSize: 13,
          width: 260,
        }}
      >
        <div style={{ color: "#22e3ff", fontWeight: 700, marginBottom: 4 }}>Board Prototype</div>
        <div style={{ opacity: 0.8 }}>
          Tile {playerTile.position} (row {playerTile.row}, col {playerTile.col}) &middot; effect:{" "}
          {playerTile.effect.type}
        </div>
        <div style={{ opacity: 0.8 }}>Frozen tiles: {state.frozenTiles.length}</div>

        <div style={{ height: 1, background: "rgba(34, 227, 255, 0.2)", margin: "8px 0" }} />

        <button style={buttonStyle} disabled={locked} onClick={() => runMove(1 + Math.floor(Math.random() * 6))}>
          Roll (random 1-6)
        </button>

        {TILE_SCENARIOS.map((s) => (
          <button key={s.targetPosition} style={buttonStyle} disabled={locked} onClick={() => runScenario(s.targetPosition)}>
            {s.label}
          </button>
        ))}

        <button style={buttonStyle} disabled={locked} onClick={runSpecialScenario}>
          Land on the special tile (Fortune Wheel)
        </button>

        {state.pendingWheelSpin && !wheelSpin && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: 8,
              borderRadius: 8,
              border: "1px dashed rgba(255, 240, 158, 0.5)",
              background: "rgba(255, 240, 158, 0.06)",
            }}
          >
            <div style={{ color: "#fff29e", fontWeight: 700, fontSize: 11, textTransform: "uppercase" }}>
              Dev: force wheel outcome
            </div>
            {WHEEL_SEGMENTS.map((seg, i) => (
              <button
                key={i}
                style={{ ...buttonStyle, borderColor: "#fff29e", color: "#fff29e" }}
                onClick={() => spinWheel(i)}
              >
                {seg.label}
              </button>
            ))}
          </div>
        )}

        <button style={buttonStyle} disabled={locked} onClick={runFreeze}>
          Play freeze card (advance 1, freeze tile behind)
        </button>

        <button style={buttonStyle} disabled={locked} onClick={() => runTrap("row")}>
          Play row-trap card here
        </button>
        <button style={buttonStyle} disabled={locked} onClick={() => runTrap("column")}>
          Play column-trap card here
        </button>

        <div style={{ height: 1, background: "rgba(34, 227, 255, 0.2)", margin: "8px 0" }} />

        <button style={{ ...buttonStyle, borderColor: "#ff2d95", color: "#ff2d95" }} disabled={busy} onClick={reset}>
          Reset
        </button>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #22e3ff",
  background: "rgba(34, 227, 255, 0.1)",
  color: "#22e3ff",
  fontWeight: 600,
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
};
