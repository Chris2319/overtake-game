"use client";

import { useState } from "react";
import { TEAM_COLORS } from "@/lib/game/engine";
import { DROID_SHAPES, MAX_PLAYER_NUMBER, type DroidShape } from "@/lib/game/droid";
import DroidScene from "./DroidScene";

const SHAPE_LABELS: Record<DroidShape, string> = {
  orb: "Orb",
  square: "Square",
  triangle: "Triangle",
};

/** Dev-only page for iterating on the droid model in isolation — no board,
 * no game state, just the droid plus a couple of controls to preview the
 * states it's actually shown in (idle vs. active-turn ring, per-team
 * color, and now which of the three body shapes). Not linked from
 * anywhere; visit `/droid` directly. */
export default function DroidPage() {
  const [color, setColor] = useState(TEAM_COLORS[0].color);
  const [ringActive, setRingActive] = useState(false);
  const [shape, setShape] = useState<DroidShape>("orb");
  const [playerNumber, setPlayerNumber] = useState(1);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "#020309" }}>
      <DroidScene color={color} ringActive={ringActive} shape={shape} playerNumber={playerNumber} />
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
          borderRadius: 8,
          background: "rgba(10, 12, 20, 0.85)",
          border: "1px solid rgba(34, 227, 255, 0.4)",
          color: "white",
          fontFamily: "sans-serif",
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          {DROID_SHAPES.map((s) => (
            <button
              key={s}
              onClick={() => setShape(s)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                background: shape === s ? "rgba(34, 227, 255, 0.25)" : "transparent",
                border: shape === s ? "1px solid rgba(34, 227, 255, 0.9)" : "1px solid rgba(255,255,255,0.3)",
                color: "white",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {SHAPE_LABELS[s]}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {TEAM_COLORS.map((team) => (
            <button
              key={team.id}
              onClick={() => setColor(team.color)}
              title={team.name}
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: `#${team.color.toString(16).padStart(6, "0")}`,
                border: color === team.color ? "2px solid white" : "1px solid rgba(255,255,255,0.3)",
                cursor: "pointer",
              }}
            />
          ))}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={ringActive} onChange={(e) => setRingActive(e.target.checked)} />
          Active ring (this droid's turn)
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          {Array.from({ length: MAX_PLAYER_NUMBER }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              onClick={() => setPlayerNumber(n)}
              title={`Player ${n}`}
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                background: playerNumber === n ? "rgba(34, 227, 255, 0.25)" : "transparent",
                border: playerNumber === n ? "1px solid rgba(34, 227, 255, 0.9)" : "1px solid rgba(255,255,255,0.3)",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              P{n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
