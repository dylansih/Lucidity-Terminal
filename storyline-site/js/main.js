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
  92,                                  // wide FOV so the rendered scene fills
  window.innerWidth / window.innerHeight,   // the entire framebuffer; the
  0.1,                                 // fisheye shader then bows it outward
  4000,                                // without leaving paper-bg margins.
);
camera.position.set(0, 0, 0);
camera.rotation.order = 'YXZ';         // yaw, then pitch — no roll

/* -------------------------------------------------------------- */
/* 2. content panels arranged on the inside of a sphere           */
/* -------------------------------------------------------------- */

const RADIUS = 480;                    // distance from camera to panel face

/*  Panel layout — strict rows with uniform angular gaps.

    Each row has its own height; within a row, every panel is the
    same height but widths vary, so the mosaic mixes near-square
    blocks and wide rectangles. Different row heights between rows
    give vertical variety as well.

    HGAP is the angular gap between panels horizontally; VGAP is
    the angular gap between rows vertically. The horizontal walk
    is scaled by 1/cos(pitch) so the perceived gap stays constant
    no matter how high or low the row sits.

    Pitch is kept under ±28° on top and bottom rows so that, after
    the cos-scaled walk, no row's total yaw extent exceeds 360° —
    otherwise panels at the extremes wrap around and overlap. */

const HGAP = 3;   // degrees of angular gap between panels horizontally
const VGAP = 3;   // degrees of angular gap between rows vertically

const ROWS = [
  // top row — short height, mix of small near-square tiles and a few wider ones
  { h: 18, ws: [18, 24, 14, 28, 20, 18, 24, 14, 26, 20, 22, 18] },

  // middle row — tallest, biggest panels, the "hero" band
  { h: 28, ws: [28, 22, 36, 24, 32, 18, 30, 24, 28, 22, 32] },

  // bottom row — short, varied
  { h: 18, ws: [22, 18, 26, 14, 24, 18, 28, 22, 24, 14, 22, 20] },
];

function buildLayout() {
  const totalH = ROWS.reduce((s, r) => s + r.h, 0) + (ROWS.length - 1) * VGAP;
  let pitchTop = totalH / 2;

  const layout = [];
  for (const row of ROWS) {
    const rowPitch = pitchTop - row.h / 2;
    // 1° of yaw at pitch p covers cos(p)° of arc-length, so we walk
    // the yaw cursor faster at higher pitches to keep the perceived
    // gap between panels constant across all rows.
    const yawScale = 1 / Math.cos(THREE.MathUtils.degToRad(rowPitch));

    const sumW = row.ws.reduce((s, w) => s + w, 0);
    const usedYaw = (sumW + row.ws.length * HGAP) * yawScale;

    let yawCursor = -usedYaw / 2 + (HGAP * yawScale) / 2;
    for (const w of row.ws) {
      const scaledW = w * yawScale;
      const yawCenter = yawCursor + scaledW / 2;
      // store the panel's *angular* width (w), not the yaw-scaled one
      // — the panel still appears w° wide on screen; only its centre
      // is shifted to maintain consistent gaps.
      layout.push([yawCenter, rowPitch, w, row.h]);
      yawCursor += scaledW + HGAP * yawScale;
    }
    pitchTop -= row.h + VGAP;
  }
  return layout;
}

const PANEL_LAYOUT = buildLayout();

// Builds a rounded-rectangle Shape centred at (0, 0). Used as the
// outline for ShapeGeometry so panels have softly rounded corners
// instead of the hard 90° angles of THREE.PlaneGeometry.
function roundedRectShape(w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo( w / 2 - r, -h / 2);
  s.quadraticCurveTo( w / 2, -h / 2,  w / 2, -h / 2 + r);
  s.lineTo( w / 2,  h / 2 - r);
  s.quadraticCurveTo( w / 2,  h / 2,  w / 2 - r,  h / 2);
  s.lineTo(-w / 2 + r,  h / 2);
  s.quadraticCurveTo(-w / 2,  h / 2, -w / 2,  h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return s;
}

// Wraps ShapeGeometry and remaps UVs from raw vertex coordinates
// (the three.js default for ShapeGeometry) to a clean [0, 1]² that
// matches the panel's bounding rectangle. Without this, textures
// would tile based on world units instead of fitting the panel.
function buildPanelGeometry(w, h, r) {
  const geom = new THREE.ShapeGeometry(roundedRectShape(w, h, r), 8);
  const pos  = geom.attributes.position;
  const uvs  = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uvs[i * 2]     = (pos.getX(i) + w / 2) / w;
    uvs[i * 2 + 1] = (pos.getY(i) + h / 2) / h;
  }
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geom;
}

// Image list — every panel pulls one of these and cycles through.
// Add or reorder freely; if there are more panels than images, the
// list wraps. Drop new files into /media/ and reference them here.
const IMAGES = [
  'media/DSC00086.jpg',
  'media/DSC00436_2.jpg',
  'media/DSC02977.jpg',
  'media/DSC03353.jpg',
  'media/DSC03383.jpg',
  'media/DSC_0153.jpg',
  'media/IMG_0149.jpg',
  'media/IMG_2219.jpg',
  'media/IMG_3660.jpg',
  'media/IMG_3769.jpg',
  'media/IMG_3834.jpg',
  'media/IMG_3839.jpg',
  'media/IMG_4001.jpg',
  'media/IMG_4936.jpg',
  'media/IMG_5519.jpg',
  'media/IMG_6369.jpg',
];

const textureLoader = new THREE.TextureLoader();

// Loads `url` as a texture and, once the image arrives, configures
// `texture.repeat` / `texture.offset` so the image fills the panel
// using a CSS object-fit:cover style — preserve aspect ratio, crop
// the overflowing axis. Also flips the panel's material to white
// once the image is ready so the texture isn't multiplied dark.
function applyCoverImage(material, url, panelAspect) {
  const tex = textureLoader.load(url, () => {
    const imgAspect = tex.image.width / tex.image.height;
    if (imgAspect > panelAspect) {
      // image wider than panel → crop sides
      const r = panelAspect / imgAspect;
      tex.repeat.set(r, 1);
      tex.offset.set((1 - r) / 2, 0);
    } else {
      // image taller than panel → crop top/bottom
      const r = imgAspect / panelAspect;
      tex.repeat.set(1, r);
      tex.offset.set(0, (1 - r) / 2);
    }
    material.map = tex;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
}

function makePanel(yawDeg, pitchDeg, wDeg, hDeg, url) {
  const yaw   = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);

  // angular size → world-space size at distance RADIUS
  const w = 2 * RADIUS * Math.tan(THREE.MathUtils.degToRad(wDeg / 2));
  const h = 2 * RADIUS * Math.tan(THREE.MathUtils.degToRad(hDeg / 2));

  // ~5% of the smaller side as the corner radius
  const r = Math.min(w, h) * 0.05;
  const geom = buildPanelGeometry(w, h, r);

  // material starts dark (so unloaded panels match the placeholder
  // look). applyCoverImage swaps map + color when the texture lands.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x1a1610,
    side:  THREE.DoubleSide,
  });
  if (url) applyCoverImage(mat, url, w / h);

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
PANEL_LAYOUT.forEach((p, i) => {
  const url = IMAGES[i % IMAGES.length];
  panelGroup.add(makePanel(...p, url));
});
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
  // drag pulls the world with the cursor: dragging right rotates the
  // camera left so on-screen content slides right with the mouse.
  state.targetYaw   += dx * DRAG_SENS;
  state.targetPitch += dy * DRAG_SENS;
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
