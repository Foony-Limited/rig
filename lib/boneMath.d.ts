import { BoneData } from './rigData.js';
/**
 * Bone matrix math shared by the compiler (setup pose, mesh weights) and the skeleton. A bone's
 * local matrix has its x axis turned by rotation + shearX and scaled by scaleX, and its y axis
 * turned by rotation + 90 + shearY and scaled by scaleY (Spine's model, so shear tilts one axis).
 */
/** Degrees to radians. */
export declare const DEG_RAD: number;
/** Radians to degrees. */
export declare const RAD_DEG: number;
/**
 * Computes bone `index`'s world matrix from its pose and its parent's world matrix, which must
 * already be current.
 */
export declare function updateBoneWorld(bones: readonly BoneData[], pose: Float64Array, world: Float64Array, index: number): void;
/**
 * Writes the axes bone `index`'s local matrix is multiplied by, a, b, c, d (x axis then y axis),
 * into `out`: its parent's world axes, changed by the bone's inherit mode. The parent's world
 * matrix must be current, and the bone must have a parent.
 */
export declare function getParentAxes(bones: readonly BoneData[], world: Float64Array, index: number, out: Float64Array): void;
/** Below this, a length or determinant counts as 0: a part scaled away, which no inverse can undo. */
export declare const EPSILON = 1e-9;
/** Returns the angle in degrees, wrapped into -180..180. */
export declare function wrapDegrees(degrees: number): number;
//# sourceMappingURL=boneMath.d.ts.map