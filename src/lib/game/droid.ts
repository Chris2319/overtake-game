import * as THREE from "three";

/** How much brighter (and bigger) the hover ring under a droid glows when
 * "active" vs idle, so it's obvious which one is about to move without
 * adding any new geometry. Pulses gently rather than sitting at a flat
 * boosted value, to draw the eye. */
const RING_INTENSITY_IDLE = 1.0;
const RING_INTENSITY_ACTIVE = 2.4;
const RING_PULSE_AMPLITUDE = 0.8;
const RING_PULSE_SPEED = 3.2;
const RING_SCALE_ACTIVE = 1.35;

export type DroidShape = "orb" | "square" | "triangle";

export const DROID_SHAPES: DroidShape[] = ["orb", "square", "triangle"];

export type DroidHandle = THREE.Group & {
  userData: {
    setColor: (color: number) => void;
    setRingActive: (active: boolean, pulseT: number) => void;
    setPlayerNumber: (n: number) => void;
  };
};

/** How many player-number stripe slots sit in the crown ring — also the max
 * seat number the ring can display (1 stripe lit for P1 up to all 5 for
 * P5). */
export const MAX_PLAYER_NUMBER = 5;

/** Lazily-built, shared matcap lookup for the chassis material below — a
 * canvas-drawn shiny-metal sphere (bright highlight upper-left, falling off
 * to a dark rim) rather than a loaded image asset. Built lazily (not at
 * module scope) since this module can be imported during SSR, where
 * `document` doesn't exist; by the time a droid is actually created we're
 * always in the browser. Shared across every droid instance since the
 * lookup itself doesn't depend on the droid's color. */
let sharedMatcap: THREE.CanvasTexture | null = null;
function getMatcapTexture(): THREE.CanvasTexture {
  if (sharedMatcap) return sharedMatcap;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0e0f13";
  ctx.fillRect(0, 0, size, size);
  const gradient = ctx.createRadialGradient(
    size * 0.35,
    size * 0.32,
    size * 0.02,
    size * 0.5,
    size * 0.5,
    size * 0.62,
  );
  gradient.addColorStop(0, "#6b7180");
  gradient.addColorStop(0.25, "#565c6a");
  gradient.addColorStop(0.55, "#3d4149");
  gradient.addColorStop(0.8, "#22252c");
  gradient.addColorStop(1, "#0e0f13");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  sharedMatcap = new THREE.CanvasTexture(canvas);
  sharedMatcap.colorSpace = THREE.SRGBColorSpace;
  return sharedMatcap;
}

/** Lazily-loaded brushed-metal photo, projected onto the chassis triplanar-
 * style (see `createChassisMaterial`) rather than through the body's own UVs
 * — a plain UV `map` shows a hard seam where the sphere/box/cone's UV island
 * wraps around, since the photo isn't seamless. Sampling it from world-space
 * position instead sidesteps UVs (and their seam) entirely. Lazy for the
 * same SSR reason as the matcap. */
let sharedMetalMap: THREE.Texture | null = null;
function getMetalTexture(): THREE.Texture {
  if (sharedMetalMap) return sharedMetalMap;
  const tex = new THREE.TextureLoader().load("/metal2.png");
  tex.colorSpace = THREE.SRGBColorSpace;
  // Mirrored (not plain) repeat: the photo itself isn't seamless — its left
  // edge is dark, its right edge is a bright highlight — so plain repeat
  // wrapping shows a hard jump/band at every tile boundary. Mirroring makes
  // each wrap continuous (the edges always meet themselves) at the cost of
  // an occasional visible flip, which reads far less like a seam.
  tex.wrapS = THREE.MirroredRepeatWrapping;
  tex.wrapT = THREE.MirroredRepeatWrapping;
  sharedMetalMap = tex;
  return tex;
}

