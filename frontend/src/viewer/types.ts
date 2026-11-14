// SkyDive viewer — shared types. Written with AI coding assistance (Claude Code).

export type Fov = 4 | 6.5 | 13 | 26;
export type Mode = 'blink' | 'sum' | 'diff';

export const FOV_NPX: Record<string, number> = { '4': 39, '6.5': 64, '13': 128, '26': 256 };
export const FOV_HINT: Record<string, string> = { '4': '8 s', '6.5': '12 s', '13': '16 s', '26': '40 s' };
export const SPHEREX_SCALE = 6.15; // arcsec per pixel
export const MJYSR_TO_UJY = 889; // per SPHEREx pixel (docs/SERVICES.md)
// SPHEREx's filters reach a little past the nominal 0.75–5.0 µm at the detector edges (0.742–5.003 µm seen).
export const WL_MIN = 0.7;
export const WL_MAX = 5.05;

export const DETECTORS: { n: number; lo: number; hi: number }[] = [
  // Measured edges of each detector's wavelengths; neighbours overlap slightly, so the ranges do too.
  { n: 1, lo: 0.7, hi: 1.11 },
  { n: 2, lo: 1.08, hi: 1.67 },
  { n: 3, lo: 1.62, hi: 2.42 },
  { n: 4, lo: 2.42, hi: 3.81 },
  { n: 5, lo: 3.8, hi: 4.44 },
  { n: 6, lo: 4.41, hi: 5.05 },
];

/** Spectral features from docs/SERVICES.md section 7. */
export const FEATURES: { key: string; label: string; chip: string; short: string; um: number; lo: number; hi: number; contaminant?: boolean }[] = [
  { key: 'paa', chip: 'H Pa-α', label: 'Hydrogen (Paschen-α)', short: 'Pa α', um: 1.875, lo: 1.83, hi: 1.92 },
  { key: 'h2o', chip: 'Water ice', label: 'Water ice', short: 'H₂O', um: 3.05, lo: 2.95, hi: 3.15 },
  { key: 'ch4', chip: 'Methane', label: 'Methane / PAH', short: 'CH₄', um: 3.3, lo: 3.22, hi: 3.38 },
  { key: 'bra', chip: 'H Br-α', label: 'Hydrogen (Brackett-α)', short: 'Br α', um: 4.052, lo: 4.01, hi: 4.1 },
  { key: 'co2', chip: 'CO₂ ice', label: 'CO₂ ice', short: 'CO₂', um: 4.27, lo: 4.2, hi: 4.34 },
  { key: 'co', chip: 'CO ice', label: 'CO ice', short: 'CO', um: 4.67, lo: 4.6, hi: 4.74 },
  { key: 'he', chip: 'Helium', label: 'Helium airglow (contaminant)', short: 'He', um: 1.083, lo: 1.07, hi: 1.1, contaminant: true },
];

/** Flag bits masked when stacking (docs/SERVICES.md). Never bit 21. */
export const MASK_BITS = [0, 2, 6, 7, 9, 10, 11, 14, 15, 17, 20, 22, 23, 24, 25, 26, 27, 28];
export const MASK_WORD = MASK_BITS.reduce((m, b) => (m | (1 << b)) >>> 0, 0);

export interface Exposure {
  id: string;
  mjd: number;
  detector: number;
  wave_um: number | null;
  bw_um: number | null;
  release: string;
  url?: string;
  key?: string;
  visit: number;
  /** Set once the cutout has arrived. */
  loaded: boolean;
  ok: boolean;
  error?: string;
  dwave_dx: number;
  dwave_dy: number;
  bg: number;
  flag_frac: number;
  /** Index into the worker's arrays; -1 until loaded ok. */
  idx: number;
}

export interface Visit {
  id: number;
  mjd_start: number;
  mjd_end: number;
  n: number;
}

export interface HistFrame {
  survey: 'wise' | 'ps1';
  band: string;
  mjd: number;
  n_px: number;
  pixscale_arcsec: number;
  label: string;
  /** Pan-STARRS only: exposures combined, and how much of the frame was filled from other filters. */
  n_warps?: number;
  filled_frac?: number;
  filled_bands?: string;
  data: Float32Array;
}

export interface Frame {
  /** s{visit}, w{epoch}, p{index} */
  id: string;
  kind: 'spherex' | 'wise' | 'ps1';
  mjd: number;
  mjd0: number;
  mjd1: number;
  label: string;
  visit?: number;
  /** For WISE: frames by band name. For PS1: single entry. */
  hist?: Record<string, HistFrame>;
}

export interface OverlaySource {
  cat: 'gaia' | 'catwise' | 'vsx';
  id: string;
  name?: string;
  ra: number;
  dec: number;
  epoch: number;
  pmra: number | null;
  pmdec: number | null;
  plx?: number | null;
  mag?: number | null;
  color?: number | null;
  w1?: number | null;
  w2?: number | null;
  vtype?: string;
  period?: number | string | null;
  max_mag?: string;
  min_mag?: string;
}

export interface SsoObject {
  mjd: number;
  num?: string;
  name: string;
  ra: number;
  dec: number;
  class?: string;
  vmag?: number | null;
  dra?: number | null;
  ddec?: number | null;
}

export interface Neossat {
  count: number;
  date_min?: string | null;
  date_max?: string | null;
  previews: { obs_id: string; date: string; url: string; exposure_s?: number }[];
}

export interface BakedField {
  key: string;
  name: string;
  ra: number;
  dec: number;
  n_px: number[];
  blurb?: string;
  note?: string;
}

export type Status = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

export interface StackResult {
  img: Float32Array;
  /** Fraction (0–255) of contributing exposures masked at each pixel. */
  tint: Uint8Array;
  n: number;
  ids: number[];
}

export interface PhotPoint {
  idx: number;
  wave: number;
  flux: number; // µJy
  err: number; // µJy
  ok: boolean;
}
