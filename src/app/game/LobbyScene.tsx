"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { createDroid, DROID_RING_PULSE_SPEED } from "@/lib/game/droid";

const DROID_RADIUS = 0.75;
/** Slow spin in place — a turntable/hero-shot feel rather than the start
 * screen's orbit-the-camera "attract mode" (there's no room to drag the
 * camera around here without swinging the droid behind the lobby panel). */
const SPIN_SPEED = 0.12;
/** How far right of the droid (world units) the camera aims, which is what
 * pushes the droid left of screen-center — not all the way to center, since
 * the lobby panel only takes the *window's* right edge, and the droid needs
 * to sit centered under the title within the narrower "stage" region to its
 * left (window width minus the panel), whose own midpoint sits left of the
 * window's true center. */
const LOOK_OFFSET_X = 0.8;
const PLATFORM_Y = -1.15;

/** Big single hero droid standing in for the start screen's row of small
 * ones — this is the "meet your droid" beat of the lobby, so one large,
 * clearly-lit droid reads better than a crowd. Static camera (no orbit
 * controls): the point is a stable composition the lobby panel can sit
 * beside, not something the player fiddles with. */
export default function LobbyScene({ color, playerNumber }: { color: number; playerNumber: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef(color);
  const playerNumberRef = useRef(playerNumber);
  colorRef.current = color;
  playerNumberRef.current = playerNumber;

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

    const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 0.9, 6.4);
    camera.lookAt(LOOK_OFFSET_X, 0.3, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.75,
      0.24,
      0.35,
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
    dirLight.position.set(3, 8, 5);
    scene.add(dirLight);

    const platformGroup = new THREE.Group();
    platformGroup.position.y = PLATFORM_Y;
    scene.add(platformGroup);

    const platformMat = new THREE.MeshStandardMaterial({ color: 0x0a0e18, roughness: 0.35, metalness: 0.6 });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.2, 48), platformMat);
    platformGroup.add(platform);

    const rimMat = new THREE.MeshStandardMaterial({
      color: colorRef.current,
      emissive: colorRef.current,
      emissiveIntensity: 0.8,
      roughness: 0.3,
      metalness: 0.2,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.035, 8, 48), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.1;
    platformGroup.add(rim);

    const droid = createDroid(colorRef.current, DROID_RADIUS);
    droid.position.y = 0.1 + DROID_RADIUS * 1.05;
    platformGroup.add(droid);

    let frameId = 0;
    const animate = () => {
      const now = performance.now();
      droid.userData.setColor(colorRef.current);
      droid.userData.setPlayerNumber(playerNumberRef.current);
      rimMat.color.set(colorRef.current);
      rimMat.emissive.set(colorRef.current);
      droid.rotation.y += SPIN_SPEED * 0.016;
      const pulseT = (Math.sin(now * 0.001 * DROID_RING_PULSE_SPEED) + 1) / 2;
      droid.userData.setRingActive(true, pulseT);
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
