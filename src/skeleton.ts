import {applyAnimation, getPoseValues, PoseValues} from './animation.js';
import {DEG_RAD, EPSILON, getParentAxes, RAD_DEG, updateBoneWorld, wrapDegrees} from './boneMath.js';
import {
  Attachment,
  BONE_ROTATION,
  BONE_SCALE_X,
  BONE_SCALE_Y,
  BONE_SHEAR_X,
  BONE_SHEAR_Y,
  BONE_STRIDE,
  BONE_X,
  BONE_Y,
  CONSTRAINT_KINDS_STRIDE,
  MeshAttachment,
  RegionAttachment,
  RigData,
  SEQUENCE_FLOATS,
  SEQUENCE_HOLD,
  SEQUENCE_ONCE,
  SEQUENCE_PINGPONG,
  SEQUENCE_REVERSE,
  SkinData,
  UPDATE_IK,
  PATH_ROTATE_CHAIN,
  PATH_ROTATE_NONE,
  PathAttachment,
  UPDATE_PATH,
  UPDATE_PHYSICS,
  UPDATE_SLIDER,
  UPDATE_TRANSFORM,
  WORLD_STRIDE,
} from './rigData.js';

/**
 * One posed instance of a {@link RigData}. Many skeletons can share one rig.
 *
 * The pose model follows Spine 4.3. Each frame:
 * 1. `local` starts at the setup pose and animations write into it ({@link AnimationState.apply}).
 * 2. Game code may override `local` values, sliders, or constraint mixes.
 * 3. {@link Skeleton.updateWorld} copies `local` into `applied`, then walks the rig's update
 *    order: bones get world matrices, and sliders and IK, transform, and physics constraints
 *    change `applied` for the bones they move, in their `order`. `local` is never changed by
 *    constraints, so the next frame's animation starts clean.
 *
 * Skeleton space is y-up, in rig units. `x`, `y`, `scaleX`, and `scaleY` place the skeleton on the
 * canvas, which is y-down: the root draws at (x, y) and skeleton +y is canvas up.
 *
 * Nothing here creates objects or arrays per frame, so hundreds of skeletons can update at 60 fps.
 */

/** What {@link Skeleton.updateWorld} does with physics. */
export type PhysicsMode =
  /** Step the springs by the time {@link Skeleton.update} added. */
  | 'update'
  /** Snap every spring back to rest, then apply them. Use after a teleport. */
  | 'reset'
  /** Leave the springs out: bones take their animated pose. */
  | 'none';

/** Seconds per physics step. Fixed so a swing plays the same at any frame rate. */
const PHYSICS_STEP = 1 / 60;
/** Most steps one update runs, so a tab coming back from the background doesn't stall. */
const MAX_PHYSICS_STEPS = 30;

/** Floats of state per physics constraint. */
const PHYSICS_STRIDE = 21;
/** Offsets into a physics constraint's state. 1 once it has a rest pose to lag behind. */
const P_READY = 0;
/** The bone origin and rest tip, last update, in skeleton space. */
const P_LAST_ORIGIN_X = 1;
const P_LAST_ORIGIN_Y = 2;
const P_LAST_TIP_X = 3;
const P_LAST_TIP_Y = 4;
/** How far the swinging tip is from the rest tip after the last step, x then y. */
const P_TIP = 5;
/** The same before the last step, for blending between steps. */
const P_TIP_PREVIOUS = 7;
/** The tip's speed. */
const P_TIP_SPEED = 9;
/** The same three for the bone origin, for translate. */
const P_ORIGIN = 11;
const P_ORIGIN_PREVIOUS = 13;
const P_ORIGIN_SPEED = 15;
/** Rest-pose movement (times inertia) not yet fed into steps, for the tip and the origin. */
const P_TIP_PENDING = 17;
const P_ORIGIN_PENDING = 19;

/** Scratch for {@link Skeleton.computeMeshVertices}. */
const skinScratch = new Float64Array(6);
/**
 * Floats per bone in a mesh's skin cache: its motion matrix (canvas order), then its turn's cosine
 * and sine, their half-angle cosine and sine, its rigid move (the move of its own origin, less the
 * turn), and its origin in the setup pose.
 */
const SKIN_FLOATS = 14;
/** {@link Skeleton.slotSequences} mode for a slot no animation keys: its flipbook plays by the clock. */
const SEQUENCE_NONE = -2;

/** Samples per path segment: enough that a quarter circle's chords miss the curve by under 0.1%. */
const PATH_SAMPLES = 16;
/** Scratch for path sampling: the path's world points, its samples (x, y), and the distance along the curve to each sample. */
let pathPoints = new Float64Array(32);
let pathSamples = new Float64Array(256);
let pathLengths = new Float64Array(128);
/** Scratch from {@link locateOnPath}: x, y, then the curve's direction there (x, y). */
const located = new Float64Array(4);

/**
 * Finds the spot `distance` along the sampled path ({@link pathSamples}, `samples` of them, `total`
 * long) into {@link located}: its x and y and the curve's direction there. A closed path wraps the
 * distance, an open one clamps it to its ends.
 */
function locateOnPath(samples: number, distance: number, total: number, isClosed: boolean) {
  const at = isClosed ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
  let low = 0;
  let high = samples - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (pathLengths[middle] <= at) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const span = pathLengths[high] - pathLengths[low];
  const t = span > 0 ? (at - pathLengths[low]) / span : 0;
  located[0] = pathSamples[low * 2] + (pathSamples[high * 2] - pathSamples[low * 2]) * t;
  located[1] = pathSamples[low * 2 + 1] + (pathSamples[high * 2 + 1] - pathSamples[low * 2 + 1]) * t;
  located[2] = pathSamples[high * 2] - pathSamples[low * 2];
  located[3] = pathSamples[high * 2 + 1] - pathSamples[low * 2 + 1];
}

/** Scratch for {@link Skeleton.getBounds}' mesh corners. */
let boundsScratch = new Float64Array(256);
/** Scratch for a bone's parent axes. */
const axesScratch = new Float64Array(4);
/** IK solves per update when uneven parent scale makes a bone's world length change as it turns. */
const UNEVEN_IK_PASSES = 4;

/** A spot on the skeleton, in skeleton space. */
export type RigSpot = {x: number; y: number; rotation: number};

export class Skeleton {
  readonly data: RigData;
  /** Canvas x of the root, in canvas pixels. */
  x = 0;
  /** Canvas y of the root, in canvas pixels (y down). */
  y = 0;
  /** Canvas pixels per rig unit across. Negative mirrors the skeleton left to right. */
  scaleX = 1;
  /** Canvas pixels per rig unit up. */
  scaleY = 1;
  /** Opacity of the whole skeleton, 0 to 1. */
  alpha = 1;
  /** Seconds this skeleton has run, advanced by {@link Skeleton.update}. Flipbooks play by it. */
  time = 0;
  /** Physics gravity, from the rig's `world.gravity`. Change it for the whole skeleton. */
  gravity: number;
  /** Physics wind, from the rig's `world.wind`. Change it for gusts. */
  wind: number;
  /**
   * Share of the skeleton's own movement across the canvas (its `x`) that physics parts feel,
   * 0 to 1. 0 keeps a cape from trailing while the camera or a platform carries the character.
   * @defaultValue 1
   */
  physicsMoveX = 1;
  /** The same for movement up and down (its `y`). 0 keeps hair from bouncing on a moving lift. @defaultValue 1 */
  physicsMoveY = 1;

