/* ==============================================================
   main.js — three.js entry point.

   What this file does, top to bottom:
     1. Sets up renderer / scene / camera (camera sits at the
        centre of the world and only rotates).
     2. Builds a set of blank "content panels" arranged on the
        inside of an imaginary sphere around the camera. Replace
        the placeholder material with images / videos later — the
        layout already mimics the SBS Storyline grid feel.
     3. Adds a faint sphere skin so the empty space behind the
        panels still reads as a curved surface (not the void).
     4. Wires pointer-drag controls that rotate the camera in
        yaw / pitch with smooth follow.
     5. Wires post-processing: fisheye → vintage film.
     6. Runs the render loop and handles resize.
   ============================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass }     from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass }     from 'three/addons/postprocessing/OutputPass.js';
import { FisheyeShader, FilmShader } from './postfx.js';

/* -------------------------------------------------------------- */
/* 1. renderer / scene / camera                                    */
/* -------------------------------------------------------------- */

const PAPER = 0xece4d2;

const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(PAPER, 1);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAPER);

const camera = new THREE.PerspectiveCamera(
  72,                                  // wide-ish FOV — fisheye does the rest
  window.innerWidth / window.innerHeight,
  0.1,
  4000,
);
camera.position.set(0, 0, 0);
camera.rotation.order = 'YXZ';         // yaw, then pitch — no roll

/* -------------------------------------------------------------- */
/* 2. content panels arranged on the inside of a sphere           */
/* -------------------------------------------------------------- */

const RADIUS = 480;                    // distance from camera to panel face

/*  Panel layout — [yawDeg, pitchDeg, widthDeg, heightDeg].
    yaw   = horizontal angle around the camera (negative = left)
    pitch = vertical angle (positive = up)
    width / height are the panel's *angular* size, in degrees.

    The grid loosely mimics the SBS Storyline arrangement: a dense
    band near the equator with a few peeking above and below, so
    panning in any direction always reveals more content. */
const PANEL_LAYOUT = [
  // upper band
  [-95,  22, 26, 18],
  [-55,  26, 22, 16],
  [-15,  20, 28, 20],
  [ 25,  24, 22, 16],
  [ 65,  22, 26, 18],
  [105,  26, 22, 16],

  // central band — the "front" of the wrap-around screen
  [-110,  2, 28, 20],
  [ -75,  4, 22, 16],
  [ -40,  0, 30, 22],
  [  -8,  6, 22, 16],
  [  25,  0, 30, 22],
  [  60,  4, 22, 16],
  [  95,  2, 28, 20],
  [ 130,  6, 22, 16],

  // lower band
  [-100, -22, 26, 18],
  [ -60, -26, 22, 16],
  [ -20, -20, 30, 22],
  [  20, -24, 22, 16],
  [  60, -22, 30, 22],
  [ 100, -26, 22, 16],

  // far behind the user — pannable to
  [ 165,  6, 28, 20],
  [-160,  4, 28, 20],
  [ 175, -22, 26, 18],
  [-150, -22, 26, 18],
];

function makePanel(yawDeg, pitchDeg, wDeg, hDeg) {
  const yaw   = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);

  // angular size → world-space size at distance RADIUS
  const w = 2 * RADIUS * Math.tan(THREE.MathUtils.degToRad(wDeg / 2));
  const h = 2 * RADIUS * Math.tan(THREE.MathUtils.degToRad(hDeg / 2));

  const geom = new THREE.PlaneGeometry(w, h);
  // BLANK content block — flat dark fill, ready to be swapped for
  // a THREE.MeshBasicMaterial({ map: imageOrVideoTexture }) later.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x1a1610,
    side:  THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);

  // place on a sphere of radius RADIUS around the camera
  const x =  RADIUS * Math.cos(pitch) * Math.sin(yaw);
  const y =  RADIUS * Math.sin(pitch);
  const z = -RADIUS * Math.cos(pitch) * Math.cos(yaw);
  mesh.position.set(x, y, z);
  mesh.lookAt(0, 0, 0);                // face the camera at the centre

  return mesh;
}

const panelGroup = new THREE.Group();
PANEL_LAYOUT.forEach(p => panelGroup.add(makePanel(...p)));
scene.add(panelGroup);

/* -------------------------------------------------------------- */
/* 3. faint sphere skin behind the panels                         */
/* -------------------------------------------------------------- */

// A slightly larger sphere rendered from the inside (BackSide) — it
// gives the empty space between panels a curved, textured backdrop
// instead of a flat colour, so the wrap-around feel is preserved
// even when you're looking at gaps.
{
  const skin = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 1.6, 64, 48),
    new THREE.MeshBasicMaterial({
      color: 0xd9cfb6,
      side:  THREE.BackSide,
    }),
  );
  scene.add(skin);
}

/* -------------------------------------------------------------- */
/* 4. pointer-drag camera rotation                                */
/* -------------------------------------------------------------- */

const state = {
  yaw: 0, pitch: 0,                    // current rotation
  targetYaw: 0, targetPitch: 0,        // where the mouse wants us to be
  dragging: false,
  lastX: 0, lastY: 0,
};

const PITCH_LIMIT = THREE.MathUtils.degToRad(45);   // can't look straight up/down
const DRAG_SENS   = 0.0028;

const dom = renderer.domElement;

function onDown(e) {
  state.dragging = true;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  document.body.classList.add('dragging');
  dom.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
  if (!state.dragging) return;
  const dx = e.clientX - state.lastX;
  const dy = e.clientY - state.lastY;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  state.targetYaw   -= dx * DRAG_SENS;
  state.targetPitch -= dy * DRAG_SENS;
  state.targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.targetPitch));
}
function onUp(e) {
  state.dragging = false;
  document.body.classList.remove('dragging');
  dom.releasePointerCapture?.(e.pointerId);
}

dom.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup',   onUp);
window.addEventListener('pointercancel', onUp);
window.addEventListener('dragstart', e => e.preventDefault());

/* -------------------------------------------------------------- */
/* 5. post-processing: fisheye + vintage film                     */
/* -------------------------------------------------------------- */

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const fisheyePass = new ShaderPass(FisheyeShader);
composer.addPass(fisheyePass);

const filmPass = new ShaderPass(FilmShader);
composer.addPass(filmPass);

composer.addPass(new OutputPass());

/* -------------------------------------------------------------- */
/* 6. resize + render loop                                        */
/* -------------------------------------------------------------- */

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  fisheyePass.uniforms.resolution.value.set(w, h);
  filmPass.uniforms.resolution.value.set(w, h);
}
window.addEventListener('resize', onResize);
onResize();

const clock = new THREE.Clock();
function tick() {
  // smooth follow toward target rotation
  state.yaw   += (state.targetYaw   - state.yaw)   * 0.09;
  state.pitch += (state.targetPitch - state.pitch) * 0.09;

  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');

  filmPass.uniforms.time.value = clock.getElapsedTime();

  composer.render();
  requestAnimationFrame(tick);
}
tick();
