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

/* 2×5 cover layout.
   Each panel is the size of ~four of the old small photo panels —
   wide enough to read as a hero, tall enough to span what used to be
   two rows. The two rows together cover the same vertical extent as
   the old four-row grid (≈ ±320 y), and the per-row arc roughly
   matches the old top row's arc, so the dome footprint is unchanged. */
const ROWS = [
  // top row — covers 1–5
  { y:  166, h: 305, ws: [370, 370, 370, 370, 370] },
  // bottom row — covers 6–10
  { y: -166, h: 305, ws: [370, 370, 370, 370, 370] },
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

// 10 hero covers, top row (1–5) then bottom row (6–10). Order in the
// array matches PANEL_LAYOUT order (buildLayout walks ROWS top → down,
// left → right within each row), so cover-01 lands top-left, cover-05
// top-right, cover-06 bottom-left, cover-10 bottom-right.
const IMAGES = [
  'media/cover-01.jpg',
  'media/cover-02.jpg',
  'media/cover-03.jpg',
  'media/cover-04.jpg',
  'media/cover-05.jpg',
  'media/cover-06.jpg',
  'media/cover-07.jpg',
  'media/cover-08.jpg',
  'media/cover-09.jpg',
  'media/cover-10.jpg',
];

const textureLoader = new THREE.TextureLoader();

/* Per-image source-pixel Y shift for the cover crop.
   The default crop centres the source image in the panel; for a few
   portrait covers the subject sits near the very bottom of the source
   (cat in cover-05, sheep in cover-08), and the centred crop puts
   them at the bottom edge of the panel — partially clipped. A
   positive value here shifts the visible crop window DOWN in the
   source image by that many pixels, which moves the subject UP in
   the rendered panel. Tuned by eye per image. */
const COVER_Y_PIXEL_OFFSET = {
  'media/cover-05.jpg': 100,
  'media/cover-08.jpg': 100,
};

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
      const baseOffsetY = (1 - r) / 2;
      // V coords on the texture with flipY=true: V=0 is the bottom
      // of the source, V=1 is the top. To shift the visible window
      // DOWN in the source (i.e. expose more of the bottom), we
      // DECREASE offset.y by pxShift / source-height.
      const pxShift = COVER_Y_PIXEL_OFFSET[url] || 0;
      const vShift  = -pxShift / tex.image.height;
      tex.offset.set(0, baseOffsetY + vShift);
    }
    material.map = tex;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = MAX_ANISO;
}

/* Same object-fit:cover treatment, but for video sources. Creates an
   HTMLVideoElement with autoplay / muted / loop / playsinline, wraps it
   in a THREE.VideoTexture, and waits for `loadedmetadata` so
   videoWidth/Height are known before computing the cover crop.
   The video element is stashed on material.userData so exitStory can
   stop playback and detach the resource when the panel is disposed. */
function applyCoverVideo(material, url, panelAspect) {
  const video = document.createElement('video');
  video.muted        = true;
  video.loop         = true;
  video.autoplay     = true;
  video.playsInline  = true;
  video.preload      = 'auto';
  // Safari iOS requires the attribute form of these for autoplay to
  // actually fire on first paint — setting the JS property isn't
  // enough on older WebKit.
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  // Detached <video> elements can be throttled / suspended by some
  // browsers (Chrome will pause playback to save resources), which
  // leaves the VideoTexture frozen on its first frame. Park them in
  // an off-screen container so they stay live.
  video.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);
  video.src = url;

  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter  = THREE.LinearFilter;
  tex.magFilter  = THREE.LinearFilter;
  tex.anisotropy = MAX_ANISO;

  const applyCrop = () => {
    const imgAspect = video.videoWidth / video.videoHeight;
    if (!imgAspect) return;
    if (imgAspect > panelAspect) {
      const r = panelAspect / imgAspect;
      tex.repeat.set(r, 1);
      tex.offset.set((1 - r) / 2, 0);
    } else {
      const r = imgAspect / panelAspect;
      tex.repeat.set(1, r);
      tex.offset.set(0, (1 - r) / 2);
    }
    material.map = tex;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
    video.play().catch(() => { /* autoplay blocked — quietly stay paused */ });
  };
  if (video.readyState >= 1) applyCrop();
  else video.addEventListener('loadedmetadata', applyCrop, { once: true });

  material.userData.videoEl = video;
}

