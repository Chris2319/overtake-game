"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Scene, { type SceneHandle } from "./Scene";
import { NeonButton } from "@/app/ui/NeonButton";
import { findTile } from "@/lib/game/board";
import { CELL } from "@/lib/game/geometry";
import { currentPlayer, OFFER_TIMEOUT_SECONDS, trapCardTileIds, WHEEL_SEGMENTS } from "@/lib/game/engine";
import { useWs } from "@/lib/ws";
import type {
  Card,
  CardId,
  CardOffer,
  GameState,
  MoveStep,
  PlayerId,
  TeamId,
  Tile,
  TileId,
  WheelOutcomeType,
} from "@/lib/game/types";

const CARD_WIDTH = 160;
const CARD_HEIGHT = 250;
const CARD_FONT_SIZE = 38;

/** Timing for the "-1" pop shown over a hand card's big readout when a
 * damage tile weakens it: the old value scales up and fades out, the "-1"
 * badge floats up and fades independently, then the new value scales in
 * once the old one's gone. Kept as three separate CSS animations (rather
 * than swapping the text mid-animation from JS) so the crossfade timing
 * only ever needs a `animation-delay`, no state-timed text swap. */
const CARD_DAMAGE_POP_OUT_MS = 260;
const CARD_DAMAGE_POP_IN_MS = 380;
const CARD_DAMAGE_BADGE_MS = 800;
const CARD_DAMAGE_POP_TOTAL_MS = Math.max(CARD_DAMAGE_POP_OUT_MS + CARD_DAMAGE_POP_IN_MS, CARD_DAMAGE_BADGE_MS);

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
/** Freeze cards get the same icy accent as the frozen-tile/overlay visuals
 * elsewhere (Scene's FROZEN_HAZARD_COLOR, the freeze flash overlays). */
const FREEZE_CARD_COLOR = "#8fe8ff";

function cardColor(card: Card, playing: boolean): string {
  if (playing) return "#555";
  if (card.type === "team-advance") return "#e6ff2e";
  if (card.type === "team-retreat") return "#ff8c42";
  if (card.type === "row-trap" || card.type === "column-trap") return TRAP_CARD_COLOR;
  if (card.type === "freeze") return FREEZE_CARD_COLOR;
  return card.value < 0 ? "#ff2d95" : "#22e3ff";
}

function cardLabel(card: Card): string {
  if (card.type === "team-advance") return `+${card.value}`;
  if (card.type === "team-retreat") return `${card.value}`;
  if (card.type === "row-trap") return "ROW";
  if (card.type === "column-trap") return "COL";
  if (card.type === "freeze") return `+${card.value}`;
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
      <text x={14} y={30} fontSize={15} fontWeight={700} fontFamily="var(--font-retro)" fill={color}>
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
      <text x={w / 2} y={h - 40} fontSize={13} fontWeight={800} fontFamily="var(--font-retro)" fill={color} textAnchor="middle">
        {mode === "row" ? "ROW TRAP" : "COLUMN TRAP"}
      </text>
      <text x={w / 2} y={h - 22} fontSize={9} fontWeight={600} fontFamily="var(--font-retro)" fill={color} opacity={0.7} textAnchor="middle">
        Drops the whole {mode}
      </text>
      {/* corner dots, bottom-right */}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={w - 14 - i * 9} cy={h - 14} r={1.6} fill={color} fillOpacity={0.5} />
      ))}
    </svg>
  );
}

/** A six-branch snowflake, each arm carrying a couple of side ticks — the
 * freeze card's center icon, drawn the same procedural-lines way as the
 * frost crystal overlays rather than a raster/emoji glyph. */
function SnowflakeIcon({ color }: { color: string }) {
  const armLength = 46;
  const branches = [0, 60, 120, 180, 240, 300];

  return (
    <g>
      {branches.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const x2 = Math.cos(rad) * armLength;
        const y2 = Math.sin(rad) * armLength;
        const tick = (t: number, side: number) => {
          const bx = Math.cos(rad) * armLength * t;
          const by = Math.sin(rad) * armLength * t;
          const tickLen = armLength * (t < 0.7 ? 0.24 : 0.16);
          const tickRad = rad + (side * Math.PI) / 3;
          return { x1: bx, y1: by, x2: bx + Math.cos(tickRad) * tickLen, y2: by + Math.sin(tickRad) * tickLen };
        };
        const ticks = [tick(0.55, 1), tick(0.55, -1), tick(0.82, 1), tick(0.82, -1)];
        return (
          <g key={deg}>
            <line x1={0} y1={0} x2={x2} y2={y2} stroke={color} strokeWidth={3} strokeLinecap="round" />
            {ticks.map((t, i) => (
              <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={color} strokeWidth={2.2} strokeLinecap="round" />
            ))}
          </g>
        );
      })}
      <circle cx={0} cy={0} r={3} fill={color} />
    </g>
  );
}

/** The stacked double-chevron "direction of travel" glyph every move-shaped
 * card face draws (see `CardFace`) — pointing up for a forward move, down
 * for a backward one — pulled out on its own so the Fortune Wheel's wedges
 * (see `SpinWheelOverlay`) can reuse exactly the same icon language. */
function ChevronIcon({
  direction,
  color,
  scale = 1,
}: {
  direction: "forward" | "backward";
  color: string;
  /** Card faces want this at its native size (the default); the Fortune
   * Wheel's "advance"/"retreat" wedges (see `wheelSegmentIcon`) scale it up,
   * since the chevron glyph is naturally much smaller than the wheel's other
   * icons (`SnowflakeIcon`, `TrapGridIcon`, ...) and would otherwise look
   * tiny sitting next to them. */
  scale?: number;
}) {
  const points = direction === "backward" ? "-18,-8 0,8 18,-8" : "-18,8 0,-8 18,8";
  const dy = direction === "backward" ? -14 : 14;
  return (
    <g transform={scale !== 1 ? `scale(${scale})` : undefined}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform={`translate(0, ${dy})`}
      />
    </g>
  );
}

/** `CardBack`'s "no info yet" center glyph — up-chevrons over a down-pointing
 * triangle — pulled out on its own so the Fortune Wheel's "wildcard" wedge
 * (see `SpinWheelOverlay`) can reuse it: a wildcard's magnitude is exactly
 * the same kind of "unknown until it resolves" thing the card back already
 * represents. */
function MysteryIcon({ cyan, pink }: { cyan: string; pink: string }) {
  return (
    <g>
      <polyline points="-26,4 0,-22 26,4" fill="none" stroke={cyan} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="-26,22 0,-4 26,22" fill="none" stroke={cyan} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
      <polygon points="-14,32 14,32 0,52" fill={pink} />
    </g>
  );
}

/** Two opposing curved arrows chasing each other — no card plays a "swap
 * positions" effect, so this has no existing card face to match; drawn in
 * the same plain-stroke, rounded-cap language as `ChevronIcon`/`SnowflakeIcon`
 * so it still reads as part of the same icon set. Used only by the Fortune
 * Wheel's "swap" wedge (see `SpinWheelOverlay`). */
function SwapArrowsIcon({ color }: { color: string }) {
  return (
    <g fill="none" stroke={color} strokeWidth={4} strokeLinecap="round">
      <path d="M -26 -8 A 27 27 0 0 1 18 -26" />
      <polygon points="18,-26 4,-24 12,-12" fill={color} stroke="none" />
      <path d="M 26 8 A 27 27 0 0 1 -18 26" />
      <polygon points="-18,26 -4,24 -12,12" fill={color} stroke="none" />
    </g>
  );
}

