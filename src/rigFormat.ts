/**
 * The Foony Rig file format (`*.rig.json`): a 2D bone rig and its animations, written and edited
 * by LLMs, not by a visual editor. It covers most of Spine 4.3 (bones, slots, skins,
 * IK, transform constraints with property mapping, physics, sliders, events, clipping, meshes,
 * flipbooks, partial draw order, additive tracks) in a form that is easy to write by hand:
 *
 * - Everything is referenced by name, never by index. `foony-rig check` names any unknown
 *   name and suggests the closest one.
 * - Space is y-up and angles are in degrees, counterclockwise (Spine's convention). Rotation 0
 *   points right (+x) and 90 points up (+y). The ground is usually y = 0.
 * - Images are placed by `pivot`, the pixel in the image that sits on the bone's origin, in the
 *   image's own pixel coordinates (x right, y down, as an image viewer shows them).
 * - Bone keys are offsets from the setup pose, as in Spine: a rotate key of 10 means "setup
 *   rotation + 10". Scale keys multiply the setup scale.
 * - `poses` name a set of bone offsets once. An animation can key whole poses by name.
 *
 * The compiler is {@link compileRig}. Its errors carry a JSON path (e.g.
 * `animations.walk.bones.thighL.rotate[2]`) so a fix can go straight to the line.
 */

/** A whole rig file. */
export type RigFile = {
  /** Always `"foony-rig@1"`. */
  format: 'foony-rig@1';
  /** A short id for logs, e.g. `"hero"`. */
  name: string;
  /**
   * The folder the images load from, relative to the site root (e.g.
   * `"img/characters/hero"`). Each image name is a file in it, without the
   * extension: the browser loads `<name>.webp`, the CLI renderer reads `<name>.png`.
   */
  images: string;
  /**
   * A prebuilt atlas in the images folder (`foony-rig atlas <rig>` makes `<atlas>.atlas.json`
   * and its pages): the browser loads its few pages instead of every image, and regions and mesh
   * grids cover only each image's trimmed art. Make it again after changing an image.
   */
  atlas?: string;
  /** All bones, parents before children. The first bone is the root and has no parent. */
  bones: RigBone[];
  /** Draw slots, back to front: the first slot draws first (behind everything else). */
  slots: RigSlot[];
  /**
   * Named sets of attachments that replace the slots' own (e.g. one skin per cosmetic hat). Maps
   * skin name to slot name to attachment name to attachment. An attachment name a skin defines
   * replaces the slot's attachment of the same name while that skin is on.
   */
  skins?: {[skin: string]: {[slot: string]: {[attachment: string]: RigAttachment}}};
  /**
   * Inverse kinematics: turn 1 or 2 bones so the chain's end reaches a target bone. Each frame
   * the constraints run in this order: sliders, IK, transforms, physics, each in file order.
   */
  ik?: RigIk[];
  /** Copy or map properties from one bone to others (gears, linked parts, follow a bone). */
  transforms?: RigTransform[];
  /** Springy follow-through on a bone (hair, ears, tails, capes). */
  physics?: RigPhysics[];
  /** Apply an animation at a chosen time, set from code or driven by a bone (aim, morphs). */
  sliders?: RigSlider[];
  /** Lay bone chains along path attachments: ropes, whips, tails, a cart on a track. */
  paths?: RigPathConstraint[];
  /** Named events that animations fire at set times (footsteps, the frame a hit lands). */
  events?: {[event: string]: RigEventDefaults};
  /** Named bone offsets, shared by animations through their `pose` keys. */
  poses?: {[pose: string]: RigPose};
  /** Animations by name. */
  animations?: {[animation: string]: RigAnimation};
  /** Crossfade time in seconds between two animations, keyed `"from>to"` (e.g. `"idle>walk": 0.15`). */
  mixes?: {[fromTo: string]: number};
  /**
   * Crossfade time in seconds when no `mixes` entry matches.
   * @defaultValue 0.1
   */
  defaultMix?: number;
  /** Skeleton-wide forces for physics, in units per second squared, y-up. */
  world?: {
    /** @defaultValue 0 */
    gravity?: number;
    /** @defaultValue 0 */
    wind?: number;
  };
};