function makePanel(yawDeg, y, w, h, url) {
  const yaw = THREE.MathUtils.degToRad(yawDeg);

  // ~5% of the smaller side as the corner radius
  const r = Math.min(w, h) * 0.05;

  const geom = buildCurvedPanelGeometry(w, h, RADIUS);

  // material starts dark (so unloaded panels match the placeholder
  // look). applyCoverImage swaps map + color when the texture lands.
  // Plain alpha blending (no alphaTest) so material.opacity can ramp
  // smoothly between 0 and 1 when stories enter / leave.
  //
  // depthWrite is OFF: with depthWrite on, every panel rendered at
  // intermediate opacity (during a fade) would punch its own shape
  // into the depth buffer. Whichever fading panel happened to draw
  // first would then occlude — at partial alpha — anything drawn
  // behind it later, producing the dark streaks the user reported.
  // Disabling depthWrite lets the rear-to-front sort do its job
  // and keeps the alpha math clean throughout the transition.
  const mat = new THREE.MeshBasicMaterial({
    color:        0x1a1610,
    side:         THREE.DoubleSide,
    alphaMap:     buildRoundedAlphaTexture(w, h, r),
    transparent:  true,
    opacity:      1,
    depthWrite:   false,
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

  // Rebuild once Anton is actually on the page.
  //
  // Why this is fiddly: on a cold load, canvas measureText() does
  // NOT register a font face with the FontFaceSet, so
  // `document.fonts.ready` resolves before Anton even starts
  // downloading. The first paint then uses a fallback face, sizes
  // the canvas wrong, and on the live site the title ends up
  // truncated and the gap collapses.
  //
  // Three independent triggers so the rebuild can't fall through:
  //   1. Explicit document.fonts.load() with Anton's actual weight
  //      (Google's CSS defines Anton at 400). This both initiates
  //      the fetch and returns a promise that resolves only after
  //      that face is ready.
  //   2. document.fonts.ready as a backstop.
  //   3. A 2.5 s timeout, in case neither of the above fires (e.g.
  //      the webfont is blocked by an extension or offline).
  // rebuildOnce dedupes — whichever trigger wins gets to do the work.
  function rebuildTerminalCanvas() {
    const rebuilt = buildTerminalCanvas();
    mat.map.image      = rebuilt.canvas;
    mat.map.needsUpdate = true;
    const newH = planeW * (rebuilt.canvasH / rebuilt.canvasW);
    mesh.geometry.dispose();
    mesh.geometry = buildCurvedPanelGeometry(planeW, newH, RADIUS);
  }
  let rebuilt = false;
  function rebuildOnce() {
    if (rebuilt) return;
    rebuilt = true;
    rebuildTerminalCanvas();
  }
  if (document.fonts && document.fonts.load) {
    document.fonts.load('400 132px "Anton"').then(rebuildOnce).catch(() => {});
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rebuildOnce).catch(() => {});
  }
  setTimeout(rebuildOnce, 2500);
  return mesh;
}
const terminalSign = addTerminalSign();

/* -------------------------------------------------------------- */
/* 2c. story mode — click a panel, content swaps out for a story  */
/* -------------------------------------------------------------- */

/* Mode machine:
     'terminal'      — initial 38 photos + sign (current world)
     'transitioning' — opacity is mid-ramp; clicks/keys are ignored
     'story'         — clicked photo is exploded into placeholder
                       content blocks on the same cylinder

   Both states use the same camera, fisheye + film passes and
   cylinder layout — only the meshes parented to the scene swap.
   Each fadeable mesh carries `userData.targetOpacity`; the tick
   loop lerps `material.opacity` toward it every frame. */

let mode = 'terminal';
let currentStoryIdx = -1;

// All meshes that should fade out when entering a story (photos + sign).
const terminalFadeables = [...panelGroup.children, terminalSign];
for (const m of terminalFadeables) m.userData.targetOpacity = 1;

// Group that holds whatever story-mode content is currently mounted.
const storyGroup = new THREE.Group();
scene.add(storyGroup);

// Pseudo-random number generator seeded by panel index, so the gray
// placeholder layout for a given photo is stable across re-entries.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Spawn a single gray placeholder mesh at (yawCenter, y) with the
   given world-space width / height. Pushed straight into storyGroup
   with opacity 0 — staggeredSet() flips targetOpacity to 1 later. */
function placeStoryBlock(yawCenter, y, w, h, rand) {
  const r       = Math.min(w, h) * 0.05;
  const gray    = 0x30 + Math.floor(rand() * 0x20);   // 0x30–0x4F
  const colorHex = (gray << 16) | (gray << 8) | gray;

  const mesh = new THREE.Mesh(
    buildCurvedPanelGeometry(w, h, RADIUS),
    new THREE.MeshBasicMaterial({
      color:       colorHex,
      side:        THREE.DoubleSide,
      alphaMap:    buildRoundedAlphaTexture(w, h, r),
      transparent: true,
      opacity:     0,
      depthWrite:  false,                            // see makePanel for why
    }),
  );
  mesh.position.set(
     RADIUS * Math.sin(yawCenter),
     y,
    -RADIUS * Math.cos(yawCenter),
  );
  mesh.lookAt(0, y, 0);
  mesh.userData.targetOpacity = 0;
  storyGroup.add(mesh);
}

/* Per-cover content manifest. Indexed by panel index (0 = cover-01,
   etc). Each item is { t: 'image' | 'video', u: url, a: aspect }.
   Aspect is the source media's natural width/height, pre-baked so
   the cluster layout can pick a panel size before the asset loads. */
const STORIES = {
  // cover-01 — Nathan
  0: [
    { t: 'image', u: 'media/story-01/p01.jpg', a: 0.665 },
    { t: 'image', u: 'media/story-01/p02.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p03.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p04.jpg', a: 1.500 },
    { t: 'image', u: 'media/story-01/p05.jpg', a: 1.778 },
    { t: 'image', u: 'media/story-01/p06.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p07.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p08.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p09.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p10.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-01/p11.jpg', a: 1.333 },
    { t: 'video', u: 'media/story-01/v01.mp4', a: 1.778 },
    { t: 'video', u: 'media/story-01/v02.mp4', a: 1.778 },
    { t: 'video', u: 'media/story-01/v03.mp4', a: 1.778 },
  ],
};

/* ~STORY_BLOCK_COUNT gray placeholder panels — only used as the
   fallback when a cover has no manifest entry in STORIES yet. */
const STORY_BLOCK_COUNT = 10;

const STORY_SIZE_PRESETS = [
  // single-row-ish
  { w: 180, h: 140 },
  { w: 220, h: 160 },
  { w: 260, h: 180 },
  { w: 300, h: 180 },
  // 2-row spanners
  { w: 200, h: 270 },
  { w: 260, h: 300 },
  { w: 320, h: 280 },
  { w: 240, h: 340 },
];

/* Target panel areas (world units²) for real-content panels. We pick
   one of these per item, then derive width/height from the item's
   aspect so panels stay visually-proportioned to their media.
   Range is set so 12–15 items can be packed around a hero cover
   without hard collisions; bigger means richer-looking but more
   layout failures. */
const STORY_ITEM_AREAS = [
  22000,    // small
  32000,    // medium
  46000,    // large
  68000,    // 2-row hero
];

/* Shared cluster parameters used by both the manifest path and the
   gray-placeholder fallback. */
const CLUSTER_PARAMS = {
  yawHalfRange: 1.4,            // ≈ ±80° from the cover
  yHalfRange:   320,            // y window centred on the cover
  yBound:       340,            // dome vertical reach
  vgap:         HGAP,           // vertical gap between blocks = HGAP for visual parity
};

function buildStoryContent(idx) {
  // Clear any existing story content. Videos need their <video>
  // element paused + detached or they keep streaming bytes invisibly.
  while (storyGroup.children.length) {
    const m = storyGroup.children.pop();
    m.geometry?.dispose();
    if (m.material) {
      const v = m.material.userData?.videoEl;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      m.material.map?.dispose();
      m.material.alphaMap?.dispose();
      m.material.dispose();
    }
  }

  const items = STORIES[idx];
  if (items && items.length) buildStoryFromItems(idx, items);
  else                        buildStoryPlaceholders(idx);
}

/* Shared cluster placement.
   buildCandidates: a generator/iterator that emits objects
     { w, h, place(yawCenter, y) }  — w / h are world dims;
     place() actually drops the mesh once we've found a non-overlapping
     spot. The caller calls .next() until the target count is met. */
function clusterPlace(idx, targetCount, makeNextCandidate) {
  const rand = mulberry32(idx + 1);

  const [yawCDeg, yC, wC, hC] = PANEL_LAYOUT[idx];
  const yawC     = THREE.MathUtils.degToRad(yawCDeg);
  const HGAP_ARC = HGAP / RADIUS;
  const { yawHalfRange, yHalfRange, yBound, vgap } = CLUSTER_PARAMS;

  const photoBox = {
    yaw1: yawC - (wC / RADIUS) / 2,
    yaw2: yawC + (wC / RADIUS) / 2,
    y1:   yC - hC / 2,
    y2:   yC + hC / 2,
  };
  const placed = [photoBox];

  function overlaps(c) {
    return placed.some(p =>
      c.yaw1 < p.yaw2 + HGAP_ARC && c.yaw2 > p.yaw1 - HGAP_ARC &&
      c.y1   < p.y2   + vgap     && c.y2   > p.y1   - vgap
    );
  }

  const MAX_ATTEMPTS_PER_SLOT = 200;
  let slot = 0;
  let placedCount = 0;
  // Walk through every requested slot. If an individual item can't
  // find a non-overlapping spot inside MAX_ATTEMPTS_PER_SLOT tries,
  // we simply skip it and move on to the next — better to drop one
  // hard-to-place item than to leave the whole cluster empty.
  while (slot < targetCount) {
    const candidate = makeNextCandidate(rand, slot);
    if (!candidate) break;                          // manifest exhausted
    const { w, h, place } = candidate;
    const arcW = w / RADIUS;

    let landed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SLOT && !landed; attempt++) {
      const cyaw = yawC + (rand() * 2 - 1) * yawHalfRange;
      const cy   = yC   + (rand() * 2 - 1) * yHalfRange;
      const cand = {
        yaw1: cyaw - arcW / 2,
        yaw2: cyaw + arcW / 2,
        y1:   cy   - h    / 2,
        y2:   cy   + h    / 2,
      };
      if (cand.y1 < -yBound || cand.y2 > yBound) continue;
      if (overlaps(cand)) continue;
      place(cyaw, cy);
      placed.push(cand);
      landed = true;
    }
    if (landed) placedCount++;
    slot++;
  }
  return placedCount;
}