/** Patches any built-in material (matcap, standard, ...) via `onBeforeCompile`
 * (three's supported hook for editing a built-in material's generated
 * shader) so it samples the brushed-metal photo triplanar-style — from three
 * object-space axes, blended by how much each axis's plane faces the local
 * normal — instead of through the mesh's own UVs, which would show a seam
 * since the photo isn't seamless. This lets one texture wrap the chassis
 * (sphere/box/pyramid) and the fins alike with no per-shape UV work and no
 * seam. `cacheKey` must be unique per distinct patch (here, per `scale`) so
 * three's shader-program cache doesn't reuse a compiled program meant for a
 * different scale. */
function applyTriplanarMetal(material: THREE.Material, scale: number, cacheKey: string): void {
  const metalMap = getMetalTexture();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.metalMap = { value: metalMap };
    shader.uniforms.metalScale = { value: scale };

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTriPos = position;\nvTriNormal = normal;",
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D metalMap;\nuniform float metalScale;\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;",
      )
      .replace(
        "#include <map_fragment>",
        `
        {
          vec3 triBlend = pow( abs( normalize( vTriNormal ) ), vec3( 4.0 ) );
          triBlend /= ( triBlend.x + triBlend.y + triBlend.z );
          vec3 texX = texture2D( metalMap, vTriPos.yz * metalScale ).rgb;
          vec3 texY = texture2D( metalMap, vTriPos.xz * metalScale ).rgb;
          vec3 texZ = texture2D( metalMap, vTriPos.xy * metalScale ).rgb;
          vec3 triColor = texX * triBlend.x + texY * triBlend.y + texZ * triBlend.z;
          // metalMap is sRGB-encoded but sampled manually here, bypassing
          // the automatic decode <map_fragment> normally does — decode by
          // hand so it combines correctly with the material's linear color.
          triColor = pow( triColor, vec3( 2.2 ) );
          diffuseColor.rgb *= triColor;
        }
        `,
      );
  };
  // Distinguishes this shader variant in three's program cache from any
  // other material in the scene that doesn't have this patch (or has it at
  // a different scale).
  material.customProgramCacheKey = () => cacheKey;
}

/** Patches a `MeshStandardMaterial` (or subclass) via `onBeforeCompile` to
 * add a fresnel rim glow: an extra emissive boost that grows toward the
 * silhouette edge (grazing viewing angle), on top of whatever lighting the
 * material already receives. This is what sells the visor/ring/stripe glow
 * as glass/energy rather than flat-lit plastic — real glass and light-guide
 * edges brighten sharply at a grazing angle. Reuses the standard material's
 * own `vNormal`/`vViewPosition` varyings (already declared+set by three's
 * built-in shader, not custom ones like `applyTriplanarMetal` needed) and
 * its own `emissive` uniform (already intensity-scaled) as the rim tint, so
 * the rim automatically tracks whatever color `setColor`/`setPlayerNumber`
 * put there — no separate color uniform to keep in sync. `cacheKey` must be
 * unique per distinct `power`/`intensity` pair (see `applyTriplanarMetal`'s
 * doc for why). */
function applyFresnelGlow(
  material: THREE.MeshStandardMaterial,
  power: number,
  intensity: number,
  cacheKey: string,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.fresnelPower = { value: power };
    shader.uniforms.fresnelIntensity = { value: intensity };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float fresnelPower;\nuniform float fresnelIntensity;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `
        #include <emissivemap_fragment>
        {
          float fresnel = pow( 1.0 - clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ), fresnelPower );
          totalEmissiveRadiance += emissive * fresnelIntensity * fresnel;
        }
        `,
      );
  };
  material.customProgramCacheKey = () => cacheKey;
}

/** Chassis material: matcap-shaded, so the metal-sphere lookup above stands
 * in for real studio lighting regardless of the scene's actual lights/bloom
 * pass, with the brushed-metal photo layered on top (see
 * `applyTriplanarMetal`) for surface detail. */
