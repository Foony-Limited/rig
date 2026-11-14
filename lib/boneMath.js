import { BONE_ROTATION, BONE_SCALE_X, BONE_SCALE_Y, BONE_SHEAR_X, BONE_SHEAR_Y, BONE_STRIDE, BONE_X, BONE_Y, INHERIT_NO_ROTATION, INHERIT_NO_SCALE, INHERIT_ONLY_TRANSLATION, WORLD_STRIDE, } from './rigData.js';
/**
 * Bone matrix math shared by the compiler (setup pose, mesh weights) and the skeleton. A bone's
 * local matrix has its x axis turned by rotation + shearX and scaled by scaleX, and its y axis
 * turned by rotation + 90 + shearY and scaled by scaleY (Spine's model, so shear tilts one axis).
 */
/** Degrees to radians. */
export const DEG_RAD = Math.PI / 180;
/** Radians to degrees. */
export const RAD_DEG = 180 / Math.PI;
/**
 * Computes bone `index`'s world matrix from its pose and its parent's world matrix, which must
 * already be current.
 */
export function updateBoneWorld(bones, pose, world, index) {
    const p = index * BONE_STRIDE;
    const rotation = pose[p + BONE_ROTATION];
    const scaleX = pose[p + BONE_SCALE_X];
    const scaleY = pose[p + BONE_SCALE_Y];
    const angleX = (rotation + pose[p + BONE_SHEAR_X]) * DEG_RAD;
    const angleY = (rotation + 90 + pose[p + BONE_SHEAR_Y]) * DEG_RAD;
    const la = Math.cos(angleX) * scaleX;
    const lb = Math.sin(angleX) * scaleX;
    const lc = Math.cos(angleY) * scaleY;
    const ld = Math.sin(angleY) * scaleY;
    const x = pose[p + BONE_X];
    const y = pose[p + BONE_Y];
    const w = index * WORLD_STRIDE;
    const bone = bones[index];
    if (bone.parent < 0) {
        world[w] = la;
        world[w + 1] = lb;
        world[w + 2] = lc;
        world[w + 3] = ld;
        world[w + 4] = x;
        world[w + 5] = y;
        return;
    }
    const q = bone.parent * WORLD_STRIDE;
    // Position always follows the parent fully. The inherit mode only changes the axes.
    world[w + 4] = world[q] * x + world[q + 2] * y + world[q + 4];
    world[w + 5] = world[q + 1] * x + world[q + 3] * y + world[q + 5];
    getParentAxes(bones, world, index, parentAxes);
    const pa = parentAxes[0];
    const pb = parentAxes[1];
    const pc = parentAxes[2];
    const pd = parentAxes[3];
    world[w] = pa * la + pc * lb;
    world[w + 1] = pb * la + pd * lb;
    world[w + 2] = pa * lc + pc * ld;
    world[w + 3] = pb * lc + pd * ld;
}
/**
 * Writes the axes bone `index`'s local matrix is multiplied by, a, b, c, d (x axis then y axis),
 * into `out`: its parent's world axes, changed by the bone's inherit mode. The parent's world
 * matrix must be current, and the bone must have a parent.
 */
export function getParentAxes(bones, world, index, out) {
    const q = bones[index].parent * WORLD_STRIDE;
    const pa = world[q];
    const pb = world[q + 1];
    const pc = world[q + 2];
    const pd = world[q + 3];
    const inherit = bones[index].inherit;
    if (inherit === INHERIT_ONLY_TRANSLATION) {
        out[0] = 1;
        out[1] = 0;
        out[2] = 0;
        out[3] = 1;
    }
    else if (inherit === INHERIT_NO_ROTATION) {
        // Keep the parent's axis lengths (and a mirror), drop its turn and shear.
        const mirror = pa * pd - pb * pc < 0 ? -1 : 1;
        out[0] = Math.sqrt(pa * pa + pb * pb);
        out[1] = 0;
        out[2] = 0;
        out[3] = Math.sqrt(pc * pc + pd * pd) * mirror;
    }
    else if (inherit === INHERIT_NO_SCALE) {
        // Keep the parent's turn (and a mirror), drop its scale and shear.
        const mirror = pa * pd - pb * pc < 0 ? -1 : 1;
        const length = Math.sqrt(pa * pa + pb * pb);
        const cos = length > EPSILON ? pa / length : 1;
        const sin = length > EPSILON ? pb / length : 0;
        out[0] = cos;
        out[1] = sin;
        out[2] = -sin * mirror;
        out[3] = cos * mirror;
    }
    else {
        out[0] = pa;
        out[1] = pb;
        out[2] = pc;
        out[3] = pd;
    }
}
/** Below this, a length or determinant counts as 0: a part scaled away, which no inverse can undo. */
export const EPSILON = 1e-9;
/** Scratch for {@link updateBoneWorld}. */
const parentAxes = new Float64Array(4);
/** Returns the angle in degrees, wrapped into -180..180. */
export function wrapDegrees(degrees) {
    degrees %= 360;
    if (degrees > 180) {
        return degrees - 360;
    }
    if (degrees < -180) {
        return degrees + 360;
    }
    return degrees;
}
