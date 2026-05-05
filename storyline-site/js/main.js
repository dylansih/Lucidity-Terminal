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

const PAPER = 0x0a0a0a;

const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(PAPER, 1);
app.appendChild(renderer.domElement);

// Max anisotropy the GPU supports — typically 16. Without this,
// textures on panels viewed at oblique angles (the ones that hug
// the left/right edges of a wide viewport) get sampled along their
// foreshortened axis with too few taps, producing horizontal motion-
// blur-style streaks. Anisotropic filtering takes more samples along
// that axis and the streaks disappear.
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(PAPER);

// Vertical FOV chosen so the middle row plus the inner half of each
// neighbouring row is visible at rest. Top/bottom row centres sit at
// ±26° pitch (see ROWS below); 56° vertical FOV reaches ±28° so we
// just clip into those rows. The user pans to discover the rest.
// A narrower FOV also keeps panels off the extreme oblique angles
// that previously stretched into thin slivers at the screen edges.
const camera = new THREE.PerspectiveCamera(
  56,
  window.innerWidth / window.innerHeight,
  0.1,
  4000,
);
camera.position.set(0, 0, 0);
camera.rotation.order = 'YXZ';         // yaw, then pitch — no roll

/* -------------------------------------------------------------- */
/* 2. content panels arranged on the inside of a vertical cylinder */
/* -------------------------------------------------------------- */

const RADIUS = 480;                    // distance from camera to panel face

/*  Panel layout — strict horizontal rows on a vertical cylinder.

    Earlier versions placed panels on a sphere with each panel
    facing the camera at the origin, which tilted top and bottom
    rows back toward the viewer. The result: adjacent panels at
    the corners of a row had visibly different angles, and the
    gap between two neighbours was a wedge rather than a uniform
    strip — see the second screenshot the user flagged.

    Now every panel sits on a vertical cylinder of radius RADIUS
    and is rotated only around the world Y axis (no pitch tilt),
    so it shares world-up with its neighbours. Adjacent panels in
    a row have perfectly aligned top and bottom edges; the only
    visual variation comes from the camera projection and the
    fisheye shader, which is exactly the SBS Storyline look.

    Each row stores:
      y  — vertical position of the row's centre (world units)
      h  — panel height for the row (world units)
      ws — list of panel widths (world units), one per panel

    HGAP is the gap between panels along the cylinder's arc, in
    world units, so the perceived gap stays constant regardless
    of the row's height. */

const HGAP = 14;

const ROWS = [
  // top — wider rectangles, hero scale
  { y:  240, h: 160, ws: [180, 130, 220, 160, 200, 140, 190, 170, 210] },

  // upper middle — shorter, denser
  { y:   72, h: 120, ws: [220, 160, 280, 200, 160, 240, 180, 220] },

  // lower middle — shorter, denser
  { y:  -72, h: 120, ws: [200, 240, 160, 220, 180, 260, 140, 200] },

  // bottom — mirrors the top in scale
  { y: -240, h: 160, ws: [180, 220, 150, 200, 170, 220, 140, 200, 190] },
];

function buildLayout() {
  const layout = [];
  for (const row of ROWS) {
    const totalArc =
      row.ws.reduce((s, w) => s + w, 0) + row.ws.length * HGAP;

    // arc cursor walks along the cylinder surface in world units;
    // dividing by RADIUS converts arc length to yaw (radians).
    let arcCursor = -totalArc / 2 + HGAP / 2;
    for (const w of row.ws) {
      const arcCenter = arcCursor + w / 2;
      const yawDeg = THREE.MathUtils.radToDeg(arcCenter / RADIUS);
      layout.push([yawDeg, row.y, w, row.h]);
      arcCursor += w + HGAP;
    }
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
  'media/IMG_3660.jpg',
  'media/DSC00086.jpg',
  'media/IMG_9779.jpg',
  'media/IMG_3839.jpg',
  'media/IMG_2652.jpg',
  'media/IMG_4001.jpg',
  'media/XGY_2735.jpg',
  'media/DSC03353.jpg',
  'media/IMG_0697.jpg',
  'media/IMG_5519.jpg',
  'media/DSC02977.jpg',
  'media/IMG_2331.jpg',
  'media/IMG_1731.jpg',
  'media/IMG_2219.jpg',
  'media/IMG_4136.jpg',
  'media/DSC_0153.jpg',
  'media/IMG_8360.jpg',
  'media/IMG_3769.jpg',
  'media/IMG_9776.jpg',
  'media/IMG_4936.jpg',
  'media/102_1643.jpg',
  'media/IMG_0171.jpg',
  'media/IMG_6369.jpg',
  'media/IMG_2655.jpg',
  'media/DSC03383.jpg',
  'media/IMG_3834.jpg',
  'media/P1070516.jpg',
  'media/IMG_1370.jpg',
  'media/DSC00436_2.jpg',
  'media/IMG_6986.jpg',
  'media/XGY_2723_2.jpg',
  'media/IMG_0149.jpg',
  'media/IMG_9609.jpg',
  'media/IMG_0110.jpg',
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
  tex.anisotropy = MAX_ANISO;
}

function makePanel(yawDeg, y, w, h, url) {
  const yaw = THREE.MathUtils.degToRad(yawDeg);

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

  // place on a vertical cylinder of radius RADIUS — the Y position
  // comes straight from the row, no pitch math.
  mesh.position.set(
     RADIUS * Math.sin(yaw),
     y,
    -RADIUS * Math.cos(yaw),
  );
  // face the central vertical axis at the same height: rotates only
  // around world Y, so the panel stays upright and adjacent panels
  // in the row share a perfectly aligned top and bottom edge.
  mesh.lookAt(0, y, 0);

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
      color: 0x141414,
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