/** Unique face for a "freeze" card: the clipped-corner HUD frame shared by
 * every card, but with a snowflake icon in place of the plain numeric
 * readout (see `TrapCardFace`, which this mirrors) — a "+1" alone wouldn't
 * hint that it also plants a frozen hazard behind the mover. */
function FreezeCardFace({ card, color }: { card: Card; color: string }) {
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
      <text x={14} y={30} fontSize={15} fontWeight={700} fontFamily="var(--font-retro)" fill={color}>
        {cardLabel(card)}
      </text>
      {/* the snowflake icon, centered */}
      <g transform={`translate(${w / 2}, ${h * 0.4})`}>
        <SnowflakeIcon color={color} />
      </g>
      {/* icy hazard stripes, reused from CardBack's/TrapCardFace's language */}
      <clipPath id={`freeze-card-hazard-${card.id}`}>
        <rect x={14} y={h - 66} width={w - 28} height={14} />
      </clipPath>
      <g clipPath={`url(#freeze-card-hazard-${card.id})`} stroke={color} strokeOpacity={0.6} strokeWidth={3}>
        {Array.from({ length: 14 }, (_, i) => {
          const x = 4 + i * 9;
          return <line key={i} x1={x} y1={h - 50} x2={x + 16} y2={h - 80} />;
        })}
      </g>
      {/* name, bottom */}
      <text x={w / 2} y={h - 40} fontSize={13} fontWeight={800} fontFamily="var(--font-retro)" fill={color} textAnchor="middle">
        FREEZE
      </text>
      <text x={w / 2} y={h - 22} fontSize={9} fontWeight={600} fontFamily="var(--font-retro)" fill={color} opacity={0.7} textAnchor="middle">
        Move 1, freeze tile behind
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
function CardFace({
  card,
  color,
  pop,
}: {
  card: Card;
  color: string;
  /** Set for one damage-pop cycle right after a "damage" tile weakens this
   * card, so the big readout can animate from the pre-damage value down to
   * `card.value` instead of just snapping to it. */
  pop?: { fromValue: number };
}) {
  if (card.type === "row-trap" || card.type === "column-trap") {
    return <TrapCardFace card={card} color={color} />;
  }
  if (card.type === "freeze") {
    return <FreezeCardFace card={card} color={color} />;
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
      <text x={14} y={30} fontSize={15} fontWeight={700} fontFamily="var(--font-retro)" fill={color}>
        {cardLabel(card)}
      </text>
      {/* big readout — a plain static label normally, or (right after a
          damage tile weakens this card) a crossfade from the pre-damage
          value to the new one plus a floating "-1" badge */}
      {pop ? (
        <>
          <text
            x={w / 2}
            y={h * 0.42}
            fontSize={CARD_FONT_SIZE}
            fontWeight={800}
            fontFamily="var(--font-retro)"
            fill={color}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              transformBox: "fill-box",
              transformOrigin: "center",
              animation: `card-value-pop-out ${CARD_DAMAGE_POP_OUT_MS}ms ease-in forwards`,
            }}
          >
            {cardLabel({ ...card, value: pop.fromValue })}
          </text>
          <text
            x={w / 2}
            y={h * 0.42}
            fontSize={CARD_FONT_SIZE}
            fontWeight={800}
            fontFamily="var(--font-retro)"
            fill={color}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              opacity: 0,
              transformBox: "fill-box",
              transformOrigin: "center",
              animation: `card-value-pop-in ${CARD_DAMAGE_POP_IN_MS}ms ease-out ${CARD_DAMAGE_POP_OUT_MS}ms forwards`,
            }}
          >
            {cardLabel(card)}
          </text>
          <text
            x={w / 2}
            y={h * 0.42 - 34}
            fontSize={20}
            fontWeight={800}
            fontFamily="var(--font-retro)"
            fill="#ff2d95"
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              opacity: 0,
              transformBox: "fill-box",
              transformOrigin: "center",
              animation: `card-damage-badge ${CARD_DAMAGE_BADGE_MS}ms ease-out forwards`,
            }}
          >
            {card.value - pop.fromValue}
          </text>
        </>
      ) : (
        <text
          x={w / 2}
          y={h * 0.42}
          fontSize={CARD_FONT_SIZE}
          fontWeight={800}
          fontFamily="var(--font-retro)"
          fill={color}
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {cardLabel(card)}
        </text>
      )}
      {/* chevrons */}
      <g transform={`translate(${w / 2}, ${chevronY})`}>
        <ChevronIcon direction={backward ? "backward" : "forward"} color={color} />
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

/** An annular wedge of a ring, from `startDeg` to `endDeg` (same
 * clockwise-from-top convention as `ringPoint`) running from `innerR` out to
 * `outerR` — the Fortune Wheel's segment shape. `innerR` is the hub circle's
 * own radius, not 0: every wedge's radial edges (and the gap between
 * neighboring wedges — see `WHEEL_GAP_DEG`) should start right at the hub's
 * rim, not converge to the wheel's true center point, which the hub
 * (drawn on top) covers anyway. */
