const CYAN = "#22e3ff";
const PINK = "#ff2d95";

/** The start screen's wordmark: "OVER//TAKE" in the same split-color,
 * slash-divided style as the "Overtake" concept art (cyan body, pink
 * slash), with a flanking tagline underneath. Split out so the title can
 * be restyled independently of the menu below it. */
export default function StartTitle() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <h1
        style={{
          margin: 0,
          display: "flex",
          alignItems: "baseline",
          gap: "0.04em",
          fontSize: 72,
          lineHeight: 1.2,
          fontFamily: "var(--font-retro)",
        }}
      >
        <span style={{ color: CYAN, textShadow: `0 0 14px ${CYAN}99, 0 0 2px ${CYAN}` }}>OVER</span>
        <span style={{ color: PINK, textShadow: `0 0 14px ${PINK}99, 0 0 2px ${PINK}` }}>TAKE</span>
      </h1>
      <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
        <span
          style={{
            flex: 1,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${CYAN}99)`,
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-retro)",
            fontSize: 9,
            letterSpacing: "0.25em",
            color: "rgba(255,255,255,0.75)",
            whiteSpace: "nowrap",
          }}
        >
          CLIMB · RACE · SURVIVE
        </span>
        <span
          style={{
            flex: 1,
            height: 1,
            background: `linear-gradient(90deg, ${CYAN}99, transparent)`,
          }}
        />
      </div>
    </div>
  );
}
