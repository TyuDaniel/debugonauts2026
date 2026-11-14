// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// The star field: one THREE.Points draw call. The vertex shader moves every star along its
// straight-line velocity (position + velocity * time), so scrubbing time costs nothing on the CPU.

import * as THREE from 'three';
import { FLAG_BD, type StarData } from './data';

const VERT = /* glsl */ `
attribute vec3 aVel;
attribute float aMag;   // absolute G magnitude * 1000
attribute float aCol;   // BP-RP * 1000
attribute float aFlag;

uniform float uTime;    // years since the catalogue epoch
uniform float uMagRef;  // apparent magnitude drawn at full strength
uniform float uScale;   // device pixels per CSS pixel, times a viewport factor
uniform float uMotion;  // 0 = star colours, 1 = colour by motion across the sky
uniform float uHaze;    // brightness floor for the faintest stars
uniform float uMinSize; // smallest point size, CSS pixels

varying vec3 vColor;
varying float vAlpha;
varying float vRing;
varying float vSize;

vec3 starColour(float c) {
  vec3 col = vec3(0.50, 0.66, 1.00);
  col = mix(col, vec3(0.66, 0.79, 1.00), smoothstep(-0.40, 0.00, c));
  col = mix(col, vec3(0.90, 0.94, 1.00), smoothstep(0.00, 0.50, c));
  col = mix(col, vec3(1.00, 0.91, 0.74), smoothstep(0.50, 0.85, c));
  col = mix(col, vec3(1.00, 0.76, 0.48), smoothstep(0.85, 1.40, c));
  col = mix(col, vec3(1.00, 0.60, 0.34), smoothstep(1.40, 2.20, c));
  col = mix(col, vec3(1.00, 0.46, 0.28), smoothstep(2.20, 3.20, c));
  col = mix(col, vec3(0.96, 0.36, 0.26), smoothstep(3.20, 4.80, c));
  return col;
}

vec3 motionColour(float t) {
  vec3 slow = vec3(0.22, 0.30, 0.46);
  vec3 mid = vec3(1.00, 0.706, 0.33);
  vec3 fast = vec3(1.00, 0.97, 0.90);
  return t < 0.5 ? mix(slow, mid, smoothstep(0.0, 0.5, t)) : mix(mid, fast, smoothstep(0.5, 1.0, t));
}

void main() {
  vec3 p = position + aVel * uTime;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float dCam = max(length(mv.xyz), 1e-4);

  // Apparent magnitude as seen from the camera, then relative flux.
  float m = aMag * 0.001 + 5.0 * log2(dCam * 0.1) * 0.30103;
  float flux = exp2(-1.32877 * (m - uMagRef));
  float size = clamp(2.0 * pow(flux, 0.33), uMinSize, 40.0);
  // A small floor keeps the faint red dwarfs (most of the catalogue) visible as a soft haze.
  float alpha = clamp(pow(flux, 0.62), 0.0, 1.0) + uHaze;
  vec3 colour = starColour(aCol * 0.001);

  // Brown dwarfs: rings of a steady screen size, fading with distance from the camera.
  float bd = step(0.5, mod(floor(aFlag * 0.5), 2.0));
  if (bd > 0.5) {
    size = clamp(300.0 / dCam, 4.0, 13.0);
    alpha = clamp(26.0 / dCam, 0.07, 0.95);
    colour = vec3(0.84, 0.55, 1.00);
  }

  if (uMotion > 0.001) {
    // Angular speed across the sky as seen from the Sun, in arcseconds per ten years.
    float r = max(length(p), 1e-4);
    vec3 rh = p / r;
    vec3 vt = aVel - rh * dot(aVel, rh);
    float a10 = length(vt) / r * 2062648.0;
    float t = clamp(log2(max(a10, 1e-3) / 0.62) * 0.150515, 0.0, 1.0);  // 0.62" -> 0, 6.2" -> 0.5, 62" -> 1
    float mSize = max(min(size, 5.0) * 0.8, mix(1.4, 8.5, t * t));
    float mAlpha = mix(0.035, 1.0, smoothstep(0.12, 0.72, t));
    if (bd > 0.5) { mSize = max(size, mSize); mAlpha = max(mAlpha, 0.3); }
    size = mix(size, mSize, uMotion);
    alpha = mix(alpha, mAlpha, uMotion);
    colour = mix(colour, motionColour(t), uMotion);
  }

  vColor = colour;
  vAlpha = alpha;
  vRing = bd;
  vSize = size;
  gl_PointSize = size * uScale;
  gl_Position = projectionMatrix * mv;
  if (alpha < 0.012) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);  // too faint to see: skip rasterising
}
`;