function wheelWedgePath(cx: number, cy: number, outerR: number, innerR: number, startDeg: number, endDeg: number): string {
  const outerStart = ringPoint(cx, cy, outerR, startDeg);
  const outerEnd = ringPoint(cx, cy, outerR, endDeg);
  const innerStart = ringPoint(cx, cy, innerR, startDeg);
  const innerEnd = ringPoint(cx, cy, innerR, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${innerStart.x} ${innerStart.y}`,
    `L ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
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
        <MysteryIcon cyan={cyan} pink={pink} />
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

/** Start/end angle (clockwise-from-top, same convention as `ringPoint`) of
 * each `WHEEL_SEGMENTS` wedge, laid out back-to-back in order and sized by
 * each segment's `weight` (default 1) — the same weight `rollWheelSegment`
 * uses server-side, so a wedge's on-screen slice always matches its actual
 * odds. */
const WHEEL_BOUNDS: { start: number; end: number }[] = (() => {
  const totalWeight = WHEEL_SEGMENTS.reduce((sum, s) => sum + (s.weight ?? 1), 0);
  let angle = 0;
  return WHEEL_SEGMENTS.map((s) => {
    const start = angle;
    angle += ((s.weight ?? 1) / totalWeight) * 360;
    return { start, end: angle };
  });
})();
/** Small angular margin trimmed off both edges of every wedge's *drawn*
 * shape (not its logical `WHEEL_BOUNDS`, which stays edge-to-edge for the
 * rotation/probability math) — without it, two neighboring wedges' strokes
 * sit exactly on top of each other and whichever one paints last wins that
 * shared border, making it flicker between the two colors depending on
 * array order rather than showing each wedge's own color on both its
 * edges. */
const WHEEL_GAP_DEG = 0.5;
/** The hub circle's radius — also `wheelWedgePath`'s `innerR`, so every
 * wedge's radial edges start at the hub's own rim instead of the wheel's
 * true center point. */
const WHEEL_HUB_RADIUS = 44;
/** How long the wheel spins before settling on its landed segment. Exported
 * so the standalone board prototype (which drives its own local spin instead
 * of a server round trip) can time its own animation the same way. */
export const WHEEL_SPIN_MS = 3200;
/** How long the wheel takes to fade/scale in when it first appears, and
 * (reversed) to fade/scale out once the celebration pause ends. Exported for
 * the same reason as `WHEEL_SPIN_MS`. */
export const WHEEL_ENTER_MS = 380;
export const WHEEL_EXIT_MS = 320;
/** How long the wheel lingers, glowing, on its landed segment before it
 * hides and the outcome is actually applied — just enough of a beat to read
 * as "you got this" rather than snapping straight to the next state. */
export const WHEEL_CELEBRATE_MS = 900;
/** Extra full rotations the spin makes before settling, purely for effect. */
const WHEEL_SPIN_TURNS = 6;
/** Shared gold accent for the wheel's "wildcard" wedge and its hub ring —
 * matches the offer fan's "selected card" glow (`#fff29e`), both reading as
 * "the good one" in this game's color language. */
const WHEEL_GOLD = "#fff29e";
/** Outcomes that set the mover (or their team) back — colored magenta,
 * matching every other "hazard"/backward-move language in this file (see
 * `cardColor`'s `card.value < 0` case). Every other non-wildcard outcome
 * reads as a plain forward/neutral move and stays blue. */
const WHEEL_NEGATIVE_TYPES = new Set<WheelOutcomeType>(["retreat", "drop"]);

/** A wedge's fill/stroke color: gold for "wildcard", magenta for a
 * setback (see `WHEEL_NEGATIVE_TYPES`), blue for everything else. */
function wheelSegmentColor(type: WheelOutcomeType): string {
  if (type === "wildcard") return WHEEL_GOLD;
  return WHEEL_NEGATIVE_TYPES.has(type) ? "#ff2d95" : "#22e3ff";
}

/** The wedge icon for each Fortune Wheel outcome, reusing exactly the same
 * icon components a card face of the matching mechanic already draws:
 * "advance"/"retreat" get the same forward/backward `ChevronIcon` a move
 * card's value chevrons use, "freeze" gets the freeze card's `SnowflakeIcon`,
 * "drop" gets the row-trap card's `TrapGridIcon` (a "drop" outcome falls one
 * row, same as a row-trap), and "wildcard" gets the card back's
 * `MysteryIcon` (its magnitude is just as unknown-until-resolved). Only
 * "swap" has no card equivalent to match — see `SwapArrowsIcon`. */
/** Chevrons are drawn much smaller than the wheel's other icons at their
 * native (card-face) size — see `ChevronIcon`'s `scale` prop. */
const WHEEL_CHEVRON_SCALE = 1.9;

function wheelSegmentIcon(type: WheelOutcomeType, color: string) {
  switch (type) {
    case "advance":
      return <ChevronIcon direction="forward" color={color} scale={WHEEL_CHEVRON_SCALE} />;
    case "retreat":
      return <ChevronIcon direction="backward" color={color} scale={WHEEL_CHEVRON_SCALE} />;
    case "freeze":
      return <SnowflakeIcon color={color} />;
    case "drop":
      return <TrapGridIcon mode="row" color={color} />;
    case "wildcard":
      return <MysteryIcon cyan={color} pink="#ff2d95" />;
    case "swap":
      return <SwapArrowsIcon color={color} />;
  }
}

/** The wheel's own lifecycle, driven by the caller: `enter` and `exit` are the
 * fade/scale-in and fade/scale-out beats (see `WHEEL_ENTER_MS`/`WHEEL_EXIT_MS`),
 * `idle` covers everything from "fully shown" through the spin itself (which
 * `spinning` drives independently), and `celebrate` is the post-landing pause
 * (`WHEEL_CELEBRATE_MS`) where the landed wedge glows before the wheel exits. */
export type WheelOverlayPhase = "enter" | "idle" | "celebrate" | "exit";

/** Full-screen "Fortune Protocol" wheel shown while `GameState.pendingWheelSpin`
 * is set (a controlled player landed on a "special"/green tile). Every client
 * sees the same wheel and outcome labels; only the player being held for
 * (`isController`) gets a working Spin button — everyone else just watches it
 * resolve. `spinning` is non-null once the server's `wheel_spun` result has
 * arrived, driving the wheel's CSS-transition spin onto `segmentIndex`
 * (see `WHEEL_BOUNDS`'s rotation math below); `phase` (see `WheelOverlayPhase`)
 * drives the surrounding fade/scale/celebrate beats. The caller applies the
 * outcome's board moves and adopts the new state only once `phase` reaches
 * `exit` and finishes. Exported so the standalone board prototype can reuse
 * the exact same wheel UI locally. */
export function SpinWheelOverlay({
  moverName,
  isController,
  spinning,
  phase,
  onSpin,
}: {
  moverName: string;
  isController: boolean;
  spinning: { segmentIndex: number } | null;
  phase: WheelOverlayPhase;
  onSpin: () => void;
}) {
  const size = 620;
  const r = 270;
  const cx = size / 2;
  const cy = size / 2;
  // Rotating the wheel group by R shifts every wedge's on-screen angle by
  // +R (clockwise, same sense `ringPoint` measures in) — so landing wedge
  // i's center exactly under the fixed top pointer means solving
  // wedgeMid + R ≡ 0 (mod 360). `WHEEL_SPIN_TURNS` extra full rotations are
  // added purely so the spin has somewhere to travel from before settling.
  const landedBounds = spinning ? WHEEL_BOUNDS[spinning.segmentIndex] : null;
  const rotation = landedBounds ? WHEEL_SPIN_TURNS * 360 - (landedBounds.start + landedBounds.end) / 2 : 0;
  // `enter`/`exit` are the two "hidden" endpoints of the fade/scale beat;
  // every other phase reads as fully shown. Reusing the same shrunken/faded
  // pose for both means the exit animation is just the enter one in reverse.
  const shown = phase !== "enter" && phase !== "exit";
  const showTransitionMs = phase === "enter" ? WHEEL_ENTER_MS : WHEEL_EXIT_MS;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 65, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, rgba(2,4,10,0.4) 0%, rgba(2,4,10,0.85) 100%)",
          opacity: shown ? 1 : 0,
          transition: `opacity ${showTransitionMs}ms ease`,
        }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "50%",
          transform: `translate(-50%, -50%) scale(${shown ? 1 : 0.6})`,
          opacity: shown ? 1 : 0,
          transition: `transform ${showTransitionMs}ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity ${showTransitionMs}ms ease`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-retro)",
            fontSize: 24,
            color: "#22e3ff",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            textShadow: "0 0 8px #22e3ff, 0 0 20px rgba(34,227,255,0.6)",
          }}
        >
          Fortune Protocol
        </div>
        <div style={{ position: "relative", width: size, height: size }}>
          <svg
            width={size}
            height={size}
            style={{
              position: "absolute",
              inset: 0,
              transform: `rotate(${rotation}deg)`,
              // Slow start, fast middle, slow finish — a standard
              // ease-in-out curve, rather than the sharp-out-of-the-gate
              // "ease-out" a real spin doesn't actually do.
              transition: spinning ? `transform ${WHEEL_SPIN_MS}ms cubic-bezier(0.65, 0, 0.35, 1)` : "none",
              filter: "drop-shadow(0 0 26px rgba(34,227,255,0.35))",
              // A pulsing glow while the wheel lingers on its landed segment
              // (see `WheelOverlayPhase`'s `celebrate`) — the `animation`
              // shorthand's `filter` keyframes take over from the static one
              // above for as long as this phase lasts.
              animation: phase === "celebrate" ? "wheel-celebrate-glow 480ms ease-in-out infinite" : undefined,
            }}
          >
            <circle cx={cx} cy={cy} r={r + 10} fill="#05070f" fillOpacity={0.8} stroke="#22e3ff" strokeWidth={7} />
            {WHEEL_SEGMENTS.map((seg, i) => {
              const { start, end } = WHEEL_BOUNDS[i];
              const color = wheelSegmentColor(seg.type);
              const mid = (start + end) / 2;
              // Icon/label sit on the wedge's own centerline, rotated by
              // `mid` (same clockwise-from-top convention as `ringPoint`) so
              // their "up" direction always points straight out along the
              // radius, away from the hub — like the spokes of the wheel
              // itself, matching every reference wheel-of-fortune design.
              const iconPos = ringPoint(cx, cy, r * 0.8, mid);
              const labelPos = ringPoint(cx, cy, r * 0.6, mid);
              // The landed wedge, once the spin's settled and celebration
              // starts — filled in solid (rather than the other wedges'
              // faint tint) and lit up, so the win reads unmistakably.
              const isWinner = phase === "celebrate" && spinning?.segmentIndex === i;
              return (
                <g key={i}>
                  <path
                    d={wheelWedgePath(cx, cy, r, WHEEL_HUB_RADIUS, start + WHEEL_GAP_DEG, end - WHEEL_GAP_DEG)}
                    fill={color}
                    fillOpacity={isWinner ? 0.55 : 0.06}
                    stroke={color}
                    strokeWidth={isWinner ? 6 : 4}
                    style={{
                      transition: "fill-opacity 200ms ease, stroke-width 200ms ease",
                      filter: isWinner ? `drop-shadow(0 0 20px ${color})` : undefined,
                    }}
                  />
                  <g transform={`translate(${iconPos.x}, ${iconPos.y}) rotate(${mid}) scale(0.85)`}>
                    {wheelSegmentIcon(seg.type, color)}
                  </g>
                  {seg.type !== "wildcard" && (
                    <text
                      x={labelPos.x}
                      y={labelPos.y}
                      fontSize={seg.type === "advance" || seg.type === "retreat" ? 22 : 15}
                      fontWeight={800}
                      fontFamily="var(--font-retro)"
                      fill={color}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      transform={`rotate(${mid}, ${labelPos.x}, ${labelPos.y})`}
                    >
                      {seg.label}
                    </text>
                  )}
                </g>
              );
            })}
            <circle cx={cx} cy={cy} r={WHEEL_HUB_RADIUS} fill="#0a0c14" stroke={WHEEL_GOLD} strokeWidth={2} />
            {/* The deck's own logo (`CardBack`'s center glyph) in the hub —
                the same "no info yet" mark every face-down card and the
                deck pile carry, since the wheel's spin is exactly that kind
                of not-yet-known draw. */}
            <g transform={`translate(${cx}, ${cy - 8}) scale(0.42)`}>
              <MysteryIcon cyan="#22e3ff" pink="#ff2d95" />
            </g>
          </svg>
          {/* Fixed pointer marking exactly where the spin stops — a separate
              (later, so it always paints on top of the wheel) svg that never
              rotates; `rotation`'s math instead always brings the landed
              wedge around to sit under this fixed point. */}
          <svg width={size} height={size} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
            <polygon
              points={`${cx - 16},${cy - r - 10} ${cx + 16},${cy - r - 10} ${cx},${cy - r + 20}`}
              fill="#22e3ff"
              style={{ filter: "drop-shadow(0 0 10px #22e3ff)" }}
            />
          </svg>
        </div>
        {isController ? (
          <div style={{ pointerEvents: "auto" }}>
            <NeonButton variant="primary" scale={2} extraPaddingX={80} disabled={!!spinning} onClick={onSpin}>
              {spinning ? "Spinning..." : "Spin"}
            </NeonButton>
          </div>
        ) : (
          <div
            style={{
              color: "#8fe8ff",
              fontFamily: "sans-serif",
              fontWeight: 600,
              fontSize: 14,
              textShadow: "0 0 8px rgba(0,0,0,0.8)",
            }}
          >
            Waiting for {moverName} to spin...
          </div>
        )}
      </div>
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
                data-card-id={card.id}
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

