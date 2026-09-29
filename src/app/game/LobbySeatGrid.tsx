"use client";

import { useState } from "react";
import type { LobbyTeam, PlayerId, TeamId } from "@/lib/game/types";
import { NeonButton } from "../ui/NeonButton";
import StartTitle from "../start/StartTitle";
import LobbyBackground from "./LobbyBackground";

const DEFAULT_DROID_COLOR = 0x22e3ff;

/** Small filled/outline person glyph for a seat row — filled+colored once a
 * seat is taken, a dim outline while still open, so occupancy reads at a
 * glance without needing to parse the row's text. */
function SeatIcon({ color, filled }: { color: string; filled: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle cx={12} cy={8} r={5} fill={filled ? color : "none"} stroke={filled ? color : "rgba(255,255,255,0.35)"} strokeWidth={filled ? 0 : 1.8} />
      <path
        d="M3 21c0-5 4-8 9-8s9 3 9 8"
        fill={filled ? color : "none"}
        stroke={filled ? color : "rgba(255,255,255,0.35)"}
        strokeWidth={filled ? 0 : 1.8}
      />
    </svg>
  );
}

/** One team's stack of seat rows in the lobby panel: a colored header plus
 * a row per seat, filled with the seated player's name or "Open seat".
 * Clicking an open row is how a player claims that seat. */
function TeamPanel({
  team,
  myPlayerId,
  hostPlayerId,
  onSelectSeat,
}: {
  team: LobbyTeam;
  myPlayerId: PlayerId | null;
  hostPlayerId: PlayerId | null;
  onSelectSeat: (teamId: TeamId, slotIndex: number) => void;
}) {
  const teamHex = `#${team.color.toString(16).padStart(6, "0")}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          color: teamHex,
          fontFamily: "var(--font-retro)",
          fontSize: 13,
          letterSpacing: "0.1em",
          textShadow: `0 0 8px color-mix(in srgb, ${teamHex} 80%, transparent)`,
        }}
      >
        {team.name.toUpperCase()}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {team.seats.map((seat, slotIndex) => {
          const isMine = seat?.playerId === myPlayerId;
          const isOpen = !seat;
          return (
            <button
              key={slotIndex}
              onClick={() => isOpen && onSelectSeat(team.id, slotIndex)}
              disabled={!isOpen}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "11px 14px",
                borderRadius: 5,
                borderLeft: `4px solid ${seat ? teamHex : "rgba(255,255,255,0.15)"}`,
                borderTop: "none",
                borderRight: "none",
                borderBottom: "none",
                background: isMine
                  ? `color-mix(in srgb, ${teamHex} 22%, transparent)`
                  : isOpen
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(255,255,255,0.07)",
                color: isOpen ? "rgba(255,255,255,0.4)" : "white",
                cursor: isOpen ? "pointer" : "default",
                fontFamily: "var(--font-retro)",
                fontSize: 13,
                letterSpacing: "0.02em",
                textAlign: "left",
              }}
            >
              <SeatIcon color={teamHex} filled={!!seat} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {seat ? seat.name : "Open seat"}
              </span>
              {seat?.playerId === hostPlayerId && (
                <span style={{ color: teamHex, fontSize: 10, letterSpacing: "0.05em" }}>HOST</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 5 teams x 5 seats each, filled in from the server's `lobby_updated`
 * broadcast. Click an open seat to sit there; the host starts the game once
 * at least 2 teams have a seated player. Laid out as a hero shot of the
 * game's droid on the left with the seat panel docked to the right, rather
 * than the seat grid alone centered on a flat background. */
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
  const [copied, setCopied] = useState(false);
  const nonEmptyTeams = teams.filter((t) => t.seats.some(Boolean)).length;
  const canStart = isHost && nonEmptyTeams >= 2;
  const myTeam = teams.find((team) => team.seats.some((seat) => seat?.playerId === myPlayerId));
  const heroColor = myTeam?.color ?? DEFAULT_DROID_COLOR;
  const mySeatIndex = myTeam?.seats.findIndex((seat) => seat?.playerId === myPlayerId) ?? -1;
  const heroPlayerNumber = mySeatIndex >= 0 ? mySeatIndex + 1 : 1;

  const copyCode = () => {
    navigator.clipboard?.writeText(gameId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div
      style={{
        position: "relative",
        height: "100dvh",
        background: "#020309",
        color: "white",
        fontFamily: "var(--font-retro)",
        overflow: "hidden",
      }}
    >
      <LobbyBackground color={heroColor} playerNumber={heroPlayerNumber} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          height: "100%",
          boxSizing: "border-box",
          padding: "32px 32px",
          display: "flex",
          gap: 24,
        }}
      >
        {/* Stage column: whatever width is left over once the panel takes
            its fixed slice on the right — the same region the droid renders
            into (see LOOK_OFFSET_X in LobbyScene), so centering the title
            here keeps it directly above the droid instead of pinned to the
            page's own top-left corner regardless of where the droid is. */}
        <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
          <StartTitle />
        </div>

        <div
          style={{
            width: 400,
            maxWidth: "88vw",
            display: "flex",
            flexDirection: "column",
            gap: 18,
            padding: 20,
            borderRadius: 12,
            background: "rgba(6, 9, 16, 0.78)",
            border: "1px solid rgba(34, 227, 255, 0.25)",
            boxShadow: "0 0 30px rgba(0,0,0,0.5)",
            flexShrink: 0,
            minHeight: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h1
              style={{
                margin: 0,
                fontSize: 20,
                letterSpacing: "0.08em",
                color: "#22e3ff",
                textShadow: "0 0 10px rgba(34,227,255,0.6)",
              }}
            >
              Lobby
            </h1>
            <button
              onClick={copyCode}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                color: "rgba(255,255,255,0.7)",
                fontFamily: "var(--font-retro)",
                fontSize: 10,
                letterSpacing: "0.06em",
                cursor: "pointer",
              }}
              title="Copy game code"
            >
              Code: <strong style={{ color: "white", letterSpacing: "0.1em" }}>{gameId}</strong>
              <span style={{ color: "#22e3ff" }}>{copied ? "✓" : "⧉"}</span>
            </button>
          </div>

          <div className="lobby-seat-scroll" style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
            {teams.map((team) => (
              <TeamPanel
                key={team.id}
                team={team}
                myPlayerId={myPlayerId}
                hostPlayerId={hostPlayerId}
                onSelectSeat={onSelectSeat}
              />
            ))}
          </div>

          {isHost ? (
            <NeonButton variant="primary" disabled={!canStart} onClick={onStartGame}>
              Start game
            </NeonButton>
          ) : (
            <div style={{ opacity: 0.6, fontSize: 10, textAlign: "center" }}>Waiting for the host to start the game…</div>
          )}
        </div>
      </div>

      <style>{`
        .lobby-seat-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(34, 227, 255, 0.5) rgba(255, 255, 255, 0.05);
        }
        .lobby-seat-scroll::-webkit-scrollbar {
          width: 8px;
        }
        .lobby-seat-scroll::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 4px;
        }
        .lobby-seat-scroll::-webkit-scrollbar-thumb {
          background: rgba(34, 227, 255, 0.5);
          border-radius: 4px;
        }
        .lobby-seat-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(34, 227, 255, 0.8);
        }
      `}</style>
    </div>
  );
}