  /** Animated pose: {@link BONE_STRIDE} floats per bone, before constraints. Write overrides here. */
  readonly local: Float64Array;
  /** Pose after constraints. Read-only for callers. */
  readonly applied: Float64Array;
  /** World matrices, {@link WORLD_STRIDE} per bone, in skeleton space. */
  readonly world: Float64Array;
  /** Each bone's motion for the mesh being skinned (see SKIN_FLOATS), so a bone shared by many corners is worked out once. */
  private readonly skinCache: Float64Array;
  /** Which {@link Skeleton.computeMeshVertices} call filled each bone's skin cache. */
  private readonly skinStamps: Int32Array;
  private skinStamp = 0;
  /** Slot tints, r, g, b, a per slot, 0 to 1. */
  readonly slotColors: Float32Array;
  /** Slot tints for the art's dark parts, r, g, b per slot, 0 to 1. Black is no tint. */
  readonly slotDarks: Float32Array;
  /**
   * Per slot, a keyed flipbook ({@link SEQUENCE_FLOATS} floats): mode (-2 for none, so the flipbook
   * plays by the clock, or -1 for the attachment's), fps (-1 for the attachment's), first frame,
   * and seconds since the key.
   */
  readonly slotSequences: Float64Array;
  /** Per slot, mesh shape key offsets: x, y per corner in setup skeleton space. Sized for the slot's largest mesh. */
  readonly slotDeforms: Float32Array[];
  /** Per slot, the attachment (index into its `attachmentNames`) the offsets in {@link Skeleton.slotDeforms} are for, or -1 for none. */
  readonly slotDeformAttachments: Int16Array;
  /** Per slot, the shown attachment's index into its `attachmentNames`, or -1 for none. */
  readonly slotAttachments: Int16Array;
  /** Slot indexes back to front. */
  readonly drawOrder: Int16Array;
  /** Per IK constraint: mix, 0 to 1. */
  readonly ikMix: Float64Array;
  /** Per IK constraint: bend, 1 or -1. */
  readonly ikBend: Float64Array;
  /** Per transform constraint: mix. */
  readonly transformMix: Float64Array;
  /** Per physics constraint: mix. */
  readonly physicsMix: Float64Array;
  /** Per slider: its animation time in seconds. A driver overrides it. */
  readonly sliderTime: Float64Array;
  /** Per slider: mix. */
  readonly sliderMix: Float64Array;
  /** Per path constraint: where the chain starts, as a share of the path's length. */
  readonly pathPosition: Float64Array;
  /** Per path constraint: world units between bone origins (unless it spaces by bone length). */
  readonly pathSpacing: Float64Array;
  /** Per path constraint: mix. */
  readonly pathMix: Float64Array;

  /** Per bone, 1 while it updates: always, or while the skin it comes with is on (its parent's too). */
  private readonly boneActive: Uint8Array;
  /** Per update kind (`UPDATE_*`) then constraint, 1 while every bone it uses is active. */
  private readonly constraintActive: Uint8Array[];
  /** Per update kind then constraint, the bones it reads or moves. */
  private readonly constraintBones: number[][][];
  private readonly sequenceStarts: Float64Array;
  private readonly lastAttachments: Int16Array;
  private readonly physicsState: Float64Array;
  private resolved: (Attachment | undefined)[][] = [];
  private physicsPending = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly boneIndex: Map<string, number>;
  private readonly slotIndex: Map<string, number>;
  /** The live values sliders write, with the applied pose as the bones. */
  private readonly sliderValues: PoseValues;

  constructor(data: RigData) {
    this.data = data;
    const boneCount = data.bones.length;
    const slotCount = data.slots.length;
    this.gravity = data.gravity;
    this.wind = data.wind;
    this.local = new Float64Array(boneCount * BONE_STRIDE);
    this.applied = new Float64Array(boneCount * BONE_STRIDE);
    this.world = new Float64Array(boneCount * WORLD_STRIDE);
    this.skinCache = new Float64Array(boneCount * SKIN_FLOATS);
    this.skinStamps = new Int32Array(boneCount);
    this.slotColors = new Float32Array(slotCount * 4);
    this.slotDarks = new Float32Array(slotCount * 3);
    this.slotSequences = new Float64Array(slotCount * SEQUENCE_FLOATS);
    this.slotDeforms = data.slots.map(slot => {
      let size = 0;
      for (const skin of [data.defaultSkin, ...data.skins]) {
        for (const attachment of skin.attachments[slot.index]) {
          if (attachment?.kind === 'mesh') {
            size = Math.max(size, attachment.vertexCount * 2);
          }
        }
      }
      return new Float32Array(size);
    });
    this.slotDeformAttachments = new Int16Array(slotCount);
    this.slotAttachments = new Int16Array(slotCount);
    this.drawOrder = new Int16Array(slotCount);
    this.sequenceStarts = new Float64Array(slotCount);
    this.lastAttachments = new Int16Array(slotCount).fill(-2);
    this.ikMix = new Float64Array(data.ik.length);
    this.ikBend = new Float64Array(data.ik.length);
    this.transformMix = new Float64Array(data.transforms.length);
    this.physicsMix = new Float64Array(data.physics.length);
    this.physicsState = new Float64Array(data.physics.length * PHYSICS_STRIDE);
    this.sliderTime = new Float64Array(data.sliders.length);
    this.sliderMix = new Float64Array(data.sliders.length);
    this.pathPosition = new Float64Array(data.paths.length);
    this.pathSpacing = new Float64Array(data.paths.length);
    this.pathMix = new Float64Array(data.paths.length);
    this.boneIndex = new Map(data.bones.map(bone => [bone.name, bone.index]));
    this.slotIndex = new Map(data.slots.map(slot => [slot.name, slot.index]));
    this.sliderValues = getPoseValues(this, this.applied);
    this.boneActive = new Uint8Array(boneCount);
    this.constraintBones = [];
    this.constraintBones[UPDATE_IK] = data.ik.map(ik => [...ik.bones, ik.target]);
    this.constraintBones[UPDATE_TRANSFORM] = data.transforms.map(transform => [transform.source, ...transform.bones]);
    this.constraintBones[UPDATE_PHYSICS] = data.physics.map(physics => [physics.bone]);
    this.constraintBones[UPDATE_SLIDER] = data.sliders.map(slider => (slider.driver ? [slider.driver.bone] : []));
    this.constraintBones[UPDATE_PATH] = data.paths.map(path => [data.slots[path.slot].bone, ...path.bones]);
    this.constraintActive = this.constraintBones.map(list => new Uint8Array(list.length));
    this.setSkins([]);
    this.setToSetupPose();
  }

  /** Returns the bone's index. Throws if there is no such bone. */
  findBone(name: string): number {
    const index = this.boneIndex.get(name);
    if (index === undefined) {
      throw new Error(`[rig] ${this.data.name}: no bone "${name}"`);
    }
    return index;
  }

  /** Returns the slot's index. Throws if there is no such slot. */
  findSlot(name: string): number {
    const index = this.slotIndex.get(name);
    if (index === undefined) {
      throw new Error(`[rig] ${this.data.name}: no slot "${name}"`);
    }
    return index;
  }

  /**
   * Turns on skins by name, replacing the ones on before. Later skins win where two supply the
   * same attachment, and the slots' own attachments fill in the rest, so cosmetics mix freely:
   * `setSkins(['dinoRed', 'hatCrown', 'feetBoots'])`. Throws on an unknown skin name.
   */
  setSkins(names: readonly string[]) {
    const skins: SkinData[] = names.map(name => {
      const skin = this.data.skins.find(candidate => candidate.name === name);
      if (!skin) {
        throw new Error(`[rig] ${this.data.name}: no skin "${name}". Skins: ${this.data.skins.map(candidate => candidate.name).join(', ')}`);
      }
      return skin;
    });
    // A bone a skin brings (and everything under it) updates only while that skin is on.
    for (const bone of this.data.bones) {
      const isOn = bone.skin < 0 || skins.includes(this.data.skins[bone.skin]);
      this.boneActive[bone.index] = isOn && (bone.parent < 0 || this.boneActive[bone.parent] === 1) ? 1 : 0;
    }
    this.constraintActive.forEach((flags, kind) => {
      this.constraintBones[kind].forEach((bones, index) => {
        const isActive = bones.every(bone => this.boneActive[bone] === 1) ? 1 : 0;
        // A swing turned back on starts from rest, not from where it was left.
        if (kind === UPDATE_PHYSICS && isActive === 1 && flags[index] === 0) {
          this.resetPhysics(index);
        }
        flags[index] = isActive;
      });
    });
    this.resolved = this.data.slots.map((slot, slotIndex) =>
      slot.attachmentNames.map((_, nameIndex) => {
        for (let i = skins.length - 1; i >= 0; i--) {
          const attachment = skins[i].attachments[slotIndex][nameIndex];
          if (attachment) {
            return attachment;
          }
        }
        return this.data.defaultSkin.attachments[slotIndex][nameIndex];
      }),
    );
  }

