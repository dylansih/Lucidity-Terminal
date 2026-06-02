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
  // Graduation group photo in highschool story. Source aspect is
  // ~1.08 (almost square) but the row-2 slot is ~2.2 letterbox, so
  // only the middle band shows by default and the three faces fall
  // above the crop window. Negative shift slides the visible window
  // UP in the source to expose the top portion (heads / shoulders).
  'media/story-03/p04.jpg': -280,
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
  // cover-02 — Utah. Both videos were filmed vertically; manifest
  // keeps their native portrait aspect so they render as tall slots
  // spanning two rows.
  1: [
    { t: 'image', u: 'media/story-02/p01.jpg', a: 1.500 },
    { t: 'image', u: 'media/story-02/p02.jpg', a: 1.501 },
    { t: 'image', u: 'media/story-02/p03.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p04.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p05.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p06.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p07.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p08.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p09.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-02/p10.jpg', a: 1.333 },
    { t: 'video', u: 'media/story-02/v01.mp4', a: 1.778 },      // landscape cover-row slot
    { t: 'video', u: 'media/story-02/v02.mp4', a: 0.5625 },     // 720×1280 portrait
  ],
  // cover-03 — High school. 4 wide videos + 8 photos. IMG_4239
  // was filmed sideways; the encode rotates it 90° CW so v03 is
  // landscape 16:9 with subjects upright.
  2: [
    { t: 'image', u: 'media/story-03/p01.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p02.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p03.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p04.jpg', a: 1.083 },       // near-square
    { t: 'image', u: 'media/story-03/p05.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p06.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p07.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-03/p08.jpg', a: 1.778 },       // 16:9
    { t: 'video', u: 'media/story-03/v01.mp4', a: 1.778 },
    { t: 'video', u: 'media/story-03/v02.mp4', a: 1.333 },       // 4:3 source
    { t: 'video', u: 'media/story-03/v03.mp4', a: 1.778 },       // rotated 90° CW
    { t: 'video', u: 'media/story-03/v04.mp4', a: 1.778 },
  ],
  // cover-04 — Canary Sand. 7 portrait photos + 2 landscape + 2 wide
  // videos. The portrait majority routes to a portrait-heavy layout.
  3: [
    { t: 'image', u: 'media/story-04/p01.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p02.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p03.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p04.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p05.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p06.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-04/p07.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-04/p08.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-04/p09.jpg', a: 0.562 },
    { t: 'video', u: 'media/story-04/v01.mp4', a: 1.778 },
    { t: 'video', u: 'media/story-04/v02.mp4', a: 1.778 },
  ],
  // cover-05 — Canary Full. 19 photos (9 landscape, 10 portrait) +
  // 5 videos (1 wide, 4 tall). Routes to the media-heavy template
  // because itemCount > 16.
  4: [
    { t: 'image', u: 'media/story-05/p01.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-05/p02.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p03.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-05/p04.jpg', a: 1.333 },
    { t: 'image', u: 'media/story-05/p05.jpg', a: 1.184 },
    { t: 'image', u: 'media/story-05/p06.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p07.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p08.jpg', a: 0.750 },
    { t: 'image', u: 'media/story-05/p09.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p10.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-05/p11.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p12.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-05/p13.jpg', a: 0.750 },
    { t: 'image', u: 'media/story-05/p14.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-05/p15.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p16.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-05/p17.jpg', a: 0.562 },
    { t: 'image', u: 'media/story-05/p18.jpg', a: 1.777 },
    { t: 'image', u: 'media/story-05/p19.jpg', a: 0.562 },
    { t: 'video', u: 'media/story-05/v01.mp4', a: 0.562 },
    { t: 'video', u: 'media/story-05/v02.mp4', a: 0.562 },
    { t: 'video', u: 'media/story-05/v03.mp4', a: 0.562 },
    { t: 'video', u: 'media/story-05/v04.mp4', a: 1.778 },
    { t: 'video', u: 'media/story-05/v05.mp4', a: 0.562 },
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

/* Deterministic slot grid for a story page.
   The cluster is laid out as 3 rows arranged "down" from a top-row
   cover (or "up" from a bottom-row cover):

     Cover row : COVER + 2 hero video slots (one each side)
     Row 1     : 4 photo slots + 1 hero video slot (centre)
     Row 2     : 7 photo slots

   = 14 slots total, exactly matching the 11 photos + 3 videos of
   the typical batch. Gap between any two adjacent slots — both
   horizontally and vertically — is HGAP (14 world units), matching
   the cover-to-cover spacing on the home page. The two cover-row
   videos sit at polar angles 0 / π around the cover; the row-1
   centre video sits at ±π/2 — so all three videos are on
   different sides by construction. */
const STORY_SLOT_DIMS = {
  coverVideo: { w: 460, h: 305 },     // cover-row video (matches cover height)
  row1Video:  { w: 360, h: 200 },     // row-1 centre video
  row1Photo:  { w: 270, h: 200 },     // row-1 photo
  row2Photo:  { w: 200, h: 122 },     // row-2 photo
  // Tall vertical-video slot. Spans both rows + the gap between them
  // (200 + 14 + 122 = 336). Width derives from the source aspect so
  // the video isn't horizontally cropped. Sized for ~9:16 sources;
  // very different aspects will still render with cover-crop.
  tallVideo:  { w: 189, h: 336 },     // 0.5625 aspect, top-aligned with row1
};
const ROW1_H = STORY_SLOT_DIMS.row1Photo.h;
const ROW2_H = STORY_SLOT_DIMS.row2Photo.h;
const TALL_H = STORY_SLOT_DIMS.tallVideo.h;

/* Shared cluster parameters used by both the manifest path and the
   gray-placeholder fallback. */
const CLUSTER_PARAMS = {
  yawHalfRange: 1.55,           // ≈ ±89° from the cover
  yHalfRange:   340,            // y window centred on the cover (matches yBound)
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
    const { w, h, place, validate } = candidate;
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
      // Optional extra rejection (e.g. videos enforcing angular
      // separation from already-placed videos around the cover).
      if (validate && !validate(cyaw, cy)) continue;
      place(cyaw, cy);
      placed.push(cand);
      landed = true;
    }
    if (landed) placedCount++;
    slot++;
  }
  return placedCount;
}

