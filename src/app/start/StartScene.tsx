"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createDroid } from "@/lib/game/droid";

/** Slow ambient spin so the skyline drifts even before the player touches
 * anything, same idea as a title-screen "attract mode". Paused the instant
 * a drag starts (see the OrbitControls "start"/"end" listeners below) so it
 * never fights the player's own look-around. */
const AUTO_ROTATE_SPEED = -0.4;
const PLATFORM_RADIUS = 3.2;
/** Pushes the platform (and everything standing on it) down in world space
 * so more of the skyline shows above it in frame, per the concept art. */
const PLATFORM_Y = -2.8;
const CAMERA_FOV_DEG = 45;
const DROID_RADIUS = 0.42;

const DROID_CYAN = 0x22e3ff;
const DROID_PINK = 0xff2d95;

/** Standing positions for the start-screen droids, one per hex platform
 * corner. `CylinderGeometry`'s `radialSegments: 6` puts its actual vertices
 * at 60° increments starting from 0° (see three.js's CylinderGeometry vertex
 * generation: theta = (segmentIndex / radialSegments) * 2π), so the six
 * corners are 0/60/120/180/240/300°, squared up to look straight at the
 * center. Distance is inset from `PLATFORM_RADIUS` by roughly the droid's
 * own footprint so its body stands on the platform surface instead of
 * hanging out past the edge (a droid centered AT the radius would have half
 * its body floating off the hex's actual corner point). Given as (angle from
 * straight-ahead in degrees, distance from platform center, team color). */
const CORNER_DROID_DISTANCE = PLATFORM_RADIUS - DROID_RADIUS * 1.2;

const DROID_LAYOUT: { angleDeg: number; distance: number; color: number; playerNumber: number }[] = [
  { angleDeg: 0, distance: CORNER_DROID_DISTANCE, color: DROID_PINK, playerNumber: 1 },
  { angleDeg: 60, distance: CORNER_DROID_DISTANCE, color: DROID_CYAN, playerNumber: 1 },
  { angleDeg: 120, distance: CORNER_DROID_DISTANCE, color: DROID_PINK, playerNumber: 2 },
  { angleDeg: 180, distance: CORNER_DROID_DISTANCE, color: DROID_CYAN, playerNumber: 2 },
  { angleDeg: 240, distance: CORNER_DROID_DISTANCE, color: DROID_PINK, playerNumber: 3 },
  { angleDeg: 300, distance: CORNER_DROID_DISTANCE, color: DROID_CYAN, playerNumber: 3 },
];

/** Renders the same neon night-city skybox and lighting/bloom setup used by
 * the in-game `Scene`, minus any game state — just a hex platform to stand
 * the start-screen droids on, orbited slowly for an "attract mode" feel.
 * Kept as its own standalone three.js mount (rather than reusing `Scene`
 * directly) since it has no board/players to render. */
export default function StartScene() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020309);
    const bgTexture = new THREE.TextureLoader().load("/background360.png", (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      scene.background = texture;
    });

    const camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 1.4, 9);
    camera.lookAt(0, PLATFORM_Y + 0.5, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Same bloom recipe as the in-game Scene, so the neon rim/city lights
    // glow rather than reading as flat bright color.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.7,
      0.22,
      0.4,
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.minDistance = 6;
    controls.maxDistance = 13;
    controls.minPolarAngle = Math.PI * 0.28;
    controls.maxPolarAngle = Math.PI * 0.52;
    controls.autoRotate = true;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    controls.target.set(0, PLATFORM_Y + 0.5, 0);
    const handleDragStart = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener("start", handleDragStart);

    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight.position.set(4, 8, 5);
    scene.add(dirLight);

    // A hex platform to anchor the scene visually, standing the start-screen
    // droids on. Grouped so the platform, its rim, and the droids all move
    // together as one unit.
    const platformGroup = new THREE.Group();
    platformGroup.position.y = PLATFORM_Y;
    scene.add(platformGroup);

    const platformMat = new THREE.MeshStandardMaterial({
      color: 0x0a0e18,
      roughness: 0.35,
      metalness: 0.6,
    });
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS, 0.2, 6),
      platformMat,
    );
    platformGroup.add(platform);

    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x22e3ff,
      emissive: 0x22e3ff,
      emissiveIntensity: 0.7,
      roughness: 0.3,
      metalness: 0.2,
    });
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(PLATFORM_RADIUS, 0.04, 8, 6),
      rimMat,
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.1;
    rim.rotation.z = Math.PI / 6;
    platformGroup.add(rim);

    // One start-screen droid per hex platform corner (see DROID_LAYOUT).
    // Their hover ring pulses gently, same idle animation as an in-game
    // token's active-turn glow, just always on here rather than gated by
    // whose turn it is.
    const droids = DROID_LAYOUT.map(({ angleDeg, distance, color, playerNumber }) => {
      const droid = createDroid(color, DROID_RADIUS);
      const angleRad = THREE.MathUtils.degToRad(angleDeg);
      droid.position.set(
        Math.sin(angleRad) * distance,
        0.1 + DROID_RADIUS * 1.05,
        Math.cos(angleRad) * distance,
      );
      // Turn a full 180 from its outward-facing radial default, so it looks
      // straight back at the platform center.
      droid.rotation.y = angleRad + Math.PI;
      // Light up each droid's crown stripes to match its seat number, same
      // as the in-game player token, so the two three-player teams read as
      // seats 1-3 rather than three identical droids per color.
      droid.userData.setPlayerNumber(playerNumber);
      platformGroup.add(droid);
      return droid;
    });

    for (const droid of droids) droid.userData.setRingActive(false, 0);

    let frameId = 0;
    const animate = () => {
      controls.update();
      composer.render();
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      composer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      controls.removeEventListener("start", handleDragStart);
      controls.dispose();
      container.removeChild(renderer.domElement);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of materials) material.dispose();
        }
      });
      bgTexture.dispose();
      composer.dispose();
      renderer.dispose();
    };
  }, []);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
