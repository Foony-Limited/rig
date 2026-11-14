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

/** A compiled bone. Its setup pose is in {@link RigData.setup}. */
export type BoneData = {
  readonly index: number;
  readonly name: string;
  /** -1 for the root. Always lower than `index`. */
  readonly parent: number;
  readonly length: number;
  /** One of the `INHERIT_*` constants. */
  readonly inherit: number;
  /** Local rotation range for `check`, or null. */
  readonly limits: readonly [number, number] | null;
  /** Index into {@link RigData.skins} of the skin this bone comes with, or -1 for always on. */
  readonly skin: number;
};

/** Slot blend modes as `globalCompositeOperation` values. */
export type BlendOperation = 'source-over' | 'lighter' | 'multiply' | 'screen';

/** A compiled slot. */
export type SlotData = {
  readonly index: number;
  readonly name: string;
  readonly bone: number;
  /** Every attachment name any skin uses on this slot. Keys and the skeleton refer to them by index. */
  readonly attachmentNames: readonly string[];
  /** Index into `attachmentNames` shown in setup, or -1 for none. */
  readonly setupAttachment: number;
  /** Setup tint r, g, b, a, each 0 to 1. */
  readonly color: readonly [number, number, number, number];
  /** Setup tint for the art's dark parts, r, g, b, each 0 to 1. Black is no tint. */
  readonly dark: readonly [number, number, number];
  readonly blend: BlendOperation;
};

/** An image on a bone, with optional flipbook frames. */
export type RegionAttachment = {
  readonly kind: 'region';
  readonly name: string;
  /** Image names: one, or every flipbook frame. */
  readonly images: readonly string[];
  /** Image size in pixels. */
  readonly width: number;
  readonly height: number;
  /** Maps image pixels (x right, y down) into the bone's space. */
  readonly matrix: readonly [number, number, number, number, number, number];
  /** The part of the image drawn, left, top, right, bottom, in image pixels. The whole image unless cropped. */
  readonly crop: readonly [number, number, number, number];
  /** Tint r, g, b, a, multiplied with the slot's. */
  readonly color: readonly [number, number, number, number];
  readonly fps: number;
  /** A `SEQUENCE_*` flipbook mode. */
  readonly mode: number;
};

/** Flipbook modes, in the order of {@link RigSequenceMode}. A reverse mode is its forward mode plus {@link SEQUENCE_REVERSE}. */
export const SEQUENCE_LOOP = 0;
export const SEQUENCE_ONCE = 1;
export const SEQUENCE_PINGPONG = 2;
export const SEQUENCE_HOLD = 3;
export const SEQUENCE_REVERSE = 4;
/** Floats per slot in a skeleton's `slotSequences`: mode, fps, first frame, seconds since the key. */
export const SEQUENCE_FLOATS = 4;

/**
 * An image drawn as triangles whose corners follow bones. Corner `i` is the weighted sum, over its
 * influences, of `weight * (bone world matrix * local point)`.
 */
export type MeshAttachment = {
  readonly kind: 'mesh';
  readonly name: string;
  /** Image names: one, or every flipbook frame. */
  readonly images: readonly string[];
  readonly fps: number;
  /** A `SEQUENCE_*` flipbook mode. */
  readonly mode: number;
  readonly width: number;
  readonly height: number;
  readonly color: readonly [number, number, number, number];
  /** Corner image pixels, x then y per corner. */
  readonly uvs: Float32Array;
  /** Three corner indexes per triangle. */
  readonly triangles: Uint16Array;
  /**
   * Per corner: an influence count n, then n times (bone index, local x, local y, weight). The
   * corners are packed back to back.
   */
  readonly weights: Float32Array;
  /** Number of corners. */
  readonly vertexCount: number;
  /** Each corner's setup-pose position in skeleton space, x then y. Joint blending turns corners from here. */
  readonly bindPositions: Float32Array;
  /**
   * Grid cells across and down: corner (row, column) is index row * (columns + 1) + column. Both 0
   * for a mesh of hand-placed points.
   */
  readonly columns: number;
  readonly rows: number;
  /** The image x range the grid spans, in image pixels: the whole image, or its trimmed art. */
  readonly left: number;
  readonly right: number;
  /** Maps image pixels into skeleton space in the setup pose, canvas order. */
  readonly bindMatrix: readonly [number, number, number, number, number, number];
  /** The bones the mesh bends with, in chain order. */
  readonly chain: readonly number[];
  /**
   * Where the chain's start, each joint (each bone after the first), and its end sit in the image,
   * u then v, in image pixels. Each image row is weighted by where the chain crosses it, so a row
   * stays a straight line however the chain bends (see {@link getChainU}). Null if the chain doesn't
   * run along the image's rows or has one bone.
   */
  readonly joints: Float32Array | null;
};

