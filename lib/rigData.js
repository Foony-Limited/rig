/**
 * A compiled rig: what {@link compileRig} makes from a rig file. Names are turned into indexes
 * and keys into flat typed arrays, so playing an animation does no lookups by name and makes no
 * garbage. Read-only and shared by every {@link Skeleton} made from it.
 *
 * Matrices are 2D affine transforms in canvas order `[a, b, c, d, e, f]`: a point (x, y) maps to
 * (a*x + c*y + e, b*x + d*y + f), the same as `CanvasRenderingContext2D.setTransform` takes.
 */
/** Floats per bone in a pose array: x, y, rotation, scaleX, scaleY, shearX, shearY. */
export const BONE_STRIDE = 7;
/** Offsets of each property inside a bone's {@link BONE_STRIDE} floats. */
export const BONE_X = 0;
export const BONE_Y = 1;
export const BONE_ROTATION = 2;
export const BONE_SCALE_X = 3;
export const BONE_SCALE_Y = 4;
export const BONE_SHEAR_X = 5;
export const BONE_SHEAR_Y = 6;
/** Floats per bone in the world array: one matrix. */
export const WORLD_STRIDE = 6;
/** A bone's inherit mode, compiled from {@link RigInherit}. */
export const INHERIT_NORMAL = 0;
export const INHERIT_NO_ROTATION = 1;
export const INHERIT_NO_SCALE = 2;
export const INHERIT_ONLY_TRANSLATION = 3;
/** Flipbook modes, in the order of {@link RigSequenceMode}. A reverse mode is its forward mode plus {@link SEQUENCE_REVERSE}. */
export const SEQUENCE_LOOP = 0;
export const SEQUENCE_ONCE = 1;
export const SEQUENCE_PINGPONG = 2;
export const SEQUENCE_HOLD = 3;
export const SEQUENCE_REVERSE = 4;
/** Floats per slot in a skeleton's `slotSequences`: mode, fps, first frame, seconds since the key. */
export const SEQUENCE_FLOATS = 4;
/** Returns the image x where a chain mesh's chain (its {@link MeshAttachment.joints}) crosses image row `v`. */
export function getChainU(joints, v) {
    const isDown = joints[joints.length - 1] >= joints[1];
    for (let k = 2; k < joints.length; k += 2) {
        if (k === joints.length - 2 || (isDown ? v <= joints[k + 1] : v >= joints[k + 1])) {
            const t = Math.max(0, Math.min(1, (v - joints[k - 1]) / (joints[k + 1] - joints[k - 1] || 1)));
            return joints[k - 2] + (joints[k] - joints[k - 2]) * t;
        }
    }
    return joints[0];
}
/** How a path constraint turns its bones. */
export const PATH_ROTATE_TANGENT = 0;
export const PATH_ROTATE_CHAIN = 1;
export const PATH_ROTATE_NONE = 2;
/** What a timeline animates. */
export const TIMELINE_BONE = 0;
export const TIMELINE_ATTACHMENT = 1;
export const TIMELINE_COLOR = 2;
export const TIMELINE_ALPHA = 3;
export const TIMELINE_IK_MIX = 4;
export const TIMELINE_IK_BEND = 5;
export const TIMELINE_TRANSFORM_MIX = 6;
export const TIMELINE_PHYSICS_MIX = 7;
export const TIMELINE_SLIDER_TIME = 8;
export const TIMELINE_SLIDER_MIX = 9;
export const TIMELINE_DARK = 10;
export const TIMELINE_SEQUENCE = 11;
export const TIMELINE_DEFORM = 12;
export const TIMELINE_PATH_POSITION = 13;
export const TIMELINE_PATH_SPACING = 14;
export const TIMELINE_PATH_MIX = 15;
/** Curve codes for a key's segment. Higher codes are easing functions, see curves.ts. */
export const CURVE_LINEAR = 0;
export const CURVE_STEP = 1;
export const CURVE_BEZIER = 2;
/** Points sampled along each bezier curve. More is smoother, fewer is faster. */
export const BEZIER_SAMPLES = 16;
/** Constraint kinds in {@link RigData.updateOrder}. */
export const UPDATE_IK = 0;
export const UPDATE_TRANSFORM = 1;
export const UPDATE_PHYSICS = 2;
export const UPDATE_SLIDER = 3;
export const UPDATE_PATH = 4;
/** Constraint index range per kind in {@link RigData.updateOrder}. */
export const CONSTRAINT_KINDS_STRIDE = 1 << 16;