function buildStoryFromItems(idx, items) {
  // Shuffle items so the visual ordering of media in the cluster is
  // randomised per re-entry, but still deterministic per cover.
  const rand = mulberry32(idx + 1);
  const shuffled = items.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  clusterPlace(idx, shuffled.length, (rng, placedCount) => {
    const item = shuffled[placedCount];
    if (!item) return null;
    const area = STORY_ITEM_AREAS[Math.floor(rng() * STORY_ITEM_AREAS.length)];
    const w = Math.round(Math.sqrt(area * item.a));
    const h = Math.round(Math.sqrt(area / item.a));
    return {
      w, h,
      place: (yawCenter, y) => placeStoryItem(yawCenter, y, w, h, item),
    };
  });
}

function buildStoryPlaceholders(idx) {
  clusterPlace(idx, STORY_BLOCK_COUNT, (rng) => {
    const preset = STORY_SIZE_PRESETS[Math.floor(rng() * STORY_SIZE_PRESETS.length)];
    const w = preset.w + Math.round((rng() - 0.5) * 40);
    const h = preset.h + Math.round((rng() - 0.5) * 30);
    return {
      w, h,
      place: (yawCenter, y) => placeStoryBlock(yawCenter, y, w, h, rng),
    };
  });
}

function placeStoryItem(yawCenter, y, w, h, item) {
  const r = Math.min(w, h) * 0.05;
  const panelAspect = w / h;

  const mat = new THREE.MeshBasicMaterial({
    color:       0x1a1610,                          // dark while loading
    side:        THREE.DoubleSide,
    alphaMap:    buildRoundedAlphaTexture(w, h, r),
    transparent: true,
    opacity:     0,
    depthWrite:  false,
  });

  if (item.t === 'video') applyCoverVideo(mat, item.u, panelAspect);
  else                    applyCoverImage(mat, item.u, panelAspect);

  const mesh = new THREE.Mesh(buildCurvedPanelGeometry(w, h, RADIUS), mat);
  mesh.position.set(
     RADIUS * Math.sin(yawCenter),
     y,
    -RADIUS * Math.cos(yawCenter),
  );
  mesh.lookAt(0, y, 0);
  mesh.userData.targetOpacity = 0;
  storyGroup.add(mesh);
}