/** Returns the image x where a chain mesh's chain (its {@link MeshAttachment.joints}) crosses image row `v`. */
export function getChainU(joints: Float32Array, v: number): number {
  const isDown = joints[joints.length - 1] >= joints[1];
  for (let k = 2; k < joints.length; k += 2) {
    if (k === joints.length - 2 || (isDown ? v <= joints[k + 1] : v >= joints[k + 1])) {
      const t = Math.max(0, Math.min(1, (v - joints[k - 1]) / (joints[k + 1] - joints[k - 1] || 1)));
      return joints[k - 2] + (joints[k] - joints[k - 2]) * t;
    }
  }
  return joints[0];
}

/** A clipping polygon. */
export type ClipAttachment = {
  readonly kind: 'clip';
  readonly name: string;
  /** Polygon corners in the bone's space, x then y. */
  readonly points: Float64Array;
  /** Index of the last slot clipped. */
  readonly endSlot: number;
  readonly inverse: boolean;
};

/** A named spot on a bone. */
export type PointAttachment = {
  readonly kind: 'point';
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
};

/** A hit-test polygon. */
export type BoxAttachment = {
  readonly kind: 'box';
  readonly name: string;
  /** Polygon corners in the bone's space, x then y. */
  readonly points: Float64Array;
};

/** Any compiled attachment. */
/** A Catmull-Rom curve through points, for path constraints. Draws nothing. */
export type PathAttachment = {
  readonly kind: 'path';
  readonly name: string;
  /** The points in the slot bone's space, x then y. */
  readonly points: Float64Array;
  readonly closed: boolean;
  /**
   * Null if the points ride the slot's bone. Else per point an influence count n, then n times
   * (bone index, local x, local y, weight), like {@link MeshAttachment.weights}.
   */
  readonly weights: Float32Array | null;
};

export type Attachment = RegionAttachment | MeshAttachment | ClipAttachment | PointAttachment | BoxAttachment | PathAttachment;

/** A skin: per slot, per attachment name index, the attachment it supplies (or undefined). */
export type SkinData = {
  readonly name: string;
  readonly attachments: readonly (readonly (Attachment | undefined)[])[];
};

/** A compiled IK constraint. Its mix and bend are animatable, see {@link Skeleton.ik}. */
export type IkData = {
  readonly index: number;
  readonly name: string;
  readonly bones: readonly number[];
  readonly target: number;
  readonly mix: number;
  readonly bend: number;
  readonly softness: number;
  readonly stretch: boolean;
  readonly volume: boolean;
};

/** One property mapping of a transform constraint. Properties are `BONE_*` offsets. */
export type TransformMap = {
  readonly from: number;
  readonly to: number;
  readonly scale: number;
  readonly offset: number;
  readonly min: number;
  readonly max: number;
};

/** A compiled transform constraint. */
export type TransformData = {
  readonly index: number;
  readonly name: string;
  readonly source: number;
  readonly bones: readonly number[];
  readonly isWorld: boolean;
  readonly map: readonly TransformMap[];
  readonly additive: boolean;
  readonly mix: number;
};

/** A compiled physics constraint. See {@link RigPhysics} for what each value does. */
export type PhysicsData = {
  readonly index: number;
  readonly name: string;
  readonly bone: number;
  readonly rotate: number;
  readonly translate: number;
  readonly stretch: number;
  readonly inertia: number;
  readonly strength: number;
  readonly damping: number;
  readonly mass: number;
  readonly gravity: number;
  readonly wind: number;
  readonly limit: number;
  readonly mix: number;
};

/** A compiled slider. */
/** A compiled path constraint. See {@link RigPathConstraint}. */
export type PathData = {
  readonly index: number;
  readonly name: string;
  /** The slot whose shown attachment is the path. */
  readonly slot: number;
  readonly bones: readonly number[];
  readonly position: number;
  /** World units between bone origins, used unless `isLengthSpacing`. */
  readonly spacing: number;
  /** If true, each bone's own world length spaces the chain. */
  readonly isLengthSpacing: boolean;
  /** One of the `PATH_ROTATE_*` constants. */
  readonly rotate: number;
  readonly mix: number;
};