/** Whether a move lands on a spiked "damage" tile — used to trigger the
 * screen-shake/orange-flash feedback for the controlled player(s) taking a
 * hit. Checked against `finalTileId` rather than the last step of `path`:
 * a "+0" move card played while already standing on a damage tile has an
 * empty path (no tiles crossed) but still re-triggers the damage, since the
 * mover lands on it again as part of resolving that play. */
function landsOnDamageTile(tiles: Tile[], finalTileId: TileId): boolean {
  return findTile(tiles, finalTileId).effect.type === "damage";
}

/** Whether a move's final step lands on a tile that was *already* an active
 * frozen hazard going into this move — the "you're stuck, lose your next
 * turn" case, as opposed to being the first player to trigger a fresh
 * freeze tile (which is a bonus, not a hit). `prevFrozenTiles` must be the
 * board's frozen-tile set from just before this move resolved. */
function landsOnActiveFreezeHazard(prevFrozenTiles: TileId[], path: MoveStep[]): boolean {
  if (path.length === 0) return false;
  const finalStep = path[path.length - 1];
  return prevFrozenTiles.includes(finalStep.tileId);
}

/** How long the orange vignette stays visible, and the (slightly shorter)
 * duration of the accompanying shake — both fired together when a
 * controlled player lands on a "damage" tile. */
const DAMAGE_FLASH_MS = 500;
const DAMAGE_SHAKE_MS = 400;

/** Full-screen orange vignette flashed over the game view on taking damage.
 * Remounted via a changing `key` each hit, so its CSS animation always plays
 * from the start even on back-to-back hits. */
function DamageFlashOverlay() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        background: "radial-gradient(ellipse at center, rgba(255,90,20,0) 35%, rgba(255,80,10,0.65) 100%)",
        animation: `damage-flash ${DAMAGE_FLASH_MS}ms ease-out`,
      }}
    />
  );
}

/** How long the icy vignette (and frost crystals) stay visible when a
 * controlled player gets stuck on an already-active frozen tile (loses
 * their next turn). Longer than the plain damage flash so the crystals have
 * time to read as "growing in" rather than just blinking. */
const FREEZE_FLASH_MS = 900;

interface FrostSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  opacity: number;
}

/** Tiny deterministic PRNG (mulberry32) — the frost pattern below only needs
 * to look organic, not actually be random, and is built once at module load,
 * so a fixed seed per call keeps it reproducible instead of reshuffling on
 * every render. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Recursively branches one frost "fern" spike from (x, y) heading at
 * `angleDeg`, shrinking length/width and throwing off a couple of angled
 * side-branches each generation — the same jagged, feathery branching real
 * window-frost crystals grow in, rather than a bare straight line. Growth
 * stops as soon as it strays past `maxReach` from `origin` (the cluster's
 * anchor on the screen edge), which is what actually keeps the crystals
 * confined to a border band instead of the branching recursion running the
 * spikes most of the way across the screen. */
function growFrostBranch(
  segments: FrostSegment[],
  x: number,
  y: number,
  angleDeg: number,
  length: number,
  width: number,
  depth: number,
  rand: () => number,
  origin: { x: number; y: number },
  maxReach: number,
) {
  if (depth <= 0 || length < 1.2) return;
  const rad = (angleDeg * Math.PI) / 180;
  const x2 = x + Math.cos(rad) * length;
  const y2 = y + Math.sin(rad) * length;
  if (Math.hypot(x2 - origin.x, y2 - origin.y) > maxReach) return;
  segments.push({ x1: x, y1: y, x2, y2, width, opacity: 0.16 + depth * 0.07 });

  const branchCount = depth > 2 ? 2 : 1;
  for (let i = 0; i < branchCount; i++) {
    const t = 0.35 + rand() * 0.4;
    const side = i % 2 === 0 ? 1 : -1;
    growFrostBranch(
      segments,
      x + (x2 - x) * t,
      y + (y2 - y) * t,
      angleDeg + side * (26 + rand() * 22),
      length * (0.42 + rand() * 0.16),
      width * 0.65,
      depth - 1,
      rand,
      origin,
      maxReach,
    );
  }

  growFrostBranch(
    segments,
    x2,
    y2,
    angleDeg + (rand() - 0.5) * 10,
    length * 0.72,
    width * 0.75,
    depth - 1,
    rand,
    origin,
    maxReach,
  );
}

