import { TEAM_COLORS } from "@/lib/game/engine";
import type { QaPlayerConfig, TeamId } from "@/lib/game/types";
import { NeonButton } from "../ui/NeonButton";
import StartTitle from "./StartTitle";

export const panelStyle: React.CSSProperties = {
  width: 360,
  maxWidth: "90vw",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const qaPanelStyle: React.CSSProperties = {
  ...panelStyle,
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

/** The start screen's primary controls: create or join a game. Split out
 * from the page so the title and background can be restyled independently
 * of this panel's logic. */
export function StartMenu(props: {
  connected: boolean;
  name: string;
  onNameChange: (name: string) => void;
  code: string;
  onCodeChange: (code: string) => void;
  error: string | null;
  onCreateGame: (name: string) => void;
  onJoinGame: (code: string, name: string) => void;
}) {
  const { connected, name, onNameChange, code, onCodeChange, error, onCreateGame, onJoinGame } = props;

  return (
    <div style={{ ...panelStyle, position: "relative" }}>
      <StartTitle />
      <input
        id="landing-player-name"
        placeholder="Your name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        style={inputStyle}
      />
      <NeonButton variant="primary" disabled={!connected || !name.trim()} onClick={() => onCreateGame(name.trim())}>
        Create game
      </NeonButton>
      <input
        id="landing-game-code"
        placeholder="Game code"
        value={code}
        onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
        style={{ ...inputStyle, textTransform: "uppercase" }}
      />
      <NeonButton
        variant="secondary"
        disabled={!connected || !name.trim() || !code.trim()}
        onClick={() => onJoinGame(code.trim(), name.trim())}
      >
        Join game
      </NeonButton>
      {error && <div style={{ color: "#ff2d95" }}>{error}</div>}
    </div>
  );
}

/** The dev/test-only QA panel: choose player count and each seat's name/team,
 * then start a local no-bots game where every seat is dealt the same fixed
 * test hand (see `createInitialState`'s `fixedHand` option). */
export function StartQaPanel(props: {
  connected: boolean;
  qaCount: number;
  onQaCountChange: (count: number) => void;
  qaPlayers: QaPlayerConfig[];
  onUpdateQaPlayer: (index: number, patch: Partial<QaPlayerConfig>) => void;
  onStartQaGame: (players: QaPlayerConfig[]) => void;
}) {
  const { connected, qaCount, onQaCountChange, qaPlayers, onUpdateQaPlayer, onStartQaGame } = props;

  return (
    <div style={{ ...qaPanelStyle, position: "relative" }}>
      <h1
        style={{
          margin: 0,
          fontSize: 22,
          lineHeight: 1.4,
          color: "#22e3ff",
          textShadow: "0 0 10px rgba(34,227,255,0.6)",
          fontFamily: "var(--font-retro)",
        }}
      >
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
          onChange={(e) => onQaCountChange(Number(e.target.value))}
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
              onChange={(e) => onUpdateQaPlayer(i, { name: e.target.value })}
              style={{ ...inputStyle, flex: 1 }}
            />
            <select
              value={player.teamId}
              onChange={(e) => onUpdateQaPlayer(i, { teamId: e.target.value as TeamId })}
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
      <NeonButton variant="primary" disabled={!connected} onClick={() => onStartQaGame(qaPlayers.slice(0, qaCount))}>
        Start QA game
      </NeonButton>
    </div>
  );
}
