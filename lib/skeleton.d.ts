import { Attachment, MeshAttachment, RegionAttachment, RigData } from './rigData.js';
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
'update'
/** Snap every spring back to rest, then apply them. Use after a teleport. */
 | 'reset'
/** Leave the springs out: bones take their animated pose. */
 | 'none';
/** A spot on the skeleton, in skeleton space. */
export type RigSpot = {
    x: number;
    y: number;
    rotation: number;
};
export declare class Skeleton {
    readonly data: RigData;
    /** Canvas x of the root, in canvas pixels. */
    x: number;
    /** Canvas y of the root, in canvas pixels (y down). */
    y: number;
    /** Canvas pixels per rig unit across. Negative mirrors the skeleton left to right. */
    scaleX: number;
    /** Canvas pixels per rig unit up. */
    scaleY: number;
    /** Opacity of the whole skeleton, 0 to 1. */
    alpha: number;
    /** Seconds this skeleton has run, advanced by {@link Skeleton.update}. Flipbooks play by it. */
    time: number;
    /** Physics gravity, from the rig's `world.gravity`. Change it for the whole skeleton. */
    gravity: number;
    /** Physics wind, from the rig's `world.wind`. Change it for gusts. */
    wind: number;
    /**
     * Share of the skeleton's own movement across the canvas (its `x`) that physics parts feel,
     * 0 to 1. 0 keeps a cape from trailing while the camera or a platform carries the character.
     * @defaultValue 1
     */
    physicsMoveX: number;
    /** The same for movement up and down (its `y`). 0 keeps hair from bouncing on a moving lift. @defaultValue 1 */
    physicsMoveY: number;
    /** Animated pose: {@link BONE_STRIDE} floats per bone, before constraints. Write overrides here. */
    readonly local: Float64Array;
    /** Pose after constraints. Read-only for callers. */
    readonly applied: Float64Array;
    /** World matrices, {@link WORLD_STRIDE} per bone, in skeleton space. */
    readonly world: Float64Array;
    /** Each bone's motion for the mesh being skinned (see SKIN_FLOATS), so a bone shared by many corners is worked out once. */
    private readonly skinCache;
    /** Which {@link Skeleton.computeMeshVertices} call filled each bone's skin cache. */
    private readonly skinStamps;
    private skinStamp;
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
    private readonly boneActive;
    /** Per update kind (`UPDATE_*`) then constraint, 1 while every bone it uses is active. */
    private readonly constraintActive;
    /** Per update kind then constraint, the bones it reads or moves. */
    private readonly constraintBones;
    private readonly sequenceStarts;
    private readonly lastAttachments;
    private readonly physicsState;
    private resolved;
    private physicsPending;
    private lastX;
    private lastY;
    private readonly boneIndex;
    private readonly slotIndex;
    /** The live values sliders write, with the applied pose as the bones. */
    private readonly sliderValues;
    constructor(data: RigData);
    /** Returns the bone's index. Throws if there is no such bone. */
    findBone(name: string): number;
    /** Returns the slot's index. Throws if there is no such slot. */
    findSlot(name: string): number;
    /**
     * Turns on skins by name, replacing the ones on before. Later skins win where two supply the
     * same attachment, and the slots' own attachments fill in the rest, so cosmetics mix freely:
     * `setSkins(['dinoRed', 'hatCrown', 'feetBoots'])`. Throws on an unknown skin name.
     */
    setSkins(names: readonly string[]): void;
    /** Returns true if bone `bone` updates: it isn't a bone of a skin that is off (see {@link Skeleton.setSkins}). */
    isBoneActive(bone: number): boolean;
    /** Returns the attachment slot `slot` shows, or undefined for none (or when its bone's skin is off). */
    getAttachment(slot: number): Attachment | undefined;
    /** Returns slot `slot`'s attachment named `name` under the current skins, or undefined. */
    getAttachmentByName(slot: number, name: string): Attachment | undefined;
    /**
     * Shows attachment `name` on slot `slot`, or none for null. Animations reset it each frame, so
     * call this after {@link AnimationState.apply}, or key it. Throws on an unknown name.
     */
    setAttachment(slot: number, name: string | null): void;
    /** Puts the local pose, slots, draw order, and constraint values back to setup. */
    setToSetupPose(): void;
    /** Advances the skeleton's clock (flipbooks) and queues `seconds` of physics for the next {@link Skeleton.updateWorld}. */
    update(seconds: number): void;
    /**
     * Moves the skeleton to canvas point (x, y) without physics noticing, so a respawn or a warp
     * doesn't fling capes and hair. Swings already going keep going.
     */
    teleport(x: number, y: number): void;
    /** Snaps physics constraint `physics` back to rest on the next update. */
    resetPhysics(physics: number): void;
    /** Computes the applied pose and world matrices from the local pose. See the class doc. */
    updateWorld(physics?: PhysicsMode): void;
    /** Returns bone `bone`'s world x in skeleton space. */
    getWorldX(bone: number): number;
    /** Returns bone `bone`'s world y in skeleton space. */
    getWorldY(bone: number): number;
    /** Returns the world angle of bone `bone`'s x axis, in degrees counterclockwise. */
    getWorldRotation(bone: number): number;
    /** Returns the world length of bone `bone`'s x axis (its world scaleX). */
    getWorldScaleX(bone: number): number;
    /** Returns the world position of bone `bone`'s tip: its origin plus `length` along x. */
    getBoneTip(bone: number): {
        x: number;
        y: number;
    };
    /** Returns where skeleton-space point (x, y) is on the canvas. */
    toCanvas(x: number, y: number): {
        x: number;
        y: number;
    };
    /** Returns where canvas point (x, y) is in skeleton space. */
    toSkeleton(x: number, y: number): {
        x: number;
        y: number;
    };
    /**
     * Moves bone `bone` so its origin lands on skeleton-space (x, y), by setting its local x and y.
     * For aiming an IK target at the mouse: call after {@link AnimationState.apply} and before
     * {@link Skeleton.updateWorld}, which this needs to have run once for the parent's matrix.
     */
    setBoneWorldPosition(bone: number, x: number, y: number): void;
    /**
     * Returns the skeleton-space position and angle of point attachment `name` on slot `slot`
     * under the current skins, or null if the slot has no such point.
     */
    getPoint(slot: number, name: string): RigSpot | null;
    /**
     * Returns the name of the front-most slot whose shown box attachment contains canvas point
     * (x, y), or null if none does.
     */
    hitTest(x: number, y: number): string | null;
    /**
     * Returns the canvas-pixel bounding box of every region and mesh the skeleton shows, for culling
     * and camera framing. Call after {@link Skeleton.updateWorld}. All 0 when it shows none.
     */
    getBounds(): {
        minX: number;
        minY: number;
        maxX: number;
        maxY: number;
    };
    /** Writes region `region`'s image-to-skeleton matrix for slot `slot` into `out`. */
    getRegionMatrix(slot: number, region: RegionAttachment, out: Float64Array | number[]): void;
    /**
     * Returns which image of `attachment` slot `slot` shows now: 0 unless it is a flipbook. A
     * flipbook plays by the skeleton's clock from when the slot switched to it, or by animation time
     * where an animation keys the slot's `sequence`.
     */
    getFrame(slot: number, attachment: RegionAttachment | MeshAttachment): number;
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
    computeMeshVertices(mesh: MeshAttachment, out: Float32Array | Float64Array, slot?: number): void;
    /**
     * Writes bone `bone`'s motion since the setup pose into `out`, canvas order: its world matrix times
     * the inverse of its setup world matrix. It takes a point in setup-pose skeleton space to where
     * the bone has carried it now.
     */
    getSkinMatrix(bone: number, out: Float64Array | number[]): void;
    private boxContains;
    /**
     * Turns bone `bone`'s applied rotation `mix` of the way toward pointing its x axis at world
     * angle `degrees`. The direction goes back through the parent's axes, so a mirrored, squashed,
     * or sheared parent still ends with the bone pointing exactly there. Does nothing when the parent
     * space is scaled to 0.
     */
    private turnTowardWorldAngle;
    /**
     * Returns the curve slot `slot`'s path attachment shows now, sampled finely, in skeleton space:
     * x then y per sample. Null if the slot shows no path. For tools that draw paths.
     */
    getPathSamples(slot: number): Float64Array | null;
    /**
     * Samples `path` on slot `slot` into {@link pathSamples} and {@link pathLengths} (distance along
     * the curve to each sample) and returns the sample count. The curve is a Catmull-Rom spline
     * through the path's points in world space, so it passes through every point.
     */
    private samplePath;
    /**
     * Lays the constraint's bones along its path: each bone's origin moves to its distance along the
     * curve (its position, plus the spacing of the bones before it), then turns along the curve or
     * at the next bone's place. A closed path wraps, an open one stops at its ends.
     */
    private applyPath;
    private applySlider;
    /**
     * Turns the chain so its end reaches the target. Works in world space: it finds the world angles
     * the bones should have, then turns each through its parent's axes ({@link Skeleton.turnTowardWorldAngle}),
     * so child offsets, mirrors, and squashed parents need no special cases. Under uneven parent scale
     * a bone's world length changes as it turns, so the 2-bone solve runs again until it lands.
     */
    private applyIk;
    /**
     * One 2-bone IK solve. It works in the space of the chain's parent (its axes, at the upper bone's
     * origin), where a squashed or mirrored parent is undone, so the law of cosines there is exact
     * and the upper bone's rotation is a plain turn. The lower bone then turns to its world angle.
     * Stretches first if `canStretch`. Returns false if there is nothing to solve: no upper length or
     * a parent scaled to 0.
     */
    private solveTwoBoneIk;
    private applyTransform;
    /** Makes `bone`'s world values match the source's, through the mapping, by adjusting its local pose. */
    private applyWorldTransform;
    /** Returns a world property of a bone: rotation and shearY in degrees, x and y, or axis scales. */
    private readWorldProperty;
    /**
     * Sets bone `bone`'s x and y in `pose` (local or applied) so its origin lands on world (x, y).
     * Leaves them when the parent is scaled to 0, since no position there reaches (x, y).
     */
    private moveToWorld;
    /**
     * A damped spring on the bone's tip (and origin, for translate). The spring's offset from rest
     * lives in skeleton space. When the rest pose or the skeleton moves, the offset takes the
     * opposite of that move times `inertia`, so the part lags, then the spring pulls it back.
     *
     * To play the same at any frame rate, steps are a fixed {@link PHYSICS_STEP}, a frame's
     * movement is shared out over the steps by time (not dumped in before them), movement no step
     * has used yet shows as plain lag, and the drawn offset blends the last two steps.
     */
    private applyPhysics;
    /**
     * Returns axis `axis` (0 x, 1 y) of a spring's drawn offset: blended between its last two
     * steps, minus the movement no step has used yet. `offset` is the spring's P_TIP or P_ORIGIN
     * slot, laid out as current, previous, speed.
     */
    private readOffset;
    /**
     * One semi-implicit Euler step of a spring pulling its offset to zero, after taking `share`
     * of the pending movement. `offset` is laid out as current (x, y), previous, speed.
     */
    private stepSpring;
    /** Shortens the (x, y) pair at `offset` in the physics state to at most `limit` long. */
    private clampPair;
}
//# sourceMappingURL=skeleton.d.ts.map