  /** Returns true if bone `bone` updates: it isn't a bone of a skin that is off (see {@link Skeleton.setSkins}). */
  isBoneActive(bone: number): boolean {
    return this.boneActive[bone] === 1;
  }

  /** Returns the attachment slot `slot` shows, or undefined for none (or when its bone's skin is off). */
  getAttachment(slot: number): Attachment | undefined {
    const name = this.slotAttachments[slot];
    return name < 0 || this.boneActive[this.data.slots[slot].bone] === 0 ? undefined : this.resolved[slot][name];
  }

  /** Returns slot `slot`'s attachment named `name` under the current skins, or undefined. */
  getAttachmentByName(slot: number, name: string): Attachment | undefined {
    const index = this.data.slots[slot].attachmentNames.indexOf(name);
    return index < 0 ? undefined : this.resolved[slot][index];
  }

  /**
   * Shows attachment `name` on slot `slot`, or none for null. Animations reset it each frame, so
   * call this after {@link AnimationState.apply}, or key it. Throws on an unknown name.
   */
  setAttachment(slot: number, name: string | null) {
    const index = name === null ? -1 : this.data.slots[slot].attachmentNames.indexOf(name);
    if (index === -1 && name !== null) {
      throw new Error(`[rig] ${this.data.name}: slot "${this.data.slots[slot].name}" has no attachment "${name}"`);
    }
    this.slotAttachments[slot] = index;
  }

  /** Puts the local pose, slots, draw order, and constraint values back to setup. */
  setToSetupPose() {
    const data = this.data;
    this.local.set(data.setup);
    for (const slot of data.slots) {
      this.slotColors.set(slot.color, slot.index * 4);
      this.slotDarks.set(slot.dark, slot.index * 3);
      this.slotSequences[slot.index * SEQUENCE_FLOATS] = SEQUENCE_NONE;
      this.slotDeformAttachments[slot.index] = -1;
      this.slotAttachments[slot.index] = slot.setupAttachment;
      this.drawOrder[slot.index] = slot.index;
    }
    for (const ik of data.ik) {
      this.ikMix[ik.index] = ik.mix;
      this.ikBend[ik.index] = ik.bend;
    }
    for (const transform of data.transforms) {
      this.transformMix[transform.index] = transform.mix;
    }
    for (const physics of data.physics) {
      this.physicsMix[physics.index] = physics.mix;
    }
    for (const slider of data.sliders) {
      this.sliderTime[slider.index] = slider.time;
      this.sliderMix[slider.index] = slider.mix;
    }
    for (const path of data.paths) {
      this.pathPosition[path.index] = path.position;
      this.pathSpacing[path.index] = path.spacing;
      this.pathMix[path.index] = path.mix;
    }
  }

  /** Advances the skeleton's clock (flipbooks) and queues `seconds` of physics for the next {@link Skeleton.updateWorld}. */
  update(seconds: number) {
    this.time += seconds;
    this.physicsPending += seconds;
  }

  /**
   * Moves the skeleton to canvas point (x, y) without physics noticing, so a respawn or a warp
   * doesn't fling capes and hair. Swings already going keep going.
   */
  teleport(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.lastX = x;
    this.lastY = y;
  }

  /** Snaps physics constraint `physics` back to rest on the next update. */
  resetPhysics(physics: number) {
    this.physicsState[physics * PHYSICS_STRIDE + P_READY] = 0;
  }

  /** Computes the applied pose and world matrices from the local pose. See the class doc. */
  updateWorld(physics: PhysicsMode = 'update') {
    const data = this.data;
    this.applied.set(this.local);
    for (let slot = 0; slot < this.slotAttachments.length; slot++) {
      if (this.slotAttachments[slot] !== this.lastAttachments[slot]) {
        this.lastAttachments[slot] = this.slotAttachments[slot];
        this.sequenceStarts[slot] = this.time;
      }
    }
    let steps = 0;
    // The seconds the movement since the last update spans, which the steps share out.
    let stepTime = 0;
    if (physics === 'update') {
      const pending = this.physicsPending;
      steps = Math.min(MAX_PHYSICS_STEPS, Math.floor(pending / PHYSICS_STEP));
      stepTime = steps === MAX_PHYSICS_STEPS ? steps * PHYSICS_STEP : pending;
      this.physicsPending = steps === MAX_PHYSICS_STEPS ? 0 : pending - steps * PHYSICS_STEP;
    } else if (physics === 'reset') {
      this.physicsState.fill(0);
      this.physicsPending = 0;
    }
    // Skeleton movement on the canvas this update, turned into skeleton space for physics inertia.
    const movedX = this.scaleX === 0 ? 0 : ((this.x - this.lastX) / this.scaleX) * this.physicsMoveX;
    const movedY = this.scaleY === 0 ? 0 : (-(this.y - this.lastY) / this.scaleY) * this.physicsMoveY;
    this.lastX = this.x;
    this.lastY = this.y;
    const order = data.updateOrder;
    for (let i = 0; i < order.length; i++) {
      const entry = order[i];
      if (entry >= 0) {
        if (this.boneActive[entry] === 1) {
          updateBoneWorld(data.bones, this.applied, this.world, entry);
        }
        continue;
      }
      const code = -1 - entry;
      const kind = Math.floor(code / CONSTRAINT_KINDS_STRIDE);
      const index = code % CONSTRAINT_KINDS_STRIDE;
      if (this.constraintActive[kind][index] === 0) {
        continue;
      }
      if (kind === UPDATE_IK) {
        this.applyIk(index);
      } else if (kind === UPDATE_TRANSFORM) {
        this.applyTransform(index);
      } else if (kind === UPDATE_PATH) {
        this.applyPath(index);
      } else if (kind === UPDATE_PHYSICS) {
        if (physics !== 'none') {
          this.applyPhysics(index, steps, stepTime, movedX, movedY);
        }
      } else {
        this.applySlider(index);
      }
    }
  }

  /** Returns bone `bone`'s world x in skeleton space. */
  getWorldX(bone: number): number {
    return this.world[bone * WORLD_STRIDE + 4];
  }

  /** Returns bone `bone`'s world y in skeleton space. */
  getWorldY(bone: number): number {
    return this.world[bone * WORLD_STRIDE + 5];
  }

  /** Returns the world angle of bone `bone`'s x axis, in degrees counterclockwise. */
  getWorldRotation(bone: number): number {
    const w = bone * WORLD_STRIDE;
    return Math.atan2(this.world[w + 1], this.world[w]) * RAD_DEG;
  }

  /** Returns the world length of bone `bone`'s x axis (its world scaleX). */
  getWorldScaleX(bone: number): number {
    const w = bone * WORLD_STRIDE;
    return Math.sqrt(this.world[w] * this.world[w] + this.world[w + 1] * this.world[w + 1]);
  }

  /** Returns the world position of bone `bone`'s tip: its origin plus `length` along x. */
  getBoneTip(bone: number): {x: number; y: number} {
    const w = bone * WORLD_STRIDE;
    const length = this.data.bones[bone].length;
    return {x: this.world[w] * length + this.world[w + 4], y: this.world[w + 1] * length + this.world[w + 5]};
  }

  /** Returns where skeleton-space point (x, y) is on the canvas. */
  toCanvas(x: number, y: number): {x: number; y: number} {
    return {x: this.x + x * this.scaleX, y: this.y - y * this.scaleY};
  }

  /** Returns where canvas point (x, y) is in skeleton space. */
  toSkeleton(x: number, y: number): {x: number; y: number} {
    // A skeleton scaled to 0 on an axis maps the whole canvas to 0 there.
    return {x: this.scaleX === 0 ? 0 : (x - this.x) / this.scaleX, y: this.scaleY === 0 ? 0 : -(y - this.y) / this.scaleY};
  }

  /**
   * Moves bone `bone` so its origin lands on skeleton-space (x, y), by setting its local x and y.
   * For aiming an IK target at the mouse: call after {@link AnimationState.apply} and before
   * {@link Skeleton.updateWorld}, which this needs to have run once for the parent's matrix.
   */
  setBoneWorldPosition(bone: number, x: number, y: number) {
    this.moveToWorld(bone, x, y, this.local);
  }