const FRAG = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vRing;
varying float vSize;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a;
  vec3 col = vColor;
  if (vRing > 0.5) {
    float w = clamp(1.6 / vSize, 0.10, 0.34);
    float ring = smoothstep(w, 0.0, abs(d - 0.74));
    float dot_ = smoothstep(0.26, 0.0, d) * 0.55;
    a = max(ring, dot_);
  } else {
    // Tight bright core with a soft halo that only matters on the larger sprites.
    float big = smoothstep(2.0, 10.0, vSize);
    float core = exp(-d * d * mix(2.2, 14.0, big));
    float halo = pow(1.0 - d, 3.0) * 0.22 * big;
    a = core + halo;
    col = mix(col, vec3(1.0), core * core * 0.55 * big);
  }
  gl_FragColor = vec4(col * a * vAlpha, 1.0);
}
`;

export class StarField {
  readonly points: THREE.Points;
  private readonly uniforms: {
    uTime: THREE.IUniform<number>;
    uMagRef: THREE.IUniform<number>;
    uScale: THREE.IUniform<number>;
    uMotion: THREE.IUniform<number>;
    uHaze: THREE.IUniform<number>;
    uMinSize: THREE.IUniform<number>;
  };
  private readonly m = new THREE.Matrix4();

  constructor(private readonly data: StarData) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.pos, 3));
    geo.setAttribute('aVel', new THREE.BufferAttribute(data.vel, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(data.mag, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(data.col, 1));
    geo.setAttribute('aFlag', new THREE.BufferAttribute(data.flags, 1));
    this.uniforms = {
      uTime: { value: 0 },
      uMagRef: { value: 9 },
      uScale: { value: 1 },
      uMotion: { value: 0 },
      uHaze: { value: 0.13 },
      uMinSize: { value: 1.5 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false; // stars move in the shader, so bounds are not static
  }

  set time(yearsSinceEpoch: number) { this.uniforms.uTime.value = yearsSinceEpoch; }
  get time(): number { return this.uniforms.uTime.value; }
  set magRef(v: number) { this.uniforms.uMagRef.value = v; }
  get magRef(): number { return this.uniforms.uMagRef.value; }
  set scale(v: number) { this.uniforms.uScale.value = v; }
  set minSize(v: number) { this.uniforms.uMinSize.value = v; }
  set haze(v: number) { this.uniforms.uHaze.value = v; }
  set motion(v: number) { this.uniforms.uMotion.value = v; }
  get motion(): number { return this.uniforms.uMotion.value; }

  /** Position of star i at the current shader time. */
  positionAt(i: number, out: THREE.Vector3, yearsSinceEpoch = this.time): THREE.Vector3 {
    const { pos, vel } = this.data;
    const k = 3 * i;
    return out.set(pos[k] + vel[k] * yearsSinceEpoch, pos[k + 1] + vel[k + 1] * yearsSinceEpoch, pos[k + 2] + vel[k + 2] * yearsSinceEpoch);
  }

  /**
   * CPU picking: project every star exactly as the shader does and return the most visible one
   * within `radius` CSS pixels of (x, y). About 1-2 ms for 332k stars, and exact at any zoom.
   */
  pick(camera: THREE.PerspectiveCamera, x: number, y: number, width: number, height: number, radius: number): number {
    const { pos, vel, mag, flags, n } = this.data;
    const t = this.time;
    const e = this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const e0 = e[0], e4 = e[4], e8 = e[8], e12 = e[12];
    const e1 = e[1], e5 = e[5], e9 = e[9], e13 = e[13];
    const e3 = e[3], e7 = e[7], e11 = e[11], e15 = e[15];
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const hw = width / 2, hh = height / 2;
    const r2 = radius * radius;
    const magRef = this.magRef;
    const motion = this.motion > 0.5;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      const px = pos[k] + vel[k] * t;
      const py = pos[k + 1] + vel[k + 1] * t;
      const pz = pos[k + 2] + vel[k + 2] * t;
      const w = e3 * px + e7 * py + e11 * pz + e15;
      if (w <= 1e-6) continue;
      const dx = ((e0 * px + e4 * py + e8 * pz + e12) / w) * hw + hw - x;
      if (dx > radius || dx < -radius) continue;
      const dy = hh - ((e1 * px + e5 * py + e9 * pz + e13) / w) * hh - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      // Rank candidates by how visible they are, then by distance from the pointer.
      const dCam = Math.hypot(px - cx, py - cy, pz - cz);
      let faint: number; // magnitudes fainter than the reference; lower is more visible
      if (motion) {
        const r = Math.hypot(px, py, pz) || 1e-4;
        const vr = (vel[k] * px + vel[k + 1] * py + vel[k + 2] * pz) / r;
        const vt = Math.sqrt(Math.max(0, vel[k] ** 2 + vel[k + 1] ** 2 + vel[k + 2] ** 2 - vr * vr));
        const a10 = (vt / r) * 2062648;
        const tt = Math.min(1, Math.max(0, Math.log10(Math.max(a10, 1e-3) / 0.62) / 2));
        faint = (1 - tt) * 10 - 3;
      } else if (flags[i] & FLAG_BD) {
        faint = dCam < 160 ? -3 : 4;
      } else {
        faint = mag[i] * 0.001 + 5 * Math.log10(dCam * 0.1) - magRef;
      }
      const score = Math.sqrt(d2) + Math.max(-4, Math.min(9, faint)) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }
}