/**
 * How a bone takes its parent's transform.
 * - `normal`: the parent's translation, rotation, scale, and shear.
 * - `noRotation`: everything but the parent's rotation (a head that stays upright).
 * - `noScale`: everything but the parent's scale (a part that keeps its size while the torso squashes).
 * - `onlyTranslation`: only the parent's position.
 */
export type RigInherit = 'normal' | 'noRotation' | 'noScale' | 'onlyTranslation';

/** One bone. All values are the setup pose, relative to the parent bone. */
export type RigBone = {
  name: string;
  /** Required on every bone but the first. */
  parent?: string;
  /** @defaultValue 0 */
  x?: number;
  /** @defaultValue 0 */
  y?: number;
  /** Degrees, counterclockwise. @defaultValue 0 */
  rotation?: number;
  /** @defaultValue 1 */
  scaleX?: number;
  /** @defaultValue 1 */
  scaleY?: number;
  /** Degrees. @defaultValue 0 */
  shearX?: number;
  /** Degrees. @defaultValue 0 */
  shearY?: number;
  /** The bone's length along its x axis. IK, physics, and `tip` attachments use it. @defaultValue 0 */
  length?: number;
  /** @defaultValue 'normal' */
  inherit?: RigInherit;
  /**
   * The rotation range this bone should stay in, in degrees of local rotation (setup plus
   * animation, before constraints). Only `check` reads it: it warns when an animation leaves it,
   * which catches knees bent backwards.
   */
  limits?: [min: number, max: number];
  /**
   * The skin this bone comes with: it, its children, their slots, and the constraints that use
   * them only update and draw while that skin is on, so a hat's dangling bones and physics cost
   * nothing without the hat. @defaultValue none: always on
   */
  skin?: string;
};

/** How a slot's pixels combine with what is under them. */
export type RigBlend = 'normal' | 'add' | 'multiply' | 'screen';

/** One draw slot: a place on a bone that shows at most one attachment at a time. */
export type RigSlot = {
  name: string;
  bone: string;
  /** The attachment shown in the setup pose, or none if left out. */
  attachment?: string;
  /** Tint as `"#rrggbb"` or `"#rrggbbaa"`. Tinting rgb costs a cached copy per color, alpha is free. @defaultValue '#ffffffff' */
  color?: string;
  /**
   * Tint for the art's dark parts, `"#rrggbb"`: each pixel shades from this color (where the art
   * is black) to the `color` tint (where it is white). `"#ffffff"` turns the art a flat white
   * silhouette, a hit flash. Black changes nothing. @defaultValue '#000000'
   */
  dark?: string;
  /** @defaultValue 'normal' */
  blend?: RigBlend;
  /** The slot's attachments by name (its default skin). */
  attachments?: {[attachment: string]: RigAttachment};
};

/** Something a slot can show or mark. */
export type RigAttachment = RigRegion | RigMesh | RigClip | RigPoint | RigBox | RigPath;

/** Where an image sits on its bone. Shared by regions and meshes. */
type RigImagePlacement = {
  /** The image file name without extension. @defaultValue the attachment's name */
  image?: string;
  /** The image pixel that sits on the bone origin, x right and y down. @defaultValue the image center */
  pivot?: [x: number, y: number];
  /**
   * A second image pixel that must land on the bone's tip (its origin plus `length` along x), or
   * for a mesh with `bones`, on the last of those bones' tip. The image turns and scales to fit,
   * so painted parts line up with their bones without guessing an angle. Use it or
   * `rotation`/`scale`, not both.
   */
  tip?: [x: number, y: number];
  /** Offset of the pivot from the bone origin, in bone space. @defaultValue 0 */
  x?: number;
  /** @defaultValue 0 */
  y?: number;
  /** Extra turn of the image, degrees counterclockwise. @defaultValue 0 */
  rotation?: number;
  /** Uniform image scale. @defaultValue 1 */
  scale?: number;
  /** Mirror the image left to right. @defaultValue false */
  flipX?: boolean;
  /** Tint multiplied with the slot color, `"#rrggbb"` or `"#rrggbbaa"`. @defaultValue '#ffffffff' */
  color?: string;
};