/** One frost cluster growing inward from an edge point — a handful of fern
 * spikes fanned around the inward-facing angle, like a real frost-covered
 * corner of a window pane, each capped at `maxReach` from that edge point so
 * the whole cluster stays a border decoration rather than creeping toward
 * the center of the screen. */
function frostCluster(
  x: number,
  y: number,
  inwardAngleDeg: number,
  maxReach: number,
  seed: number,
): FrostSegment[] {
  const rand = mulberry32(seed);
  const segments: FrostSegment[] = [];
  const origin = { x, y };
  const spikeCount = 3 + Math.floor(rand() * 2);
  for (let i = 0; i < spikeCount; i++) {
    growFrostBranch(
      segments,
      x,
      y,
      inwardAngleDeg + (rand() - 0.5) * 46,
      maxReach * (0.4 + rand() * 0.25),
      1.3,
      4,
      rand,
      origin,
      maxReach,
    );
  }
  return segments;
}

/** Coordinate space the frost border is authored in — close to a typical
 * 16:9 viewport so `preserveAspectRatio="none"` scaling to the actual screen
 * doesn't visibly skew the branch angles. */
const FROST_VIEW_W = 160;
const FROST_VIEW_H = 90;

/** Frost creeping in from all four screen edges, denser and longer-reaching
 * at the corners — the vignette-y "ice crystals framing the view" look,
 * built once at module load (see `mulberry32`) rather than regenerated on
 * every flash. */
// Border band depth each cluster is capped to — a fraction of that edge's
// own dimension, so the crystals read as a frame around the view instead of
// reaching toward the center.
const FROST_EDGE_REACH_H = FROST_VIEW_H * 0.11;
const FROST_EDGE_REACH_V = FROST_VIEW_W * 0.11;

const FROST_BORDER_SEGMENTS: FrostSegment[] = (() => {
  const clusters: { x: number; y: number; angle: number; reach: number; seed: number }[] = [];
  const edgeT = [0.03, 0.13, 0.26, 0.5, 0.74, 0.87, 0.97];
  const cornerBoost = (t: number) => (Math.min(t, 1 - t) < 0.18 ? 1.5 : 1);

  edgeT.forEach((t, i) => {
    const x = t * FROST_VIEW_W;
    clusters.push({ x, y: 0, angle: 90, reach: FROST_EDGE_REACH_H * cornerBoost(t), seed: 100 + i });
    clusters.push({ x, y: FROST_VIEW_H, angle: -90, reach: FROST_EDGE_REACH_H * cornerBoost(t), seed: 200 + i });
  });
  edgeT.forEach((t, i) => {
    const y = t * FROST_VIEW_H;
    clusters.push({ x: 0, y, angle: 0, reach: FROST_EDGE_REACH_V * cornerBoost(t), seed: 300 + i });
    clusters.push({ x: FROST_VIEW_W, y, angle: 180, reach: FROST_EDGE_REACH_V * cornerBoost(t), seed: 400 + i });
  });

  return clusters.flatMap((c) => frostCluster(c.x, c.y, c.angle, c.reach, c.seed));
})();

/** The frost crystal branches themselves, layered over `FreezeFlashOverlay`'s
 * plain radial vignette — an SVG so the jagged fern shapes stay crisp at any
 * resolution instead of needing a raster texture. Icy glow via `filter`
 * rather than per-line shadows, to keep the (large) segment count cheap. */
function FrostCrystalOverlay() {
  return (
    <svg
      viewBox={`0 0 ${FROST_VIEW_W} ${FROST_VIEW_H}`}
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        filter: "drop-shadow(0 0 0.6px #eafbff)",
      }}
    >
      {FROST_BORDER_SEGMENTS.map((s, i) => (
        <line
          key={i}
          x1={s.x1}
          y1={s.y1}
          x2={s.x2}
          y2={s.y2}
          stroke="#eafbff"
          strokeWidth={s.width * 0.16}
          strokeLinecap="round"
          opacity={s.opacity}
        />
      ))}
    </svg>
  );
}

/** How long the persistent "you're frozen" frame takes to fade in/out as
 * that status turns on/off, so it doesn't just snap. */
const FROZEN_STATUS_FADE_MS = 500;

/** Steady (not flashing) frost frame kept on screen for as long as a
 * controlled player is actually stuck on a frozen tile — from the moment
 * they land there until they finally move off it again, including every
 * turn in between where their own turn is skipped. Always mounted so
 * `visible` can drive a plain CSS opacity transition instead of a
 * mount/unmount, which would skip the fade. Reuses the same frost crystal
 * border as the momentary `FreezeFlashOverlay`, just held steady at a lower
 * opacity instead of pulsing. */
function FrozenStatusOverlay({ visible }: { visible: boolean }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 39,
        pointerEvents: "none",
        opacity: visible ? 0.75 : 0,
        transition: `opacity ${FROZEN_STATUS_FADE_MS}ms ease`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, rgba(143,232,255,0) 55%, rgba(143,232,255,0.28) 100%)",
        }}
      />
      <FrostCrystalOverlay />
    </div>
  );
}

/** Full-screen icy-blue vignette (plus a frame of frost crystals creeping in
 * from the edges) flashed over the game view when a controlled player lands
 * on an active frozen hazard — the "freeze" analog of `DamageFlashOverlay`.
 * Remounted via a changing `key` each hit, so the animation always plays
 * from the start even on back-to-back hits. */