const hudEl = document.querySelector('.hud');
const HUD_TERMINAL = 'drag to look around';
const HUD_STORY    = 'esc to return to terminal';

/* Staggered fade timing.
   Each block's fade starts at a random offset in [0, STAGGER_MS),
   then takes roughly FADE_TAIL_MS for the per-frame opacity lerp
   (FADE_LERP = 0.15) to actually snap to the target value. So one
   phase is bounded at STAGGER_MS + FADE_TAIL_MS. Transitions run
   sequentially (out fully, then in fully) so old and new content
   are never simultaneously mid-fade — that simultaneity was the
   source of the "dark streaks" the user reported. */
const STAGGER_MS   = 1500;
const FADE_TAIL_MS = 700;          // 700 ms ≈ 42 frames at 60 Hz, plenty of margin
const PHASE_MS     = STAGGER_MS + FADE_TAIL_MS;

function staggeredSet(meshes, value) {
  // Set each mesh's targetOpacity to `value` after an independent
  // random delay. Returns nothing — the per-frame stepFade loop drives
  // the actual lerp. Caller still has to wait PHASE_MS to know all
  // meshes are settled.
  for (const m of meshes) {
    setTimeout(() => { m.userData.targetOpacity = value; },
               Math.random() * STAGGER_MS);
  }
}

