"use client";

import type { LobbyTeam, PlayerId, TeamId } from "@/lib/game/types";

/** 5 teams x 5 seats each, filled in from the server's `lobby_updated`
 * broadcast. Click an open seat to sit there; the host starts the game once
 * at least 2 teams have a seated player. */
export default function LobbySeatGrid({
  gameId,
  teams,
  myPlayerId,
  hostPlayerId,
  isHost,
  onSelectSeat,
  onStartGame,
}: {
  gameId: string;
  teams: LobbyTeam[];
  myPlayerId: PlayerId | null;
  hostPlayerId: PlayerId | null;
  isHost: boolean;
  onSelectSeat: (teamId: TeamId, slotIndex: number) => void;
  onStartGame: () => void;
}) {
  const nonEmptyTeams = teams.filter((t) => t.seats.some(Boolean)).length;
  const canStart = isHost && nonEmptyTeams >= 2;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020309",
        color: "white",
        fontFamily: "sans-serif",
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, color: "#22e3ff", textShadow: "0 0 10px rgba(34,227,255,0.6)" }}>
          Lobby
        </h1>
        <span style={{ opacity: 0.7 }}>
          Code: <strong style={{ color: "white", letterSpacing: "0.1em" }}>{gameId}</strong>
        </span>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", justifyContent: "center" }}>
        {teams.map((team) => {
          const teamHex = `#${team.color.toString(16).padStart(6, "0")}`;
          return (
            <div
              key={team.id}
              style={{
                width: 150,
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 12,
                borderRadius: 10,
                border: `1px solid ${teamHex}`,
                boxShadow: `0 0 12px color-mix(in srgb, ${teamHex} 35%, transparent)`,
              }}
            >
              <div style={{ color: teamHex, fontWeight: 800, letterSpacing: "0.08em", textAlign: "center" }}>
                {team.name}
              </div>
              {team.seats.map((seat, slotIndex) => {
                const isMine = seat?.playerId === myPlayerId;
                const isOpen = !seat;
                return (
                  <button
                    key={slotIndex}
                    onClick={() => isOpen && onSelectSeat(team.id, slotIndex)}
                    disabled={!isOpen}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 6,
                      textAlign: "left",
                      border: isMine ? `1px solid ${teamHex}` : "1px solid rgba(255,255,255,0.15)",
                      background: isMine
                        ? `color-mix(in srgb, ${teamHex} 25%, transparent)`
                        : isOpen
                          ? "rgba(255,255,255,0.04)"
                          : "rgba(255,255,255,0.09)",
                      color: isOpen ? "rgba(255,255,255,0.4)" : "white",
                      cursor: isOpen ? "pointer" : "default",
                      fontSize: 13,
                    }}
                  >
                    {seat ? (
                      <>
                        {seat.name}
                        {seat.playerId === hostPlayerId && (
                          <span style={{ marginLeft: 6, color: teamHex, fontSize: 11 }}>HOST</span>
                        )}
                      </>
                    ) : (
                      "Open seat"
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {isHost ? (
        <button
          disabled={!canStart}
          onClick={onStartGame}
          style={{
            padding: "12px 28px",
            borderRadius: 8,
            border: "1px solid #22e3ff",
            background: canStart ? "rgba(34, 227, 255, 0.2)" : "rgba(255,255,255,0.05)",
            color: canStart ? "#22e3ff" : "rgba(255,255,255,0.4)",
            fontWeight: 800,
            letterSpacing: "0.06em",
            cursor: canStart ? "pointer" : "default",
          }}
        >
          Start game
        </button>
      ) : (
        <div style={{ opacity: 0.6 }}>Waiting for the host to start the game…</div>
      )}
    </div>
  );
}