/**
 * How a flipbook plays:
 * - `loop`: start over after the last frame.
 * - `once`: hold the last frame.
 * - `pingpong`: play forward, then back, and repeat.
 * - `hold`: stay on one frame (a `sequence` key's `frame`).
 * - `loopReverse`, `onceReverse`, `pingpongReverse`: the same, from the last frame to the first.
 */
export type RigSequenceMode = 'loop' | 'once' | 'pingpong' | 'hold' | 'loopReverse' | 'onceReverse' | 'pingpongReverse';

/**
 * Flipbook frames, for a region or a mesh. On its own a flipbook plays from the moment the slot
 * switches to it. A slot's `sequence` keys play it by animation time instead, so it freezes in
 * hitstop and scrubs with a seek.
 */
export type RigFlipbook = {
  /** Flipbook image names, played in order. All must be the same size as `image`. */
  frames?: string[];
  /** Flipbook speed in frames per second. @defaultValue 12 */
  fps?: number;
  /** @defaultValue 'loop' */
  mode?: RigSequenceMode;
};

/** An image on a bone. With `frames` it is a flipbook (see {@link RigFlipbook}). */
export type RigRegion = RigImagePlacement & RigFlipbook & {
  type?: 'region';
  /**
   * Draw only this part of the image, `[left, top, right, bottom]` in image pixels. Use it to hide
   * paint another part already shows, like a sleeve cuff painted on both the upper arm and the
   * forearm. `pivot` and `tip` stay in whole-image pixels. @defaultValue the whole image
   */
  crop?: [left: number, top: number, right: number, bottom: number];
};

/**
 * An image that bends with several bones (limbs, tails, capes). Each grid point follows the nearest
 * bones of `bones`, weighted by distance, so no weights are written by hand.
 *
 * When `bones` run down the image (a limb drawn upright, its chain from top to bottom), the grid gets
 * extra rows around each joint so the bend is a smooth curve. Give a limb several columns: on the
 * inside of a sharp bend the cells far from the bones fold over, and with narrow columns those are
 * only the image's empty margin. Prefer a plain region when one bone moves the part.
 */
export type RigMesh = RigImagePlacement & RigFlipbook & {
  type: 'mesh';
  /** Grid cells across and down the image. @defaultValue [4, 4] */
  grid?: [columns: number, rows: number];
  /**
   * Corners placed by hand instead of a grid, in image pixels: the outline in order first, then
   * any points inside. A corner can set its own bone weights, `{"at": [x, y], "bones": {"jaw": 1}}`;
   * the rest are weighted like a grid's. Fit the outline to the art to draw less empty margin.
   * A 2D canvas draws a hand-placed mesh triangle by triangle, much slower than a grid.
   */
  points?: ([x: number, y: number] | {at: [x: number, y: number]; bones: {[bone: string]: number}})[];
  /** How many of the first `points` are the outline. @defaultValue all of them */
  outline?: number;
  /** Triangles as point index triples. @defaultValue the points triangulated inside the outline */
  triangles?: [a: number, b: number, c: number][];
  /**
   * Weight overrides for an area of the image: corners near `at` (image pixels) blend toward
   * `bones`' weights, fully at `at` and fading to none `radius` pixels away, e.g. a shoulder that
   * should follow the torso: `[{"at": [40, 10], "radius": 30, "bones": {"torso": 1}}]`.
   */
  paint?: {at: [x: number, y: number]; radius?: number; bones: {[bone: string]: number}}[];
  /** Bones the grid bends with, usually a chain. @defaultValue the slot's bone only */
  bones?: string[];
  /**
   * How wide the soft bend around each joint is, in world units. A grid point follows every bone
   * whose distance (measured along the bones, so a whole grid row shares its weights) is within
   * `smooth` of the nearest bone's, with more pull from the nearer ones. At each joint it is
   * capped at 0.3 of the shorter bone, so a short foot bends at its ankle, not all along.
   * @defaultValue a quarter of the average length of `bones`
   */
  smooth?: number;
};

