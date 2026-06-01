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
  // top — wider rectangles, hero scale (10 panels)
  { y:  240, h: 160, ws: [180, 130, 220, 160, 200, 175, 140, 190, 170, 210] },

  // upper middle — shorter, denser (9 panels)
  { y:   72, h: 120, ws: [220, 160, 280, 200, 200, 160, 240, 180, 220] },

  // lower middle — shorter, denser (9 panels)
  { y:  -72, h: 120, ws: [200, 240, 160, 220, 180, 260, 230, 140, 200] },

  // bottom — mirrors the top in scale (10 panels)
  { y: -240, h: 160, ws: [180, 220, 150, 200, 175, 170, 220, 140, 200, 190] },
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

/* Curved-panel geometry.

   Earlier each panel was a flat ShapeGeometry rounded rectangle
   that we tilted to face the origin. That made the cylinder of
   panels read as a faceted polygon — neighbours met at visible
   chord angles, especially along the top and bottom edges where
   the silhouette of the row stair-stepped.

   Now every panel is a tessellated strip that physically curves
   along the same cylinder of radius R that the panels live on.
   In the panel's local frame the cylinder axis sits at
   (0, *, R) — i.e. R units in front of the flat rectangle. We
   bend each vertex around that axis:

     φ      = x / R              (arc parameter along cylinder)
     bent_x = R · sin(φ)
     bent_z = R · (1 − cos(φ))

   so the two side edges of one panel lie on the same cylindrical
   arc as the matching side of its neighbour. Tangents agree at
   the seam → no visible angle break. Spacing along the cylinder
   stays uniform because we still walk arc length when laying out
   panels (see buildLayout).

   Rectangular grid + alpha mask gives us the rounded-corner look
   without having to triangulate a rounded-rect outline (which
   would leave the interior un-tessellated and unable to bend
   smoothly). NX is high enough that within a single panel the
   bend looks continuous; NY can stay tiny because the panel is
   not curved vertically. */
const PANEL_NX = 24;
const PANEL_NY = 2;

function buildCurvedPanelGeometry(w, h, R) {
  const nx = PANEL_NX;
  const ny = PANEL_NY;
  const vCount = (nx + 1) * (ny + 1);
  const positions = new Float32Array(vCount * 3);
  const uvs       = new Float32Array(vCount * 2);

  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    const y = (v - 0.5) * h;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const x = (u - 0.5) * w;

      const phi = x / R;
      const bx = R * Math.sin(phi);
      const bz = R * (1 - Math.cos(phi));

      const k = (j * (nx + 1) + i) * 3;
      positions[k]     = bx;
      positions[k + 1] = y;
      positions[k + 2] = bz;

      const uk = (j * (nx + 1) + i) * 2;
      uvs[uk]     = u;
      uvs[uk + 1] = v;
    }
  }

  const indices = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + (nx + 1);
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/* Per-panel canvas alpha mask: white rounded rectangle on transparent.
   Sized to match the panel's aspect so the corner curves stay circular
   instead of stretching into ellipses. */
