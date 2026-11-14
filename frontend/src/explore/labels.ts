// Written with AI assistance (Claude) for the NASA Space Apps 2026 hackathon.
// HTML labels pinned to 3D points, with priority-based collision hiding.

import * as THREE from 'three';

export type LabelKind = 'sun' | 'showcase' | 'famous' | 'ring' | 'region' | 'beyond';

export interface LabelSpec {
  text: string;
  kind: LabelKind;
  /** World position at the current time. */
  position: (out: THREE.Vector3) => THREE.Vector3;
  /** Called on click/tap; labels without it ignore the pointer. */
  onSelect?: () => void;
  /** Hide when the camera is farther than this from the point (pc). */
  maxCamDist?: number;
  /** Hide when the camera is nearer than this to the point (pc). */
  minCamDist?: number;
}

interface Item {
  spec: LabelSpec;
  el: HTMLElement;
  w: number;
  h: number;
  shown: boolean;
}

export class LabelLayer {
  private items: Item[] = [];
  private readonly v = new THREE.Vector3();
  private readonly placed: number[] = [];
  private obstacles: number[] = [];

  constructor(private readonly root: HTMLElement) {}

  /** Add labels in priority order: earlier labels win collisions. */
  add(spec: LabelSpec): void {
    const el = document.createElement(spec.onSelect ? 'button' : 'span');
    el.className = `label label-${spec.kind}`;
    el.textContent = spec.text;
    if (spec.onSelect) {
      (el as HTMLButtonElement).type = 'button';
      el.tabIndex = -1;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        spec.onSelect!();
      });
    }
    this.root.appendChild(el);
    this.items.push({ spec, el, w: 0, h: 0, shown: false });
  }

  /** Screen rectangles (UI panels) that labels must not be drawn over. */
  setObstacles(rects: DOMRect[]): void {
    this.obstacles = [];
    for (const r of rects) if (r.width && r.height) this.obstacles.push(r.left - 6, r.top - 4, r.right + 6, r.bottom + 4);
  }

  measure(): void {
    for (const it of this.items) {
      it.w = it.el.offsetWidth;
      it.h = it.el.offsetHeight;
    }
  }

  update(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    const placed = this.placed;
    placed.length = 0;
    for (const v of this.obstacles) placed.push(v);
    for (const it of this.items) {
      if (!it.w) {
        it.w = it.el.offsetWidth;
        it.h = it.el.offsetHeight;
      }
      const p = it.spec.position(this.v);
      const camDist = p.distanceTo(camera.position);
      p.project(camera);
      let show = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.05 && Math.abs(p.y) < 1.05;
      if (show && it.spec.maxCamDist !== undefined && camDist > it.spec.maxCamDist) show = false;
      if (show && it.spec.minCamDist !== undefined && camDist < it.spec.minCamDist) show = false;
      let x = 0;
      let y = 0;
      if (show) {
        x = (p.x * 0.5 + 0.5) * width + 9;
        y = (0.5 - p.y * 0.5) * height - it.h / 2;
        if (it.spec.kind === 'ring' || it.spec.kind === 'region') x -= 9 + it.w / 2;
        const x1 = x - 12, y1 = y - 5, x2 = x + it.w + 10, y2 = y + it.h + 5;
        for (let k = 0; k < placed.length; k += 4) {
          if (x1 < placed[k + 2] && x2 > placed[k] && y1 < placed[k + 3] && y2 > placed[k + 1]) {
            show = false;
            break;
          }
        }
        if (show) placed.push(x1, y1, x2, y2);
      }
      if (show !== it.shown) {
        it.shown = show;
        it.el.classList.toggle('on', show);
      }
      if (show) it.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
    }
  }
}
