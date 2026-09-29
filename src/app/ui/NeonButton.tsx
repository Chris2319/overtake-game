/** Cuts the top-left/bottom-right corners off a rectangle, giving buttons
 * and cards the angled "console bracket" look from the concept art instead
 * of a plain rounded rect. `size` is the cut depth in px. */
export const cutCorners = (size: number) =>
  `polygon(${size}px 0, 100% 0, 100% calc(100% - ${size}px), calc(100% - ${size}px) 100%, 0 100%, 0 ${size}px)`;

/** A cut-corner button that glows like the game's own HUD frames: a solid
 * cyan layer clipped to the button's shape, with a near-black layer inset
 * on top of it, so the border reads as a crisp neon line against real
 * black rather than a translucent tinted fill. Both variants share the same
 * size so a "primary"/"secondary" pair (e.g. "Create game"/"Join game")
 * lines up — `variant="primary"` is just the brighter main CTA, `"secondary"`
 * a quieter glow/text color. */
export function NeonButton({
  variant,
  disabled,
  onClick,
  children,
}: {
  variant: "primary" | "secondary";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const cut = 10;
  const borderWidth = 1.5;
  const glow = variant === "primary" ? "0 0 26px rgba(34, 227, 255, 0.6)" : "0 0 14px rgba(34, 227, 255, 0.35)";

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        position: "relative",
        padding: "16px 14px",
        border: "none",
        background: "none",
        color: variant === "primary" ? "#22e3ff" : "#bdf6ff",
        fontFamily: "var(--font-retro)",
        fontSize: 13,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        cursor: "pointer",
        whiteSpace: "nowrap",
        textShadow: `0 0 8px ${variant === "primary" ? "#22e3ff" : "rgba(34, 227, 255, 0.8)"}`,
        boxShadow: glow,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ position: "absolute", inset: 0, clipPath: cutCorners(cut), background: "#22e3ff", zIndex: 0 }} />
      <span
        style={{
          position: "absolute",
          inset: borderWidth,
          clipPath: cutCorners(Math.max(cut - borderWidth, 0)),
          background: "#04070d",
          zIndex: 0,
        }}
      />
      <span style={{ position: "relative", zIndex: 1 }}>{children}</span>
    </button>
  );
}
