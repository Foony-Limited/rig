import {BEZIER_SAMPLES, CURVE_BEZIER, CURVE_LINEAR, CURVE_STEP} from './rigData.js';

/**
 * Easing functions for key segments and crossfades. Each maps progress 0..1 to eased 0..1.
 * A named curve compiles to a code: 0 linear, 1 step, 2 bezier, then `EASING_BASE + i` for
 * the i-th of `EASING_NAMES` (a family's In, Out, then InOut).
 */

const EASING_BASE = 3;

function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) {
    return n * t * t;
  }
  if (t < 2 / d) {
    t -= 1.5 / d;
    return n * t * t + 0.75;
  }
  if (t < 2.5 / d) {
    t -= 2.25 / d;
    return n * t * t + 0.9375;
  }
  t -= 2.625 / d;
  return n * t * t + 0.984375;
}

const BACK_OVERSHOOT = 1.70158;

/** Ease-in families, in code order. Each gives an In, an Out, and an InOut curve. */
const FAMILY_NAMES = ['sine', 'quad', 'cubic', 'quart', 'expo', 'back', 'elastic', 'bounce'];
/** Curves per family: In, Out, then InOut (named for the family alone). */
const PER_FAMILY = 3;
const EASING_NAMES: string[] = FAMILY_NAMES.flatMap(name => [`${name}In`, `${name}Out`, name]);

/**
 * Returns family `family`'s ease-in at `t`. One switch, not a table of functions, so a hot key
 * loop makes direct calls and V8 doesn't box the results.
 */
function easeIn(family: number, t: number): number {
  switch (family) {
    case 0:
      return 1 - Math.cos((t * Math.PI) / 2);
    case 1:
      return t * t;
    case 2:
      return t * t * t;
    case 3:
      return t * t * t * t;
    case 4:
      return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
    case 5:
      return t * t * ((BACK_OVERSHOOT + 1) * t - BACK_OVERSHOOT);
    case 6:
      return t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin(((t * 10 - 10.75) * 2 * Math.PI) / 3);
    default:
      return 1 - bounceOut(1 - t);
  }
}

/** Every curve name a key or crossfade accepts, for error messages. */
export const CURVE_NAMES: readonly string[] = ['linear', 'step', ...EASING_NAMES];

/** Returns the curve code for a curve name, or -1 if there is no such name. */
export function getCurveCode(name: string): number {
  if (name === 'linear') {
    return CURVE_LINEAR;
  }
  if (name === 'step') {
    return CURVE_STEP;
  }
  const index = EASING_NAMES.indexOf(name);
  return index === -1 ? -1 : EASING_BASE + index;
}

/**
 * Returns `progress` (0..1) eased by curve `code`. Bezier curves read their lookup table from
 * `bezier` at `offset`.
 */
export function applyCurve(code: number, progress: number, bezier: Float64Array | null, offset: number): number {
  if (code === CURVE_LINEAR) {
    return progress;
  }
  if (code === CURVE_STEP) {
    return 0;
  }
  if (code === CURVE_BEZIER) {
    return sampleBezier(bezier!, offset, progress);
  }
  const index = code - EASING_BASE;
  const family = Math.floor(index / PER_FAMILY);
  const direction = index - family * PER_FAMILY;
  if (direction === 0) {
    return easeIn(family, progress);
  }
  if (direction === 1) {
    return 1 - easeIn(family, 1 - progress);
  }
  return progress < 0.5 ? easeIn(family, progress * 2) / 2 : 1 - easeIn(family, (1 - progress) * 2) / 2;
}

/**
 * Writes {@link BEZIER_SAMPLES} (x, y) points of the CSS cubic-bezier (x1, y1, x2, y2) into
 * `out` at `offset`. The curve runs from (0, 0) to (1, 1), so x is progress and y the eased value.
 */
export function writeBezierTable(x1: number, y1: number, x2: number, y2: number, out: Float64Array, offset: number) {
  for (let i = 0; i < BEZIER_SAMPLES; i++) {
    const t = (i + 1) / (BEZIER_SAMPLES + 1);
    const u = 1 - t;
    out[offset + i * 2] = 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t;
    out[offset + i * 2 + 1] = 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t;
  }
}

/** Reads the eased value at progress `x` from a table made by {@link writeBezierTable}. */
function sampleBezier(table: Float64Array, offset: number, x: number): number {
  // The x values rise along the table (x1 and x2 are in 0..1), so the first sample past x brackets it.
  let previousX = 0;
  let previousY = 0;
  for (let i = 0; i < BEZIER_SAMPLES; i++) {
    const sampleX = table[offset + i * 2];
    const sampleY = table[offset + i * 2 + 1];
    if (sampleX >= x) {
      return sampleX === previousX ? sampleY : previousY + ((sampleY - previousY) * (x - previousX)) / (sampleX - previousX);
    }
    previousX = sampleX;
    previousY = sampleY;
  }
  return previousY + ((1 - previousY) * (x - previousX)) / (1 - previousX);
}
