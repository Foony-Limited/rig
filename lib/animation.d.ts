import { AnimationData } from './rigData.js';
import type { Skeleton } from './skeleton.js';
/**
 * Every value an animation writes, as one set of arrays: a skeleton's live arrays (see
 * {@link getPoseValues}), or a copy of them (see {@link copyPoseValues}). `bones` is the skeleton's
 * `local` pose for animations, or its `applied` pose for sliders.
 */
export type PoseValues = {
    readonly bones: Float64Array;
    readonly slotColors: Float32Array;
    readonly slotDarks: Float32Array;
    readonly slotSequences: Float64Array;
    readonly slotDeforms: Float32Array[];
    readonly slotDeformAttachments: Int16Array;
    readonly slotAttachments: Int16Array;
    readonly drawOrder: Int16Array;
    readonly ikMix: Float64Array;
    readonly ikBend: Float64Array;
    readonly transformMix: Float64Array;
    readonly physicsMix: Float64Array;
    readonly sliderTime: Float64Array;
    readonly sliderMix: Float64Array;
    readonly pathPosition: Float64Array;
    readonly pathSpacing: Float64Array;
    readonly pathMix: Float64Array;
};
/** Returns `skeleton`'s live values, with `bones` as the bone pose to write. */
export declare function getPoseValues(skeleton: Skeleton, bones: Float64Array): PoseValues;
/** Returns new arrays the size of `values`', for {@link copyPoseValues} to fill. */
export declare function makePoseValues(values: PoseValues): PoseValues;
/** Copies every array of `from` into `to`. */
export declare function copyPoseValues(from: PoseValues, to: PoseValues): void;
/**
 * Applies an animation at `time` (seconds, already wrapped for loops) onto `out`.
 *
 * Each value the animation keys becomes its target, `alpha` of the way from `under` to the
 * animation's value. `out` then moves `mix` of the way to that target. Without a crossfade, pass
 * the same values as `out` and `under` and a `mix` of 1, and each value moves `alpha` of the way.
 * In a crossfade, `under` is the pose before the track's animations, and each entry moves the
 * pose from the entry before it by its own crossfade progress, so a crossfade never sags toward
 * setup, and ends exactly on the new animation.
 *
 * With `additive`, values add their offset from setup times alpha times mix instead.
 * Step-like values (attachments, bend, draw order) change only once alpha times mix reaches
 * `discreteThreshold`. A timeline does nothing before its first key.
 *
 * `rotationMemory`, per property, keeps the way each rotation turned last frame, so a crossfade
 * whose gap passes 180 degrees keeps turning the same way instead of flipping across.
 */
export declare function applyAnimation(animation: AnimationData, time: number, alpha: number, mix: number, additive: boolean, discreteThreshold: number, out: PoseValues, under: PoseValues, setup: Float64Array, rotationMemory: Float64Array | null): void;
/**
 * For a crossfade: moves the values `animation` (an older entry) keys back toward `under` by
 * `mix`, the newer entry's progress, skipping those `newerKeyed` marks (the newer entry sets them)
 * and those `done` marks (another older entry already moved them this frame). Step-like values go
 * back to `under` once `mix` passes `discreteThreshold`.
 */
export declare function fadeTowardUnder(animation: AnimationData, newerKeyed: Uint8Array | null, mix: number, out: PoseValues, under: PoseValues, done: Uint8Array, rotationMemory: Float64Array | null, discreteThreshold: number): void;
//# sourceMappingURL=animation.d.ts.map