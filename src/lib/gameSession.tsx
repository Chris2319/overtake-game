"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useWs } from "@/lib/ws";
import type { GamePhase, GameState, LobbyTeam, PlayerId, QaPlayerConfig, TeamId } from "@/lib/game/types";

interface SessionState {
  gameId: string | null;
  playerId: PlayerId | null;
  /** All player ids this client drives directly — see `WsServerEvent`'s
   * `game_created`/`game_joined`. Just `[playerId]` outside QA mode. */
  controlledPlayerIds: PlayerId[];
  isHost: boolean;
  phase: GamePhase | null;
  teams: LobbyTeam[];
  hostPlayerId: PlayerId | null;
  gameState: GameState | null;
  error: string | null;
}

interface SessionContextValue extends SessionState {
  connected: boolean;
  createGame: (name: string, gameId?: string) => void;
  startQaGame: (players: QaPlayerConfig[]) => void;
  joinGame: (gameId: string, name: string) => void;
  selectSeat: (teamId: TeamId, slotIndex: number) => void;
  startGame: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const initialSession: SessionState = {
  gameId: null,
  playerId: null,
  controlledPlayerIds: [],
  isHost: false,
  phase: null,
  teams: [],
  hostPlayerId: null,
  gameState: null,
  error: null,
};

export function GameSessionProvider({ children }: { children: ReactNode }) {
  const { connected, send, subscribe } = useWs();
  const [session, setSession] = useState<SessionState>(initialSession);

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.event === "game_created" || msg.event === "game_joined") {
          setSession((s) => ({
            ...s,
            gameId: msg.gameId,
            playerId: msg.playerId,
            controlledPlayerIds: msg.controlledPlayerIds,
            isHost: msg.isHost,
            phase: msg.phase,
            teams: msg.teams,
            gameState: msg.gameState,
            error: null,
          }));
        } else if (msg.event === "lobby_updated") {
          setSession((s) => ({ ...s, teams: msg.teams, hostPlayerId: msg.hostPlayerId }));
        } else if (msg.event === "game_started") {
          setSession((s) => ({ ...s, phase: "playing", gameState: msg.state }));
        } else if (msg.event === "error") {
          setSession((s) => ({ ...s, error: msg.message }));
        }
      }),
    [subscribe],
  );

  const createGame = useCallback(
    (name: string, gameId?: string) => send({ action: "create_game", name, gameId }),
    [send],
  );
  const startQaGame = useCallback(
    (players: QaPlayerConfig[]) => send({ action: "create_qa_game", players }),
    [send],
  );
  const joinGame = useCallback((gameId: string, name: string) => send({ action: "join_game", gameId, name }), [send]);
  const selectSeat = useCallback(
    (teamId: TeamId, slotIndex: number) => send({ action: "select_seat", teamId, slotIndex }),
    [send],
  );
  const startGame = useCallback(() => send({ action: "start_game" }), [send]);

  return (
    <SessionContext.Provider
      value={{ ...session, connected, createGame, startQaGame, joinGame, selectSeat, startGame }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useGameSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useGameSession must be used inside GameSessionProvider");
  return ctx;
}
