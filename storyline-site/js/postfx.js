/* ==============================================================
   postfx.js — custom post-processing shaders.

   FisheyeShader  → barrel-distorts the rendered image so straight
                    lines bow outward, giving the "wrap-around screen"
                    feel. Includes a touch of chromatic aberration
                    that strengthens toward the edges.

   FilmShader     → vintage / retro look on top of the distorted
                    image: desaturation, sepia warm cast, soft
                    contrast, animated grain, scanlines, vignette,
                    and the occasional bright dust speck.

   Both are plain THREE.ShaderPass-compatible objects. main.js
   wires them into an EffectComposer in order:
     RenderPass → FisheyePass → FilmPass → OutputPass
   ============================================================== */

import * as THREE from 'three';

export const FisheyeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    strength:   { value: 0.55 },                   // barrel amount
    chroma:     { value: 0.006 },                  // RGB split at edge
    bgColor:    { value: new THREE.Color(0xece4d2) },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform float chroma;
    uniform vec3  bgColor;
    uniform vec2  resolution;
    varying vec2  vUv;

    // Barrel distortion centered at (0.5, 0.5).
    //
    // The result is renormalized so the screen corner maps exactly to
    // the source corner, while the middle of each edge is pushed out
    // toward the corner — so straight lines bow outward (the fisheye
    // look) and the rendered scene covers the entire viewport, with
    // no empty paper-coloured margins.
    vec2 barrel(vec2 uv, float k) {
      float aspect = resolution.x / resolution.y;
      vec2 p = uv - 0.5;
      p.x *= aspect;

      float r2   = dot(p, p);
      float f    = 1.0 + r2 * (k + k * r2);

      // f at the screen corner: rMax² = (aspect/2)² + (1/2)²
      float rMax2 = 0.25 * (aspect * aspect + 1.0);
      float fMax  = 1.0 + rMax2 * (k + k * rMax2);

      p *= f / fMax;
      p.x /= aspect;
      return p + 0.5;
    }

    void main() {
      // sample each channel with a slightly different distortion strength
      vec2 uvR = barrel(vUv, strength + chroma);
      vec2 uvG = barrel(vUv, strength);
      vec2 uvB = barrel(vUv, strength - chroma);

      // clamp as a safety net; with the renormalised barrel above the
      // sample UVs already stay in [0, 1] for any aspect ratio.
      uvR = clamp(uvR, 0.0, 1.0);
      uvG = clamp(uvG, 0.0, 1.0);
      uvB = clamp(uvB, 0.0, 1.0);

      vec3 col;
      col.r = texture2D(tDiffuse, uvR).r;
      col.g = texture2D(tDiffuse, uvG).g;
      col.b = texture2D(tDiffuse, uvB).b;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export const FilmShader = {
  uniforms: {
    tDiffuse:        { value: null },
    time:            { value: 0 },
    resolution:      { value: new THREE.Vector2(1, 1) },
    grainAmount:     { value: 0.13 },
    sepiaAmount:     { value: 0.34 },
    desatAmount:     { value: 0.22 },
    contrastAmount:  { value: 0.96 },
    vignetteAmount:  { value: 0.55 },
    scanlineAmount:  { value: 0.06 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform vec2  resolution;
    uniform float grainAmount;
    uniform float sepiaAmount;
    uniform float desatAmount;
    uniform float contrastAmount;
    uniform float vignetteAmount;
    uniform float scanlineAmount;
    varying vec2  vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // 1. desaturate slightly
      float gray = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(gray), desatAmount);

      // 2. sepia / warm cast (classic photo conversion matrix)
      vec3 sepia = vec3(
        dot(col, vec3(0.393, 0.769, 0.189)),
        dot(col, vec3(0.349, 0.686, 0.168)),
        dot(col, vec3(0.272, 0.534, 0.131))
      );
      col = mix(col, sepia, sepiaAmount);

      // 3. soft contrast pull-down
      col = (col - 0.5) * contrastAmount + 0.5;

      // 4. animated film grain
      float n = hash(vUv * resolution + time * 73.0);
      col += (n - 0.5) * grainAmount;

      // 5. fine horizontal scanlines (very subtle)
      float sl = sin(vUv.y * resolution.y * 1.6) * 0.5 + 0.5;
      col *= 1.0 - scanlineAmount * sl;

      // 6. vignette — extra darkness at corners on top of fisheye fall-off
      vec2 vc = vUv - 0.5;
      float vd = dot(vc, vc);
      col *= 1.0 - vignetteAmount * smoothstep(0.18, 0.78, vd);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