function enterStory(panelIdx) {
  if (mode !== 'terminal') return;
  mode = 'transitioning';
  currentStoryIdx = panelIdx;
  if (hudEl) hudEl.textContent = HUD_STORY;

  // The clicked panel is exempt — it stays fully opaque throughout
  // the transition so the user keeps the photo they tapped as a
  // visual anchor while the story content materialises around it.
  const clicked = panelGroup.children[panelIdx];
  const fading  = terminalFadeables.filter(m => m !== clicked);

  // Phase 1: stagger-fade the home content out.
  staggeredSet(fading, 0);

  // Phase 2 fires once Phase 1 is fully complete (everyone snapped
  // to 0). Then build the story content and stagger its fade-in.
  setTimeout(() => {
    for (const m of fading) m.visible = false;
    buildStoryContent(panelIdx);
    staggeredSet(storyGroup.children, 1);

    setTimeout(() => {
      mode = 'story';
    }, PHASE_MS);
  }, PHASE_MS);
}

function exitStory() {
  if (mode !== 'story') return;
  mode = 'transitioning';
  if (hudEl) hudEl.textContent = HUD_TERMINAL;

  const clicked = currentStoryIdx >= 0 ? panelGroup.children[currentStoryIdx] : null;
  const returning = terminalFadeables.filter(m => m !== clicked);

  // Phase 1: stagger-fade the story content out.
  staggeredSet(storyGroup.children, 0);

  // Phase 2: dispose story, restore + stagger-fade-in home content.
  setTimeout(() => {
    while (storyGroup.children.length) {
      const m = storyGroup.children.pop();
      m.geometry?.dispose();
      const v = m.material.userData?.videoEl;
      if (v) {
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      m.material.map?.dispose();
      m.material.alphaMap?.dispose();
      m.material.dispose();
    }
    for (const m of returning) m.visible = true;
    staggeredSet(returning, 1);

    setTimeout(() => {
      mode = 'terminal';
      currentStoryIdx = -1;
    }, PHASE_MS);
  }, PHASE_MS);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'story') exitStory();
});

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

