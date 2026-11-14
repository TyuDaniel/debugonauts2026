// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// Static furniture of the map: distance rings, the Sun, off-map direction markers, selection line.

import * as THREE from 'three';
import { GALACTIC_CENTRE, GALACTIC_NORTH, unitFromRaDec } from './astro';
import type { BeyondEntry } from './data';

export const RING_RADII = [10, 25, 50, 100];
export const MAP_RADIUS = 100;
/** Off-map markers are drawn from the map edge out to this radius (pc). */
export const BEYOND_INNER = 100;
export const BEYOND_OUTER = 124;

const north = new THREE.Vector3(...GALACTIC_NORTH);
// Basis of the Galactic plane: ex toward the Galactic centre, ey = north x ex.
const ex = new THREE.Vector3(...GALACTIC_CENTRE).projectOnPlane(north).normalize();
const ey = new THREE.Vector3().crossVectors(north, ex).normalize();

export function galacticNorth(): THREE.Vector3 {
  return north.clone();
}

/** Point in the Galactic plane at `radius` pc and Galactic longitude `lonDeg`. */
export function planePoint(radius: number, lonDeg: number): THREE.Vector3 {
  const a = (lonDeg * Math.PI) / 180;
  return ex.clone().multiplyScalar(Math.cos(a) * radius).addScaledVector(ey, Math.sin(a) * radius);
}

function circle(radius: number, segments: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) pts.push(planePoint(radius, (i / segments) * 360));
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function glowTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,250,235,1)');
  grad.addColorStop(0.1, 'rgba(255,226,160,0.95)');
  grad.addColorStop(0.28, 'rgba(255,180,84,0.32)');
  grad.addColorStop(0.6, 'rgba(255,180,84,0.07)');
  grad.addColorStop(1, 'rgba(255,180,84,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Furniture {
  readonly group = new THREE.Group();
  readonly sun: THREE.Sprite;
  private readonly selLine: THREE.Line;
  private readonly selPos: THREE.BufferAttribute;
  private readonly ringMats: THREE.LineBasicMaterial[] = [];

  constructor(beyond: BeyondEntry[]) {
    for (const r of RING_RADII) {
      const mat = new THREE.LineBasicMaterial({
        color: 0xbfc8d6,
        transparent: true,
        opacity: r === MAP_RADIUS ? 0.3 : 0.17,
        depthTest: false,
        depthWrite: false,
      });
      this.ringMats.push(mat);
      this.group.add(new THREE.LineLoop(circle(r, r >= 50 ? 256 : 128), mat));
    }
    // Two faint axes across the plane give the rings a sense of orientation.
    const axisMat = new THREE.LineBasicMaterial({ color: 0xbfc8d6, transparent: true, opacity: 0.07, depthTest: false, depthWrite: false });
    const axes = new THREE.BufferGeometry().setFromPoints([
      planePoint(MAP_RADIUS, 0), planePoint(MAP_RADIUS, 180), planePoint(MAP_RADIUS, 90), planePoint(MAP_RADIUS, 270),
    ]);
    this.group.add(new THREE.LineSegments(axes, axisMat));

    // Off-map targets: a dashed spoke leaving the 100 pc sphere in the target's direction.
    const dashMat = new THREE.LineDashedMaterial({
      color: 0xffb454, transparent: true, opacity: 0.75, dashSize: 2.2, gapSize: 2.2, depthTest: false, depthWrite: false,
    });
    for (const b of beyond) {
      const u = new THREE.Vector3(...unitFromRaDec(b.ra, b.dec));
      const geo = new THREE.BufferGeometry().setFromPoints([u.clone().multiplyScalar(BEYOND_INNER), u.clone().multiplyScalar(BEYOND_OUTER)]);
      const line = new THREE.Line(geo, dashMat);
      line.computeLineDistances();
      this.group.add(line);
    }

    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false,
    }));
    this.sun.scale.setScalar(0.045);
    this.group.add(this.sun);

    this.selPos = new THREE.BufferAttribute(new Float32Array(6), 3);
    const selGeo = new THREE.BufferGeometry();
    selGeo.setAttribute('position', this.selPos);
    this.selLine = new THREE.Line(selGeo, new THREE.LineBasicMaterial({
      color: 0xffb454, transparent: true, opacity: 0.42, depthTest: false, depthWrite: false,
    }));
    this.selLine.frustumCulled = false;
    this.selLine.visible = false;
    this.group.add(this.selLine);
  }

  /** Line from the Sun to the selected object, or hidden when `to` is null. */
  setSelection(to: THREE.Vector3 | null): void {
    this.selLine.visible = !!to;
    if (!to) return;
    this.selPos.setXYZ(1, to.x, to.y, to.z);
    this.selPos.needsUpdate = true;
  }

  /** Fade the Sun glow and rings as the camera reaches the Sun (during a dive). */
  setCameraDistance(dSun: number): void {
    const k = THREE.MathUtils.smoothstep(dSun, 0.4, 3);
    this.sun.material.opacity = k;
    this.ringMats.forEach((m, i) => {
      m.opacity = (RING_RADII[i] === MAP_RADIUS ? 0.3 : 0.17) * (0.25 + 0.75 * k);
    });
  }
}
