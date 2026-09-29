import StartScene from "./StartScene";

/** The start screen's background layer, isolated from the title/menu on top
 * of it: the same night-city skybox/lighting/bloom setup as the in-game
 * `Scene`, with a hex platform for the (future) start-screen droids to
 * stand on, plus a vignette so the panels on top stay legible. */
export default function StartBackground() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <StartScene />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(circle at center, rgba(2,3,9,0.25) 0%, rgba(2,3,9,0.8) 100%)",
        }}
      />
    </div>
  );
}
