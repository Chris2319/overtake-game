"use client";

import { use, useEffect, useRef, useState } from "react";
import { useGameSession } from "@/lib/gameSession";
import type { LobbyTeam, TeamId } from "@/lib/game/types";
import LobbySeatGrid from "../LobbySeatGrid";
import GameUI from "../GameUI";

/** First open seat on the team with the fewest players seated so far (ties
 * broken by team order) — good enough to spread a handful of scripted
 * players across teams without any real player having to choose. */
function pickAutoSeat(teams: LobbyTeam[]): { teamId: TeamId; slotIndex: number } | null {
  let best: { teamId: TeamId; slotIndex: number; count: number } | null = null;
  for (const team of teams) {
    const slotIndex = team.seats.findIndex((seat) => !seat);
    if (slotIndex === -1) continue;
    const count = team.seats.filter(Boolean).length;
    if (!best || count < best.count) best = { teamId: team.id, slotIndex, count };
  }
  return best;
}

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

  // Dev/scripting convenience so a launcher script can open N separate
  // browser windows that join a game hands-free — see scripts/ launcher.
  // `?autojoin=1&name=X` joins with no clicks (retrying until the host's
  // room exists), `&autoseat=1` picks an open seat automatically, and
  // `&autostart=1[&expect=N]` has the host start once enough players are
  // seated (N total, or just >=2 teams if `expect` is omitted).
  const [query] = useState(() =>
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search),
  );
  const autoJoinName = query.get("autojoin") === "1" ? query.get("name") : null;
  const autoSeat = query.get("autoseat") === "1";
  const autoStart = query.get("autostart") === "1";
  const expectRaw = query.get("expect");
  const expect = expectRaw ? Number(expectRaw) : null;

  useEffect(() => {
    if (!autoJoinName || inThisGame) return;
    const interval = setInterval(() => session.joinGame(routeGameId, autoJoinName), 800);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJoinName, inThisGame, routeGameId]);

  const hasAutoSeatedRef = useRef(false);
  useEffect(() => {
    if (!autoSeat || !inThisGame || session.phase !== "lobby" || !session.playerId) return;
    if (hasAutoSeatedRef.current) return;
    const alreadySeated = session.teams.some((team) => team.seats.some((seat) => seat?.playerId === session.playerId));
    if (alreadySeated) {
      hasAutoSeatedRef.current = true;
      return;
    }
    const seat = pickAutoSeat(session.teams);
    if (!seat) return;
    hasAutoSeatedRef.current = true;
    session.selectSeat(seat.teamId, seat.slotIndex);
  }, [autoSeat, inThisGame, session.phase, session.playerId, session.teams, session.selectSeat]);

  const hasAutoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || !session.isHost || session.phase !== "lobby" || hasAutoStartedRef.current) return;
    const nonEmptyTeams = session.teams.filter((team) => team.seats.some(Boolean)).length;
    if (nonEmptyTeams < 2) return;
    const seatedCount = session.teams.reduce((sum, team) => sum + team.seats.filter(Boolean).length, 0);
    if (expect != null && seatedCount < expect) return;
    hasAutoStartedRef.current = true;
    session.startGame();
  }, [autoStart, session.isHost, session.phase, session.teams, expect, session.startGame]);

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
