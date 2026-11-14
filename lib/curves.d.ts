/** Every curve name a key or crossfade accepts, for error messages. */
export declare const CURVE_NAMES: readonly string[];
/** Returns the curve code for a curve name, or -1 if there is no such name. */
export declare function getCurveCode(name: string): number;
/**
 * Returns `progress` (0..1) eased by curve `code`. Bezier curves read their lookup table from
 * `bezier` at `offset`.
 */
export declare function applyCurve(code: number, progress: number, bezier: Float64Array | null, offset: number): number;
/**
 * Writes {@link BEZIER_SAMPLES} (x, y) points of the CSS cubic-bezier (x1, y1, x2, y2) into
 * `out` at `offset`. The curve runs from (0, 0) to (1, 1), so x is progress and y the eased value.
 */
export declare function writeBezierTable(x1: number, y1: number, x2: number, y2: number, out: Float64Array, offset: number): void;
//# sourceMappingURL=curves.d.ts.map