"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createDroid, DROID_RING_PULSE_SPEED, type DroidShape } from "@/lib/game/droid";

const DROID_RADIUS = 1;

/** Isolated droid viewer for `/droid` — same droid geometry, lighting
 * language, and bloom pipeline as the board (`Scene.tsx`), but with nothing
 * else in the scene, so tweaks to `createDroid` can be judged without a
 * full game running. Orbit controls are always on (unlike the board, where
 * they're a debug toggle) since free-look is the whole point here. Changing
 * `shape` rebuilds the droid (unlike color/ringActive, which just update
 * the existing one each frame) since it swaps geometry, not just material. */
export default function DroidScene({
  color,
  ringActive,
  shape,
  playerNumber,
}: {
  color: number;
  ringActive: boolean;
  shape: DroidShape;
  playerNumber: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef(color);
  const ringActiveRef = useRef(ringActive);
  const playerNumberRef = useRef(playerNumber);
  colorRef.current = color;
  ringActiveRef.current = ringActive;
  playerNumberRef.current = playerNumber;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020309);

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 0.6, 3.2);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 1.0, 0.22, 0.32);
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    const orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.22));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight.position.set(4, 8, 5);
    scene.add(dirLight);

    const droid = createDroid(colorRef.current, DROID_RADIUS, shape);
    scene.add(droid);

    let frameId: number;
    const animate = () => {
      const now = performance.now();
      droid.userData.setColor(colorRef.current);
      droid.userData.setPlayerNumber(playerNumberRef.current);
      const pulseT = (Math.sin(now * 0.001 * DROID_RING_PULSE_SPEED) + 1) / 2;
      droid.userData.setRingActive(ringActiveRef.current, pulseT);
      orbitControls.update();
      composer.render();
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);

    const handleResize = () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      composer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", handleResize);
      orbitControls.dispose();
      container.removeChild(renderer.domElement);
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const material of materials) material.dispose();
        }
      });
      composer.dispose();
      renderer.dispose();
    };
  }, [shape]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