/** How a path constraint turns its bones. */
export const PATH_ROTATE_TANGENT = 0;
export const PATH_ROTATE_CHAIN = 1;
export const PATH_ROTATE_NONE = 2;

export type SliderData = {
  readonly index: number;
  readonly name: string;
  readonly animation: number;
  readonly time: number;
  readonly mix: number;
  readonly additive: boolean;
  /** The bone and `BONE_*` property that set the time, with its value range, or null. */
  readonly driver: {readonly bone: number; readonly property: number; readonly from: readonly [number, number]} | null;
};

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

/** One animated value over time. */
export type Timeline = {
  /** One of the `TIMELINE_*` constants. */
  readonly kind: number;
  /**
   * What it writes: for bones the index into the pose array (bone * BONE_STRIDE + property), for
   * slots the slot index, for constraints the constraint index.
   */
  readonly target: number;
  /** The id in {@link AnimationData.keyed} of the property it writes. */
  readonly property: number;
  /** Key times in seconds, ascending. */
  readonly times: Float64Array;
  /** Key values, `stride` per key (4 for color, else 1). Attachment keys hold a name index or -1. */
  readonly values: Float64Array;
  readonly stride: number;
  /** Curve code per key, for the segment that starts at that key. */
  readonly curves: Uint8Array;
  /** Bezier lookup tables, {@link BEZIER_SAMPLES} (x, y) pairs per key, or null if no key uses one. */
  readonly bezier: Float64Array | null;
  /** For a shape key timeline: the slot attachment (index into its `attachmentNames`) it shapes. Each key's values are an x, y offset per mesh corner in setup skeleton space. */
  readonly attachment?: number;
};

/** Points sampled along each bezier curve. More is smoother, fewer is faster. */
export const BEZIER_SAMPLES = 16;

/** An event key inside an animation. */
export type EventKey = {
  readonly time: number;
  readonly name: string;
  readonly int: number;
  readonly float: number;
  readonly string: string;
};

/** A compiled animation. */
export type AnimationData = {
  readonly index: number;
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly timelines: readonly Timeline[];
  /** 1 for each property id a timeline here writes. Crossfades read it to avoid dipping. */
  readonly keyed: Uint8Array;
  /** Sorted by time. */
  readonly events: readonly EventKey[];
  /** Draw order keys: times, and for each the full slot order (or null for setup). */
  readonly drawOrder: {readonly times: Float64Array; readonly orders: readonly (Int16Array | null)[]} | null;
  /** Physics resets: sorted times, and the physics constraint each resets. */
  readonly physicsResets: readonly {readonly time: number; readonly physics: number}[];
};

/** A compiled rig. */
export type RigData = {
  readonly name: string;
  /** Folder the images load from, relative to the site root. */
  readonly images: string;
  readonly bones: readonly BoneData[];
  /** Setup pose, {@link BONE_STRIDE} floats per bone. */
  readonly setup: Float64Array;
  /** Setup-pose world matrices, {@link WORLD_STRIDE} per bone. Mesh skinning measures bone motion from them. */
  readonly setupWorld: Float64Array;
  readonly slots: readonly SlotData[];
  /** The slots' own attachments. */
  readonly defaultSkin: SkinData;
  readonly skins: readonly SkinData[];
  readonly ik: readonly IkData[];
  readonly transforms: readonly TransformData[];
  readonly physics: readonly PhysicsData[];
  readonly sliders: readonly SliderData[];
  readonly paths: readonly PathData[];
  readonly animations: readonly AnimationData[];
  /** Crossfade seconds by `"from>to"`. */
  readonly mixes: ReadonlyMap<string, number>;
  readonly defaultMix: number;
  readonly gravity: number;
  readonly wind: number;
  /**
   * The order bones and constraints update in. Each entry is a bone index, or a constraint as
   * `-1 - (kind * CONSTRAINT_KINDS_STRIDE + index)`: see `UPDATE_*`.
   */
  readonly updateOrder: Int32Array;
  /** Number of property ids, the length of each {@link AnimationData.keyed}. */
  readonly propertyCount: number;
  /** Every image name the rig uses, for preloading. */
  readonly imageNames: readonly string[];
};

/** Constraint kinds in {@link RigData.updateOrder}. */
export const UPDATE_IK = 0;
export const UPDATE_TRANSFORM = 1;
export const UPDATE_PHYSICS = 2;
export const UPDATE_SLIDER = 3;
export const UPDATE_PATH = 4;
/** Constraint index range per kind in {@link RigData.updateOrder}. */
export const CONSTRAINT_KINDS_STRIDE = 1 << 16;
