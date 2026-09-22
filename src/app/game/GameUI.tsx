"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Scene, { type SceneHandle } from "./Scene";
import { findTile } from "@/lib/game/board";
import { CELL } from "@/lib/game/geometry";
import { currentPlayer, OFFER_TIMEOUT_SECONDS, trapCardTileIds } from "@/lib/game/engine";
import { useWs } from "@/lib/ws";
import type { Card, CardId, CardOffer, GameState, MoveStep, PlayerId, TeamId, Tile, TileId } from "@/lib/game/types";

const CARD_WIDTH = 160;
const CARD_HEIGHT = 250;
const CARD_FONT_SIZE = 38;

const HAND_PERSPECTIVE_PX = 900;
const CARD_TILT_X_DEG = 42;
const CARD_FAN_STEP_DEG = 6;
/** All cards start stacked at the same spot and are splayed with a plain 2D
 * `rotate()` around a shared pivot far below the hand (see --fan-radius
 * below), like a real fan of cards held from underneath. Every card is the
 * same rectangle rotated by a different angle about the *same* point, so
 * neighboring edges stay parallel and evenly spaced — unlike rotateY, which
 * rotates each card around its own independent axis and shears it by an
 * amount that depends on its own angle, producing uneven-looking gaps
 * between cards with different fan angles. The vertical "arch" (center card
 * highest, outer cards lower) falls out of this rotation for free: a card's
 * bottom-center point sits highest when angle is 0 and drops as |angle|
 * grows, since it's tracing a circle around the pivot. The shared "lean
 * back on the table" tilt is applied once to the whole fanned hand instead
 * of per-card, so it distorts the hand as one rigid tilted plane rather
 * than shearing each card differently. */
const CARD_FAN_RADIUS_PX = 1600;

/** Same shared-pivot trick as `CARD_FAN_RADIUS_PX`, but for the card-offer
 * fan: a much tighter radius so the arch (middle card highest, outer cards
 * lowest) is actually visible instead of the near-flat curve a radius this
 * large would give at the offer fan's much wider per-card angle. */
const OFFER_FAN_RADIUS_PX = 130;

/** Deal-in animation for the card-offer fan: each card starts stacked flat
 * at the deck (rotate(0), scaled down) and springs out to its fanned angle,
 * staggered outward from the center card so the fan appears to "open" like
 * a hand of cards being spread. */
const OFFER_DEAL_MS = 420;
const OFFER_DEAL_STAGGER_MS = 45;

/** How much earlier than the collapse's full commit time the "land back in
 * the deck" particle burst fires, so it lines up with the cards visually
 * arriving rather than with the (later) state commit. */
const OFFER_COLLAPSE_BURST_LEAD_MS = 300;

/** The offer fan's container (see `CardOfferFan`) is nudged up-and-left of
 * the deck and tilted, so the fanned cards don't sit flush on top of the
 * deck pile they came from. */
const OFFER_FAN_CONTAINER_OFFSET_X = -135;
const OFFER_FAN_CONTAINER_OFFSET_Y_FACTOR = -0.95; // times CARD_HEIGHT
const OFFER_FAN_CONTAINER_TILT_DEG = -30;

function rotateVector(x: number, y: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** A card's own rotate happens about a point far below itself (see
 * `OFFER_FAN_RADIUS_PX`), shared by every card in the fan — this is that
 * pivot, expressed in the container's local (pre-tilt) coordinates. Every
 * card's wrapper sits at the same base spot before the deal, so this pivot
 * is identical for all of them. */
const OFFER_FAN_PIVOT = { x: 0, y: CARD_HEIGHT + OFFER_FAN_RADIUS_PX };

/** Container-local position of a card's corner (the point its rotate/scale
 * is anchored from) once its own rotate is `rotateDeg` — i.e. where the
 * shared-pivot rotation trick actually puts it. Used to work out where a
 * card must start (and its rotation) for the deal-in to look like it's
 * coming off the deck rather than out of thin air. */
function offerCardCornerAt(rotateDeg: number): { x: number; y: number } {
  const rel = { x: -CARD_WIDTH / 2 - OFFER_FAN_PIVOT.x, y: -OFFER_FAN_PIVOT.y };
  const rotated = rotateVector(rel.x, rel.y, rotateDeg);
  return { x: OFFER_FAN_PIVOT.x + rotated.x, y: OFFER_FAN_PIVOT.y + rotated.y };
}

/** The card's own rotate a dealt card must start at so that, combined with
 * the container's constant tilt, it reads as perfectly axis-aligned —
 * matching the untilted deck pile it's coming from — instead of already
 * looking tilted the instant it appears. */
const OFFER_DEAL_START_ROTATE_DEG = -OFFER_FAN_CONTAINER_TILT_DEG;

/** Where (in the fan container's own, pre-tilt local coordinates) a dealt
 * card's wrapper must be translated to so that — combined with the card
 * starting at `OFFER_DEAL_START_ROTATE_DEG` and the container's constant
 * offset/tilt — it visually lands exactly on top of the deck pile. Both of
 * those are fixed layout constants, so this only needs computing once.
 * Used as the deal-in/collapse animation's translate origin, on a wrapper
 * around each card (see `.offer-deal-wrap`) kept separate from the card's
 * own rotate/scale so the two don't compound. */
const OFFER_DEAL_ORIGIN = (() => {
  const containerToAnchor = rotateVector(
    -OFFER_FAN_CONTAINER_OFFSET_X,
    -OFFER_FAN_CONTAINER_OFFSET_Y_FACTOR * CARD_HEIGHT,
    -OFFER_FAN_CONTAINER_TILT_DEG,
  );
  const startCorner = offerCardCornerAt(OFFER_DEAL_START_ROTATE_DEG);
  return { x: containerToAnchor.x - startCorner.x, y: containerToAnchor.y - startCorner.y };
})();

/** Basic draw-pile visual to the right of the hand: a handful of stacked
 * card backs plus the remaining count, filled in for real once drawing gets
 * its own interaction. */
const DECK_STACK_SIZE = 4;

/** How long the played card lingers, enlarged, in the center of the screen
 * before it gets pulled down into the player and disappears — like a
 * consumable being used. */
const GROW_MS = 260;
const HOLD_MS = 200;
const SHRINK_MS = 280;
/** Fallback distance below screen-center the card travels on its way
 * "into" the player, used only if the player's on-screen position can't
 * be read (e.g. right at mount). */
const CONSUME_DROP_PX = 260;
/** How small the card shrinks to as it's consumed by the player token. */
const CONSUME_SCALE = 0.15;

/** Particle burst fired the instant the card lands on the player. */
const BURST_PARTICLE_COUNT = 12;
const BURST_MS = 450;

/** How long the whole offer fan takes to fold back down onto the deck once
 * every pick has been made (or the timer runs out) — it's the deal-in
 * animation mirrored (see `.offer-collapse-card`/`offer-collapse-out`), so
 * picking reads as "the fan closes back up" instead of the chosen cards
 * just vanishing into the hand. Accounts for the outward stagger so the
 * outermost card (the last one to finish collapsing) isn't cut off. */