  /**
   * Returns the skeleton-space position and angle of point attachment `name` on slot `slot`
   * under the current skins, or null if the slot has no such point.
   */
  getPoint(slot: number, name: string): RigSpot | null {
    const attachment = this.getAttachmentByName(slot, name);
    if (attachment?.kind !== 'point') {
      return null;
    }
    const w = this.data.slots[slot].bone * WORLD_STRIDE;
    const world = this.world;
    // The point's direction goes through the bone's matrix, so a mirrored bone turns it the other way.
    const cos = Math.cos(attachment.rotation * DEG_RAD);
    const sin = Math.sin(attachment.rotation * DEG_RAD);
    return {
      x: world[w] * attachment.x + world[w + 2] * attachment.y + world[w + 4],
      y: world[w + 1] * attachment.x + world[w + 3] * attachment.y + world[w + 5],
      rotation: Math.atan2(world[w + 1] * cos + world[w + 3] * sin, world[w] * cos + world[w + 2] * sin) * RAD_DEG,
    };
  }

  /**
   * Returns the name of the front-most slot whose shown box attachment contains canvas point
   * (x, y), or null if none does.
   */
  hitTest(x: number, y: number): string | null {
    const point = this.toSkeleton(x, y);
    for (let i = this.drawOrder.length - 1; i >= 0; i--) {
      const slot = this.drawOrder[i];
      const attachment = this.getAttachment(slot);
      if (attachment?.kind === 'box' && this.boxContains(slot, attachment.points, point.x, point.y)) {
        return this.data.slots[slot].name;
      }
    }
    return null;
  }