/**
 * Hides everything drawn from this slot through slot `end` outside (or with `inverse`, inside)
 * a polygon. The slot itself shows nothing.
 */
export type RigClip = {
  type: 'clip';
  /** Polygon corners in the bone's space. At least 3. */
  points: [x: number, y: number][];
  /** The last slot clipped. @defaultValue the last slot */
  end?: string;
  /** If true, hide what is inside the polygon instead of outside. @defaultValue false */
  inverse?: boolean;
};

/** A named spot on a bone that code can read (a projectile spawn, a weapon tip). Draws nothing. */
export type RigPoint = {
  type: 'point';
  /** @defaultValue 0 */
  x?: number;
  /** @defaultValue 0 */
  y?: number;
  /** Degrees. @defaultValue 0 */
  rotation?: number;
};

/**
 * A smooth curve through `points` (in the slot bone's space): a Catmull-Rom spline, so it passes
 * through every point and needs no handles. A path constraint lays bones along it. Draws nothing.
 */
export type RigPath = {
  type: 'path';
  /** At least 2. The curve runs through them in order. */
  points: [x: number, y: number][];
  /** If true, the curve joins its last point back to its first. @defaultValue false */
  closed?: boolean;
  /** Bones the points follow, each point weighted to the nearest like a mesh's corners, so the path bends. @defaultValue the slot's bone only */
  bones?: string[];
};

/** A polygon on a bone that code can hit test (hurtboxes, click areas). Draws nothing. */
export type RigBox = {
  type: 'box';
  /** Polygon corners in the bone's space. At least 3. */
  points: [x: number, y: number][];
};

/** Payload values an event uses when its key gives none. */
export type RigEventDefaults = {
  int?: number;
  float?: number;
  string?: string;
};

/** Bone offsets from setup, by bone name. Properties left out stay at setup. */
export type RigPose = {
  [bone: string]: {
    rotate?: number;
    x?: number;
    y?: number;
    scaleX?: number;
    scaleY?: number;
    shearX?: number;
    shearY?: number;
  };
};

/**
 * How a value moves from one key to the next. Set on the earlier key.
 * - `linear` (the default), `step` (hold, then jump).
 * - Easing names: `sineIn`, `sineOut`, `sine` (in and out), and the same for `quad`, `cubic`,
 *   `quart`, `expo`, `back` (overshoots), `elastic`, `bounce`.
 * - `[x1, y1, x2, y2]`: a CSS `cubic-bezier()`.
 */
export type RigCurve =
  | 'linear'
  | 'step'
  | `${'sine' | 'quad' | 'cubic' | 'quart' | 'expo' | 'back' | 'elastic' | 'bounce'}${'' | 'In' | 'Out'}`
  | [x1: number, y1: number, x2: number, y2: number];

/** A key with one value: `[time in seconds, value, curve?]`. */
export type RigKey = [time: number, value: number, curve?: RigCurve];
/** A key with two values: `[time in seconds, x, y, curve?]`. */
export type RigKey2 = [time: number, x: number, y: number, curve?: RigCurve];