function offerCollapseDuration(offerSize: number): number {
  const mid = (offerSize - 1) / 2;
  return OFFER_DEAL_MS + Math.ceil(mid) * OFFER_DEAL_STAGGER_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Row/column-trap cards share the same pink accent as the card frames'
 * "hazard" language (the ring ticks and center glyph on `CardBack`), marking
 * them as the same kind of danger as a plain backward-move card, just at
 * board scale. */
const TRAP_CARD_COLOR = "#ff2d95";

function cardColor(card: Card, playing: boolean): string {
  if (playing) return "#555";
  if (card.type === "team-advance") return "#e6ff2e";
  if (card.type === "team-retreat") return "#ff8c42";
  if (card.type === "row-trap" || card.type === "column-trap") return TRAP_CARD_COLOR;
  return card.value < 0 ? "#ff2d95" : "#22e3ff";
}

function cardLabel(card: Card): string {
  if (card.type === "team-advance") return `+${card.value}`;
  if (card.type === "team-retreat") return `${card.value}`;
  if (card.type === "row-trap") return "ROW";
  if (card.type === "column-trap") return "COL";
  return card.value > 0 ? `+${card.value}` : `${card.value}`;
}

/** Every card reads as "moving forward" (chevrons pointing up) except a
 * negative-value one, which reads as "moving back" (chevrons pointing down)
 * — covers both plain backward move cards and "team-retreat", whose value
 * is always negative. */
function cardDirection(card: Card): "forward" | "backward" {
  return card.value < 0 ? "backward" : "forward";
}

/** Mini 5x5 grid icon for the row/column-trap card faces: every square lit
 * up except the whole middle row or column, which reads as punched clean
 * through — the trapdoor's hole — rather than highlighted like a normal
 * selection. */
function TrapGridIcon({ mode, color }: { mode: "row" | "column"; color: string }) {
  const size = 5;
  const cell = 15;
  const gap = 3;
  const span = size * cell + (size - 1) * gap;
  const start = -span / 2;
  const holeIndex = 2;

  return (
    <g>
      {Array.from({ length: size }, (_, r) =>
        Array.from({ length: size }, (_, c) => {
          const isHole = mode === "row" ? r === holeIndex : c === holeIndex;
          return (
            <rect
              key={`${r}-${c}`}
              x={start + c * (cell + gap)}
              y={start + r * (cell + gap)}
              width={cell}
              height={cell}
              rx={2}
              fill={isHole ? "#0a0c14" : color}
              fillOpacity={isHole ? 1 : 0.85}
              stroke={color}
              strokeOpacity={isHole ? 0.9 : 0}
              strokeWidth={1.5}
              strokeDasharray={isHole ? "3 2" : undefined}
            />
          );
        }),
      )}
    </g>
  );
}

/** Unique face for a "row-trap"/"column-trap" card: the clipped-corner HUD
 * frame shared by every card, but with a grid icon showing the entire
 * row/column punched out (see `TrapGridIcon`) and hazard stripes instead of
 * the plain numeric readout — these cards don't move the mover, so a value
 * readout would be meaningless. */
function TrapCardFace({ card, color }: { card: Card; color: string }) {
  const mode = card.type === "row-trap" ? "row" : "column";
  const w = CARD_WIDTH;
  const h = CARD_HEIGHT;
  const cut = 16;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" style={{ display: "block" }}>
      <polygon
        points={`${cut},0 ${w},0 ${w},${h - cut} ${w - cut},${h} 0,${h} 0,${cut}`}
        fill="#0a0c14"
        stroke={color}
        strokeWidth={2}
      />
      {/* corner circuit accents, matching CardFace */}
      <path d={`M ${cut + 10} 6 h 22 l 8 8`} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />
      <circle cx={cut + 42} cy={14} r={2} fill={color} fillOpacity={0.7} />
      <path d={`M ${w - 6} ${h - cut - 10} v -22 l -8 -8`} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5} />
      {/* label, top-left */}
      <text x={14} y={30} fontSize={15} fontWeight={700} fontFamily="sans-serif" fill={color}>
        {cardLabel(card)}
      </text>
      {/* the trap grid icon, centered */}
      <g transform={`translate(${w / 2}, ${h * 0.4})`}>
        <TrapGridIcon mode={mode} color={color} />
      </g>
      {/* hazard stripes, reused from CardBack's language */}
      <clipPath id={`trap-card-hazard-${card.id}`}>
        <rect x={14} y={h - 66} width={w - 28} height={14} />
      </clipPath>
      <g clipPath={`url(#trap-card-hazard-${card.id})`} stroke={color} strokeOpacity={0.6} strokeWidth={3}>
        {Array.from({ length: 14 }, (_, i) => {
          const x = 4 + i * 9;
          return <line key={i} x1={x} y1={h - 50} x2={x + 16} y2={h - 80} />;
        })}
      </g>
      {/* name, bottom */}
      <text x={w / 2} y={h - 40} fontSize={13} fontWeight={800} fontFamily="sans-serif" fill={color} textAnchor="middle">
        {mode === "row" ? "ROW TRAP" : "COLUMN TRAP"}
      </text>
      <text x={w / 2} y={h - 22} fontSize={9} fontWeight={600} fontFamily="sans-serif" fill={color} opacity={0.7} textAnchor="middle">
        Drops the whole {mode}
      </text>
      {/* corner dots, bottom-right */}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={w - 14 - i * 9} cy={h - 14} r={1.6} fill={color} fillOpacity={0.5} />
      ))}
    </svg>
  );
}

/** Sci-fi HUD face for a card: clipped-corner frame, corner circuit
 * accents, the big value readout, a pair of chevrons showing which way the
 * card moves a token, and a segmented bar whose fill length reads off the
 * card's magnitude (out of the biggest value a card can have, 6). Sized to
 * exactly fill a `CARD_WIDTH` x `CARD_HEIGHT` slot; the caller supplies the
 * glow/box-shadow around it. Row/column-trap cards get their own distinct
 * face (`TrapCardFace`) instead, since a numeric readout doesn't apply. */
function CardFace({ card, color }: { card: Card; color: string }) {
  if (card.type === "row-trap" || card.type === "column-trap") {
    return <TrapCardFace card={card} color={color} />;
  }
  const backward = cardDirection(card) === "backward";
  const cut = 16;
  const w = CARD_WIDTH;
  const h = CARD_HEIGHT;
  const segments = 6;
  const filled = Math.min(Math.abs(card.value), segments);
  const segGap = 4;
  const segSize = (w - 2 * 24 - (segments - 1) * segGap) / segments;
  const segStartX = 24;
  const segY = h - 40;
  const chevronY = backward ? h * 0.62 : h * 0.58;
  const chevronDy = backward ? -14 : 14;
  const chevronPoints = backward ? "-18,-8 0,8 18,-8" : "-18,8 0,-8 18,8";

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" style={{ display: "block" }}>
      <polygon
        points={`${cut},0 ${w},0 ${w},${h - cut} ${w - cut},${h} 0,${h} 0,${cut}`}
        fill="#0a0c14"
        stroke={color}
        strokeWidth={2}
      />
      {/* corner circuit accents */}
      <path d={`M ${cut + 10} 6 h 22 l 8 8`} fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />
      <circle cx={cut + 42} cy={14} r={2} fill={color} fillOpacity={0.7} />
      <path d={`M ${w - 6} ${h - cut - 10} v -22 l -8 -8`} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5} />
      {/* value label, top-left */}
      <text x={14} y={30} fontSize={15} fontWeight={700} fontFamily="sans-serif" fill={color}>
        {cardLabel(card)}
      </text>
      {/* big readout */}
      <text
        x={w / 2}
        y={h * 0.42}
        fontSize={CARD_FONT_SIZE}
        fontWeight={800}
        fontFamily="sans-serif"
        fill={color}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {cardLabel(card)}
      </text>
      {/* chevrons */}
      <g transform={`translate(${w / 2}, ${chevronY})`}>
        <polyline points={chevronPoints} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
        <polyline
          points={chevronPoints}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          transform={`translate(0, ${chevronDy})`}
        />
      </g>
      {/* segmented magnitude bar */}
      {Array.from({ length: segments }, (_, i) => (
        <rect
          key={i}
          x={segStartX + i * (segSize + segGap)}
          y={segY}
          width={segSize}
          height={segSize}
          rx={2}
          fill={i < filled ? color : "none"}
          fillOpacity={i < filled ? 0.85 : 1}
          stroke={color}
          strokeOpacity={i < filled ? 1 : 0.35}
          strokeWidth={1.5}
        />
      ))}
      {/* corner dots, bottom-right */}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={w - 14 - i * 9} cy={h - 14} r={1.6} fill={color} fillOpacity={0.5} />
      ))}
    </svg>
  );
}

/** Point on a circle of radius `r` around (cx, cy) at `deg` degrees,
 * measured clockwise from straight up — matches how the ring accents in
 * `CardBack` are laid out (top/right/bottom/left, diagonals in between). */