function FreezeFlashOverlay() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        animation: `freeze-flash ${FREEZE_FLASH_MS}ms ease-out`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at center, rgba(143,232,255,0) 35%, rgba(143,232,255,0.55) 100%)",
        }}
      />
      <FrostCrystalOverlay />
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
        pointerEvents: "auto",
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
        pointerEvents: "auto",
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
        fontFamily: "var(--font-retro)",
        width: 230,
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
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {team.name}
            </span>
            <span style={{ marginLeft: "auto", color: "white", fontSize: 14, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>
              {finishedCount} / {roster.length}
            </span>
            {active && <span style={{ color: teamHex, fontSize: 13, lineHeight: 1, flexShrink: 0 }}>›</span>}
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

type StartPhase = "countdown" | "hud-off" | "flicker" | "hud-on";

const START_COUNTDOWN_SECONDS = 3;
const START_HUD_OFF_HOLD_MS = 500;
const START_HUD_FLICKER_MS = 700;
/** Held past the HUD starting to flicker on before the scene itself (its
 * background and the tiles falling into place) begins — so the HUD visibly
 * leads the reveal instead of both powering on in the same beat. */
const SCENE_REVEAL_DELAY_MS = 500;
/** How long the scene's background takes to fade from fully transparent to
 * visible once revealed — the tiles' own fall (`Scene.playTileDropIn`) plays
 * on top of this. */
const SCENE_FADE_MS = 900;

/** Full-screen "Game starting in 3..2..1" overlay shown the moment `GameUI`
 * mounts, before the HUD or scene appear at all — see the `startPhase`
 * sequence in `GameUI` below. */
function StartCountdownOverlay({ onDone }: { onDone: () => void }) {
  const [count, setCount] = useState(START_COUNTDOWN_SECONDS);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (count <= 1) {
      const timer = setTimeout(() => onDoneRef.current(), 1000);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [count]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#020309",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-retro)",
            fontSize: 28,
            color: "#22e3ff",
            textShadow: "0 0 8px #22e3ff, 0 0 20px rgba(34, 227, 255, 0.6), 0 0 40px rgba(34, 227, 255, 0.35)",
            letterSpacing: "0.05em",
          }}
        >
          Game starting in
        </div>
        <div
          style={{
            fontFamily: "var(--font-retro)",
            fontSize: 72,
            color: "#22e3ff",
            textShadow: "0 0 8px #22e3ff, 0 0 20px rgba(34, 227, 255, 0.6), 0 0 40px rgba(34, 227, 255, 0.35)",
            letterSpacing: "0.05em",
          }}
        >
          {count}
        </div>
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
  const [damageFlash, setDamageFlash] = useState<number | null>(null);
  const damageFlashIdRef = useRef(0);
  const [freezeFlash, setFreezeFlash] = useState<number | null>(null);
  const freezeFlashIdRef = useRef(0);
  // The board's frozen-tile set as of the last committed state — read (not
  // written) inside the `card_played` handler below, before `state` itself
  // updates, so a move can be checked against whichever tiles were already
  // active hazards going into it.
  const frozenTilesRef = useRef<TileId[]>(initialState.frozenTiles);
  useEffect(() => {
    frozenTilesRef.current = state.frozenTiles;
  }, [state.frozenTiles]);
  // Latest committed state, read (not written) inside the `wheel_spun`
  // handler below — a Fortune Wheel "drop" outcome needs to know which row
  // the mover was standing in *before* the drop lands (`msg.state` is
  // already post-drop) so it can build/open trapdoors for the whole row,
  // exactly like playing a row-trap card does.
  const stateRef = useRef<GameState>(initialState);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // Every player's hand as of the last committed state, read (not written)
  // inside the `card_played` handler below, before `state` itself updates —
  // gives the pre-damage card values to animate the hand's "-1" pop from
  // once the post-damage state lands (see `triggerDamagePop`).
  const handsRef = useRef<Record<PlayerId, Card[]>>(
    Object.fromEntries(initialState.players.map((p) => [p.id, p.hand])),
  );
  useEffect(() => {
    handsRef.current = Object.fromEntries(state.players.map((p) => [p.id, p.hand]));
  }, [state.players]);
  // Non-null for one damage-pop cycle right after a controlled player's hand
  // is weakened by landing on a "damage" tile — `fromValues` holds each
  // affected card's pre-damage value, keyed by card id, for `CardFace` to
  // animate from (see `landsOnDamageTile`/`applyDamageToHand`).
  const [damagePop, setDamagePop] = useState<{ id: number; playerId: PlayerId; fromValues: Record<CardId, number> } | null>(
    null,
  );
  const damagePopIdRef = useRef(0);
  const sceneShakeRef = useRef<HTMLDivElement | null>(null);
  const [offerProgress, setOfferProgress] = useState(1);
  const [selectedOfferIds, setSelectedOfferIds] = useState<string[]>([]);
  const [offerResolving, setOfferResolving] = useState(false);
  const offerResolvingRef = useRef(false);
  const [deckAnchor, setDeckAnchor] = useState<{ x: number; y: number } | null>(null);
  // Identifies one offer "session" (from first appearing to fully resolving)
  // independent of `cardOffer.offered`/`deadline`, both of which mutate on
  // every intermediate pick and `offer_activity` renewal (see `chooseOfferCard`/
  // `offer_activity` in server.ts) — captured once when the offer first shows
  // up and held until it clears, so `CardOfferFan` below can key off it
  // instead of the shrinking `offered` list. Keying off `offered` caused a
  // full remount (replaying the deal-in animation) after every partial pick
  // in a multi-pick offer, since each pick's server round trip removes that
  // card from `offered` before the next one is sent.
  const offerSessionKeyRef = useRef<string | null>(null);
  if (state?.cardOffer) {
    if (offerSessionKeyRef.current === null) {
      offerSessionKeyRef.current = `${state.cardOffer.playerId}:${state.cardOffer.deadline}`;
    }
  } else {
    offerSessionKeyRef.current = null;
  }
  const [orbitMode, setOrbitMode] = useState(false);
  // Local Fortune Wheel session: appears the instant `state.pendingWheelSpin`
  // shows up (see the effect below), stays mounted through the spin/move
  // animation even after the server has already cleared `pendingWheelSpin`
  // from state (so the wheel doesn't vanish mid-spin), and is cleared once
  // that whole sequence finishes and the outcome's state is adopted.
  const [wheelOverlay, setWheelOverlay] = useState<{
    playerId: PlayerId;
    segmentIndex: number | null;
    phase: WheelOverlayPhase;
  } | null>(null);
  useEffect(() => {
    if (state.pendingWheelSpin && !wheelOverlay) {
      setWheelOverlay({ playerId: state.pendingWheelSpin.playerId, segmentIndex: null, phase: "enter" });
      // Mount in the shrunken/faded `enter` pose, then flip to `idle` on the
      // next frame so the fade/scale-in transition actually has something to
      // animate from — flipping in the same tick would let the browser
      // coalesce both states and skip the animation (see `CardPlayOverlay`'s
      // identical "start" -> "grow" two-step for the same reason).
      requestAnimationFrame(() => setWheelOverlay((w) => (w && w.phase === "enter" ? { ...w, phase: "idle" } : w)));
    }
  }, [state.pendingWheelSpin, wheelOverlay]);
  const awaitingPlayRef = useRef<AwaitingPlay | null>(null);
  // Every tile a just-played row/column-trap card will drop (the whole
  // row/column, not just tiles a player happens to stand on) — computed in
  // `handlePlayCard` while the card is still live in local state, and
  // consumed once the resulting move animations actually start (see
  // `consumeCard`) so every floor's door swings open together right as the
  // fall begins rather than at card-grow time (which could be a while
  // before the server round-trip resolves).
  const pendingTrapTileIdsRef = useRef<string[] | null>(null);

  // Game-start intro: countdown, then the HUD powers on (off -> flicker ->
  // on) while the scene stays hidden. `GameUI` only ever mounts once per
  // game (no reconnect/resume), so this can just run once on mount rather
  // than being driven by a prop from the route page.
  const [startPhase, setStartPhase] = useState<StartPhase>("countdown");
  useEffect(() => {
    if (startPhase !== "hud-off") return;
    const timer = setTimeout(() => setStartPhase("flicker"), START_HUD_OFF_HOLD_MS);
    return () => clearTimeout(timer);
  }, [startPhase]);
  // Scene reveal: once the HUD starts powering on, wait a beat (so the HUD
  // visibly leads) then fade the scene's background in and kick off every
  // tile's fall-into-place (see `Scene.playTileDropIn`), rather than having
  // the whole scene snap into view already assembled.
  const [sceneRevealed, setSceneRevealed] = useState(false);
  useEffect(() => {
    if (startPhase !== "flicker") return;
    const timer = setTimeout(() => {
      setSceneRevealed(true);
      sceneHandleRef.current?.playTileDropIn();
    }, SCENE_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [startPhase]);
  useEffect(() => {
    if (startPhase !== "flicker") return;
    const timer = setTimeout(() => setStartPhase("hud-on"), START_HUD_FLICKER_MS);
    return () => clearTimeout(timer);
  }, [startPhase]);

  useEffect(() => {
    if (!burst) return;
    const timer = setTimeout(() => setBurst(null), BURST_MS);
    return () => clearTimeout(timer);
  }, [burst]);

  // Restarts the screen-shake animation imperatively (rather than relying on
  // React re-mounting a keyed element, which would tear down and rebuild the
  // whole Scene/WebGL subtree) so consecutive hits each replay in full, then
  // clears the flash overlay once it's done.
  useEffect(() => {
    if (damageFlash === null) return;
    const el = sceneShakeRef.current;
    if (el) {
      el.style.animation = "none";
      void el.offsetHeight;
      el.style.animation = `damage-shake ${DAMAGE_SHAKE_MS}ms ease-in-out`;
    }
    const timer = setTimeout(() => setDamageFlash(null), DAMAGE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [damageFlash]);

  const triggerDamageFlash = () => {
    damageFlashIdRef.current += 1;
    setDamageFlash(damageFlashIdRef.current);
  };

  // Clears the hand's "-1" pop once its longest constituent animation
  // (`CARD_DAMAGE_POP_TOTAL_MS`) has had time to finish.
  useEffect(() => {
    if (!damagePop) return;
    const timer = setTimeout(() => setDamagePop(null), CARD_DAMAGE_POP_TOTAL_MS);
    return () => clearTimeout(timer);
  }, [damagePop]);

  const triggerDamagePop = (playerId: PlayerId, fromValues: Record<CardId, number>) => {
    damagePopIdRef.current += 1;
    setDamagePop({ id: damagePopIdRef.current, playerId, fromValues });
  };

  useEffect(() => {
    if (freezeFlash === null) return;
    const timer = setTimeout(() => setFreezeFlash(null), FREEZE_FLASH_MS);
    return () => clearTimeout(timer);
  }, [freezeFlash]);

  const triggerFreezeFlash = () => {
    freezeFlashIdRef.current += 1;
    setFreezeFlash(freezeFlashIdRef.current);
  };


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
  }, [state?.status, startPhase, state?.cardOffer]);

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
  // True from the moment any controlled player lands on a frozen tile until
  // they finally move off it again — spans however many turns (their own
  // skipped one included) that takes, unlike the momentary `freezeFlash`.
  const isControlledPlayerFrozen = state.players.some(
    (p) => controlledPlayerIds.includes(p.id) && p.frozenTileId !== null,
  );

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
    // Fired once every affected token's board animation has actually
    // finished (right before the new state commits) — used for effects that
    // need to read as happening *on* the landed tile (the hand's damage
    // pop) rather than at move-start, like `triggerDamageFlash` below.
    onLand?: () => void,
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

    onLand?.();
    setState((s) => commit(s));
    setCardAnim(null);
    setPlaying(false);
  };

  // Applies a `card_played` broadcast on a client that didn't initiate it:
  // just runs every affected player's board-move animation (no hand-card
  // fly-in — this client has no button/origin for a card it didn't play),
  // then commits the server's authoritative state. `onLand` — see
  // `consumeCard` — fires once those animations actually finish.
  const applyRemoteCardPlay = async (
    moves: { playerId: PlayerId; path: MoveStep[] }[],
    nextState: GameState,
    onLand?: () => void,
  ) => {
    await Promise.all(moves.map((m) => sceneHandleRef.current?.animateMove(m.playerId, m.path)));
    onLand?.();
    setState(nextState);
  };

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.event === "card_played") {
          const damagedMove = msg.moves.find((m) => {
            if (!controlledPlayerIds.includes(m.playerId)) return false;
            const finalTileId = msg.state.players.find((p) => p.id === m.playerId)?.currentTileId;
            return !!finalTileId && landsOnDamageTile(msg.state.tiles, finalTileId);
          });
          const tookDamage = !!damagedMove;
          const gotFrozen = msg.moves.some(
            (m) => controlledPlayerIds.includes(m.playerId) && landsOnActiveFreezeHazard(frozenTilesRef.current, m.path),
          );
          // Snapshot each weakened "move" card's pre-damage value now, while
          // `handsRef` still holds the hand as it was going into this play —
          // `fireDamagePop` (deferred to line up with when `state` actually
          // picks up the new values) reads it back later.
          const fireDamagePop = damagedMove
            ? () => {
                const prevHand = handsRef.current[damagedMove.playerId] ?? [];
                const nextHand = msg.state.players.find((p) => p.id === damagedMove.playerId)?.hand ?? [];
                const fromValues: Record<CardId, number> = {};
                for (const c of prevHand) {
                  if (c.type !== "move") continue;
                  const next = nextHand.find((nc) => nc.id === c.id);
                  if (next && next.value !== c.value) fromValues[c.id] = c.value;
                }
                if (Object.keys(fromValues).length > 0) triggerDamagePop(damagedMove.playerId, fromValues);
              }
            : null;
          // Fire every landing-triggered effect (flash/shake, freeze flash,
          // hand damage pop) together once the token has actually finished
          // traveling to the tile, rather than at move-start — otherwise a
          // multi-tile move reads as "damaged" before it's even reached the
          // spiked tile.
          const fireLandEffects = () => {
            if (tookDamage) triggerDamageFlash();
            if (gotFrozen) triggerFreezeFlash();
            fireDamagePop?.();
          };
          const awaiting = awaitingPlayRef.current;
          if (awaiting) {
            awaitingPlayRef.current = null;
            void consumeCard(msg.card, awaiting.mover, msg.moves, () => msg.state, fireLandEffects);
          } else {
            void applyRemoteCardPlay(msg.moves, msg.state, fireLandEffects);
          }
        } else if (msg.event === "wheel_spun") {
          setWheelOverlay((w) => (w ? { ...w, segmentIndex: msg.segmentIndex } : w));
          // A "drop" outcome is exactly a row-trap card played from the
          // mover's own tile (see `applyWheelOutcome`'s "drop" case) — figure
          // out which row (from the pre-drop state) now, but hold off
          // actually building the trapdoors until the wheel's fully hidden
          // (below), or they'd visibly appear on the board while the wheel is
          // still up.
          const dropTileIds =
            msg.outcome === "drop" ? trapCardTileIds(stateRef.current, msg.playerId, "row") : null;
          void (async () => {
            // Let the spin finish, then hold on the landed segment for a
            // celebratory beat before reversing the enter animation to hide
            // the wheel — only then do the board moves/state actually land,
            // so the reveal always happens after the wheel's gone.
            await sleep(WHEEL_SPIN_MS);
            setWheelOverlay((w) => (w ? { ...w, phase: "celebrate" } : w));
            await sleep(WHEEL_CELEBRATE_MS);
            setWheelOverlay((w) => (w ? { ...w, phase: "exit" } : w));
            await sleep(WHEEL_EXIT_MS);
            setWheelOverlay(null);
            if (dropTileIds) {
              sceneHandleRef.current?.prepareTrapdoorDrop(dropTileIds);
              sceneHandleRef.current?.openTrapdoors(dropTileIds);
            }
            await Promise.all(msg.moves.map((m) => sceneHandleRef.current?.animateMove(m.playerId, m.path)));
            setState(msg.state);
          })();
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

  const handleSpinWheel = () => {
    if (!wheelOverlay || wheelOverlay.segmentIndex !== null || !controlledPlayerIds.includes(wheelOverlay.playerId)) return;
    send({ action: "spin_wheel" });
  };

  const handlePlayCard = async (card: Card, buttonEl: HTMLButtonElement) => {
    if (playing || state.status !== "idle" || state.cardOffer || state.pendingWheelSpin || !isMyTurn) return;
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

  // Recording-only shortcuts: number keys 1-5 stand in for clicking a card
  // by hand position, so a demo can be played from the keyboard without the
  // mouse cursor showing up on screen. In the card-offer overlay they pick
  // from the offered fan instead of the hand, mirroring whichever row is
  // actually on screen.
  useEffect(() => {
    const handleCardShortcut = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const index = Number(e.key) - 1;
      if (!(index >= 0 && index <= 4)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

      if (state.cardOffer && controlledPlayerIds.includes(state.cardOffer.playerId)) {
        const card = state.cardOffer.offered[index];
        if (card) handleToggleOfferCard(card);
        return;
      }

      const card = myPlayer.hand[index];
      if (!card) return;
      const buttonEl = document.querySelector<HTMLButtonElement>(`button.game-card[data-card-id="${card.id}"]`);
      if (buttonEl) handlePlayCard(card, buttonEl);
    };
    window.addEventListener("keydown", handleCardShortcut);
    return () => window.removeEventListener("keydown", handleCardShortcut);
  }, [state.cardOffer, controlledPlayerIds, myPlayer, handleToggleOfferCard, handlePlayCard]);

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
      <div ref={sceneShakeRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {/* Scene stays hidden through the countdown, the HUD's dark "off"
            hold, and the start of its flicker — it's still mounted (just at
            opacity 0) so Three.js can initialize in the background. Once
            `sceneRevealed` flips (a beat after the HUD starts flickering on,
            see the effect above), its background fades in over
            `SCENE_FADE_MS` while the tiles fall into place on top of it
            (`playTileDropIn`), rather than the whole scene snapping into
            view already assembled. */}
        <div
          className="scene-layer"
          style={{
            position: "absolute",
            inset: 0,
            opacity: sceneRevealed ? 1 : 0,
            transition: `opacity ${SCENE_FADE_MS}ms ease`,
            // Was hardcoded "none", which permanently blocked mouse drag/
            // scroll from ever reaching the OrbitControls canvas beneath —
            // only interactive before the reveal finishes (still fading in
            // over the countdown overlay).
            pointerEvents: sceneRevealed ? "auto" : "none",
          }}
        >
          <Scene state={state} handleRef={sceneHandleRef} onOrbitModeChange={setOrbitMode} />
        </div>
        {startPhase === "countdown" && (
          <StartCountdownOverlay onDone={() => setStartPhase("hud-off")} />
        )}
        {startPhase !== "countdown" && (
        <div
          className="hud-layer"
          data-power={startPhase === "flicker" ? "flicker" : startPhase === "hud-on" ? "on" : "off"}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
        {damageFlash !== null && <DamageFlashOverlay key={damageFlash} />}
        <FrozenStatusOverlay visible={isControlledPlayerFrozen} />
        {freezeFlash !== null && <FreezeFlashOverlay key={freezeFlash} />}
        {state.cardOffer && deckAnchor && controlledPlayerIds.includes(state.cardOffer.playerId) && (
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
            pointerEvents: "auto",
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
                const locked = playing || !!state.cardOffer || !!state.pendingWheelSpin || !isMyTurn;
                const color = cardColor(card, locked);
                const mid = (myPlayer.hand.length - 1) / 2;
                const offset = i - mid;
                const popFromValue =
                  damagePop && damagePop.playerId === myPlayer.id ? damagePop.fromValues[card.id] : undefined;
                return (
                  <button
                    key={card.id}
                    className="game-card"
                    data-card-id={card.id}
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
                    <CardFace
                      card={card}
                      color={color}
                      pop={popFromValue !== undefined ? { fromValue: popFromValue } : undefined}
                    />
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
        )}
      </div>
      {cardAnim && <CardPlayOverlay anim={cardAnim} />}
      {cardAnim?.phase === "await-target" && (
        <TeamTargetOverlay
          teams={state.teams.filter((t) => t.id !== activePlayer.teamId)}
          onSelect={handleSelectRetreatTarget}
        />
      )}
      {state.cardOffer && deckAnchor && controlledPlayerIds.includes(state.cardOffer.playerId) && (
        <CardOfferFan
          key={offerSessionKeyRef.current ?? undefined}
          offer={state.cardOffer}
          offeringPlayerName={state.players.find((p) => p.id === state.cardOffer!.playerId)?.name ?? "Player"}
          anchor={deckAnchor}
          selectedIds={selectedOfferIds}
          resolving={offerResolving}
          locked={playing}
          onToggle={handleToggleOfferCard}
        />
      )}
      {burst && <ParticleBurst burst={burst} />}
      {wheelOverlay && (
        <SpinWheelOverlay
          moverName={state.players.find((p) => p.id === wheelOverlay.playerId)?.name ?? "Player"}
          isController={controlledPlayerIds.includes(wheelOverlay.playerId)}
          spinning={wheelOverlay.segmentIndex !== null ? { segmentIndex: wheelOverlay.segmentIndex } : null}
          phase={wheelOverlay.phase}
          onSpin={handleSpinWheel}
        />
      )}
      <style>{`
        .hud-layer[data-power="off"] {
          filter: grayscale(1) brightness(0.35) contrast(0.9);
          opacity: 0.55;
        }
        .hud-layer[data-power="flicker"] {
          animation: hud-power-flicker ${START_HUD_FLICKER_MS}ms steps(1, end) both;
        }
        .hud-layer[data-power="on"] {
          filter: none;
          opacity: 1;
          transition: filter 0.4s ease, opacity 0.4s ease;
        }
        @keyframes hud-power-flicker {
          0%   { filter: grayscale(1) brightness(0.35); opacity: 0.5; }
          8%   { filter: none; opacity: 1; }
          15%  { filter: grayscale(1) brightness(0.35); opacity: 0.5; }
          24%  { filter: none; opacity: 1; }
          30%  { filter: grayscale(1) brightness(0.3); opacity: 0.4; }
          45%  { filter: none; opacity: 1; }
          55%  { filter: grayscale(1) brightness(0.3); opacity: 0.45; }
          65%  { filter: none; opacity: 1; }
          100% { filter: none; opacity: 1; }
        }
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
        @keyframes damage-flash {
          0% { opacity: 0; }
          15% { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes freeze-flash {
          0% { opacity: 0; transform: scale(0.92); }
          20% { opacity: 1; transform: scale(1); }
          65% { opacity: 1; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.04); }
        }
        @keyframes card-value-pop-out {
          0% { opacity: 1; transform: scale(1); }
          40% { opacity: 1; transform: scale(1.3); }
          100% { opacity: 0; transform: scale(1.5); }
        }
        @keyframes card-value-pop-in {
          0% { opacity: 0; transform: scale(0.4); }
          60% { opacity: 1; transform: scale(1.25); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes card-damage-badge {
          0% { opacity: 0; transform: translateY(0) scale(0.6); }
          20% { opacity: 1; transform: translateY(-6px) scale(1.25); }
          35% { opacity: 1; transform: translateY(-10px) scale(1); }
          100% { opacity: 0; transform: translateY(-34px) scale(1); }
        }
        @keyframes wheel-celebrate-glow {
          0%, 100% { filter: drop-shadow(0 0 26px rgba(34,227,255,0.35)); }
          50% { filter: drop-shadow(0 0 50px rgba(255,242,158,0.9)); }
        }
        @keyframes damage-shake {
          0% { transform: translate(0, 0); }
          10% { transform: translate(-10px, -6px); }
          20% { transform: translate(9px, 7px); }
          30% { transform: translate(-8px, 4px); }
          40% { transform: translate(7px, -6px); }
          50% { transform: translate(-6px, 3px); }
          60% { transform: translate(5px, -4px); }
          70% { transform: translate(-4px, 2px); }
          80% { transform: translate(3px, -2px); }
          90% { transform: translate(-2px, 1px); }
          100% { transform: translate(0, 0); }
        }
      `}</style>
    </div>
  );
}