  /**
   * Returns the canvas-pixel bounding box of every region and mesh the skeleton shows, for culling
   * and camera framing. Call after {@link Skeleton.updateWorld}. All 0 when it shows none.
   */
  getBounds(): {minX: number; minY: number; maxX: number; maxY: number} {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number) => {
      const canvasX = this.x + x * this.scaleX;
      const canvasY = this.y - y * this.scaleY;
      minX = Math.min(minX, canvasX);
      minY = Math.min(minY, canvasY);
      maxX = Math.max(maxX, canvasX);
      maxY = Math.max(maxY, canvasY);
    };
    const matrix = skinScratch;
    for (let i = 0; i < this.drawOrder.length; i++) {
      const slot = this.drawOrder[i];
      const attachment = this.getAttachment(slot);
      if (attachment?.kind === 'region') {
        this.getRegionMatrix(slot, attachment, matrix);
        const [left, top, right, bottom] = attachment.crop;
        for (const [u, v] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
          add(matrix[0] * u + matrix[2] * v + matrix[4], matrix[1] * u + matrix[3] * v + matrix[5]);
        }
      } else if (attachment?.kind === 'mesh') {
        if (boundsScratch.length < attachment.vertexCount * 2) {
          boundsScratch = new Float64Array(attachment.vertexCount * 4);
        }
        const vertices = boundsScratch;
        this.computeMeshVertices(attachment, vertices, slot);
        for (let v = 0; v < attachment.vertexCount * 2; v += 2) {
          add(vertices[v], vertices[v + 1]);
        }
      }
    }
    return minX === Infinity ? {minX: 0, minY: 0, maxX: 0, maxY: 0} : {minX, minY, maxX, maxY};
  }

  /** Writes region `region`'s image-to-skeleton matrix for slot `slot` into `out`. */
  getRegionMatrix(slot: number, region: RegionAttachment, out: Float64Array | number[]) {
    const w = this.data.slots[slot].bone * WORLD_STRIDE;
    const world = this.world;
    const [a, b, c, d, e, f] = region.matrix;
    out[0] = world[w] * a + world[w + 2] * b;
    out[1] = world[w + 1] * a + world[w + 3] * b;
    out[2] = world[w] * c + world[w + 2] * d;
    out[3] = world[w + 1] * c + world[w + 3] * d;
    out[4] = world[w] * e + world[w + 2] * f + world[w + 4];
    out[5] = world[w + 1] * e + world[w + 3] * f + world[w + 5];
  }

  /**
   * Returns which image of `attachment` slot `slot` shows now: 0 unless it is a flipbook. A
   * flipbook plays by the skeleton's clock from when the slot switched to it, or by animation time
   * where an animation keys the slot's `sequence`.
   */
  getFrame(slot: number, attachment: RegionAttachment | MeshAttachment): number {
    const count = attachment.images.length;
    if (count === 1) {
      return 0;
    }
    const q = slot * SEQUENCE_FLOATS;
    const sequences = this.slotSequences;
    if (sequences[q] === SEQUENCE_NONE) {
      return getSequenceFrame(attachment.mode, count, 0, Math.floor((this.time - this.sequenceStarts[slot]) * attachment.fps));
    }
    const mode = sequences[q] < 0 ? attachment.mode : sequences[q];
    const fps = sequences[q + 1] < 0 ? attachment.fps : sequences[q + 1];
    return getSequenceFrame(mode, count, sequences[q + 2], Math.floor(sequences[q + 3] * fps));
  }

  /**
   * Writes mesh `mesh`'s corner positions in skeleton space, x then y, into `out`.
   *
   * A corner on one bone follows it exactly. A corner shared by several bones (around a joint)
   * blends their motions as dual complex numbers: the 2D form of dual quaternion skinning. Averaging
   * the bones' positions instead (linear blend skinning) pulls a bent joint's corners toward the
   * joint, so a 120 degree elbow would pinch to half its width. Blended this way, the corners turn
   * about the joint and keep their distance. Bone scale, which a rigid blend can't carry, is added
   * back as a plain weighted average, measured from each bone's own origin: measured from the
   * skeleton's origin, a stretched bone's rigid part carries a move as big as the stretch times its
   * distance from there, and blending that with a turned neighbor flings the joint's corners away.
   */
  computeMeshVertices(mesh: MeshAttachment, out: Float32Array | Float64Array, slot = -1) {
    const weights = mesh.weights;
    const bind = mesh.bindPositions;
    const world = this.world;
    const skin = skinScratch;
    const cache = this.skinCache;
    const stamps = this.skinStamps;
    const stamp = ++this.skinStamp;
    // Shape key offsets, when slot `slot` shows this mesh and an animation shaped it.
    const deform = slot >= 0 && this.slotDeformAttachments[slot] >= 0 && this.slotDeformAttachments[slot] === this.slotAttachments[slot] && this.slotDeforms[slot].length >= mesh.vertexCount * 2 ? this.slotDeforms[slot] : null;
    let read = 0;
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
      const count = weights[read++];
      if (count === 1 && deform !== null) {
        // One bone carries the shaped corner: its motion since setup, applied to the shaped setup position.
        this.getSkinMatrix(weights[read], skin);
        const x = bind[vertex * 2] + deform[vertex * 2];
        const y = bind[vertex * 2 + 1] + deform[vertex * 2 + 1];
        out[vertex * 2] = skin[0] * x + skin[2] * y + skin[4];
        out[vertex * 2 + 1] = skin[1] * x + skin[3] * y + skin[5];
        read += 4;
        continue;
      }
      if (count === 1) {
        const w = weights[read] * WORLD_STRIDE;
        const localX = weights[read + 1];
        const localY = weights[read + 2];
        out[vertex * 2] = world[w] * localX + world[w + 2] * localY + world[w + 4];
        out[vertex * 2 + 1] = world[w + 1] * localX + world[w + 3] * localY + world[w + 5];
        read += 4;
        continue;
      }
      const bindX = deform === null ? bind[vertex * 2] : bind[vertex * 2] + deform[vertex * 2];
      const bindY = deform === null ? bind[vertex * 2 + 1] : bind[vertex * 2 + 1] + deform[vertex * 2 + 1];
      // The blended dual complex number: real part (realW, realZ) is the half-angle turn, dual part (dualX, dualY) the move.
      let realW = 0;
      let realZ = 0;
      let dualX = 0;
      let dualY = 0;
      let scaleX = 0;
      let scaleY = 0;
      let firstW = 0;
      let firstZ = 0;
      for (let i = 0; i < count; i++) {
        const weight = weights[read + 3];
        const bone = weights[read];
        read += 4;
        const at = bone * SKIN_FLOATS;
        if (stamps[bone] !== stamp) {
          stamps[bone] = stamp;
          this.getSkinMatrix(bone, skin);
          cache.set(skin, at);
          // Its turn, from the motion's x axis, and as half-angle cosine and sine.
          const length = Math.sqrt(skin[0] * skin[0] + skin[1] * skin[1]) || 1;
          const cos = skin[0] / length;
          const sin = skin[1] / length;
          cache[at + 6] = cos;
          cache[at + 7] = sin;
          cache[at + 8] = Math.sqrt(Math.max(0, (1 + cos) / 2));
          cache[at + 9] = Math.sqrt(Math.max(0, (1 - cos) / 2)) * (sin < 0 ? -1 : 1);
          // The rigid move: where the turn alone, about the skeleton's origin, must be moved to put the
          // bone's setup origin where its origin is now.
          const originX = this.data.setupWorld[bone * WORLD_STRIDE + 4];
          const originY = this.data.setupWorld[bone * WORLD_STRIDE + 5];
          cache[at + 10] = world[bone * WORLD_STRIDE + 4] - (cos * originX - sin * originY);
          cache[at + 11] = world[bone * WORLD_STRIDE + 5] - (sin * originX + cos * originY);
          cache[at + 12] = originX;
          cache[at + 13] = originY;
        }
        const sa = cache[at];
        const sb = cache[at + 1];
        const sc = cache[at + 2];
        const sd = cache[at + 3];
        const se = cache[at + 10];
        const sf = cache[at + 11];
        const fromX = bindX - cache[at + 12];
        const fromY = bindY - cache[at + 13];
        const cos = cache[at + 6];
        const sin = cache[at + 7];
        let halfW = cache[at + 8];
        let halfZ = cache[at + 9];
        if (i === 0) {
          firstW = halfW;
          firstZ = halfZ;
        } else if (halfW * firstW + halfZ * firstZ < 0) {
          // q and -q are the same turn: take the one nearest the first bone's, or the blend goes the long way.
          halfW = -halfW;
          halfZ = -halfZ;
        }
        realW += halfW * weight;
        realZ += halfZ * weight;
        dualX += 0.5 * (se * halfW + sf * halfZ) * weight;
        dualY += 0.5 * (sf * halfW - se * halfZ) * weight;
        // What the bone's scale and shear add beyond its turn and move, from its own origin.
        scaleX += (sa * fromX + sc * fromY - (cos * fromX - sin * fromY)) * weight;
        scaleY += (sb * fromX + sd * fromY - (sin * fromX + cos * fromY)) * weight;
      }
      const norm = Math.sqrt(realW * realW + realZ * realZ) || 1;
      realW /= norm;
      realZ /= norm;
      dualX /= norm;
      dualY /= norm;
      const turnCos = realW * realW - realZ * realZ;
      const turnSin = 2 * realW * realZ;
      const moveX = 2 * (dualX * realW - dualY * realZ);
      const moveY = 2 * (dualX * realZ + dualY * realW);
      out[vertex * 2] = turnCos * bindX - turnSin * bindY + moveX + scaleX;
      out[vertex * 2 + 1] = turnSin * bindX + turnCos * bindY + moveY + scaleY;
    }
  }

  /**
   * Writes bone `bone`'s motion since the setup pose into `out`, canvas order: its world matrix times
   * the inverse of its setup world matrix. It takes a point in setup-pose skeleton space to where
   * the bone has carried it now.
   */
  getSkinMatrix(bone: number, out: Float64Array | number[]) {
    const setupWorld = this.data.setupWorld;
    const world = this.world;
    const w = bone * WORLD_STRIDE;
    let determinant = setupWorld[w] * setupWorld[w + 3] - setupWorld[w + 2] * setupWorld[w + 1];
    if (Math.abs(determinant) < EPSILON) {
      // A bone scaled to 0 in setup carries nothing: its inverse is taken as 0.
      determinant = Infinity;
    }
    const ia = setupWorld[w + 3] / determinant;
    const ib = -setupWorld[w + 1] / determinant;
    const ic = -setupWorld[w + 2] / determinant;
    const id = setupWorld[w] / determinant;
    const ie = -(ia * setupWorld[w + 4] + ic * setupWorld[w + 5]);
    const iff = -(ib * setupWorld[w + 4] + id * setupWorld[w + 5]);
    out[0] = world[w] * ia + world[w + 2] * ib;
    out[1] = world[w + 1] * ia + world[w + 3] * ib;
    out[2] = world[w] * ic + world[w + 2] * id;
    out[3] = world[w + 1] * ic + world[w + 3] * id;
    out[4] = world[w] * ie + world[w + 2] * iff + world[w + 4];
    out[5] = world[w + 1] * ie + world[w + 3] * iff + world[w + 5];
  }

  private boxContains(slot: number, points: Float64Array, x: number, y: number): boolean {
    const w = this.data.slots[slot].bone * WORLD_STRIDE;
    const world = this.world;
    let inside = false;
    const count = points.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
      const xi = world[w] * points[i * 2] + world[w + 2] * points[i * 2 + 1] + world[w + 4];
      const yi = world[w + 1] * points[i * 2] + world[w + 3] * points[i * 2 + 1] + world[w + 5];
      const xj = world[w] * points[j * 2] + world[w + 2] * points[j * 2 + 1] + world[w + 4];
      const yj = world[w + 1] * points[j * 2] + world[w + 3] * points[j * 2 + 1] + world[w + 5];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Turns bone `bone`'s applied rotation `mix` of the way toward pointing its x axis at world
   * angle `degrees`. The direction goes back through the parent's axes, so a mirrored, squashed,
   * or sheared parent still ends with the bone pointing exactly there. Does nothing when the parent
   * space is scaled to 0.
   */
  private turnTowardWorldAngle(bone: number, degrees: number, mix: number) {
    const p = bone * BONE_STRIDE;
    const applied = this.applied;
    let dx = Math.cos(degrees * DEG_RAD);
    let dy = Math.sin(degrees * DEG_RAD);
    if (this.data.bones[bone].parent >= 0) {
      const axes = axesScratch;
      getParentAxes(this.data.bones, this.world, bone, axes);
      const determinant = axes[0] * axes[3] - axes[2] * axes[1];
      if (Math.abs(determinant) < EPSILON) {
        return;
      }
      const localX = (axes[3] * dx - axes[2] * dy) / determinant;
      dy = (axes[0] * dy - axes[1] * dx) / determinant;
      dx = localX;
    }
    // The x axis is the rotation plus shearX, flipped by a negative scaleX.
    let local = Math.atan2(dy, dx) * RAD_DEG - applied[p + BONE_SHEAR_X];
    if (applied[p + BONE_SCALE_X] < 0) {
      local += 180;
    }
    applied[p + BONE_ROTATION] += wrapDegrees(local - applied[p + BONE_ROTATION]) * mix;
  }

  /**
   * Returns the curve slot `slot`'s path attachment shows now, sampled finely, in skeleton space:
   * x then y per sample. Null if the slot shows no path. For tools that draw paths.
   */
  getPathSamples(slot: number): Float64Array | null {
    const attachment = this.getAttachment(slot);
    if (attachment?.kind !== 'path') {
      return null;
    }
    const count = this.samplePath(slot, attachment);
    return pathSamples.slice(0, count * 2);
  }

  /**
   * Samples `path` on slot `slot` into {@link pathSamples} and {@link pathLengths} (distance along
   * the curve to each sample) and returns the sample count. The curve is a Catmull-Rom spline
   * through the path's points in world space, so it passes through every point.
   */
  private samplePath(slot: number, path: PathAttachment): number {
    const count = path.points.length / 2;
    const world = this.world;
    if (pathPoints.length < count * 2) {
      pathPoints = new Float64Array(count * 4);
    }
    if (path.weights === null) {
      const w = this.data.slots[slot].bone * WORLD_STRIDE;
      for (let p = 0; p < count * 2; p += 2) {
        pathPoints[p] = world[w] * path.points[p] + world[w + 2] * path.points[p + 1] + world[w + 4];
        pathPoints[p + 1] = world[w + 1] * path.points[p] + world[w + 3] * path.points[p + 1] + world[w + 5];
      }
    } else {
      // Each point is its bones' world matrices times its local spot, weighted.
      let read = 0;
      for (let p = 0; p < count * 2; p += 2) {
        let x = 0;
        let y = 0;
        const influences = path.weights[read++];
        for (let i = 0; i < influences; i++) {
          const w = path.weights[read] * WORLD_STRIDE;
          const weight = path.weights[read + 3];
          x += (world[w] * path.weights[read + 1] + world[w + 2] * path.weights[read + 2] + world[w + 4]) * weight;
          y += (world[w + 1] * path.weights[read + 1] + world[w + 3] * path.weights[read + 2] + world[w + 5]) * weight;
          read += 4;
        }
        pathPoints[p] = x;
        pathPoints[p + 1] = y;
      }
    }
    const segments = path.closed ? count : count - 1;
    const samples = segments * PATH_SAMPLES + 1;
    if (pathSamples.length < samples * 2) {
      pathSamples = new Float64Array(samples * 4);
      pathLengths = new Float64Array(samples * 2);
    }
    const point = (index: number, axis: number) => {
      if (path.closed) {
        return pathPoints[(((index % count) + count) % count) * 2 + axis];
      }
      // Past an open end: the point that makes the curve leave the end as a parabola through the
      // end's three points would (a mirror of its neighbor with only two), so it starts on the curve's own heading.
      if (index < 0) {
        return count < 3 ? 2 * pathPoints[axis] - pathPoints[2 + axis] : 3 * pathPoints[axis] - 3 * pathPoints[2 + axis] + pathPoints[4 + axis];
      }
      if (index >= count) {
        const last = (count - 1) * 2 + axis;
        return count < 3 ? 2 * pathPoints[last] - pathPoints[last - 2] : 3 * pathPoints[last] - 3 * pathPoints[last - 2] + pathPoints[last - 4];
      }
      return pathPoints[index * 2 + axis];
    };
    let sample = 0;
    for (let segment = 0; segment < segments; segment++) {
      for (let step = segment === 0 ? 0 : 1; step <= PATH_SAMPLES; step++) {
        const t = step / PATH_SAMPLES;
        for (let axis = 0; axis < 2; axis++) {
          const p0 = point(segment - 1, axis);
          const p1 = point(segment, axis);
          const p2 = point(segment + 1, axis);
          const p3 = point(segment + 2, axis);
          pathSamples[sample * 2 + axis] = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
        }
        pathLengths[sample] = sample === 0 ? 0 : pathLengths[sample - 1] + Math.sqrt((pathSamples[sample * 2] - pathSamples[sample * 2 - 2]) ** 2 + (pathSamples[sample * 2 + 1] - pathSamples[sample * 2 - 1]) ** 2);
        sample++;
      }
    }
    return sample;
  }

  /**
   * Lays the constraint's bones along its path: each bone's origin moves to its distance along the
   * curve (its position, plus the spacing of the bones before it), then turns along the curve or
   * at the next bone's place. A closed path wraps, an open one stops at its ends.
   */
  private applyPath(index: number) {
    const constraint = this.data.paths[index];
    const mix = this.pathMix[index];
    const attachment = this.getAttachment(constraint.slot);
    if (mix === 0 || attachment?.kind !== 'path' || attachment.points.length < 4) {
      return;
    }
    const samples = this.samplePath(constraint.slot, attachment);
    const total = pathLengths[samples - 1];
    if (total < EPSILON) {
      return;
    }
    const world = this.world;
    const bones = this.data.bones;
    let distance = this.pathPosition[index] * total;
    for (let i = 0; i < constraint.bones.length; i++) {
      const bone = constraint.bones[i];
      const w = bone * WORLD_STRIDE;
      locateOnPath(samples, distance, total, attachment.closed);
      const x = located[0];
      const y = located[1];
      const tangent = Math.atan2(located[3], located[2]) * RAD_DEG;
      const spacing = constraint.isLengthSpacing ? bones[bone].length * Math.sqrt(world[w] * world[w] + world[w + 1] * world[w + 1]) : this.pathSpacing[index];
      this.moveToWorld(bone, world[w + 4] + (x - world[w + 4]) * mix, world[w + 5] + (y - world[w + 5]) * mix, this.applied);
      updateBoneWorld(bones, this.applied, world, bone);
      if (constraint.rotate !== PATH_ROTATE_NONE) {
        let angle = tangent;
        if (constraint.rotate === PATH_ROTATE_CHAIN && spacing > EPSILON) {
          locateOnPath(samples, distance + spacing, total, attachment.closed);
          angle = Math.atan2(located[1] - y, located[0] - x) * RAD_DEG;
        }
        this.turnTowardWorldAngle(bone, angle, mix);
        updateBoneWorld(bones, this.applied, world, bone);
      }
      distance += spacing;
    }
  }

  private applySlider(index: number) {
    const slider = this.data.sliders[index];
    const mix = this.sliderMix[index];
    if (mix === 0) {
      return;
    }
    const animation = this.data.animations[slider.animation];
    let time = this.sliderTime[index];
    if (slider.driver) {
      const {bone, property, from} = slider.driver;
      const progress = (this.applied[bone * BONE_STRIDE + property] - from[0]) / (from[1] - from[0]);
      time = Math.max(0, Math.min(1, progress)) * animation.duration;
    }
    applyAnimation(animation, time, mix, 1, slider.additive, 0.5, this.sliderValues, this.sliderValues, this.data.setup, null);
  }

  /**
   * Turns the chain so its end reaches the target. Works in world space: it finds the world angles
   * the bones should have, then turns each through its parent's axes ({@link Skeleton.turnTowardWorldAngle}),
   * so child offsets, mirrors, and squashed parents need no special cases. Under uneven parent scale
   * a bone's world length changes as it turns, so the 2-bone solve runs again until it lands.
   */
  private applyIk(index: number) {
    const ik = this.data.ik[index];
    const mix = this.ikMix[index];
    if (mix === 0) {
      return;
    }
    const world = this.world;
    const applied = this.applied;
    const bones = this.data.bones;
    const t = ik.target * WORLD_STRIDE;
    const targetX = world[t + 4];
    const targetY = world[t + 5];
    const parent = ik.bones[0];
    const w = parent * WORLD_STRIDE;
    const p = parent * BONE_STRIDE;
    const originX = world[w + 4];
    const originY = world[w + 5];

    if (ik.bones.length === 1) {
      this.turnTowardWorldAngle(parent, Math.atan2(targetY - originY, targetX - originX) * RAD_DEG, mix);
      updateBoneWorld(bones, applied, world, parent);
      if (ik.stretch) {
        const length = bones[parent].length * Math.sqrt(world[w] * world[w] + world[w + 1] * world[w + 1]);
        const distance = Math.sqrt((targetX - originX) ** 2 + (targetY - originY) ** 2);
        if (length > EPSILON && distance > length) {
          const stretch = (distance / length - 1) * mix + 1;
          applied[p + BONE_SCALE_X] *= stretch;
          if (ik.volume) {
            applied[p + BONE_SCALE_Y] /= stretch;
          }
          updateBoneWorld(bones, applied, world, parent);
        }
      }
      return;
    }

    // Uneven scale or shear on the upper bone makes the lower bone's length change as it turns: solve again until it lands.
    const isUneven = Math.abs(applied[p + BONE_SCALE_X]) !== Math.abs(applied[p + BONE_SCALE_Y]) || applied[p + BONE_SHEAR_X] !== 0 || applied[p + BONE_SHEAR_Y] !== 0;
    const passes = mix === 1 && isUneven ? UNEVEN_IK_PASSES : 1;
    for (let pass = 0; pass < passes; pass++) {
      if (!this.solveTwoBoneIk(index, targetX, targetY, mix, pass === 0)) {
        return;
      }
    }
  }

  /**
   * One 2-bone IK solve. It works in the space of the chain's parent (its axes, at the upper bone's
   * origin), where a squashed or mirrored parent is undone, so the law of cosines there is exact
   * and the upper bone's rotation is a plain turn. The lower bone then turns to its world angle.
   * Stretches first if `canStretch`. Returns false if there is nothing to solve: no upper length or
   * a parent scaled to 0.
   */
  private solveTwoBoneIk(index: number, targetX: number, targetY: number, mix: number, canStretch: boolean): boolean {
    const ik = this.data.ik[index];
    const world = this.world;
    const applied = this.applied;
    const bones = this.data.bones;
    const parent = ik.bones[0];
    const child = ik.bones[1];
    const w = parent * WORLD_STRIDE;
    const v = child * WORLD_STRIDE;
    const p = parent * BONE_STRIDE;
    const c = child * BONE_STRIDE;
    const originX = world[w + 4];
    const originY = world[w + 5];
    // World offsets from the upper bone's origin into parent space, through the inverse parent axes.
    const axes = axesScratch;
    if (bones[parent].parent >= 0) {
      getParentAxes(bones, world, parent, axes);
    } else {
      axes[0] = 1;
      axes[1] = 0;
      axes[2] = 0;
      axes[3] = 1;
    }
    const pa = axes[0];
    const pb = axes[1];
    const pc = axes[2];
    const pd = axes[3];
    const determinant = pa * pd - pc * pb;
    if (Math.abs(determinant) < EPSILON) {
      return false;
    }
    // Offsets from the upper bone's origin, in parent space: joint, lower bone tip, and target.
    const length = bones[child].length;
    const jointWorldX = world[v + 4] - originX;
    const jointWorldY = world[v + 5] - originY;
    const tipWorldX = world[v] * length + jointWorldX;
    const tipWorldY = world[v + 1] * length + jointWorldY;
    const jointX = (pd * jointWorldX - pc * jointWorldY) / determinant;
    const jointY = (pa * jointWorldY - pb * jointWorldX) / determinant;
    const lowerX = (pd * tipWorldX - pc * tipWorldY) / determinant - jointX;
    const lowerY = (pa * tipWorldY - pb * tipWorldX) / determinant - jointY;
    let upper = Math.sqrt(jointX * jointX + jointY * jointY);
    let lower = Math.sqrt(lowerX * lowerX + lowerY * lowerY);
    if (upper < EPSILON) {
      return false;
    }
    let dx = (pd * (targetX - originX) - pc * (targetY - originY)) / determinant;
    let dy = (pa * (targetY - originY) - pb * (targetX - originX)) / determinant;
    let distance = Math.sqrt(dx * dx + dy * dy);
    if (ik.softness > 0 && distance > EPSILON) {
      // Near full reach, pull the target in on a curve so the chain eases straight instead of snapping.
      const over = distance - upper - lower + ik.softness;
      if (over > 0) {
        const eased = Math.min(1, over / (ik.softness * 2)) - 1;
        const shrink = (over - ik.softness * (1 - eased * eased)) / distance;
        dx -= dx * shrink;
        dy -= dy * shrink;
        distance = Math.sqrt(dx * dx + dy * dy);
      }
    }
    if (canStretch && ik.stretch && distance > upper + lower) {
      const stretch = (distance / (upper + lower) - 1) * mix + 1;
      applied[p + BONE_SCALE_X] *= stretch;
      applied[c + BONE_SCALE_X] *= stretch;
      if (ik.volume) {
        applied[p + BONE_SCALE_Y] /= stretch;
        applied[c + BONE_SCALE_Y] /= stretch;
      }
      upper *= stretch;
      lower *= stretch;
    }
    // Law of cosines: the bend at the joint, then the angle that puts the chain end on the target.
    const cosBend = lower < EPSILON ? 1 : Math.max(-1, Math.min(1, (distance * distance - upper * upper - lower * lower) / (2 * upper * lower)));
    // The bend is in the parent's space, so a mirrored limb bends its joint the mirrored way too.
    const bend = Math.acos(cosBend) * this.ikBend[index];
    const parentAngle = Math.atan2(dy, dx) - Math.atan2(lower * Math.sin(bend), upper + lower * Math.cos(bend));
    applied[p + BONE_ROTATION] += wrapDegrees((parentAngle - Math.atan2(jointY, jointX)) * RAD_DEG) * mix;
    updateBoneWorld(bones, applied, world, parent);
    updateBoneWorld(bones, applied, world, child);
    // The lower bone's direction, back in world space.
    const lowerAngle = parentAngle + bend;
    const lowerWorldX = pa * Math.cos(lowerAngle) + pc * Math.sin(lowerAngle);
    const lowerWorldY = pb * Math.cos(lowerAngle) + pd * Math.sin(lowerAngle);
    this.turnTowardWorldAngle(child, Math.atan2(lowerWorldY, lowerWorldX) * RAD_DEG, mix);
    updateBoneWorld(bones, applied, world, child);
    return true;
  }

  private applyTransform(index: number) {
    const transform = this.data.transforms[index];
    const mix = this.transformMix[index];
    if (mix === 0) {
      return;
    }
    const applied = this.applied;
    const bones = this.data.bones;
    const s = transform.source * BONE_STRIDE;
    for (const bone of transform.bones) {
      const p = bone * BONE_STRIDE;
      if (transform.isWorld) {
        this.applyWorldTransform(transform.index, bone, mix);
        continue;
      }
      for (const map of transform.map) {
        const value = Math.max(map.min, Math.min(map.max, applied[s + map.from] * map.scale + map.offset));
        const isScale = map.to === BONE_SCALE_X || map.to === BONE_SCALE_Y;
        if (transform.additive) {
          applied[p + map.to] = isScale ? applied[p + map.to] * (1 + (value - 1) * mix) : applied[p + map.to] + value * mix;
        } else {
          applied[p + map.to] += (value - applied[p + map.to]) * mix;
        }
      }
      updateBoneWorld(bones, applied, this.world, bone);
    }
  }

  /** Makes `bone`'s world values match the source's, through the mapping, by adjusting its local pose. */
  private applyWorldTransform(index: number, bone: number, mix: number) {
    const transform = this.data.transforms[index];
    const world = this.world;
    const applied = this.applied;
    const p = bone * BONE_STRIDE;
    const w = bone * WORLD_STRIDE;
    let worldX = world[w + 4];
    let worldY = world[w + 5];
    let moved = false;
    for (const map of transform.map) {
      const source = this.readWorldProperty(transform.source, map.from);
      const current = this.readWorldProperty(bone, map.to);
      let value = Math.max(map.min, Math.min(map.max, source * map.scale + map.offset));
      if (transform.additive) {
        value = map.to === BONE_SCALE_X || map.to === BONE_SCALE_Y ? current * value : current + value;
      }
      if (map.to === BONE_ROTATION) {
        this.turnTowardWorldAngle(bone, current + wrapDegrees(value - current), mix);
      } else if (map.to === BONE_SHEAR_Y) {
        applied[p + BONE_SHEAR_Y] += wrapDegrees(value - current) * mix;
      } else if (map.to === BONE_X) {
        worldX += (value - current) * mix;
        moved = true;
      } else if (map.to === BONE_Y) {
        worldY += (value - current) * mix;
        moved = true;
      } else if (current > 1e-9) {
        applied[p + map.to] *= 1 + (value / current - 1) * mix;
      }
    }
    if (moved) {
      this.moveToWorld(bone, worldX, worldY, this.applied);
    }
    updateBoneWorld(this.data.bones, applied, world, bone);
  }

  /** Returns a world property of a bone: rotation and shearY in degrees, x and y, or axis scales. */
  private readWorldProperty(bone: number, property: number): number {
    const w = bone * WORLD_STRIDE;
    const world = this.world;
    switch (property) {
      case BONE_X:
        return world[w + 4];
      case BONE_Y:
        return world[w + 5];
      case BONE_ROTATION:
        return Math.atan2(world[w + 1], world[w]) * RAD_DEG;
      case BONE_SCALE_X:
        return Math.sqrt(world[w] * world[w] + world[w + 1] * world[w + 1]);
      case BONE_SCALE_Y:
        return Math.sqrt(world[w + 2] * world[w + 2] + world[w + 3] * world[w + 3]);
      default:
        return wrapDegrees((Math.atan2(world[w + 3], world[w + 2]) - Math.atan2(world[w + 1], world[w])) * RAD_DEG - 90);
    }
  }

  /**
   * Sets bone `bone`'s x and y in `pose` (local or applied) so its origin lands on world (x, y).
   * Leaves them when the parent is scaled to 0, since no position there reaches (x, y).
   */
  private moveToWorld(bone: number, x: number, y: number, pose: Float64Array) {
    const parent = this.data.bones[bone].parent;
    const p = bone * BONE_STRIDE;
    if (parent < 0) {
      pose[p + BONE_X] = x;
      pose[p + BONE_Y] = y;
      return;
    }
    const q = parent * WORLD_STRIDE;
    const world = this.world;
    const determinant = world[q] * world[q + 3] - world[q + 2] * world[q + 1];
    if (Math.abs(determinant) < EPSILON) {
      return;
    }
    const dx = x - world[q + 4];
    const dy = y - world[q + 5];
    pose[p + BONE_X] = (world[q + 3] * dx - world[q + 2] * dy) / determinant;
    pose[p + BONE_Y] = (world[q] * dy - world[q + 1] * dx) / determinant;
  }

  /**
   * A damped spring on the bone's tip (and origin, for translate). The spring's offset from rest
   * lives in skeleton space. When the rest pose or the skeleton moves, the offset takes the
   * opposite of that move times `inertia`, so the part lags, then the spring pulls it back.
   *
   * To play the same at any frame rate, steps are a fixed {@link PHYSICS_STEP}, a frame's
   * movement is shared out over the steps by time (not dumped in before them), movement no step
   * has used yet shows as plain lag, and the drawn offset blends the last two steps.
   */
  private applyPhysics(index: number, steps: number, stepTime: number, movedX: number, movedY: number) {
    const physics = this.data.physics[index];
    const state = this.physicsState;
    const s = index * PHYSICS_STRIDE;
    const bone = physics.bone;
    const w = bone * WORLD_STRIDE;
    const world = this.world;
    const length = this.data.bones[bone].length;
    const originX = world[w + 4];
    const originY = world[w + 5];
    const tipX = world[w] * length + originX;
    const tipY = world[w + 1] * length + originY;
    if (state[s + P_READY] === 0) {
      state.fill(0, s, s + PHYSICS_STRIDE);
      state[s + P_READY] = 1;
    } else {
      state[s + P_TIP_PENDING] += (tipX - state[s + P_LAST_TIP_X] + movedX) * physics.inertia;
      state[s + P_TIP_PENDING + 1] += (tipY - state[s + P_LAST_TIP_Y] + movedY) * physics.inertia;
      state[s + P_ORIGIN_PENDING] += (originX - state[s + P_LAST_ORIGIN_X] + movedX) * physics.inertia;
      state[s + P_ORIGIN_PENDING + 1] += (originY - state[s + P_LAST_ORIGIN_Y] + movedY) * physics.inertia;
      // Movement no step has used yet shows as lag: cap it like the swing, so a sudden jump can't fling the part.
      this.clampPair(s + P_TIP_PENDING, physics.limit);
      this.clampPair(s + P_ORIGIN_PENDING, physics.limit);
    }
    state[s + P_LAST_ORIGIN_X] = originX;
    state[s + P_LAST_ORIGIN_Y] = originY;
    state[s + P_LAST_TIP_X] = tipX;
    state[s + P_LAST_TIP_Y] = tipY;

    const keep = Math.pow(1 - physics.damping, PHYSICS_STEP);
    const forceX = (this.wind * physics.wind) / physics.mass;
    const forceY = (-this.gravity * physics.gravity) / physics.mass;
    const springs = physics.strength / physics.mass;
    let remaining = stepTime;
    for (let step = 0; step < steps; step++) {
      const share = remaining > PHYSICS_STEP ? PHYSICS_STEP / remaining : 1;
      remaining -= PHYSICS_STEP;
      this.stepSpring(s + P_TIP, s + P_TIP_PENDING, share, springs, forceX, forceY, keep, physics.limit);
      this.stepSpring(s + P_ORIGIN, s + P_ORIGIN_PENDING, share, springs, forceX, forceY, keep, physics.limit);
    }
    const mix = this.physicsMix[index];
    if (mix === 0) {
      return;
    }
    const blend = this.physicsPending / PHYSICS_STEP;
    let changed = false;
    if (physics.translate > 0) {
      const amount = physics.translate * mix;
      this.moveToWorld(bone, originX + this.readOffset(s + P_ORIGIN, s + P_ORIGIN_PENDING, blend, 0) * amount, originY + this.readOffset(s + P_ORIGIN, s + P_ORIGIN_PENDING, blend, 1) * amount, this.applied);
      changed = true;
    }
    if (length > 0 && (physics.rotate > 0 || physics.stretch > 0)) {
      const restX = tipX - originX;
      const restY = tipY - originY;
      const swungX = restX + this.readOffset(s + P_TIP, s + P_TIP_PENDING, blend, 0);
      const swungY = restY + this.readOffset(s + P_TIP, s + P_TIP_PENDING, blend, 1);
      const restLength = Math.sqrt(restX * restX + restY * restY);
      if (physics.rotate > 0 && restLength > EPSILON) {
        const turn = wrapDegrees((Math.atan2(swungY, swungX) - Math.atan2(restY, restX)) * RAD_DEG);
        this.turnTowardWorldAngle(bone, Math.atan2(restY, restX) * RAD_DEG + turn * physics.rotate * mix, 1);
      }
      if (physics.stretch > 0 && restLength > EPSILON) {
        const ratio = Math.sqrt(swungX * swungX + swungY * swungY) / restLength;
        this.applied[bone * BONE_STRIDE + BONE_SCALE_X] *= 1 + (ratio - 1) * physics.stretch * mix;
      }
      changed = true;
    }
    if (changed) {
      updateBoneWorld(this.data.bones, this.applied, world, bone);
    }
  }

  /**
   * Returns axis `axis` (0 x, 1 y) of a spring's drawn offset: blended between its last two
   * steps, minus the movement no step has used yet. `offset` is the spring's P_TIP or P_ORIGIN
   * slot, laid out as current, previous, speed.
   */
  private readOffset(offset: number, pending: number, blend: number, axis: number): number {
    const state = this.physicsState;
    const previous = state[offset + 2 + axis];
    return previous + (state[offset + axis] - previous) * blend - state[pending + axis];
  }

  /**
   * One semi-implicit Euler step of a spring pulling its offset to zero, after taking `share`
   * of the pending movement. `offset` is laid out as current (x, y), previous, speed.
   */
  private stepSpring(offset: number, pending: number, share: number, springs: number, forceX: number, forceY: number, keep: number, limit: number) {
    const state = this.physicsState;
    for (let axis = 0; axis < 2; axis++) {
      const moved = state[pending + axis] * share;
      state[pending + axis] -= moved;
      state[offset + 2 + axis] = state[offset + axis] - moved;
      state[offset + axis] -= moved;
    }
    state[offset + 4] = (state[offset + 4] + (forceX - springs * state[offset]) * PHYSICS_STEP) * keep;
    state[offset + 5] = (state[offset + 5] + (forceY - springs * state[offset + 1]) * PHYSICS_STEP) * keep;
    state[offset] += state[offset + 4] * PHYSICS_STEP;
    state[offset + 1] += state[offset + 5] * PHYSICS_STEP;
    this.clampPair(offset, limit);
  }

  /** Shortens the (x, y) pair at `offset` in the physics state to at most `limit` long. */
  private clampPair(offset: number, limit: number) {
    const state = this.physicsState;
    const distance = Math.sqrt(state[offset] * state[offset] + state[offset + 1] * state[offset + 1]);
    if (distance > limit) {
      state[offset] *= limit / distance;
      state[offset + 1] *= limit / distance;
    }
  }
}

/**
 * Returns the frame (0 to `count` - 1) a flipbook in `mode` shows `steps` frames after starting
 * on frame `first`.
 */
function getSequenceFrame(mode: number, count: number, first: number, steps: number): number {
  if (mode === SEQUENCE_HOLD) {
    return Math.max(0, Math.min(count - 1, first));
  }
  const isReverse = mode >= SEQUENCE_REVERSE;
  const forward = isReverse ? mode - SEQUENCE_REVERSE : mode;
  let index = first + steps;
  if (forward === SEQUENCE_ONCE) {
    index = Math.max(0, Math.min(count - 1, index));
  } else if (forward === SEQUENCE_PINGPONG) {
    const period = Math.max(1, count * 2 - 2);
    const position = ((index % period) + period) % period;
    index = position < count ? position : period - position;
  } else {
    index = ((index % count) + count) % count;
  }
  return isReverse ? count - 1 - index : index;
}