// Click-vs-drag detection: any pointer-down that ends within CLICK_PX
// of the start position and CLICK_MS milliseconds counts as a click;
// otherwise the gesture is treated as a drag (and a click is suppressed).
const CLICK_PX = 5;
const CLICK_MS = 400;

const raycaster  = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function tryClickAtPointer(e) {
  if (mode !== 'terminal') return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  pointerNDC.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  const hits = raycaster.intersectObjects(panelGroup.children, false);
  if (!hits.length) return;
  const idx = panelGroup.children.indexOf(hits[0].object);
  if (idx >= 0) enterStory(idx);
}

/* Pointer handling: no setPointerCapture — pointermove + pointerup
   are already attached to `window`, so a drag that wanders off the
   canvas still tracks correctly. Click vs drag is decided entirely
   at pointerup from start/end coords + elapsed time. */
function onDown(e) {
  state.dragging = true;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  state.downX = e.clientX;
  state.downY = e.clientY;
  state.downT = performance.now();
  document.body.classList.add('dragging');
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
  if (!state.dragging) return;          // ignore stray pointerups
  state.dragging = false;
  document.body.classList.remove('dragging');
  const dx = Math.abs(e.clientX - state.downX);
  const dy = Math.abs(e.clientY - state.downY);
  const dt = performance.now() - state.downT;
  if (dx < CLICK_PX && dy < CLICK_PX && dt < CLICK_MS) {
    tryClickAtPointer(e);
  }
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

// Lerp factor per frame for opacity fades. 0.15 ≈ 70% of the way to
// the target in ~7 frames at 60 Hz, matching the FADE_MS setTimeout.
const FADE_LERP = 0.15;

function stepFade(mesh) {
  const mat = mesh.material;
  if (!mat || !('opacity' in mat)) return;
  const tgt = mesh.userData.targetOpacity ?? 1;
  if (mat.opacity === tgt) return;
  mat.opacity += (tgt - mat.opacity) * FADE_LERP;
  if (Math.abs(mat.opacity - tgt) < 0.005) mat.opacity = tgt;
}

function tick() {
  // smooth follow toward target rotation
  state.yaw   += (state.targetYaw   - state.yaw)   * 0.09;
  state.pitch += (state.targetPitch - state.pitch) * 0.09;

  camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');

  // drive fade animations
  for (const m of terminalFadeables) stepFade(m);
  for (const m of storyGroup.children) stepFade(m);

  // Keep the time uniform bounded so the grain hash inside FilmShader
  // doesn't drift. The hash is sensitive to its input magnitude: when
  // time grows large, `vUv*resolution + time*73` reaches the precision
  // floor of float32 and the per-pixel noise stops being independent —
  // adjacent pixels start sharing the same hashed sin() bucket and the
  // pattern visibly slides toward one corner. Wrapping at 10 s keeps
  // the input bounded forever; the user can't see the wrap because
  // each frame's noise already looks random vs the previous frame.
  filmPass.uniforms.time.value = clock.getElapsedTime() % 10.0;

  composer.render();
  requestAnimationFrame(tick);
}
tick();