/** Bone keys. Every value is an offset from setup (scale multiplies it). */
export type RigBoneKeys = {
  /** Degrees added to the setup rotation. Values move in a straight line: 0 to 350 turns the long way. */
  rotate?: RigKey[];
  /** Added to the setup x and y. */
  translate?: RigKey2[];
  x?: RigKey[];
  y?: RigKey[];
  /** Multiplies the setup scale. */
  scale?: RigKey2[];
  scaleX?: RigKey[];
  scaleY?: RigKey[];
  /** Degrees added to the setup shear. */
  shear?: RigKey2[];
  shearX?: RigKey[];
  shearY?: RigKey[];
};

/** Slot keys. */
export type RigSlotKeys = {
  /** `[time, attachment name or null for none]`. Always a step. */
  attachment?: [time: number, attachment: string | null][];
  /** `[time, "#rrggbb" or "#rrggbbaa", curve?]`. */
  color?: [time: number, color: string, curve?: RigCurve][];
  /** Only the alpha, 0 to 1. Cheaper than `color`, which also re-tints. */
  alpha?: RigKey[];
  /** `[time, "#rrggbb", curve?]`: the slot's `dark` tint. Key it to white and back for a hit flash. */
  dark?: [time: number, color: string, curve?: RigCurve][];
  /**
   * `[time, {mode?, fps?, frame?}]`: from the key on, the slot's flipbook plays by animation time
   * from `frame`, at `fps`, in `mode` (each defaulting to the attachment's, and frame 0). Always a step.
   * @example [[0, {fps: 24}], [0.5, {mode: "hold", frame: 3}]]
   */
  sequence?: [time: number, key: {mode?: RigSequenceMode; fps?: number; frame?: number}][];
};

/**
 * One move in a shape key: the mesh around image pixel `at` moves by `move` (image pixels, x
 * right and y down), fading smoothly to nothing `radius` pixels away. The mesh moves its corners,
 * so the shape is only as fine as its grid.
 */
export type RigDeformHandle = {
  at: [x: number, y: number];
  move: [x: number, y: number];
  /** @defaultValue a quarter of the image's longer side */
  radius?: number;
};

/** One animation. */
export type RigAnimation = {
  /** Length in seconds. @defaultValue the time of the last key */
  duration?: number;
  /**
   * If true (the default), `check` expects the last keys to match the first so the loop has no
   * jump, and `render` shows it looping. Code still chooses to loop when it plays it.
   */
  loop?: boolean;
  /**
   * Whole poses by name, `[time, pose name or null for setup, curve?]`. Each bone property any of
   * these poses sets becomes keyed. A property can't be keyed by both `pose` and `bones`.
   */
  pose?: [time: number, pose: string | null, curve?: RigCurve][];
  bones?: {[bone: string]: RigBoneKeys};
  slots?: {[slot: string]: RigSlotKeys};
  ik?: {
    [ik: string]: {
      /** 0 (off) to 1 (fully on). */
      mix?: RigKey[];
      /** `[time, 1 or -1]`, which way the 2-bone chain bends. Always a step. */
      bend?: [time: number, bend: 1 | -1][];
    };
  };
  transforms?: {[transform: string]: {mix?: RigKey[]}};
  physics?: {
    [physics: string]: {
      mix?: RigKey[];
      /** Times at which the spring snaps back to rest (after a teleport). */
      reset?: number[];
    };
  };
  sliders?: {[slider: string]: {time?: RigKey[]; mix?: RigKey[]}};
  /** Path constraint keys: where the chain starts (share of the path), its spacing, and its mix. */
  paths?: {[path: string]: {position?: RigKey[]; spacing?: RigKey[]; mix?: RigKey[]}};
  /**
   * `[time, slot names]`: the listed slots swap among the places they hold in setup, drawn in the
   * listed order (back to front). Other slots don't move. `null` puts every slot back. Always a step.
   * @example [[0, ["armFront", "torso"]], [0.4, null]]
   */
  drawOrder?: [time: number, slots: string[] | null][];
  /**
   * Shape keys for meshes, by slot then attachment name: `[time, handles, curve?]`. A key moves
   * its mesh's corners from the bones' pose by the sum of its handles, and keys blend over time.
   * Move faces and cloth with these, and limbs with bones.
   * @example {"face": {"face": [[0, []], [0.2, [{"at": [120, 80], "move": [6, 0], "radius": 40}]]]}}
   */
  deform?: {[slot: string]: {[attachment: string]: [time: number, handles: RigDeformHandle[], curve?: RigCurve][]}};
  /** `[time, event name, payload?]`. The payload fills in or overrides the event's defaults. */
  events?: [time: number, event: string, payload?: RigEventDefaults][];
};