/* Row-2 width tier: more photos in the row → thinner slots so the
   row stays within the cluster's yaw extent. */
function row2SlotWidth(count) {
  if (count <= 5) return 270;
  if (count === 6) return 230;
  return 200;
}

/* Geometry shared by every layout: y centres for rows 1 and 2 relative
   to the cover. Mirrored for bottom-row covers so the cluster always
   extends AWAY from the dome edge. */
function getStoryRowGeometry(idx) {
  const [, yC, , hC] = PANEL_LAYOUT[idx];
  const yDir = yC > 0 ? -1 : 1;
  const coverFarEdge = yC + yDir * hC / 2;
  const row1Edge     = coverFarEdge + yDir * HGAP;
  const row1Y        = row1Edge + yDir * ROW1_H / 2;
  const row1FarEdge  = row1Y + yDir * ROW1_H / 2;
  const row2Edge     = row1FarEdge + yDir * HGAP;
  const row2Y        = row2Edge + yDir * ROW2_H / 2;
  // Tall slot covers the full vertical span of row 1 + gap + row 2.
  // Its centre is the midpoint between row 1 top and row 2 bottom.
  const tallTopY    = row1Edge;
  const tallBotY    = row2Y + yDir * ROW2_H / 2;
  const tallY       = (tallTopY + tallBotY) / 2;
  return { row1Y, row2Y, tallY };
}

/* Slot template when there are NO vertical videos — original 3-row
   grid: cover row (2 hero slots) + row 1 (5) + row 2 (count − 7). */
