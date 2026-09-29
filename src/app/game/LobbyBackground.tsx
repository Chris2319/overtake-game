import LobbyScene from "./LobbyScene";

/** The lobby's background layer: the hero droid on its hex platform, plus a
 * left-to-right vignette that fades the skyline down behind the seat panel
 * on the right (kept out of `LobbyScene` itself, which only knows about 3D)
 * and a top-down one so the title text stays legible over the skyline. */
export default function LobbyBackground({ color, playerNumber }: { color: number; playerNumber: number }) {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <LobbyScene color={color} playerNumber={playerNumber} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(90deg, rgba(2,3,9,0.15) 0%, rgba(2,3,9,0.35) 55%, rgba(2,3,9,0.9) 78%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, rgba(2,3,9,0.55) 0%, rgba(2,3,9,0) 22%, rgba(2,3,9,0) 78%, rgba(2,3,9,0.5) 100%)",
        }}
      />
    </div>
  );
}