function createChassisMaterial(): THREE.MeshMatcapMaterial {
  const material = new THREE.MeshMatcapMaterial({ matcap: getMatcapTexture() });
  // Texels per object-space unit — the droid's body radius is ~0.2, so a
  // fairly large scale keeps the brushed-metal grain fine rather than
  // stretching one giant smear across the whole chassis.
  applyTriplanarMetal(material, 3.0, "droid-chassis-triplanar");
  return material;
}

/** Body geometry for each droid shape, tuned so all three fill roughly the
 * same footprint (radius `r`) — that lets the visor/band/ring/fin offsets
 * below stay shape-agnostic instead of needing a per-shape layout. */
function createBody(shape: DroidShape, r: number): THREE.BufferGeometry {
  switch (shape) {
    case "square":
      return new THREE.BoxGeometry(r * 1.7, r * 1.7, r * 1.7);
    case "triangle":
      // radialSegments=3 turns the cone into a triangular pyramid; rotated
      // below so a flat face points forward like the sphere/box do.
      return new THREE.ConeGeometry(r * 1.15, r * 2.1, 3);
    case "orb":
    default:
      return new THREE.SphereGeometry(r, 32, 24);
  }
}

/** Builds an annular wedge (inner/outer radius) swept through `arc`,
 * starting at the front (+Z) and curving toward the side (+X). Drawn flat
 * as a 2D annular-sector shape then extruded and rotated upright, so from a
 * top-down view it reads as a curved blade sticking out — like the
 * reference sketch — rather than a flat slab that reads as a pair of
 * glasses head-on. Shared by the quarter-circle visor and the smaller
 * one-fifth player-number stripes below, which are the same shape at a
 * different arc/radius/height. */
function createArcWedgeGeometry(rInner: number, rOuter: number, height: number, arc: number): THREE.BufferGeometry {
  const segments = 16;
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * arc;
    const x = Math.sin(a) * rOuter;
    const y = -Math.cos(a) * rOuter;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = segments; i >= 0; i--) {
    const a = (i / segments) * arc;
    shape.lineTo(Math.sin(a) * rInner, -Math.cos(a) * rInner);
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: segments });
  // The shape above is drawn flat in the XY plane and extruded along Z;
  // rotating it upright turns that extrusion depth into the blade's
  // vertical height, with the arc itself now sweeping front-to-side.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height / 2, 0);
  return geo;
}

/** Builds a small hovering drone-bot: a dark body (sphere, cube, or
 * triangular pyramid, per `shape`) with a glowing visor stripe, belly band,
 * hover ring, and a pair of fin-like stabilizers, in a neon-glass language.
 * Used both as an in-game player token (Scene.tsx) and as a standalone
 * character on the start screen. The visor and belly band share one
 * emissive material so `setColor` recolors (and, for other players, dims)
 * them in one go; the hover ring gets its own material clone so its glow
 * can be boosted independently (see `setRingActive`) without affecting the
 * rest of the bot. Sized/anchored so the body center sits at the group's
 * origin. */