function getStandardSlots(idx, itemCount) {
  const [yawCDeg, yC, wC] = PANEL_LAYOUT[idx];
  const yawC = THREE.MathUtils.degToRad(yawCDeg);
  const { row1Y, row2Y } = getStoryRowGeometry(idx);

  const COVER_COUNT = Math.min(2, itemCount);
  const ROW1_COUNT  = Math.min(5, Math.max(0, itemCount - COVER_COUNT));
  const ROW2_COUNT  = Math.max(0, itemCount - COVER_COUNT - ROW1_COUNT);

  const slots = [];

  const cv = STORY_SLOT_DIMS.coverVideo;
  const coverYawDelta = (wC / 2 + HGAP + cv.w / 2) / RADIUS;
  if (COVER_COUNT >= 1) slots.push({ yaw: yawC - coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'wide' });
  if (COVER_COUNT >= 2) slots.push({ yaw: yawC + coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'wide' });

  if (ROW1_COUNT > 0) {
    const r1v = STORY_SLOT_DIMS.row1Video;
    const r1p = STORY_SLOT_DIMS.row1Photo;
    const centreIdx = Math.floor(ROW1_COUNT / 2);
    const r1Widths = [];
    for (let i = 0; i < ROW1_COUNT; i++) r1Widths.push(i === centreIdx ? r1v.w : r1p.w);
    const r1Total = r1Widths.reduce((s, w) => s + w, 0) + (r1Widths.length - 1) * HGAP;
    let cursor = -r1Total / 2;
    for (let i = 0; i < ROW1_COUNT; i++) {
      const w = r1Widths[i];
      slots.push({
        yaw: yawC + (cursor + w / 2) / RADIUS,
        y:   row1Y,
        w,
        h:   ROW1_H,
        role: i === centreIdx ? 'wide' : 'photo',
      });
      cursor += w + HGAP;
    }
  }

  if (ROW2_COUNT > 0) {
    const r2w = row2SlotWidth(ROW2_COUNT);
    const r2Total = ROW2_COUNT * r2w + (ROW2_COUNT - 1) * HGAP;
    let cursor = -r2Total / 2;
    for (let i = 0; i < ROW2_COUNT; i++) {
      slots.push({
        yaw: yawC + (cursor + r2w / 2) / RADIUS,
        y:   row2Y,
        w:   r2w,
        h:   ROW2_H,
        role: 'photo',
      });
      cursor += r2w + HGAP;
    }
  }

  return slots;
}

/* Slot template when the manifest contains vertical (portrait) videos.
   - 1–2 tall slots sit at the far yaw edges of the cluster, spanning
     row 1 + gap + row 2 vertically so a 9:16 source isn't cropped.
   - Row 1 and Row 2 photos sit BETWEEN the tall slots (so their yaw
     range is compressed compared to the standard layout).
   - There are no cover-row lateral slots when there are no wide
     videos to put in them.
   Designed for the common case of 1–2 tall videos + lots of photos. */
