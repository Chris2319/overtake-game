"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useGameSession } from "@/lib/gameSession";
import { TEAM_COLORS } from "@/lib/game/engine";
import type { QaPlayerConfig, TeamId } from "@/lib/game/types";

const MAX_QA_PLAYERS = 5;

const panelStyle: React.CSSProperties = {
  width: 360,
  maxWidth: "90vw",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  borderRadius: 12,
  border: "1px solid #22e3ff",
  background: "rgba(10, 12, 20, 0.9)",
  boxShadow: "0 0 24px rgba(34, 227, 255, 0.25)",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid rgba(34, 227, 255, 0.4)",
  background: "#04070d",
  color: "white",
  fontSize: 15,
};

const buttonStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid #22e3ff",
  background: "rgba(34, 227, 255, 0.15)",
  color: "#22e3ff",
  fontWeight: 700,
  letterSpacing: "0.04em",
  cursor: "pointer",
};

function defaultQaPlayers(): QaPlayerConfig[] {
  return Array.from({ length: MAX_QA_PLAYERS }, (_, i) => ({
    name: `Player ${i + 1}`,
    teamId: TEAM_COLORS[i % TEAM_COLORS.length].id,
  }));
}

export default function Home() {
  const router = useRouter();
  const { gameId, error, connected, createGame, startQaGame, joinGame } = useGameSession();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [qaCount, setQaCount] = useState(2);
  const [qaPlayers, setQaPlayers] = useState<QaPlayerConfig[]>(defaultQaPlayers);

  const updateQaPlayer = (index: number, patch: Partial<QaPlayerConfig>) =>
    setQaPlayers((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  // Dev/scripting convenience: `?autocreate=1&name=Alice[&gameId=CODE]` opens
  // straight into a hosted game with no clicks — see launcher script under
  // scripts/. Query string carries over into the /game/[id] route so its own
  // autoseat/autostart flags (if present) still apply once we navigate.
  const autoCreateFiredRef = useRef(false);
  useEffect(() => {
    if (autoCreateFiredRef.current || !connected) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("autocreate") !== "1") return;
    const autoName = params.get("name");
    if (!autoName) return;
    autoCreateFiredRef.current = true;
    createGame(autoName, params.get("gameId") ?? undefined);
  }, [connected, createGame]);

  useEffect(() => {
    if (gameId) router.push(`/game/${gameId}${window.location.search}`);
  }, [gameId, router]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 24,
        flexWrap: "wrap",
        background: "#020309",
        fontFamily: "sans-serif",
        color: "white",
      }}
    >
      <div style={panelStyle}>
        <h1 style={{ margin: 0, fontSize: 22, color: "#22e3ff", textShadow: "0 0 10px rgba(34,227,255,0.6)" }}>
          Overtake
        </h1>
        <input
          id="landing-player-name"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={inputStyle}
        />
        <button
          disabled={!connected || !name.trim()}
          onClick={() => createGame(name.trim())}
          style={{ ...buttonStyle, opacity: !connected || !name.trim() ? 0.5 : 1 }}
        >
          Create game
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            id="landing-game-code"
            placeholder="Game code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            style={{ ...inputStyle, flex: 1, textTransform: "uppercase" }}
          />
          <button
            disabled={!connected || !name.trim() || !code.trim()}
            onClick={() => joinGame(code.trim(), name.trim())}
            style={{ ...buttonStyle, opacity: !connected || !name.trim() || !code.trim() ? 0.5 : 1 }}
          >
            Join game
          </button>
        </div>
        {error && <div style={{ color: "#ff2d95" }}>{error}</div>}
      </div>

      <div style={panelStyle}>
        <h1 style={{ margin: 0, fontSize: 22, color: "#22e3ff", textShadow: "0 0 10px rgba(34,227,255,0.6)" }}>
          QA mode
        </h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
          Play every seat yourself — no bots. Set how many players and which team each one is on.
        </p>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, opacity: 0.8 }}>
          Players
          <select
            id="landing-qa-count"
            value={qaCount}
            onChange={(e) => setQaCount(Number(e.target.value))}
            style={inputStyle}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} player{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {qaPlayers.slice(0, qaCount).map((player, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <input
                placeholder={`Player ${i + 1} name`}
                value={player.name}
                onChange={(e) => updateQaPlayer(i, { name: e.target.value })}
                style={{ ...inputStyle, flex: 1 }}
              />
              <select
                value={player.teamId}
                onChange={(e) => updateQaPlayer(i, { teamId: e.target.value as TeamId })}
                style={inputStyle}
              >
                {TEAM_COLORS.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <button
          disabled={!connected}
          onClick={() => startQaGame(qaPlayers.slice(0, qaCount))}
          style={{ ...buttonStyle, opacity: !connected ? 0.5 : 1 }}
        >
          Start QA game
        </button>
      </div>
    </div>
  );
}