/** IK: turns `bones` so the chain's end points at (1 bone) or reaches (2 bones) `target`. */
export type RigIk = {
  name: string;
  /**
   * When this runs among all sliders, IK, transform, path, and physics constraints: lowest first.
   * Ties run sliders, then IK, transforms, paths, and physics, each in file order. Give a constraint that
   * moves another's target (or a slider's driver) a lower order, so the other reads where it moved.
   * @defaultValue 0
   */
  order?: number;
  /** `[bone]` or `[parent, child]`, where child is a direct child of parent. */
  bones: [string] | [string, string];
  /** The bone to reach. It must not be one of `bones` or below them. */
  target: string;
  /** 0 (off) to 1 (fully on). @defaultValue 1 */
  mix?: number;
  /**
   * 1: the child turns counterclockwise from the parent, so a leg pointing down has its knee
   * toward -x (left). -1: clockwise, knee toward +x. It is in the chain parent's space, so a
   * mirrored parent mirrors the bend with it. @defaultValue 1
   */
  bend?: 1 | -1;
  /** Distance before full reach where the chain starts to straighten slowly, so it doesn't snap straight. @defaultValue 0 */
  softness?: number;
  /** If true, the bones stretch to reach a target past their length. @defaultValue false */
  stretch?: boolean;
  /** If true, a stretched bone gets thinner (scaleY divides by the stretch) to keep its volume. @defaultValue false */
  volume?: boolean;
};

/** A bone property a transform constraint reads or writes. */
export type RigProperty = 'rotate' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'shearY';

/**
 * Sets properties of `bones` from properties of `source`. In `local` space it reads and writes
 * local values (a gear turning another, a dial driving a lid). In `world` space it reads the
 * source's world values and makes each bone match them (a hand following a weapon).
 */
export type RigTransform = {
  name: string;
  /**
   * When this runs among all sliders, IK, transform, path, and physics constraints: lowest first.
   * Ties run sliders, then IK, transforms, paths, and physics, each in file order. Give a constraint that
   * moves another's target (or a slider's driver) a lower order, so the other reads where it moved.
   * @defaultValue 0
   */
  order?: number;
  source: string;
  bones: string[];
  /** @defaultValue 'local' */
  space?: 'local' | 'world';
  /**
   * Which source property sets which bone property: `to = clamp(from * scale + offset, min, max)`.
   * @defaultValue rotate, x, y, scaleX, scaleY, and shearY, each to itself
   */
  map?: {
    from: RigProperty;
    to: RigProperty;
    /** @defaultValue 1 */
    scale?: number;
    /** @defaultValue 0 */
    offset?: number;
    min?: number;
    max?: number;
  }[];
  /** If true, adds the mapped value to the bone's own instead of replacing it. @defaultValue false */
  additive?: boolean;
  /** 0 (off) to 1 (fully on). @defaultValue 1 */
  mix?: number;
};

/**
 * A spring on a bone. Its tip lags behind when the bone or the whole skeleton moves, then swings
 * back. Steps at a fixed rate, so it plays the same at any frame rate.
 */