function getTallVideoSlots(idx, tallCount, photoCount) {
  const [yawCDeg, yC, wC] = PANEL_LAYOUT[idx];
  const yawC = THREE.MathUtils.degToRad(yawCDeg);
  const { row1Y, row2Y, tallY } = getStoryRowGeometry(idx);

  const tv = STORY_SLOT_DIMS.tallVideo;
  // Position tall slots near (but not at) the cluster edge. Outer
  // edge of tall slot is at ±EDGE_YAW; inner edge sets the start
  // of the row 1 / row 2 yaw window.
  const EDGE_YAW = 1.5;                              // ≈ ±86°
  const tallCentreYawOff = EDGE_YAW - (tv.w / 2) / RADIUS;
  const tallInnerYawOff  = tallCentreYawOff - (tv.w / 2) / RADIUS;

  // Row 1 / Row 2 yaw range: between the inner edges of the tall
  // slots, with HGAP cushion on each side.
  const innerHalfYaw = tallInnerYawOff - HGAP / RADIUS;
  const rowWorldWidth = innerHalfYaw * 2 * RADIUS;

  const slots = [];

  // ---- Tall slots ----
  if (tallCount >= 1) slots.push({ yaw: yawC - tallCentreYawOff, y: tallY, w: tv.w, h: tv.h, role: 'tall' });
  if (tallCount >= 2) slots.push({ yaw: yawC + tallCentreYawOff, y: tallY, w: tv.w, h: tv.h, role: 'tall' });

  // Photos split between row 1 and row 2 as evenly as possible, with
  // any odd one going to row 1 (closer to the cover, reads first).
  const PHOTO_BUDGET = photoCount;
  const ROW1_COUNT   = Math.ceil(PHOTO_BUDGET / 2);
  const ROW2_COUNT   = PHOTO_BUDGET - ROW1_COUNT;

  // Row 1 / Row 2 slot widths sized so the row fills the available
  // width snugly, keeping HGAP gaps between slots.
  function fillRow(count, y, h, slotsOut) {
    if (count <= 0) return;
    const w = Math.floor((rowWorldWidth - (count - 1) * HGAP) / count);
    let cursor = -((count * w + (count - 1) * HGAP) / 2);
    for (let i = 0; i < count; i++) {
      slotsOut.push({
        yaw: yawC + (cursor + w / 2) / RADIUS,
        y,
        w,
        h,
        role: 'photo',
      });
      cursor += w + HGAP;
    }
  }
  fillRow(ROW1_COUNT, row1Y, ROW1_H, slots);
  fillRow(ROW2_COUNT, row2Y, ROW2_H, slots);

  return slots;
}

/* Slot template for a mix of 1 tall video + N wide videos + photos.
   - Cover-row wide slot at the LEFT of the cover (v01 here).
   - Tall slot IMMEDIATELY RIGHT of the cover, sized to span the full
     vertical reach of the cluster (cover row + gap + row 1 + gap +
     row 2). With 9:16 source this is ~368 × 655. The video reads as
     a hero block right next to the cover.
   - Photos fill the wide LEFT segment (yaw [−1.55, cover right edge])
     across rows 1 and 2, plus a narrow RIGHT column at row 2 next to
     the tall slot. The narrow column is row 2 only because at row 1
     height the aspect would be too portrait for the landscape photos.
   Designed for 1 wide + 1 tall + ~10 photo (Utah). */