function ringPoint(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** An arc segment of a ring, `spanDeg` wide, centered on `deg` — used for
 * the four pink "loading" ticks around the back's center ring. */
function ringArc(cx: number, cy: number, r: number, deg: number, spanDeg: number): string {
  const p1 = ringPoint(cx, cy, r, deg - spanDeg / 2);
  const p2 = ringPoint(cx, cy, r, deg + spanDeg / 2);
  return `M ${p1.x} ${p1.y} A ${r} ${r} 0 0 1 ${p2.x} ${p2.y}`;
}

/** Face-down card back: the same clipped-corner HUD frame as `CardFace`,
 * but with a generic "no info yet" center — a dashed radar ring with pink
 * tick marks and cardinal nodes, and the up-chevron/down-triangle glyph
 * used for the deck and any other spot a card's value isn't shown. */
function CardBack({ cyan = "#22e3ff", pink = "#ff2d95" }: { cyan?: string; pink?: string }) {
  const w = CARD_WIDTH;
  const h = CARD_HEIGHT;
  const cut = 16;
  const cx = w / 2;
  const cy = h * 0.42;
  const rOuter = 62;
  const rInner = 52;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" style={{ display: "block" }}>
      <polygon
        points={`${cut},0 ${w},0 ${w},${h - cut} ${w - cut},${h} 0,${h} 0,${cut}`}
        fill="#0a0c14"
        stroke={cyan}
        strokeWidth={3}
      />
      {/* corner circuit accents */}
      <path d={`M ${cut + 8} 10 h 30`} fill="none" stroke={cyan} strokeOpacity={0.5} strokeWidth={1.5} />
      <path
        d={`M ${w * 0.42} 8 h ${w * 0.28} l 14 14 v ${h * 0.28} l -10 10`}
        fill="none"
        stroke={cyan}
        strokeOpacity={0.5}
        strokeWidth={1.5}
      />
      {[0.42, 0.58, 0.7].map((t, i) => (
        <circle key={i} cx={w * t + (i === 2 ? 4 : 0)} cy={8} r={2} fill={cyan} fillOpacity={0.7} />
      ))}
      <circle cx={w - 10} cy={h * 0.3} r={2} fill={cyan} fillOpacity={0.7} />

      {/* center radar ring */}
      <circle cx={cx} cy={cy} r={rOuter} fill="none" stroke={cyan} strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="6 5" />
      <circle cx={cx} cy={cy} r={rInner} fill="none" stroke={cyan} strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="4 4" />
      {[45, 135, 225, 315].map((deg) => (
        <path key={deg} d={ringArc(cx, cy, (rOuter + rInner) / 2, deg, 26)} fill="none" stroke={pink} strokeWidth={7} strokeLinecap="round" />
      ))}
      {[0, 90, 180, 270].map((deg) => {
        const node = ringPoint(cx, cy, rOuter + 14, deg);
        const tick = ringPoint(cx, cy, rOuter + 4, deg);
        return (
          <g key={deg}>
            <line x1={tick.x} y1={tick.y} x2={node.x} y2={node.y} stroke={cyan} strokeWidth={1.5} strokeOpacity={0.7} />
            <circle cx={node.x} cy={node.y} r={4} fill="none" stroke={cyan} strokeWidth={1.5} />
          </g>
        );
      })}

      {/* center glyph: up-chevrons over a down-triangle */}
      <g transform={`translate(${cx}, ${cy})`}>
        <polyline points="-26,4 0,-22 26,4" fill="none" stroke={cyan} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
        <polyline points="-26,22 0,-4 26,22" fill="none" stroke={cyan} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
        <polygon points="-14,32 14,32 0,52" fill={pink} />
      </g>

      {/* bottom-left hazard stripes */}
      <clipPath id="card-back-hazard">
        <rect x={14} y={h - 26} width={54} height={14} />
      </clipPath>
      <g clipPath="url(#card-back-hazard)" stroke={cyan} strokeOpacity={0.6} strokeWidth={3}>
        {Array.from({ length: 8 }, (_, i) => {
          const x = 6 + i * 9;
          return <line key={i} x1={x} y1={h - 10} x2={x + 16} y2={h - 40} />;
        })}
      </g>

      {/* corner dots, bottom-right */}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={w - 14 - i * 9} cy={h - 14} r={2} fill={cyan} fillOpacity={0.7} />
      ))}
    </svg>
  );
}

interface CardAnim {
  card: Card;
  /** Center point (viewport px) of the hand slot the card was played from. */
  origin: { x: number; y: number };
  /** "await-target" is a "team-retreat" card holding, enlarged, at
   * screen-center while the player picks which opposing team it hits. */
  phase: "start" | "grow" | "await-target" | "shrink";
  /** Viewport point (the current player's token, projected to screen
   * space) the card shrinks into during the shrink phase. */
  shrinkTarget: { x: number; y: number } | null;
}

/** Ghost of the played card, animated via a FLIP-style transform: it starts
 * pinned exactly over its hand slot, then transitions to an enlarged,
 * screen-centered pose, then shrinks/moves/fades into the player's token
 * position as if being consumed. */
function CardPlayOverlay({ anim }: { anim: CardAnim }) {
  const { card, origin, phase, shrinkTarget } = anim;
  const centerX = typeof window !== "undefined" ? window.innerWidth / 2 : origin.x;
  const centerY = typeof window !== "undefined" ? window.innerHeight / 2 : origin.y;

  let transform = "translate(-50%, -50%) scale(1)";
  let opacity = 1;
  if (phase === "grow" || phase === "await-target") {
    const dx = centerX - origin.x;
    const dy = centerY - origin.y;
    transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(2.6)`;
  } else if (phase === "shrink") {
    const target = shrinkTarget ?? { x: centerX, y: centerY + CONSUME_DROP_PX };
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${CONSUME_SCALE})`;
    opacity = 0;
  }

  return (
    <div
      style={{
        position: "fixed",
        left: origin.x,
        top: origin.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform,
        opacity,
        transition: `transform ${phase === "shrink" ? SHRINK_MS : GROW_MS}ms ease-in-out, opacity ${SHRINK_MS}ms ease-in`,
        pointerEvents: "none",
        zIndex: 50,
        boxShadow: `0 0 24px ${cardColor(card, false)}`,
      }}
    >
      <CardFace card={card} color={cardColor(card, false)} />
    </div>
  );
}

/** Circle picker shown once a "team-retreat" card is holding at
 * screen-center: one circle per team other than the mover's own, arranged
 * in a row below the card. Clicking one is what finally consumes the card. */
function TeamTargetOverlay({
  teams,
  onSelect,
}: {
  teams: { id: TeamId; name: string; color: number }[];
  onSelect: (teamId: TeamId) => void;
}) {
  const centerX = typeof window !== "undefined" ? window.innerWidth / 2 : 0;
  const centerY = typeof window !== "undefined" ? window.innerHeight / 2 : 0;
  const spacing = 90;
  const startX = centerX - ((teams.length - 1) * spacing) / 2;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 55, pointerEvents: "none" }}>
      <div
        style={{
          position: "fixed",
          left: centerX,
          top: centerY - 150,
          transform: "translate(-50%, -50%)",
          color: "white",
          fontFamily: "sans-serif",
          fontWeight: 700,
          fontSize: 16,
          textShadow: "0 0 8px rgba(0,0,0,0.8)",
        }}
      >
        Choose a team to move back
      </div>
      {teams.map((team, i) => (
        <button
          key={team.id}
          onClick={() => onSelect(team.id)}
          style={{
            position: "fixed",
            left: startX + i * spacing,
            top: centerY + 150,
            transform: "translate(-50%, -50%)",
            width: 64,
            height: 64,
            borderRadius: "50%",
            border: "2px solid white",
            background: `#${team.color.toString(16).padStart(6, "0")}`,
            cursor: "pointer",
            pointerEvents: "auto",
            boxShadow: "0 0 16px rgba(255,255,255,0.5)",
          }}
          title={team.name}
        />
      ))}
    </div>
  );
}

/** Small segmented countdown bar shown on the deck while a card offer is
 * pending, filling in one block at a time as `OFFER_TIMEOUT_SECONDS` drains.
 * Mirrors the magnitude bar on `CardFace` so the two read as the same UI
 * language. */