export type RigPhysics = {
  name: string;
  /**
   * When this runs among all sliders, IK, transform, path, and physics constraints: lowest first.
   * Ties run sliders, then IK, transforms, paths, and physics, each in file order. Give a constraint that
   * moves another's target (or a slider's driver) a lower order, so the other reads where it moved.
   * @defaultValue 0
   */
  order?: number;
  /** The bone to swing. Rotation needs a `length`. */
  bone: string;
  /** How much the swing turns the bone, 0 to 1. @defaultValue 1 */
  rotate?: number;
  /** How much the swing moves the bone, 0 to 1. @defaultValue 0 */
  translate?: number;
  /** How much the bone stretches along its length when its tip lags, 0 to 1. @defaultValue 0 */
  stretch?: number;
  /** How much the part keeps its place when its parent moves, 0 (stiff) to 1 (loose). @defaultValue 1 */
  inertia?: number;
  /** Spring strength: higher snaps back faster. @defaultValue 100 */
  strength?: number;
  /** How much speed is lost per second, 0 (none, swings forever) to 1 (stops at once). @defaultValue 0.9 */
  damping?: number;
  /** Heavier parts move less from the same force. @defaultValue 1 */
  mass?: number;
  /** Multiplier on the rig's `world.gravity`. @defaultValue 0 */
  gravity?: number;
  /** Multiplier on the rig's `world.wind`. @defaultValue 0 */
  wind?: number;
  /** Most the tip can lag or swing, in world units, so a sudden jump can't fling it. For a warp, `skeleton.teleport()` skips physics altogether. @defaultValue 5000 */
  limit?: number;
  /** 0 (off) to 1 (fully on). @defaultValue 1 */
  mix?: number;
};

/**
 * Applies `animation` at `time`, as a pose dial. Set it from code
 * (`skeleton.getSlider('aim').time = 0.5`), key it, or let `driver` turn a bone's local value
 * into a time. Sliders apply before the other constraints, in file order.
 */
/** Lays `bones` (a chain, parent first) along the path the slot `path` shows (see {@link RigPath}). */
export type RigPathConstraint = {
  name: string;
  /**
   * When this runs among all sliders, IK, transform, path, and physics constraints: lowest first.
   * Ties run sliders, then IK, transforms, paths, and physics, each in file order. Give a constraint that
   * moves another's target (or a slider's driver) a lower order, so the other reads where it moved.
   * @defaultValue 0
   */
  order?: number;
  /** The slot whose shown attachment is the path. */
  path: string;
  /** The bones to lay along it, parent first. */
  bones: string[];
  /** Where the first bone's origin sits, as a share of the path's length, 0 to 1. @defaultValue 0 */
  position?: number;
  /** World units from each bone's origin to the next, or `"length"` for each bone's own length. @defaultValue 'length' */
  spacing?: number | 'length';
  /**
   * - `tangent`: each bone points along the curve.
   * - `chain`: each bone points at the next bone's place, so a stiff chain cuts corners.
   * - `none`: bones keep their own turn and only move.
   * @defaultValue 'tangent'
   */
  rotate?: 'tangent' | 'chain' | 'none';
  /** 0 (off) to 1 (fully on). @defaultValue 1 */
  mix?: number;
};

export type RigSlider = {
  name: string;
  /**
   * When this runs among all sliders, IK, transform, path, and physics constraints: lowest first.
   * Ties run sliders, then IK, transforms, paths, and physics, each in file order. Give a constraint that
   * moves another's target (or a slider's driver) a lower order, so the other reads where it moved.
   * @defaultValue 0
   */
  order?: number;
  animation: string;
  /** @defaultValue 0 */
  time?: number;
  /** 0 (off) to 1 (fully on). @defaultValue 1 */
  mix?: number;
  /** If true, the animation adds to the pose instead of replacing the keyed values. @defaultValue false */
  additive?: boolean;
  /** Maps a bone's local value to the time: `time = (value - from[0]) / (from[1] - from[0]) * duration`. */
  driver?: {
    bone: string;
    property: RigProperty;
    /** The value range that plays the whole animation, start to end. */
    from: [start: number, end: number];
  };
};