function getMixedSlots(idx, items) {
  const [yawCDeg, yC, wC, hC] = PANEL_LAYOUT[idx];
  const yawC = THREE.MathUtils.degToRad(yawCDeg);
  const yDir = yC > 0 ? -1 : 1;
  const { row1Y, row2Y } = getStoryRowGeometry(idx);
  const HGAP_ARC = HGAP / RADIUS;

  const wideCount  = items.filter(it => it.t === 'video' && it.a >= 1).length;
  const tallCount  = items.filter(it => it.t === 'video' && it.a < 1).length;
  const photoCount = items.filter(it => it.t === 'image').length;

  const slots = [];

  // ---- Tall slot: sized to span all three rows (cover-row top → row 2 bottom). ----
  const coverFarEdgeY  = yC - yDir * hC / 2;
  const row2FarEdgeY   = row2Y + yDir * ROW2_H / 2;
  const tallY          = (coverFarEdgeY + row2FarEdgeY) / 2;
  const tallH          = Math.abs(coverFarEdgeY - row2FarEdgeY);
  const TALL_ASPECT    = 0.5625;                          // 9:16
  const tallW          = Math.round(tallH * TALL_ASPECT);
  const tallYawDelta   = (wC / 2 + HGAP + tallW / 2) / RADIUS;   // right-adjacent to cover
  const tallLeftYawOff  = tallYawDelta - (tallW / 2) / RADIUS;
  const tallRightYawOff = tallYawDelta + (tallW / 2) / RADIUS;
  if (tallCount >= 1) {
    slots.push({ yaw: yawC + tallYawDelta, y: tallY, w: tallW, h: tallH, role: 'tall' });
  }

  // ---- Cover-row wide slot LEFT of the cover (e.g. v01) ----
  const cv = STORY_SLOT_DIMS.coverVideo;
  const coverYawDelta = (wC / 2 + HGAP + cv.w / 2) / RADIUS;
  if (wideCount >= 1) {
    slots.push({ yaw: yawC - coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'wide' });
  }

  // ---- Photo rows ----
  // Photos in rows 1 and 2 extend across the full yaw width that's NOT
  // blocked by the tall slot. Vertically, rows 1 and 2 are unaffected
  // by v01 (different y), so the photo rows can sit under both the
  // cover and v01.
  const leftRightYawOff = tallLeftYawOff - HGAP_ARC;       // photo row right edge
  const leftLeftYawOff  = -1.55;                            // photo row left edge
  const leftWidth       = (leftRightYawOff - leftLeftYawOff) * RADIUS;
  const leftCentreYaw   = (leftLeftYawOff + leftRightYawOff) / 2;

  const rightLeftYawOff  = tallRightYawOff + HGAP_ARC;
  const rightRightYawOff = 1.55;
  const rightWidth       = (rightRightYawOff - rightLeftYawOff) * RADIUS;
  const rightCentreYaw   = (rightLeftYawOff + rightRightYawOff) / 2;

  /* Place `count` evenly-sized photo slots inside a 1-D yaw segment
     centred at `centreYawOff`. Uniform widths within a row keep
     horizontal gaps at exactly HGAP, matching the rest of the cluster. */
  function fillSegment(count, y, h, segmentWidth, centreYawOff) {
    if (count <= 0) return;
    const w = Math.floor((segmentWidth - (count - 1) * HGAP) / count);
    const totalW = count * w + (count - 1) * HGAP;
    let cursor = -totalW / 2;
    for (let i = 0; i < count; i++) {
      slots.push({
        yaw: yawC + centreYawOff + (cursor + w / 2) / RADIUS,
        y, w, h, role: 'photo',
      });
      cursor += w + HGAP;
    }
  }

  // All photos live in the left segment — a single isolated cell to
  // the right of the tall slot looks lonely, so everything stays on
  // the cohesive side. Larger half in row 1 (closer to cover, taller
  // cells = easier aspect for landscape photos), rest in row 2.
  // Keep `rightCentreYaw` referenced so the linter doesn't whine —
  // the right segment is reserved for future stories with portrait
  // photos that fit there naturally.
  void rightCentreYaw;
  const ROW1_LEFT = Math.min(4, photoCount);
  const ROW2_LEFT = photoCount - ROW1_LEFT;

  fillSegment(ROW1_LEFT, row1Y, ROW1_H, leftWidth, leftCentreYaw);
  fillSegment(ROW2_LEFT, row2Y, ROW2_H, leftWidth, leftCentreYaw);

  return slots;
}

/* Slot template for portrait-heavy stories (e.g. 7 portrait photos +
   2 landscape + 2 wide videos). Cover row uses the standard 2 hero
   video slots. Row 1 becomes a single wide mixed row of slots at
   h=200, with landscape photos pinned to the EDGES and portrait
   slots packed in the middle so each portrait source goes into a
   portrait-shaped cell. Row 2 is unused — empty cylinder skin shows
   below row 1, which is fine because all media slots are above. */