function buildRoundedAlphaTexture(w, h, r) {
  const LONG = 256;
  const cw = w >= h ? LONG : Math.round(LONG * (w / h));
  const ch = h >  w ? LONG : Math.round(LONG * (h / w));
  const canvas = document.createElement('canvas');
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const pr = r * (cw / w);                      // world radius → px

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(pr, 0);
  ctx.lineTo(cw - pr, 0);
  ctx.quadraticCurveTo(cw, 0, cw, pr);
  ctx.lineTo(cw, ch - pr);
  ctx.quadraticCurveTo(cw, ch, cw - pr, ch);
  ctx.lineTo(pr, ch);
  ctx.quadraticCurveTo(0, ch, 0, ch - pr);
  ctx.lineTo(0, pr);
  ctx.quadraticCurveTo(0, 0, pr, 0);
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
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
  'media/IMG_5012.jpg',
  'media/IMG_5013.jpg',
  'media/IMG_5014.jpg',
  'media/IMG_5015.jpg',
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

  const geom = buildCurvedPanelGeometry(w, h, RADIUS);

  // material starts dark (so unloaded panels match the placeholder
  // look). applyCoverImage swaps map + color when the texture lands.
  // alphaTest 0.5 turns the rounded-rect mask into a clean cutout —
  // no transparency-sort artefacts against the cylinder skin behind.
  const mat = new THREE.MeshBasicMaterial({
    color:        0x1a1610,
    side:         THREE.DoubleSide,
    alphaMap:     buildRoundedAlphaTexture(w, h, r),
    transparent:  true,
    alphaTest:    0.5,
  });
  if (url) applyCoverImage(mat, url, w / h);

  const mesh = new THREE.Mesh(geom, mat);

  // place on a vertical cylinder of radius RADIUS — the Y position
  // comes straight from the row, no pitch math. The panel's curved
  // local geometry was built around a bend axis at local (0, 0, R),
  // which after lookAt(origin) lines up exactly with the world Y
  // axis at this row's height — so the panel's left/right edges sit
  // on the same cylinder its neighbours sit on, with no chord break.
  mesh.position.set(
     RADIUS * Math.sin(yaw),
     y,
    -RADIUS * Math.cos(yaw),
  );
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
/* 2b. Lucidity Terminal — diegetic text plane                     */
/* -------------------------------------------------------------- */

/* The text used to live as a fixed HTML overlay. That meant it
   sat on top of the rendered canvas, never moved when the user
   panned, and skipped the fisheye + film passes. Now it lives
   inside the scene as a textured plane: it pans with the world,
   barrel-distorts at the screen edges, and picks up the same
   sepia/grain/scanlines as everything else.

   The plane sits on the same cylinder as the photo panels but at
   yaw 180° — the back of the dome — where the rows leave a wide
   empty arc. The user discovers it by dragging to look behind. */

function buildTerminalCanvas() {
  // Canvas is laid out around the natural width of the title at
  // a chosen font size; every body line then wraps to that exact
  // pixel width. So as long as the title fits, every other line
  // is guaranteed to stay within the title's measured width — the
  // user-flagged "long sentences spilling past the headline" can't
  // happen by construction.
  const TITLE     = 'THE LUCIDITY TERMINAL';
  const PARAGRAPHS = [
    'Life review. The phenomenon where your lives flash before your eyes, your mind replaying significant emotional events and memories. But why wait. Why wait until the end, when it’s too late to share it all with the world.',
    'So much to learn, so much to feel, so many stories, so many lives lived in one. This is a peak into my life, my stories, my people and the places I’ve been.',
  ];
  const WELCOME = 'Welcome to my terminal.';

  const TITLE_FONT = '600 132px "Neue Television", "Anton", "Bebas Neue", sans-serif';
  const BODY_FONT  = '32px "Times New Roman", Georgia, serif';
  const WELCOME_FONT = 'italic 34px "Times New Roman", Georgia, serif';

  // first pass: measure title to size the canvas
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = TITLE_FONT;
  const titleW = probe.measureText(TITLE).width;

  const PAD_X = 40;
  const PAD_Y = 40;
  const TITLE_BODY_GAP = 22;          // matches the inter-paragraph gap
  const PARA_GAP = 22;
  const LINE_H = 44;
  const WRAP_W = titleW;                          // body lines wrap to title width

  // measure body height by simulating wrap
  function wrapLines(text, font) {
    probe.font = font;
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (probe.measureText(test).width > WRAP_W) {
        if (line) lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  const bodyBlocks = PARAGRAPHS.map(p => wrapLines(p, BODY_FONT));
  const welcomeLines = wrapLines(WELCOME, WELCOME_FONT);

  let bodyH = 0;
  for (const block of bodyBlocks) bodyH += block.length * LINE_H + PARA_GAP;
  bodyH += LINE_H * welcomeLines.length;          // welcome trailing block
  bodyH += PARA_GAP * 1.4;                         // extra breathing room before welcome

  const canvasW = Math.ceil(titleW + PAD_X * 2);
  const canvasH = Math.ceil(PAD_Y * 2 + 132 + TITLE_BODY_GAP + bodyH);

  // upscale for crispness; the GPU will downsample when texturing
  const DPR = 2;
  const canvas = document.createElement('canvas');
  canvas.width  = canvasW * DPR;
  canvas.height = canvasH * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // soft halo so the text reads if anything ever ends up behind it
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur  = 14;
  ctx.fillStyle   = '#e8e4dc';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'top';

  // title
  ctx.font = TITLE_FONT;
  let y = PAD_Y;
  ctx.fillText(TITLE, canvasW / 2, y);
  y += 132 + TITLE_BODY_GAP;

  // body paragraphs
  ctx.font = BODY_FONT;
  for (const block of bodyBlocks) {
    for (const line of block) {
      ctx.fillText(line, canvasW / 2, y);
      y += LINE_H;
    }
    y += PARA_GAP;
  }

  // welcome (italic, slight extra gap)
  y += PARA_GAP * 0.4;
  ctx.font = WELCOME_FONT;
  for (const line of welcomeLines) {
    ctx.fillText(line, canvasW / 2, y);
    y += LINE_H;
  }

  return { canvas, canvasW, canvasH };
}

function addTerminalSign() {
  const { canvas, canvasW, canvasH } = buildTerminalCanvas();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  // world size — keep the plane comparable to a hero panel while
  // matching the canvas aspect ratio, so the bitmap is never stretched
  const planeW = 520;
  const planeH = planeW * (canvasH / canvasW);

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // Curved like the photo panels so the back of the dome reads as
  // one continuous surface, not a flat sign on a curved wall.
  const mesh = new THREE.Mesh(
    buildCurvedPanelGeometry(planeW, planeH, RADIUS),
    mat,
  );

  // sit on the same cylinder as the photo panels, yaw 180° (behind),
  // y 0 (centred vertically), facing the camera at the origin
  const yaw = Math.PI;
  mesh.position.set(
     RADIUS * Math.sin(yaw),
     0,
    -RADIUS * Math.cos(yaw),
  );
  mesh.lookAt(0, 0, 0);
  scene.add(mesh);

  // rebuild once webfonts arrive, in case the first paint used a fallback
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      const rebuilt = buildTerminalCanvas();
      mat.map.image = rebuilt.canvas;
      mat.map.needsUpdate = true;
      // resize the plane in case the title's measured width shifted
      const newH = planeW * (rebuilt.canvasH / rebuilt.canvasW);
      mesh.geometry.dispose();
      mesh.geometry = buildCurvedPanelGeometry(planeW, newH, RADIUS);
    });
  }
}
addTerminalSign();

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

// Start the camera facing the terminal sign on the back of the
// cylinder (yaw 180°), so the title + paragraphs are the first thing
// the visitor sees. Dragging then walks them around to the photos.
const state = {
  yaw: Math.PI, pitch: 0,                    // current rotation
  targetYaw: Math.PI, targetPitch: 0,        // where the mouse wants us to be
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