function OfferTimerBlocks({ progress }: { progress: number }) {
  const segments = 6;
  // `floor` (not `round`) so a block only goes dark once its slice of time
  // has fully elapsed — `round` was blanking the last block up to ~2/3 of a
  // second before the real `OFFER_TIMEOUT_SECONDS` deadline hit zero.
  const filled = Math.min(segments, Math.floor(progress * segments + 1e-6));
  const blockSize = 12;
  const gap = 4;
  const width = segments * blockSize + (segments - 1) * gap;
  const color = "#22e3ff";
  return (
    <svg
      width={width}
      height={blockSize}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, 70px)",
        pointerEvents: "none",
      }}
    >
      {Array.from({ length: segments }, (_, i) => (
        <rect
          key={i}
          x={i * (blockSize + gap)}
          y={0}
          width={blockSize}
          height={blockSize}
          rx={2}
          fill={i < filled ? color : "none"}
          fillOpacity={i < filled ? 0.85 : 1}
          stroke={color}
          strokeOpacity={i < filled ? 1 : 0.35}
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}

/** The card offer's 5 face-up options, fanned out above the deck. Clicking
 * a card toggles its selection (`selectedIds`) rather than immediately
 * committing it — a chosen card stays put and glows so the player can see
 * what they've picked (and change their mind) until the offer resolves.
 * Once `resolving` is set (selection complete, or the timer ran out), the
 * whole fan plays the deal-in animation in reverse, folding back onto the
 * deck before the caller commits the picks and unmounts this component. */
function CardOfferFan({
  offer,
  offeringPlayerName,
  anchor,
  selectedIds,
  resolving,
  locked,
  onToggle,
}: {
  offer: CardOffer;
  offeringPlayerName: string;
  anchor: { x: number; y: number };
  selectedIds: string[];
  resolving: boolean;
  locked: boolean;
  onToggle: (card: Card) => void;
}) {
  const mid = (offer.offered.length - 1) / 2;
  const cardWidth = CARD_WIDTH;
  const cardHeight = CARD_HEIGHT;
  const picksLeft = offer.picksRemaining - selectedIds.length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 45, pointerEvents: "none" }}>
      <div
        style={{
          position: "fixed",
          left: anchor.x + cardWidth / 2,
          top: anchor.y - cardHeight - 88,
          transform: "translate(-50%, 0)",
          zIndex: 1,
          color: "#22e3ff",
          fontFamily: "var(--font-geist-mono), monospace",
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          textShadow: "0 0 8px rgba(34,227,255,0.9), 0 0 18px rgba(34,227,255,0.5), 0 2px 4px rgba(0,0,0,0.9)",
          whiteSpace: "nowrap",
        }}
      >
        Pick {offer.picksRemaining} card{offer.picksRemaining === 1 ? "" : "s"}
      </div>
      <div
        style={{
          position: "fixed",
          left: anchor.x + OFFER_FAN_CONTAINER_OFFSET_X,
          top: anchor.y + OFFER_FAN_CONTAINER_OFFSET_Y_FACTOR * cardHeight,
          transform: `rotate(${OFFER_FAN_CONTAINER_TILT_DEG}deg)`,
        }}
      >
        {offer.offered.map((card, i) => {
          const angle = (i - mid) * 18;
          const dealDelay = Math.abs(i - mid) * OFFER_DEAL_STAGGER_MS;
          const selected = selectedIds.includes(card.id);
          const disabled = resolving || locked || (picksLeft <= 0 && !selected);
          return (
            // Two nested transforms so the deal-in "fly in from the deck"
            // translate and the fan's own rotate/scale don't compound: this
            // wrapper only ever translates (deck position <-> resting spot),
            // while the button inside handles the rotate/scale/opacity that
            // opens it into the fan (unaffected by the wrapper's translate).
            <div
              key={card.id}
              className={`offer-deal-wrap${resolving ? " offer-collapse-wrap" : ""}`}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                marginLeft: -cardWidth / 2,
                width: cardWidth,
                height: cardHeight,
                ["--deal-delay" as string]: `${dealDelay}ms`,
              }}
            >
              <button
                onClick={() => onToggle(card)}
                disabled={disabled}
                className={`offer-deal-card offer-card-button${resolving ? " offer-collapse-card" : ""}`}
                style={{
                  position: "absolute",
                  inset: 0,
                  transformOrigin: `50% calc(100% + ${OFFER_FAN_RADIUS_PX}px)`,
                  ["--deal-angle" as string]: `${angle}deg`,
                  ["--deal-delay" as string]: `${dealDelay}ms`,
                  width: cardWidth,
                  height: cardHeight,
                  borderRadius: 10,
                  border: selected ? "1px solid #fff29e" : "1px solid #22e3ff",
                  background: "linear-gradient(160deg, #11141c 0%, #060810 100%)",
                  boxShadow: selected
                    ? "0 0 22px 6px rgba(255, 240, 120, 0.85), 0 0 46px 16px rgba(255, 240, 120, 0.5), inset 0 0 12px rgba(255, 255, 255, 0.35)"
                    : "0 0 8px rgba(34, 227, 255, 0.25), inset 0 0 8px rgba(34, 227, 255, 0.15)",
                  cursor: disabled ? "default" : "pointer",
                  pointerEvents: "auto",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface Burst {
  id: number;
  x: number;
  y: number;
  color: string;
}

/** Small burst of glowing specks fired outward from a point, marking the
 * moment the played card is consumed by the player token. Pure CSS
 * animation (a shared @keyframes, per-particle direction via custom
 * properties) so it can just be dropped in and forgotten about. */
function ParticleBurst({ burst }: { burst: Burst }) {
  const particles = Array.from({ length: BURST_PARTICLE_COUNT }, (_, i) => {
    const angle = (i / BURST_PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.5;
    const distance = 30 + Math.random() * 40;
    return {
      id: i,
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      size: 4 + Math.random() * 5,
    };
  });

  return (
    <div
      style={{
        position: "fixed",
        left: burst.x,
        top: burst.y,
        width: 0,
        height: 0,
        zIndex: 60,
        pointerEvents: "none",
      }}
    >
      {particles.map((p) => (
        <span
          key={p.id}
          style={
            {
              position: "absolute",
              left: 0,
              top: 0,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: burst.color,
              boxShadow: `0 0 6px 1px ${burst.color}`,
              "--particle-dx": `${p.dx}px`,
              "--particle-dy": `${p.dy}px`,
              animation: `card-particle-burst ${BURST_MS}ms ease-out forwards`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/** Degrees nudged per tick (initial press, and each repeat) by the HUD's
 * rotate/tilt buttons. */
const ORBIT_BUTTON_ROTATE_DEG = 18;
const ORBIT_BUTTON_TILT_DEG = 10;
/** World-space distance nudged per tick by the HUD's pan-up/pan-down
 * buttons — a straight slide of the framing, not a tilt. */
const PAN_BUTTON_STEP = CELL * 1.5;
/** Delay before hold-to-repeat kicks in, and the interval between repeats
 * once it does — lets a single click register as one discrete step while a
 * held-down button keeps nudging the camera. */
const ORBIT_HOLD_REPEAT_DELAY_MS = 350;
const ORBIT_HOLD_REPEAT_INTERVAL_MS = 60;

/** Fires `onStep` immediately on press, then keeps firing it on an interval
 * for as long as the button is held — used by the rotate/tilt HUD buttons so
 * a tap nudges the camera once but holding sweeps it continuously. */
function useHoldRepeat(onStep: () => void) {
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  const stop = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };
  const start = () => {
    stop();
    onStepRef.current();
    timeoutRef.current = window.setTimeout(() => {
      intervalRef.current = window.setInterval(() => onStepRef.current(), ORBIT_HOLD_REPEAT_INTERVAL_MS);
    }, ORBIT_HOLD_REPEAT_DELAY_MS);
  };

  useEffect(() => stop, []);

  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop };
}

/** One round button in the `CameraControls` pill — same glowing HUD style
 * used throughout (card frames, deck timer), sized to fit an SVG icon. */
function OrbitButton({
  title,
  active,
  children,
  ...handlers
}: {
  title: string;
  active?: boolean;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const color = "#22e3ff";
  return (
    <button
      title={title}
      {...handlers}
      style={{
        position: "relative",
        zIndex: 1,
        width: 36,
        height: 36,
        borderRadius: "50%",
        border: `1px solid ${color}`,
        background: active ? color : "rgba(34, 227, 255, 0.12)",
        color: active ? "#04121a" : color,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: active ? `0 0 12px ${color}` : "none",
        transition: "background 0.15s ease, box-shadow 0.15s ease",
      }}
    >
      {children}
    </button>
  );
}

/** Clip-path for the chamfered-corner HUD frame used on the card faces
 * (`CardFace`) — corners cut at top-left and bottom-right by `inset` px.
 * Percentage/px mix means it adapts to the element's actual rendered size,
 * unlike an SVG viewBox which would need fixed dimensions to avoid
 * distorting the diagonal cut. */
function chamferClip(inset: number): string {
  return `polygon(${inset}px 0, 100% 0, 100% calc(100% - ${inset}px), calc(100% - ${inset}px) 100%, 0 100%, 0 ${inset}px)`;
}

/** Small circuit-line + dot corner accents — the same HUD corner-bracket
 * language used on the card frames (`CardFace`/`CardBack`), reused here on
 * the `CameraControls` pill and `TeamStatsPanel` so all three share the same
 * visual language. */
function HudCorners({ color }: { color: string }) {
  const corners: { top?: number; bottom?: number; left?: number; right?: number; flipX: boolean; flipY: boolean }[] = [
    { top: 4, left: 4, flipX: false, flipY: false },
    { top: 4, right: 4, flipX: true, flipY: false },
    { bottom: 4, left: 4, flipX: false, flipY: true },
    { bottom: 4, right: 4, flipX: true, flipY: true },
  ];
  return (
    <>
      {corners.map((c, i) => (
        <svg
          key={i}
          width={18}
          height={18}
          viewBox="0 0 18 18"
          style={{
            position: "absolute",
            top: c.top,
            bottom: c.bottom,
            left: c.left,
            right: c.right,
            transform: `scale(${c.flipX ? -1 : 1}, ${c.flipY ? -1 : 1})`,
            pointerEvents: "none",
          }}
        >
          <path d="M2 10 V4 h8" fill="none" stroke={color} strokeOpacity={0.55} strokeWidth={1.5} />
          <circle cx={14} cy={4} r={1.6} fill={color} fillOpacity={0.7} />
        </svg>
      ))}
    </>
  );
}

/** HUD control, docked to the left edge of the board: a vertical pill of
 * five buttons — tilt up, rotate left, orbit toggle, rotate right, tilt down
 * — for flying the free-orbit camera (mouse drag/scroll still works too) and
 * hopping back to the scripted follow-cam. The center button toggles orbit
 * mode on/off exactly like the "o" key shortcut in Scene; rotate/tilt also
 * engage it on first press if it isn't already active. Either path keeps
 * `orbitMode` in sync via Scene's `onOrbitModeChange` callback. */
function CameraControls({
  orbitMode,
  onOrbitBy,
  onPanBy,
  onToggleOrbit,
}: {
  orbitMode: boolean;
  onOrbitBy: (azimuthDeg: number, polarDeg: number) => void;
  onPanBy: (deltaY: number) => void;
  onToggleOrbit: () => void;
}) {
  const color = "#22e3ff";
  const cut = 16;
  const borderWidth = 1.5;
  const panUp = useHoldRepeat(() => onPanBy(PAN_BUTTON_STEP));
  const panDown = useHoldRepeat(() => onPanBy(-PAN_BUTTON_STEP));
  const tiltUp = useHoldRepeat(() => onOrbitBy(0, -ORBIT_BUTTON_TILT_DEG));
  const tiltDown = useHoldRepeat(() => onOrbitBy(0, ORBIT_BUTTON_TILT_DEG));
  const rotateLeft = useHoldRepeat(() => onOrbitBy(-ORBIT_BUTTON_ROTATE_DEG, 0));
  const rotateRight = useHoldRepeat(() => onOrbitBy(ORBIT_BUTTON_ROTATE_DEG, 0));

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: 40,
        transform: "translateY(-50%)",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "16px 8px 14px",
        boxShadow: "0 0 10px rgba(34, 227, 255, 0.35), inset 0 0 8px rgba(34, 227, 255, 0.15)",
      }}
    >
      {/* chamfered-corner HUD frame — same clipped-corner language as the card frames */}
      <div style={{ position: "absolute", inset: 0, clipPath: chamferClip(cut), background: color, zIndex: 0 }} />
      <div
        style={{
          position: "absolute",
          inset: borderWidth,
          clipPath: chamferClip(cut - borderWidth),
          background: "rgba(6, 12, 24, 0.9)",
          zIndex: 0,
        }}
      />
      <HudCorners color={color} />
      <OrbitButton title="Pan view up" {...panUp}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <path d="M5 12 L12 5 L19 12" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 19 L12 12 L19 19" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </OrbitButton>
      <OrbitButton title="Tilt camera up" {...tiltUp}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <path d="M5 15 L12 8 L19 15" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </OrbitButton>
      <OrbitButton title="Rotate camera left" {...rotateLeft}>
        {/* Feather "rotate-ccw" — a well-tested arrow shape, kept clear of
            the button's own round edge so it doesn't blend into it. */}
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <polyline points="1 4 1 10 7 10" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
          <path
            d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </OrbitButton>
      <OrbitButton
        title={orbitMode ? "Return to follow camera" : "Switch to free orbit camera"}
        active={orbitMode}
        onClick={onToggleOrbit}
      >
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <ellipse cx={12} cy={12} rx={9} ry={4.5} stroke="currentColor" strokeWidth={1.8} />
          <circle cx={12} cy={12} r={2.2} fill="currentColor" />
          <path
            d="M18.8 9.2 A9 4.5 0 0 1 12 16.5"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            fill="none"
          />
          <path d="M15.6 15.6 L18.8 16.6 L18.2 13.3 Z" fill="currentColor" />
        </svg>
      </OrbitButton>
      <OrbitButton title="Rotate camera right" {...rotateRight}>
        {/* Feather "rotate-cw", mirrored from "rotate-ccw" above. */}
        <svg width={18} height={18} viewBox="0 0 24 24" fill="none">
          <polyline points="23 4 23 10 17 10" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
          <path
            d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </OrbitButton>
      <OrbitButton title="Tilt camera down" {...tiltDown}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <path d="M5 9 L12 16 L19 9" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </OrbitButton>
      <OrbitButton title="Pan view down" {...panDown}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <path d="M5 5 L12 12 L19 5" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 12 L12 19 L19 12" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </OrbitButton>
    </div>
  );
}

/** Top-right toggle for the browser's fullscreen mode — the same chamfered-
 * corner HUD card frame as `CameraControls`/`TeamStatsPanel`/`TurnIndicator`,
 * sized down to a single round glowing `OrbitButton`. Swaps between an
 * outward "expand to corners" icon and an inward "collapse from corners"
 * one to reflect the current state. */
function FullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const color = "#22e3ff";
  const cut = 16;
  const borderWidth = 1.5;

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  return (
    <div
      style={{
        position: "absolute",
        // Matches the deck's own inset from the bottom-right corner: the
        // hand bar's 24px edge padding plus its -24px/-16px anchor
        // translate (see the deck's wrapper below), mirrored to the top-right.
        top: 30,
        right: 40,
        zIndex: 20,
        padding: "10px 8px",
        boxShadow: "0 0 10px rgba(34, 227, 255, 0.35), inset 0 0 8px rgba(34, 227, 255, 0.15)",
      }}
    >
      {/* chamfered-corner HUD frame — same clipped-corner language as the card frames */}
      <div style={{ position: "absolute", inset: 0, clipPath: chamferClip(cut), background: color, zIndex: 0 }} />
      <div
        style={{
          position: "absolute",
          inset: borderWidth,
          clipPath: chamferClip(cut - borderWidth),
          background: "rgba(6, 12, 24, 0.9)",
          zIndex: 0,
        }}
      />
      <HudCorners color={color} />
      <OrbitButton title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={toggle}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          {isFullscreen ? (
            <>
              <path d="M9 3 L9 9 L3 9" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M15 3 L15 9 L21 9" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M9 21 L9 15 L3 15" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M15 21 L15 15 L21 15" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </>
          ) : (
            <>
              <path d="M3 9 L3 3 L9 3" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M15 3 L21 3 L21 9" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M21 15 L21 21 L15 21" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M9 21 L3 21 L3 15" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </>
          )}
        </svg>
      </OrbitButton>
    </div>
  );
}

/** Dev-only HUD button that sends `dev_setup_column_trap_test`, teleporting
 * the current player to the top row and slotting a "column-trap" card into
 * their (and the next player's) hand — a one-click way to set up and replay
 * the trapdoor-fall animation without grinding through the deck for the
 * right roll. Only rendered outside a production build; see the matching
 * server-side `dev` guard in server.ts. */
function DevColumnTrapTestButton({ onClick }: { onClick: () => void }) {
  const color = "#ff2d95";
  return (
    <button
      title="Dev: move current player to top row and deal a column-trap card"
      onClick={onClick}
      style={{
        position: "absolute",
        top: 30,
        right: 96,
        zIndex: 20,
        padding: "8px 12px",
        borderRadius: 6,
        border: `1px solid ${color}`,
        background: "rgba(255, 45, 149, 0.12)",
        color,
        fontSize: 11,
        fontFamily: "monospace",
        letterSpacing: "0.05em",
        cursor: "pointer",
      }}
    >
      TEST COLUMN TRAP
    </button>
  );
}

/** HUD panel occupying the hand bar's left slot (where a lone player-info
 * readout used to sit), listing one row per team with that team's progress
 * toward the actual win condition — how many of its players have reached
 * the last tile, e.g. "2 / 4" — instead of every player, so the panel stays
 * a fixed height regardless of team size. The team whose turn it currently
 * is gets a filled highlight — mirrors the glowing-frame language used
 * elsewhere in the HUD. */
function TeamStatsPanel({
  teams,
  players,
  tiles,
  currentPlayerId,
}: {
  teams: { id: TeamId; name: string; color: number }[];
  players: { id: PlayerId; name: string; teamId: TeamId; color: number; currentTileId: TileId }[];
  tiles: Tile[];
  currentPlayerId: PlayerId;
}) {
  const color = "#22e3ff";
  const cut = 16;
  const borderWidth = 1.5;

  return (
    <div
      style={{
        flexShrink: 0,
        alignSelf: "flex-end",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 16px 14px",
        fontFamily: "sans-serif",
        width: 200,
        boxShadow: "0 0 14px rgba(34, 227, 255, 0.2), inset 0 0 10px rgba(34, 227, 255, 0.08)",
      }}
    >
      {/* chamfered-corner HUD frame — same clipped-corner language as the card frames */}
      <div style={{ position: "absolute", inset: 0, clipPath: chamferClip(cut), background: color, zIndex: 0 }} />
      <div
        style={{
          position: "absolute",
          inset: borderWidth,
          clipPath: chamferClip(cut - borderWidth),
          background: "#0a0c14",
          zIndex: 0,
        }}
      />
      <HudCorners color={color} />
      {teams.map((team) => {
        const teamHex = `#${team.color.toString(16).padStart(6, "0")}`;
        const roster = players.filter((p) => p.teamId === team.id);
        const active = roster.some((p) => p.id === currentPlayerId);
        const finishedCount = roster.filter((p) => {
          const tile = findTile(tiles, p.currentTileId);
          const layerMaxPosition = tiles.filter((t) => t.layerId === tile.layerId).length;
          return tile.position === layerMaxPosition;
        }).length;
        return (
          <div
            key={team.id}
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              borderRadius: 6,
              background: active ? `color-mix(in srgb, ${teamHex} 18%, transparent)` : "transparent",
              border: `1px solid ${active ? teamHex : "transparent"}`,
              boxShadow: active ? `0 0 8px color-mix(in srgb, ${teamHex} 50%, transparent)` : "none",
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                flexShrink: 0,
                background: teamHex,
                boxShadow: `0 0 6px ${teamHex}`,
              }}
            />
            <span
              style={{
                color: teamHex,
                fontWeight: 800,
                fontSize: 12,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                textShadow: `0 0 8px ${teamHex}`,
              }}
            >
              {team.name}
            </span>
            <span style={{ marginLeft: "auto", color: "white", fontSize: 14, fontWeight: 700 }}>
              {finishedCount} / {roster.length}
            </span>
            {active && <span style={{ color: teamHex, fontSize: 13, lineHeight: 1 }}>›</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Top-left HUD readout for whose turn it is and what was last played —
 * same chamfered-frame + corner-bracket language as `TeamStatsPanel`, tinted
 * to the active player's color instead of the fixed cyan accent. Collapses
 * to a plain win banner once the game is finished. */
function TurnIndicator({
  state,
  player,
}: {
  state: GameState;
  player: { name: string; color: number; teamId: TeamId };
}) {
  const cut = 16;
  const borderWidth = 1.5;
  const finished = state.status === "finished";
  const playerHex = `#${player.color.toString(16).padStart(6, "0")}`;
  const color = finished ? "#22e3ff" : playerHex;

  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        zIndex: 10,
        padding: "12px 18px 14px",
        fontFamily: "sans-serif",
        minWidth: 200,
        boxShadow: `0 0 14px color-mix(in srgb, ${color} 35%, transparent), inset 0 0 10px color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {/* chamfered-corner HUD frame — same clipped-corner language as the card frames */}
      <div style={{ position: "absolute", inset: 0, clipPath: chamferClip(cut), background: color, zIndex: 0 }} />
      <div
        style={{
          position: "absolute",
          inset: borderWidth,
          clipPath: chamferClip(cut - borderWidth),
          background: "#0a0c14",
          zIndex: 0,
        }}
      />
      <HudCorners color={color} />
      <div style={{ position: "relative", zIndex: 1 }}>
        {finished ? (
            <div
              style={{
                color: "#22e3ff",
                fontWeight: 800,
                fontSize: 15,
                letterSpacing: "0.05em",
                textShadow: "0 0 8px rgba(34,227,255,0.9), 0 0 18px rgba(34,227,255,0.5)",
              }}
            >
              🎉 {state.players.find((p) => p.id === state.winnerId)?.name} wins!
            </div>
          ) : (
            <>
              <div
                style={{
                  color,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  opacity: 0.75,
                  marginBottom: 2,
                }}
              >
                Turn
              </div>
              <div
                style={{
                  color: "white",
                  fontSize: 15,
                  fontWeight: 800,
                  letterSpacing: "0.02em",
                }}
              >
                <span style={{ color, textShadow: `0 0 8px ${color}` }}>
                  {player.name}
                </span>{" "}
                <span style={{ opacity: 0.55, fontWeight: 600, fontSize: 13 }}>
                  ({state.teams.find((t) => t.id === player.teamId)?.name})
                </span>
              </div>
              {state.lastPlayedCard !== null && (
                <div style={{ marginTop: 6, color: "rgba(255,255,255,0.65)", fontSize: 12, letterSpacing: "0.02em" }}>
                  Last card: <span style={{ color: "white", fontWeight: 700 }}>{cardLabel(state.lastPlayedCard)}</span>
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}

/** Glowing HUD baseline drawn behind the hand of cards — a shallow upward
 * bow (matching the fan's own arch, tallest under the center card) with a
 * small bracket tick at each end, in the same cyan glow language as the
 * card frames. Purely decorative: sits one paint-order step behind the
 * card buttons (both absolutely positioned, so plain DOM order is enough
 * to keep it behind without needing z-index). */
function HandBaseline() {
  const color = "#22e3ff";
  return (
    <svg
      viewBox={`0 0 1000 ${CARD_HEIGHT}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 18,
        width: "100%",
        height: CARD_HEIGHT,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      <path
        d={`M 20 ${CARD_HEIGHT - 12} L 100 ${CARD_HEIGHT - 12} L 180 ${CARD_HEIGHT * 0.45} L 820 ${CARD_HEIGHT * 0.45} L 900 ${CARD_HEIGHT - 12} L 980 ${CARD_HEIGHT - 12}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.8}
        strokeLinejoin="round"
        style={{ filter: `drop-shadow(0 0 6px ${color})` }}
      />
      <path d={`M 20 ${CARD_HEIGHT - 26} L 20 ${CARD_HEIGHT + 2}`} stroke={color} strokeWidth={2} strokeOpacity={0.8} />
      <path d={`M 980 ${CARD_HEIGHT - 26} L 980 ${CARD_HEIGHT + 2}`} stroke={color} strokeWidth={2} strokeOpacity={0.8} />
    </svg>
  );
}

/** Basic draw-pile stand-in: a few offset card backs to read as a physical
 * deck, with the remaining count. */
function DeckPile({
  timer,
  stackRef,
}: {
  timer?: ReactNode;
  stackRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: 180,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 12,
        color: "white",
        fontFamily: "sans-serif",
      }}
    >
      <div ref={stackRef} style={{ flexShrink: 0, position: "relative", width: CARD_WIDTH, height: CARD_HEIGHT }}>
        {Array.from({ length: DECK_STACK_SIZE }, (_, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: i * 2,
              top: -i * 2,
              width: CARD_WIDTH,
              height: CARD_HEIGHT,
              boxShadow: "0 0 8px rgba(34, 227, 255, 0.25)",
            }}
          >
            <CardBack />
            {i === DECK_STACK_SIZE - 1 && timer}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Who played the card that's arriving in the next `card_played` broadcast,
 * set right before this client sends `play_card`/`select_retreat_target` so
 * the handler for that broadcast knows to run the local hand-card-fly
 * animation (see `consumeCard`) instead of the plain remote board-move
 * animation every other client plays. */
interface AwaitingPlay {
  mover: PlayerId;
}

export default function GameUI({
  initialState,
  controlledPlayerIds,
}: {
  initialState: GameState;
  /** All player ids this client drives — just one outside QA mode, several
   * when one person is playing multiple seats themselves. */
  controlledPlayerIds: PlayerId[];
}) {
  const { send, subscribe } = useWs();
  const [state, setState] = useState<GameState>(initialState);
  const sceneHandleRef = useRef<SceneHandle | null>(null);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cardAnim, setCardAnim] = useState<CardAnim | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);
  const burstIdRef = useRef(0);
  const [offerProgress, setOfferProgress] = useState(1);
  const [selectedOfferIds, setSelectedOfferIds] = useState<string[]>([]);
  const [offerResolving, setOfferResolving] = useState(false);
  const offerResolvingRef = useRef(false);
  const [deckAnchor, setDeckAnchor] = useState<{ x: number; y: number } | null>(null);
  const [orbitMode, setOrbitMode] = useState(false);
  const awaitingPlayRef = useRef<AwaitingPlay | null>(null);
  // Every tile a just-played row/column-trap card will drop (the whole
  // row/column, not just tiles a player happens to stand on) — computed in
  // `handlePlayCard` while the card is still live in local state, and
  // consumed once the resulting move animations actually start (see
  // `consumeCard`) so every floor's door swings open together right as the
  // fall begins rather than at card-grow time (which could be a while
  // before the server round-trip resolves).
  const pendingTrapTileIdsRef = useRef<string[] | null>(null);

  useEffect(() => {
    if (!burst) return;
    const timer = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(timer);
  }, [burst]);


  // Tracks the topmost deck card's own top-left corner on screen, so the
  // offer fan's deal-in/collapse animation can land exactly on it (see
  // `OFFER_DEAL_ORIGIN`) instead of an approximate point near the deck.
  useEffect(() => {
    const updateAnchor = () => {
      const rect = deckRef.current?.getBoundingClientRect();
      if (rect) {
        const topCardOffset = (DECK_STACK_SIZE - 1) * 2;
        setDeckAnchor({ x: rect.left + topCardOffset, y: rect.top - topCardOffset });
      }
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    return () => window.removeEventListener("resize", updateAnchor);
  }, [state?.status]);

  // Clears selection/resolving state once there's no active offer, covering
  // both "no offer yet" and "an offer just finished resolving".
  useEffect(() => {
    if (!state?.cardOffer) {
      setSelectedOfferIds([]);
      setOfferResolving(false);
      offerResolvingRef.current = false;
    }
  }, [state?.cardOffer]);

  // Folds the offer fan back onto the deck (the deal-in animation played in
  // reverse, see `.offer-collapse-card`) and, once that finishes, sends each
  // pick to the server (the actual authoritative source of the resulting
  // hand/draw pile — see `choose_offer_card` in server.ts). `offerResolvingRef`
  // guards against the manual-pick effect and the timeout tick both firing.
  const beginOfferResolution = (offerSize: number, pickedIds: CardId[]) => {
    if (offerResolvingRef.current) return;
    offerResolvingRef.current = true;
    setOfferResolving(true);
    const collapseDuration = offerCollapseDuration(offerSize);
    setTimeout(() => {
      if (deckAnchor) {
        burstIdRef.current += 1;
        setBurst({
          id: burstIdRef.current,
          x: deckAnchor.x + CARD_WIDTH / 2,
          y: deckAnchor.y + CARD_HEIGHT / 2,
          color: "#fff29e",
        });
      }
    }, Math.max(0, collapseDuration - OFFER_COLLAPSE_BURST_LEAD_MS));
    setTimeout(() => {
      for (const id of pickedIds) send({ action: "choose_offer_card", cardId: id });
    }, collapseDuration);
  };

  // Drives the deck's countdown ring while a card offer is pending — purely
  // cosmetic on this client; the server owns the actual timeout and
  // broadcasts whatever it resolves to via `offer_updated`. Only the
  // offering player's own client runs this (everyone else just watches
  // `state.cardOffer` disappear once the server resolves it). Reads the
  // deadline straight off `state.cardOffer` (a server timestamp) rather than
  // approximating one locally from whenever this effect happens to run —
  // that guess drifted out of sync with the real timeout by however long
  // this client took to notice the offer, so the deck could vanish while the
  // countdown blocks still showed time left.
  useEffect(() => {
    if (!state.cardOffer || !controlledPlayerIds.includes(state.cardOffer.playerId)) return;
    const deadline = state.cardOffer.deadline;
    let raf: number;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      setOfferProgress(remaining / (OFFER_TIMEOUT_SECONDS * 1000));
      if (remaining <= 0) {
        setOfferProgress(0);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state.cardOffer, controlledPlayerIds]);

  // Toggles a card's selection (glow) without committing it to the hand.
  // Once enough cards are selected to fill the offer's picks, a separate
  // effect below kicks off the fold-back/commit sequence.
  const handleToggleOfferCard = (card: Card) => {
    if (!state.cardOffer || !controlledPlayerIds.includes(state.cardOffer.playerId) || offerResolvingRef.current) return;
    const picksRequired = state.cardOffer.picksRemaining;
    setSelectedOfferIds((prev) => {
      if (prev.includes(card.id)) return prev.filter((id) => id !== card.id);
      if (prev.length >= picksRequired) return prev;
      return [...prev, card.id];
    });
    // Let the server know the player is still actively picking, so it pushes
    // the offer's timeout back out instead of resolving it out from under
    // an in-progress selection. It broadcasts the renewed `deadline` back,
    // which is what the countdown effect above actually reads.
    send({ action: "offer_activity" });
  };

  // Fires once the player has manually selected enough cards to fill the
  // offer.
  useEffect(() => {
    if (!state.cardOffer || !controlledPlayerIds.includes(state.cardOffer.playerId) || offerResolvingRef.current) return;
    if (selectedOfferIds.length >= state.cardOffer.picksRemaining) {
      beginOfferResolution(state.cardOffer.offered.length, selectedOfferIds);
    }
  }, [selectedOfferIds, state.cardOffer, controlledPlayerIds]);

  const activePlayer = currentPlayer(state);
  const isMyTurn = controlledPlayerIds.includes(activePlayer.id);
  const myPlayer = isMyTurn
    ? activePlayer
    : (state.players.find((p) => controlledPlayerIds.includes(p.id)) ?? activePlayer);

  // Shared tail of playing any card: shrinks/fades the held card into the
  // mover's token, fires the consume burst, runs every affected player's
  // board animation, then commits the server's authoritative state. `mover`
  // is who played the card (whose token the card visually flies into and
  // whose hand it's removed from) even when the card's effect lands on
  // other players (e.g. a "team-retreat" target).
  const consumeCard = async (
    card: Card,
    mover: PlayerId,
    moveAnimTargets: { playerId: PlayerId; path: MoveStep[] }[],
    commit: (s: GameState) => GameState,
  ) => {
    // Read the mover's screen position right as the shrink kicks off, so
    // the card heads toward wherever they currently sit on the board
    // rather than a fixed point.
    const shrinkTarget = sceneHandleRef.current?.getPlayerScreenPosition(mover) ?? null;
    setCardAnim((a) => (a ? { ...a, phase: "shrink", shrinkTarget } : a));

    // Fire the burst exactly when the shrink lands, independent of how long
    // the token's own board animation ends up taking.
    const burstPos = shrinkTarget ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2 + CONSUME_DROP_PX,
    };
    setTimeout(() => {
      burstIdRef.current += 1;
      setBurst({ id: burstIdRef.current, x: burstPos.x, y: burstPos.y, color: cardColor(card, false) });
    }, SHRINK_MS);

    // A row/column-trap card's doors were only built (shut) back in
    // `handlePlayCard`; open the whole row/column together now, exactly as
    // the fall it's for actually starts.
    if (pendingTrapTileIdsRef.current) {
      sceneHandleRef.current?.openTrapdoors(pendingTrapTileIdsRef.current);
      pendingTrapTileIdsRef.current = null;
    }

    const moveAnimations = moveAnimTargets.map((t) => sceneHandleRef.current?.animateMove(t.playerId, t.path));
    await Promise.all([...moveAnimations, sleep(SHRINK_MS)]);

    setState((s) => commit(s));
    setCardAnim(null);
    setPlaying(false);
  };

  // Applies a `card_played` broadcast on a client that didn't initiate it:
  // just runs every affected player's board-move animation (no hand-card
  // fly-in — this client has no button/origin for a card it didn't play),
  // then commits the server's authoritative state.
  const applyRemoteCardPlay = async (moves: { playerId: PlayerId; path: MoveStep[] }[], nextState: GameState) => {
    await Promise.all(moves.map((m) => sceneHandleRef.current?.animateMove(m.playerId, m.path)));
    setState(nextState);
  };

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.event === "card_played") {
          const awaiting = awaitingPlayRef.current;
          if (awaiting) {
            awaitingPlayRef.current = null;
            void consumeCard(msg.card, awaiting.mover, msg.moves, () => msg.state);
          } else {
            void applyRemoteCardPlay(msg.moves, msg.state);
          }
        } else if (msg.event === "offer_updated") {
          setState(msg.state);
        } else if (msg.event === "dev_state_set") {
          setState(msg.state);
        } else if (msg.event === "error") {
          console.error("[game] server error:", msg.message);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribe],
  );

  const handlePlayCard = async (card: Card, buttonEl: HTMLButtonElement) => {
    if (playing || state.status !== "idle" || state.cardOffer || !isMyTurn) return;
    setPlaying(true);

    const rect = buttonEl.getBoundingClientRect();
    const origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    setCardAnim({ card, origin, phase: "start", shrinkTarget: null });
    // Let the "start" pose (pinned over the hand slot) paint for a frame
    // before transitioning, or the browser may coalesce it with "grow" and
    // skip the animation entirely.
    requestAnimationFrame(() => setCardAnim((a) => (a ? { ...a, phase: "grow" } : a)));

    if (card.type === "team-retreat") {
      // Two-step card: hold enlarged at center and wait for the mover to
      // pick a target team via the TeamTargetOverlay before it's consumed
      // — see handleSelectRetreatTarget. Tell the server the card was
      // played now so it records pendingRetreat; select_retreat_target
      // depends on that state existing.
      await sleep(GROW_MS);
      setCardAnim((a) => (a ? { ...a, phase: "await-target" } : a));
      send({ action: "play_card", cardId: card.id });
      return;
    }

    if (card.type === "row-trap" || card.type === "column-trap") {
      // Build every trapdoor the whole row/column will need — not just the
      // tiles anyone's actually standing on — so the fall reads as the
      // entire row/column giving way. Purely visual and safe to compute
      // locally — it's a deterministic function of the already-synced
      // state, no card-draw randomness involved (that part stays
      // server-authoritative). Built now (doors stay shut) but not opened
      // until the fall animation actually starts, in `consumeCard`.
      const tileIds = trapCardTileIds(state, activePlayer.id, card.type === "row-trap" ? "row" : "column");
      sceneHandleRef.current?.prepareTrapdoorDrop(tileIds);
      pendingTrapTileIdsRef.current = tileIds;
    }

    await sleep(GROW_MS + HOLD_MS);
    awaitingPlayRef.current = { mover: activePlayer.id };
    send({ action: "play_card", cardId: card.id });
  };

  const handleSelectRetreatTarget = (teamId: TeamId) => {
    if (!cardAnim || cardAnim.phase !== "await-target") return;
    awaitingPlayRef.current = { mover: activePlayer.id };
    send({ action: "select_retreat_target", teamId });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100vh",
        overflow: "hidden",
        background: "#020309",
      }}
    >
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <Scene state={state} handleRef={sceneHandleRef} onOrbitModeChange={setOrbitMode} />
        {state.cardOffer && deckAnchor && (
          // Draws the eye toward the offer fan (anchored bottom-right, by the
          // deck) by dimming everything else — darkest at the opposite,
          // top-left corner and clear right where the cards themselves sit,
          // rather than an even scrim that doesn't hint where to look.
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 5,
              pointerEvents: "none",
              background:
                "linear-gradient(to top left, rgba(2,4,10,0) 0%, rgba(2,4,10,0.35) 40%, rgba(2,4,10,0.75) 100%)",
            }}
          />
        )}
        <CameraControls
          orbitMode={orbitMode}
          onOrbitBy={(azimuthDeg, polarDeg) => sceneHandleRef.current?.orbitBy(azimuthDeg, polarDeg)}
          onPanBy={(deltaY) => sceneHandleRef.current?.panBy(deltaY)}
          onToggleOrbit={() => sceneHandleRef.current?.setOrbitMode(!orbitMode)}
        />
        <FullscreenButton />
        {process.env.NODE_ENV !== "production" && (
          <DevColumnTrapTestButton onClick={() => send({ action: "dev_setup_column_trap_test" })} />
        )}
        {state.status === "finished" && <TurnIndicator state={state} player={activePlayer} />}
      {state.status !== "finished" && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            height: 280,
            padding: "0 24px 24px",
            background:
              "linear-gradient(to top, rgba(6, 12, 24, 0.92) 0%, rgba(6, 12, 24, 0.75) 30%, rgba(6, 12, 24, 0) 70%)",
          }}
        >
          <div style={{ alignSelf: "flex-end", position: "relative", transform: "translate(16px, -16px)" }}>
            <TeamStatsPanel teams={state.teams} players={state.players} tiles={state.tiles} currentPlayerId={activePlayer.id} />
          </div>
          <div
            style={{
              flex: 1,
              height: "100%",
              perspective: HAND_PERSPECTIVE_PX,
              perspectiveOrigin: "50% 0%",
            }}
          >
            <div
              style={{
                position: "relative",
                width: "100%",
                height: "100%",
                transform: `rotateX(${CARD_TILT_X_DEG}deg)`,
                transformOrigin: "bottom center",
              }}
            >
              <HandBaseline />
              {myPlayer.hand.map((card, i) => {
                const isAnimating = cardAnim?.card.id === card.id;
                const locked = playing || !!state.cardOffer || !isMyTurn;
                const color = cardColor(card, locked);
                const mid = (myPlayer.hand.length - 1) / 2;
                const offset = i - mid;
                return (
                  <button
                    key={card.id}
                    className="game-card"
                    onClick={(e) => handlePlayCard(card, e.currentTarget)}
                    disabled={locked}
                    style={{
                      ["--glow" as string]: color,
                      ["--rotate-z" as string]: `${offset * CARD_FAN_STEP_DEG}deg`,
                      position: "absolute",
                      left: "50%",
                      bottom: 0,
                      marginLeft: -CARD_WIDTH / 2,
                      transformOrigin: `50% calc(100% + ${CARD_FAN_RADIUS_PX}px)`,
                      width: CARD_WIDTH,
                      height: CARD_HEIGHT,
                      padding: 0,
                      border: "none",
                      background: "transparent",
                      cursor: locked ? "default" : "pointer",
                      // Hide the source card while its ghost is flying, so it
                      // doesn't double up with the overlay.
                      visibility: isAnimating ? "hidden" : "visible",
                    }}
                  >
                    <CardFace card={card} color={color} />
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ position: "relative", transform: "translate(-24px, -16px)" }}>
            <DeckPile
              timer={state.cardOffer && <OfferTimerBlocks progress={offerProgress} />}
              stackRef={deckRef}
            />
          </div>
        </div>
      )}
      </div>
      {cardAnim && <CardPlayOverlay anim={cardAnim} />}
      {cardAnim?.phase === "await-target" && (
        <TeamTargetOverlay
          teams={state.teams.filter((t) => t.id !== activePlayer.teamId)}
          onSelect={handleSelectRetreatTarget}
        />
      )}
      {state.cardOffer && deckAnchor && (
        <CardOfferFan
          key={state.cardOffer.offered.map((c) => c.id).join(",")}
          offer={state.cardOffer}
          offeringPlayerName={state.players.find((p) => p.id === state.cardOffer!.playerId)?.name ?? "Player"}
          anchor={deckAnchor}
          selectedIds={selectedOfferIds}
          resolving={offerResolving}
          locked={playing || !controlledPlayerIds.includes(state.cardOffer.playerId)}
          onToggle={handleToggleOfferCard}
        />
      )}
      {burst && <ParticleBurst burst={burst} />}
      <style>{`
        .game-card {
          --lift: 0px;
          transform: translateY(var(--lift)) rotate(var(--rotate-z, 0deg));
          box-shadow:
            0 0 6px var(--glow),
            0 0 14px color-mix(in srgb, var(--glow) 60%, transparent),
            0 0 26px color-mix(in srgb, var(--glow) 35%, transparent),
            inset 0 0 8px rgba(255, 255, 255, 0.25);
          text-shadow: 0 0 4px rgba(255, 255, 255, 0.35);
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .game-card:disabled {
          box-shadow: none;
          text-shadow: none;
        }
        .game-card:not(:disabled):hover {
          --lift: -22px;
          box-shadow:
            0 0 10px var(--glow),
            0 0 22px color-mix(in srgb, var(--glow) 75%, transparent),
            0 0 42px color-mix(in srgb, var(--glow) 50%, transparent),
            inset 0 0 10px rgba(255, 255, 255, 0.35);
        }
        .game-card:not(:disabled):active {
          --lift: -10px;
        }
        @keyframes card-particle-burst {
          from {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
          }
          to {
            transform: translate(
              calc(-50% + var(--particle-dx)),
              calc(-50% + var(--particle-dy))
            ) scale(0.2);
            opacity: 0;
          }
        }
        .offer-card-button {
          transition: box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .offer-deal-card {
          transform: rotate(var(--deal-angle));
          animation: offer-deal-in ${OFFER_DEAL_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
          animation-delay: var(--deal-delay, 0ms);
        }
        @keyframes offer-deal-in {
          from { transform: rotate(${OFFER_DEAL_START_ROTATE_DEG}deg) scale(0.8); opacity: 0; }
          to { transform: rotate(var(--deal-angle)) scale(1); opacity: 1; }
        }
        .offer-collapse-card {
          animation: offer-collapse-out ${OFFER_DEAL_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
          animation-delay: var(--deal-delay, 0ms);
        }
        @keyframes offer-collapse-out {
          from { transform: rotate(var(--deal-angle)) scale(1); opacity: 1; }
          to { transform: rotate(${OFFER_DEAL_START_ROTATE_DEG}deg) scale(0.8); opacity: 0; }
        }
        .offer-deal-wrap {
          animation: offer-deal-move ${OFFER_DEAL_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
          animation-delay: var(--deal-delay, 0ms);
        }
        @keyframes offer-deal-move {
          from { transform: translate(${OFFER_DEAL_ORIGIN.x}px, ${OFFER_DEAL_ORIGIN.y}px); }
          to { transform: translate(0, 0); }
        }
        .offer-collapse-wrap {
          animation: offer-collapse-move ${OFFER_DEAL_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
          animation-delay: var(--deal-delay, 0ms);
        }
        @keyframes offer-collapse-move {
          from { transform: translate(0, 0); }
          to { transform: translate(${OFFER_DEAL_ORIGIN.x}px, ${OFFER_DEAL_ORIGIN.y}px); }
        }
      `}</style>
    </div>
  );
}