function getPortraitHeavySlots(idx, items) {
  const [yawCDeg, yC, wC, hC] = PANEL_LAYOUT[idx];
  const yawC = THREE.MathUtils.degToRad(yawCDeg);
  const yDir = yC > 0 ? -1 : 1;

  const wideCount      = items.filter(it => it.t === 'video' && it.a >= 1).length;
  const portraitCount  = items.filter(it => it.t === 'image' && it.a <  1).length;
  const landscapeCount = items.filter(it => it.t === 'image' && it.a >= 1).length;

  const slots = [];

  // Cover row: 2 hero video slots flanking the cover.
  const cv = STORY_SLOT_DIMS.coverVideo;
  const coverYawDelta = (wC / 2 + HGAP + cv.w / 2) / RADIUS;
  if (wideCount >= 1) slots.push({ yaw: yawC - coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'wide' });
  if (wideCount >= 2) slots.push({ yaw: yawC + coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'wide' });

  // Row 1 y position (just below the cover row).
  const coverFarEdgeY = yC + yDir * hC / 2;
  const ROW_H = 200;
  const rowY = coverFarEdgeY + yDir * (HGAP + ROW_H / 2);

  // Build row widths + per-slot role.
  //   [landscape] [portrait]*N [landscape]   (landscape pinned to edges)
  // Portrait slots are 113×200 (aspect 0.565), matching 9:16 sources.
  // Landscape slots are 280×200 (aspect 1.40) — slight horizontal crop
  // on 16:9 sources but still clearly landscape-shaped.
  const PORTRAIT_W  = 113;
  const LANDSCAPE_W = 280;
  const widths = [];
  const roles  = [];
  let landsLeft  = landscapeCount;
  let landsRight = 0;
  if (landsLeft >= 2) { landsLeft--; landsRight++; }   // split evenly: 1 each side
  for (let i = 0; i < landsLeft; i++)  { widths.push(LANDSCAPE_W); roles.push('photo'); }
  for (let i = 0; i < portraitCount; i++) { widths.push(PORTRAIT_W); roles.push('portrait'); }
  for (let i = 0; i < landsRight; i++) { widths.push(LANDSCAPE_W); roles.push('photo'); }

  const totalW = widths.reduce((s, w) => s + w, 0) + (widths.length - 1) * HGAP;
  let cursor = -totalW / 2;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    slots.push({
      yaw: yawC + (cursor + w / 2) / RADIUS,
      y:   rowY,
      w,
      h:   ROW_H,
      role: roles[i],
    });
    cursor += w + HGAP;
  }

  return slots;
}

/* Slot template for very large media batches with several tall
   videos. Tall videos sit at the far yaw edges (2 per side for 4
   tall, etc.) so they read as heroes; cover row, portrait photos
   and landscape photos all sit in the cluster middle (the
   uninterrupted yaw range between the tall-slot pairs). The cluster
   expands beyond ±90° as needed to fit the tall hero slots without
   shrinking them. Used for Canary Full (1 wide + 4 tall + 10
   portrait + 9 landscape = 24 items).

   - Tall hero slot: 309 × 550 (aspect 0.562 — matches 9:16 source).
     ~70 % the area of Utah's hero tall, plenty bigger than the
     113 × 200 portraits.
   - Cover row: cover + wide-video LEFT + landscape-photo RIGHT.
   - Row 1: uniform 113 × 200 portrait slots in the centre yaw range.
   - Row 2: landscape photo slots in the centre yaw range, h = 100
     so source aspect can stay closer to 16:9 with slot width ~155
     (aspect ~1.55, slight crop on 16:9 sources). */
