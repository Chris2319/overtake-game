"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useGameSession } from "@/lib/gameSession";
import { TEAM_COLORS } from "@/lib/game/engine";
import type { QaPlayerConfig } from "@/lib/game/types";
import StartBackground from "./start/StartBackground";
import { StartMenu, StartQaPanel } from "./start/StartMenu";

const MAX_QA_PLAYERS = 5;

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

  // QA mode is dev/test tooling, not a player-facing feature — keep it out of
  // the start page unless explicitly opened with `?qa=1`.
  const [showQaMode, setShowQaMode] = useState(false);
  useEffect(() => {
    setShowQaMode(new URLSearchParams(window.location.search).get("qa") === "1");
  }, []);

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
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: 24,
        flexWrap: "wrap",
        fontFamily: "sans-serif",
        color: "white",
        overflow: "hidden",
      }}
    >
      <StartBackground />
      <div
        style={{
          display: "flex",
          gap: 24,
          flexWrap: "wrap",
          justifyContent: "center",
          transform: "translateY(-18%)",
        }}
      >
        <StartMenu
          connected={connected}
          name={name}
          onNameChange={setName}
          code={code}
          onCodeChange={setCode}
          error={error}
          onCreateGame={createGame}
          onJoinGame={joinGame}
        />
        {showQaMode && (
          <StartQaPanel
            connected={connected}
            qaCount={qaCount}
            onQaCountChange={setQaCount}
            qaPlayers={qaPlayers}
            onUpdateQaPlayer={updateQaPlayer}
            onStartQaGame={startQaGame}
          />
        )}
      </div>
    </div>
  );
}