export function createDroid(initialColor: number, radius = 0.22, shape: DroidShape = "orb"): DroidHandle {
  const r = radius;
  const group = new THREE.Group() as DroidHandle;

  const bodyMat = createChassisMaterial();
  const body = new THREE.Mesh(createBody(shape, r), bodyMat);
  if (shape === "triangle") body.rotation.y = Math.PI / 6;
  group.add(body);

  const glowMat = new THREE.MeshStandardMaterial({
    color: initialColor,
    emissive: initialColor,
    emissiveIntensity: 1.0,
    roughness: 0.15,
    metalness: 0.1,
  });
  // Visor/band rim glow: brightens toward the edge like light catching the
  // side of a glass blade, instead of the flat, uniform glow a plain
  // emissive gives.
  applyFresnelGlow(glowMat, 2.5, 1.4, "droid-glow-fresnel");

  // Quarter-circle visor blade, sticking out proud of the body from the
  // front and curving around to the side (see reference top-view sketch),
  // rather than a flat stripe across the face.
  const visor = new THREE.Mesh(createArcWedgeGeometry(r * 0.82, r * 1.0, r * 0.22, Math.PI / 2), glowMat);
  visor.position.set(0, r * 0.18, 0);
  // The 90° arc is built starting from dead-ahead and sweeping to the side,
  // so rotate it back by half that sweep to center it on the front instead
  // of reading as pointed off to one side.
  visor.rotation.y = -Math.PI / 4;
  group.add(visor);

  // Belly band wrapping most of the way around the equator.
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(r * 0.88, r * 0.1, 8, 28, Math.PI * 1.2),
    glowMat,
  );
  band.rotation.x = Math.PI / 2;
  band.rotation.z = Math.PI * 0.9;
  band.position.y = -r * 0.02;
  group.add(band);

  // Hover ring, sitting below the body like a repulsor disc. Own material
  // clone (rather than sharing glowMat) so its glow can be boosted for the
  // active droid independently of the visor/band. `clone()` doesn't carry
  // over `onBeforeCompile`/`customProgramCacheKey` (three's base
  // `Material.copy` doesn't touch either), so the fresnel patch has to be
  // reapplied here rather than inherited from glowMat.
  const ringMat = glowMat.clone();
  applyFresnelGlow(ringMat, 2.5, 1.4, "droid-glow-fresnel");
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.78, r * 0.07, 8, 28), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -r * 1.05;
  group.add(ring);

  // A pair of small angled stabilizer fins, sharing the chassis's own
  // matcap material (rather than a separate MeshStandardMaterial) so they're
  // not just a similar color but genuinely the same lighting-independent
  // shading as the body — a standard material would react to the scene's
  // real (and deliberately dim) lights and never quite match.
  const finMat = bodyMat;
  // The socket each fin rotates around: a dark ball-joint sitting where the
  // fin meets the body, so the fin reads as a separate part plugged into the
  // chassis rather than a box clipped straight into the sphere/cube/pyramid.
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x2c303a,
    emissive: 0x14161c,
    emissiveIntensity: 0.3,
    roughness: 0.35,
    metalness: 0.75,
  });
  const jointR = r * 0.16;
  const jointGeo = new THREE.SphereGeometry(jointR, 16, 12);

  // Trapezoidal fin profile: wide at the root (near the joint), tapering to
  // a narrower rounded tip. Drawn flat in the arm-length/height plane and
  // extruded a short way in depth, so the broad tapered face reads straight
  // toward the camera (matching the droid's front) instead of edge-on.
  const finLen = r * 0.9;
  const finHeight = r * 0.12;
  const finDepth = r * 0.3;
  const finTopHalf = finLen / 2;
  const finBottomHalf = finLen * 0.34;
  const finHalfH = finHeight / 2;
  const finCornerR = finHeight * 0.3;
  const finShape = new THREE.Shape();
  finShape.moveTo(-finBottomHalf, -finHalfH);
  finShape.lineTo(finBottomHalf, -finHalfH);
  finShape.lineTo(finTopHalf, finHalfH - finCornerR);
  finShape.quadraticCurveTo(finTopHalf, finHalfH, finTopHalf - finCornerR, finHalfH);
  finShape.lineTo(-finTopHalf + finCornerR, finHalfH);
  finShape.quadraticCurveTo(-finTopHalf, finHalfH, -finTopHalf, finHalfH - finCornerR);
  finShape.lineTo(-finBottomHalf, -finHalfH);
  const finGeo = new THREE.ExtrudeGeometry(finShape, {
    depth: finDepth,
    bevelEnabled: false,
    curveSegments: 8,
  });
  finGeo.translate(0, 0, -finDepth / 2);
  // The flat extrude alone only tapers the X/Y silhouette (correct from the
  // front), leaving a constant-depth slab that reads as a plain rectangle
  // from the side. Scale each vertex's depth by the same top/bottom ratio
  // as the width, so the blade also narrows in depth from tip to root —
  // a true wedge, tapered from every angle, not just face-on.
  const finBottomDepthScale = finBottomHalf / finTopHalf;
  const finPos = finGeo.attributes.position;
  for (let i = 0; i < finPos.count; i++) {
    const y = finPos.getY(i);
    const t = (y + finHalfH) / finHeight;
    const depthScale = THREE.MathUtils.lerp(finBottomDepthScale, 1, t);
    finPos.setZ(i, finPos.getZ(i) * depthScale);
  }
  finPos.needsUpdate = true;
  finGeo.computeVertexNormals();

  // Each wing is a pivot group anchored at the joint (on the body's
  // shoulder), holding the joint ball at its origin and the fin offset
  // outward from it. Rotating the pivot (future animation) swings the fin
  // around the ball joint instead of around the body's own center.
  function createWing(side: 1 | -1): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(side * r * 0.95, r * 0.05, 0);
    pivot.rotation.z = side * (Math.PI * 0.12 - Math.PI / 2);

    const joint = new THREE.Mesh(jointGeo, jointMat);
    pivot.add(joint);

    // The fin rests on top of the joint ball, root end overlapping it,
    // extending outward from there — like an arm resting on a shoulder,
    // rather than sitting beside it at the same height.
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.set(side * r * 0.27, jointR * 0.85, 0);
    pivot.add(fin);

    return pivot;
  }
  group.add(createWing(-1));
  group.add(createWing(1));

  // Player-number stripes: up to MAX_PLAYER_NUMBER curved bars stacked front
  // to back across the TOP of the head, like rungs running from the crown
  // down toward the visor — each individual bar already curves left/right
  // with the head (the same annular-wedge shape the visor uses), and the
  // bars are stacked by walking that curve's mount point back along the
  // crown, NOT by fanning copies side by side at one spot (that read as a
  // single row of teeth sticking out of the face). All slots always exist;
  // `setPlayerNumber` lights up the first N in the droid's own color and
  // leaves the rest dim, so the droid reads at a glance as "seat N of 5" —
  // e.g. P1 gets one lit stripe, P5 gets all five.
  const stripeArc = Math.PI / 3;
  const stripeGeo = createArcWedgeGeometry(r * 0.87, r * 1.03, r * 0.08, stripeArc);
  // Center the wedge's curve on its own local +Z axis (rather than starting
  // there), so aiming that axis at the mount direction below points the
  // bar's middle outward instead of one edge of its sweep.
  stripeGeo.rotateY(-stripeArc / 2);
  const stripeAxis = new THREE.Vector3(0, 0, 1);
  // Row tilt, measured from straight up, walking from near the back of the
  // crown (small tilt) forward toward the visor (larger tilt) — this is what
  // stacks the rows front-to-back, distinct from the wedge's own built-in
  // left/right curve.
  const stripeRowTiltMin = Math.PI / 18;
  const stripeRowTiltMax = Math.PI / 4.1;
  // The whole stack is built centered on the front meridian (same as the
  // visor) and then swung back as one unit around the body's X axis, so it
  // lands squarely on the crown clear of the visor instead of spilling down
  // the front — moving the group here shifts every row together rather than
  // needing each row's tilt retuned individually.
  const stripeGroup = new THREE.Group();
  // Counter-rotate by the middle row's own tilt so the middle (3rd of 5)
  // stripe lands exactly at the top, with the rest fanning symmetrically
  // fore/aft around it.
  stripeGroup.rotation.x = -THREE.MathUtils.lerp(stripeRowTiltMin, stripeRowTiltMax, 0.5);
  // Spin the already-correct stack 90° around the vertical axis, as an outer
  // wrapper (rather than a second rotation on stripeGroup itself) so it just
  // reorients the finished assembly instead of interacting with the tilt
  // above — the rows now run side-to-side across the crown instead of
  // front-to-back.
  const stripeSpinGroup = new THREE.Group();
  stripeSpinGroup.rotation.y = Math.PI / 2;
  stripeSpinGroup.add(stripeGroup);
  const stripeDimColor = 0x2c303a;
  const stripeMats: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < MAX_PLAYER_NUMBER; i++) {
    const t = i / (MAX_PLAYER_NUMBER - 1);
    const tilt = THREE.MathUtils.lerp(stripeRowTiltMin, stripeRowTiltMax, t);
    const stripeMat = new THREE.MeshStandardMaterial({
      color: stripeDimColor,
      emissive: stripeDimColor,
      emissiveIntensity: 0.3,
      roughness: 0.15,
      metalness: 0.2,
    });
    applyFresnelGlow(stripeMat, 2.5, 1.4, "droid-glow-fresnel");
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    // Direction from the body center through this row's mount point: always
    // centered left/right (no azimuth component — the wedge's own curve
    // already supplies the left/right sweep), walking from the back of the
    // crown toward the front as tilt increases. The wedge geometry already
    // spans the right radial range around the origin, so aiming its axis is
    // all that's needed — no separate position offset.
    const dir = new THREE.Vector3(0, Math.cos(tilt), Math.sin(tilt));
    stripe.quaternion.setFromUnitVectors(stripeAxis, dir);
    stripeGroup.add(stripe);
    stripeMats.push(stripeMat);
  }
  group.add(stripeSpinGroup);

  // Lighting order (by stripe index, 0 = back-most row, MAX-1 = front-most)
  // for `setPlayerNumber`: starts at the middle row and works outward —
  // middle, then next-front, then next-back, then front, then back — so the
  // lit count grows from the center of the crown rather than sweeping
  // straight across in physical order.
  const stripeLightOrder = [2, 3, 1, 0, 4];

  // Tracked so setColor (which can fire independently of setPlayerNumber,
  // e.g. every frame in the game scene) knows how many stripes are
  // currently lit and re-applies the new color to just those.
  let litStripeCount = 0;
  const applyStripeColor = (color: number) => {
    const litIndices = new Set(stripeLightOrder.slice(0, litStripeCount));
    stripeMats.forEach((mat, i) => {
      if (litIndices.has(i)) {
        mat.color.set(color);
        mat.emissive.set(color);
        mat.emissiveIntensity = 1.0;
      } else {
        mat.color.set(stripeDimColor);
        mat.emissive.set(stripeDimColor);
        mat.emissiveIntensity = 0.3;
      }
    });
  };

  group.userData.setColor = (color: number) => {
    glowMat.color.set(color);
    glowMat.emissive.set(color);
    ringMat.color.set(color);
    ringMat.emissive.set(color);
    applyStripeColor(color);
  };

  group.userData.setPlayerNumber = (n: number) => {
    litStripeCount = THREE.MathUtils.clamp(Math.round(n), 0, MAX_PLAYER_NUMBER);
    applyStripeColor(glowMat.color.getHex());
  };

  // Drives the hover ring's glow/size each frame: `pulseT` (0-1, typically a
  // sine wave) only matters while `active`, letting the caller keep every
  // droid's ring in sync with one shared clock instead of each animating on
  // its own.
  group.userData.setRingActive = (active: boolean, pulseT: number) => {
    ringMat.emissiveIntensity = active
      ? RING_INTENSITY_ACTIVE + pulseT * RING_PULSE_AMPLITUDE
      : RING_INTENSITY_IDLE;
    const scale = active ? RING_SCALE_ACTIVE : 1;
    ring.scale.set(scale, scale, scale);
  };

  return group;
}

export const DROID_RING_PULSE_SPEED = RING_PULSE_SPEED;