function getMediaHeavySlots(idx, items) {
  const [yawCDeg, yC, wC, hC] = PANEL_LAYOUT[idx];
  const yawC = THREE.MathUtils.degToRad(yawCDeg);
  const yDir = yC > 0 ? -1 : 1;

  const wideCount      = items.filter(it => it.t === 'video' && it.a >= 1).length;
  const tallCount      = items.filter(it => it.t === 'video' && it.a <  1).length;
  const portraitCount  = items.filter(it => it.t === 'image' && it.a <  1).length;
  const landscapeCount = items.filter(it => it.t === 'image' && it.a >= 1).length;

  const HGAP_ARC = HGAP / RADIUS;

  // Y geometry for the centre rows.
  // coverNearEdgeY is the cover's edge CLOSER to y=0 (the edge that
  // faces the rows). For a top-row cover at yC=166 with yDir=-1,
  // that's the cover's bottom at y=13.5; rows extend downward from
  // there. Mirror for bottom-row covers.
  const coverNearEdgeY = yC + yDir * hC / 2;
  const ROW1_H = 200;
  const row1Y  = coverNearEdgeY + yDir * (HGAP + ROW1_H / 2);
  const row1FarEdgeY = row1Y + yDir * ROW1_H / 2;
  const ROW2_H = 100;                                   // shorter row 2 → better landscape aspect
  const row2Y  = row1FarEdgeY + yDir * (HGAP + ROW2_H / 2);

  // Tall slot dimensions. Aspect matches typical 9:16 sources so the
  // video frame is rendered uncropped.
  const TALL_W = 309;
  const TALL_H = 550;
  // Tall slot is aligned with the cover's FAR edge (top for top-row
  // covers, bottom for bottom-row) so its top reaches as high as the
  // cover and it then extends down (toward row 2) by TALL_H. Centre
  // y is FAR edge plus yDir * TALL_H/2 — for top-row: 318.5 + (-1)*275 = 43.5.
  const coverFarEdgeY = yC - yDir * hC / 2;
  const tallY = coverFarEdgeY + yDir * TALL_H / 2;

  const slots = [];

  // ---- Cover row: cover + wide v LEFT + landscape photo RIGHT ----
  const cv = STORY_SLOT_DIMS.coverVideo;
  const coverYawDelta = (wC / 2 + HGAP + cv.w / 2) / RADIUS;
  slots.push({ yaw: yawC - coverYawDelta, y: yC, w: cv.w, h: cv.h,
               role: wideCount >= 1 ? 'wide' : 'photo' });
  if (landscapeCount >= 1) {
    slots.push({ yaw: yawC + coverYawDelta, y: yC, w: cv.w, h: cv.h, role: 'photo' });
  }
  const coverRowOuterYawOff = coverYawDelta + (cv.w / 2) / RADIUS;

  // ---- Tall slots at far edges ----
  // Distribute `tallCount` slots between the two sides — floor(N/2)
  // on the left, ceil(N/2) on the right. Each side stacks slots from
  // inside (next to cover row) outwards, separated by HGAP.
  const TALL_HALF_ARC = (TALL_W / 2) / RADIUS;
  const leftTallCount  = Math.floor(tallCount / 2);
  const rightTallCount = tallCount - leftTallCount;
  function placeSideTalls(side, count) {
    let nextInnerYawOff = coverRowOuterYawOff + HGAP_ARC;
    for (let i = 0; i < count; i++) {
      const centreYawOff = nextInnerYawOff + TALL_HALF_ARC;
      slots.push({
        yaw: yawC + side * centreYawOff,
        y:   tallY,
        w:   TALL_W,
        h:   TALL_H,
        role: 'tall',
      });
      nextInnerYawOff = centreYawOff + TALL_HALF_ARC + HGAP_ARC;
    }
  }
  placeSideTalls(-1, leftTallCount);
  placeSideTalls(+1, rightTallCount);

  // ---- Centre photo rows ----
  // Row 1 and row 2 sit in the cluster's centre yaw range, between
  // the innermost tall slots' inner edges (with HGAP buffer). That
  // range is exactly the cover row's yaw extent, so photo rows align
  // visually under the cover/wide-v/landscape-photo trio.
  const photoRowYawWidth = 2 * coverRowOuterYawOff * RADIUS;   // world units

  function fillCentreRow(count, y, w, h, role) {
    if (count <= 0) return;
    const totalW = count * w + (count - 1) * HGAP;
    let cursor = -totalW / 2;
    for (let i = 0; i < count; i++) {
      slots.push({
        yaw: yawC + (cursor + w / 2) / RADIUS,
        y, w, h, role,
      });
      cursor += w + HGAP;
    }
  }

  // Row 1: 10 portrait slots at uniform tall-shaped dims (113 × 200).
  const PORTRAIT_W = 113;
  fillCentreRow(portraitCount, row1Y, PORTRAIT_W, ROW1_H, 'portrait');

  // Row 2: landscape slots. Width chosen so all photos fit in the
  // centre row width with HGAP gaps.
  const row2Count = Math.max(0, landscapeCount - (landscapeCount >= 1 ? 1 : 0));
  if (row2Count > 0) {
    const row2W = Math.floor((photoRowYawWidth - (row2Count - 1) * HGAP) / row2Count);
    fillCentreRow(row2Count, row2Y, row2W, ROW2_H, 'photo');
  }

  return slots;
}

