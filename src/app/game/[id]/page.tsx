"use client";

import { use, useState } from "react";
import { useGameSession } from "@/lib/gameSession";
import LobbySeatGrid from "../LobbySeatGrid";
import GameUI from "../GameUI";

/** Landed on directly (e.g. a shared game-code link) without having gone
 * through the "/" create/join flow yet — ask for a name and join this exact
 * game id. */
function JoinForm({ gameId, onJoin, error }: { gameId: string; onJoin: (name: string) => void; error: string | null }) {
  const [name, setName] = useState("");
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#020309",
        color: "white",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          width: 320,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: 24,
          borderRadius: 12,
          border: "1px solid #22e3ff",
          background: "rgba(10, 12, 20, 0.9)",
        }}
      >
        <div>
          Joining game <strong style={{ letterSpacing: "0.1em" }}>{gameId}</strong>
        </div>
        <input
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid rgba(34, 227, 255, 0.4)",
            background: "#04070d",
            color: "white",
            fontSize: 15,
          }}
        />
        <button
          disabled={!name.trim()}
          onClick={() => onJoin(name.trim())}
          style={{
            padding: "10px 12px",
            borderRadius: 6,
            border: "1px solid #22e3ff",
            background: "rgba(34, 227, 255, 0.15)",
            color: "#22e3ff",
            fontWeight: 700,
            cursor: name.trim() ? "pointer" : "default",
            opacity: name.trim() ? 1 : 0.5,
          }}
        >
          Join
        </button>
        {error && <div style={{ color: "#ff2d95" }}>{error}</div>}
      </div>
    </div>
  );
}

export default function GameRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const routeGameId = id.toUpperCase();
  const session = useGameSession();

  const inThisGame = session.gameId === routeGameId;

  if (!inThisGame) {
    return <JoinForm gameId={routeGameId} onJoin={(name) => session.joinGame(routeGameId, name)} error={session.error} />;
  }

  if (session.phase === "playing" && session.gameState) {
    return <GameUI initialState={session.gameState} controlledPlayerIds={session.controlledPlayerIds} />;
  }

  return (
    <LobbySeatGrid
      gameId={routeGameId}
      teams={session.teams}
      myPlayerId={session.playerId}
      hostPlayerId={session.hostPlayerId}
      isHost={session.isHost}
      onSelectSeat={session.selectSeat}
      onStartGame={session.startGame}
    />
  );
}