/* Dispatcher: picks the correct slot template for the story's mix.
   - itemCount > 16 → media-heavy template (Canary Full).
   - `portraitCount >= 3` + no tall → portrait-heavy template
     (Canary Sand).
   - any tall + no wide          → all-tall (Utah, if both portrait).
   - tall + wide                 → mixed template (Utah).
   - default                     → standard (Nathan, Highschool). */
function getStorySlots(idx, items) {
  const tallCount     = items.filter(it => it.t === 'video' && it.a <  1).length;
  const wideCount     = items.filter(it => it.t === 'video' && it.a >= 1).length;
  const photoCount    = items.filter(it => it.t === 'image').length;
  const portraitCount = items.filter(it => it.t === 'image' && it.a < 1).length;

  if (items.length > 16)                     return getMediaHeavySlots(idx, items);
  if (tallCount === 0 && portraitCount >= 3) return getPortraitHeavySlots(idx, items);
  if (tallCount === 0)                       return getStandardSlots(idx, items.length);
  if (tallCount >= 1 && wideCount === 0)     return getTallVideoSlots(idx, tallCount, photoCount);
  return getMixedSlots(idx, items);
}

function buildStoryFromItems(idx, items) {
  const slots = getStorySlots(idx, items);

  const wideVideos = items.filter(it => it.t === 'video' && it.a >= 1);
  const tallVideos = items.filter(it => it.t === 'video' && it.a < 1);
  const photos     = items.filter(it => it.t === 'image');

  // Deterministic-but-fresh shuffle of photos so the same cover
  // always sees the same arrangement on re-entry but different
  // covers feel distinct.
  const rand = mulberry32(idx + 1);
  const shuffledPhotos = photos.slice();
  for (let i = shuffledPhotos.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffledPhotos[i], shuffledPhotos[j]] = [shuffledPhotos[j], shuffledPhotos[i]];
  }

  // Bucket slot indices by role.
  const tallIdx     = [];
  const wideIdx     = [];
  const portraitIdx = [];
  const photoIdx    = [];
  slots.forEach((s, i) => {
    if (s.role === 'tall')          tallIdx.push(i);
    else if (s.role === 'wide')     wideIdx.push(i);
    else if (s.role === 'portrait') portraitIdx.push(i);
    else                            photoIdx.push(i);
  });

  const assignment = new Array(slots.length).fill(null);

  // Tall videos → tall slots.
  for (let i = 0; i < tallVideos.length && i < tallIdx.length; i++) {
    assignment[tallIdx[i]] = tallVideos[i];
  }
  // Wide videos → wide slots first; overflow falls back to photo
  // slots so a story with 4 wide videos still places all four.
  const wideQueue = wideVideos.slice();
  for (const sIdx of [...wideIdx, ...photoIdx]) {
    if (assignment[sIdx] !== null) continue;
    if (!wideQueue.length) break;
    assignment[sIdx] = wideQueue.shift();
  }
  // Portrait photos → portrait slots first so source aspect matches
  // slot aspect. Landscape photos and any portrait overflow then
  // fill the remaining (square-ish or landscape) slots.
  const portraitPhotos  = shuffledPhotos.filter(p => p.a <  1);
  const landscapePhotos = shuffledPhotos.filter(p => p.a >= 1);
  const portraitQueue   = portraitPhotos.slice();
  for (const sIdx of portraitIdx) {
    if (!portraitQueue.length) break;
    assignment[sIdx] = portraitQueue.shift();
  }
  const photoQueue = [...landscapePhotos, ...portraitQueue];
  for (const sIdx of [...wideIdx, ...portraitIdx, ...photoIdx]) {
    if (assignment[sIdx] !== null) continue;
    if (!photoQueue.length) break;
    assignment[sIdx] = photoQueue.shift();
  }

  // Drop the meshes into the scene at their fixed slot positions.
  for (let i = 0; i < slots.length; i++) {
    const item = assignment[i];
    if (!item) continue;
    const s = slots[i];
    placeStoryItem(s.yaw, s.y, s.w, s.h, item);
  }
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
