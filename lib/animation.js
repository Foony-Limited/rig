import { wrapDegrees } from './boneMath.js';
import { applyCurve } from './curves.js';
import { BEZIER_SAMPLES, BONE_ROTATION, BONE_SCALE_X, BONE_SCALE_Y, BONE_STRIDE, SEQUENCE_FLOATS, TIMELINE_ALPHA, TIMELINE_ATTACHMENT, TIMELINE_BONE, TIMELINE_COLOR, TIMELINE_DARK, TIMELINE_DEFORM, TIMELINE_IK_BEND, TIMELINE_IK_MIX, TIMELINE_PATH_MIX, TIMELINE_PATH_POSITION, TIMELINE_PATH_SPACING, TIMELINE_PHYSICS_MIX, TIMELINE_SEQUENCE, TIMELINE_SLIDER_MIX, TIMELINE_SLIDER_TIME, TIMELINE_TRANSFORM_MIX, } from './rigData.js';
/** Returns `skeleton`'s live values, with `bones` as the bone pose to write. */
export function getPoseValues(skeleton, bones) {
    return {
        bones,
        slotColors: skeleton.slotColors,
        slotDarks: skeleton.slotDarks,
        slotSequences: skeleton.slotSequences,
        slotDeforms: skeleton.slotDeforms,
        slotDeformAttachments: skeleton.slotDeformAttachments,
        slotAttachments: skeleton.slotAttachments,
        drawOrder: skeleton.drawOrder,
        ikMix: skeleton.ikMix,
        ikBend: skeleton.ikBend,
        transformMix: skeleton.transformMix,
        physicsMix: skeleton.physicsMix,
        sliderTime: skeleton.sliderTime,
        sliderMix: skeleton.sliderMix,
        pathPosition: skeleton.pathPosition,
        pathSpacing: skeleton.pathSpacing,
        pathMix: skeleton.pathMix,
    };
}
/** Returns new arrays the size of `values`', for {@link copyPoseValues} to fill. */
export function makePoseValues(values) {
    return {
        bones: new Float64Array(values.bones.length),
        slotColors: new Float32Array(values.slotColors.length),
        slotDarks: new Float32Array(values.slotDarks.length),
        slotSequences: new Float64Array(values.slotSequences.length),
        slotDeforms: values.slotDeforms.map(deform => new Float32Array(deform.length)),
        slotDeformAttachments: new Int16Array(values.slotDeformAttachments.length),
        slotAttachments: new Int16Array(values.slotAttachments.length),
        drawOrder: new Int16Array(values.drawOrder.length),
        ikMix: new Float64Array(values.ikMix.length),
        ikBend: new Float64Array(values.ikBend.length),
        transformMix: new Float64Array(values.transformMix.length),
        physicsMix: new Float64Array(values.physicsMix.length),
        sliderTime: new Float64Array(values.sliderTime.length),
        sliderMix: new Float64Array(values.sliderMix.length),
        pathPosition: new Float64Array(values.pathPosition.length),
        pathSpacing: new Float64Array(values.pathSpacing.length),
        pathMix: new Float64Array(values.pathMix.length),
    };
}
/** Copies every array of `from` into `to`. */
export function copyPoseValues(from, to) {
    to.bones.set(from.bones);
    to.slotColors.set(from.slotColors);
    to.slotDarks.set(from.slotDarks);
    to.slotSequences.set(from.slotSequences);
    for (let slot = 0; slot < from.slotDeforms.length; slot++) {
        to.slotDeforms[slot].set(from.slotDeforms[slot]);
    }
    to.slotDeformAttachments.set(from.slotDeformAttachments);
    to.slotAttachments.set(from.slotAttachments);
    to.drawOrder.set(from.drawOrder);
    to.ikMix.set(from.ikMix);
    to.ikBend.set(from.ikBend);
    to.transformMix.set(from.transformMix);
    to.physicsMix.set(from.physicsMix);
    to.sliderTime.set(from.sliderTime);
    to.sliderMix.set(from.sliderMix);
    to.pathPosition.set(from.pathPosition);
    to.pathSpacing.set(from.pathSpacing);
    to.pathMix.set(from.pathMix);
}
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
export function applyAnimation(animation, time, alpha, mix, additive, discreteThreshold, out, under, setup, rotationMemory) {
    const weight = alpha * mix;
    if (weight <= 0) {
        return;
    }
    const isDiscreteOn = weight >= discreteThreshold;
    const timelines = animation.timelines;
    for (let i = 0; i < timelines.length; i++) {
        const timeline = timelines[i];
        const times = timeline.times;
        if (time < times[0]) {
            continue;
        }
        const key = findKey(times, time);
        const target = timeline.target;
        switch (timeline.kind) {
            case TIMELINE_BONE: {
                const property = target % BONE_STRIDE;
                const isScale = property === BONE_SCALE_X || property === BONE_SCALE_Y;
                const offset = sampleValue(timeline, key, time, 0);
                const base = setup[target];
                const value = isScale ? base * offset : base + offset;
                if (additive) {
                    out.bones[target] += (value - base) * weight;
                    break;
                }
                const from = under.bones[target];
                const goal = property === BONE_ROTATION ? from + wrapDegrees(value - from) * alpha : from + (value - from) * alpha;
                blendBone(out.bones, target, goal, mix, property, rotationMemory, timeline.property);
                break;
            }
            case TIMELINE_ATTACHMENT:
                if (isDiscreteOn) {
                    out.slotAttachments[target] = timeline.values[key];
                }
                break;
            case TIMELINE_COLOR:
                for (let channel = 0; channel < 4; channel++) {
                    blendTo(out.slotColors, under.slotColors, target * 4 + channel, sampleValue(timeline, key, time, channel), alpha, mix);
                }
                break;
            case TIMELINE_ALPHA:
                blendTo(out.slotColors, under.slotColors, target * 4 + 3, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_DARK:
                for (let channel = 0; channel < 3; channel++) {
                    blendTo(out.slotDarks, under.slotDarks, target * 3 + channel, sampleValue(timeline, key, time, channel), alpha, mix);
                }
                break;
            case TIMELINE_IK_MIX:
                blendTo(out.ikMix, under.ikMix, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_IK_BEND:
                if (isDiscreteOn) {
                    out.ikBend[target] = timeline.values[key];
                }
                break;
            case TIMELINE_SEQUENCE:
                if (isDiscreteOn) {
                    // Mode, fps, and first frame from the key, and how long ago the key was.
                    const q = target * SEQUENCE_FLOATS;
                    out.slotSequences[q] = timeline.values[key * 3];
                    out.slotSequences[q + 1] = timeline.values[key * 3 + 1];
                    out.slotSequences[q + 2] = timeline.values[key * 3 + 2];
                    out.slotSequences[q + 3] = time - times[key];
                }
                break;
            case TIMELINE_DEFORM:
                applyDeform(timeline, key, time, alpha, mix, additive, out, under);
                break;
            case TIMELINE_TRANSFORM_MIX:
                blendTo(out.transformMix, under.transformMix, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_PHYSICS_MIX:
                blendTo(out.physicsMix, under.physicsMix, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_SLIDER_TIME:
                blendTo(out.sliderTime, under.sliderTime, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_SLIDER_MIX:
                blendTo(out.sliderMix, under.sliderMix, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_PATH_POSITION:
                blendTo(out.pathPosition, under.pathPosition, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_PATH_SPACING:
                blendTo(out.pathSpacing, under.pathSpacing, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
            case TIMELINE_PATH_MIX:
                blendTo(out.pathMix, under.pathMix, target, sampleValue(timeline, key, time, 0), alpha, mix);
                break;
        }
    }
    const drawOrder = animation.drawOrder;
    if (drawOrder !== null && time >= drawOrder.times[0] && isDiscreteOn) {
        const order = drawOrder.orders[findKey(drawOrder.times, time)];
        if (order === null) {
            for (let slot = 0; slot < out.drawOrder.length; slot++) {
                out.drawOrder[slot] = slot;
            }
        }
        else {
            out.drawOrder.set(order);
        }
    }
}
/**
 * For a crossfade: moves the values `animation` (an older entry) keys back toward `under` by
 * `mix`, the newer entry's progress, skipping those `newerKeyed` marks (the newer entry sets them)
 * and those `done` marks (another older entry already moved them this frame). Step-like values go
 * back to `under` once `mix` passes `discreteThreshold`.
 */
export function fadeTowardUnder(animation, newerKeyed, mix, out, under, done, rotationMemory, discreteThreshold) {
    if (mix <= 0) {
        return;
    }
    const isDiscreteOn = mix > discreteThreshold;
    const timelines = animation.timelines;
    for (let i = 0; i < timelines.length; i++) {
        const timeline = timelines[i];
        const property = timeline.property;
        if ((newerKeyed !== null && newerKeyed[property] === 1) || done[property] === 1) {
            continue;
        }
        done[property] = 1;
        const target = timeline.target;
        switch (timeline.kind) {
            case TIMELINE_BONE:
                blendBone(out.bones, target, under.bones[target], mix, target % BONE_STRIDE, rotationMemory, property);
                break;
            case TIMELINE_ATTACHMENT:
                if (isDiscreteOn) {
                    out.slotAttachments[target] = under.slotAttachments[target];
                }
                break;
            case TIMELINE_COLOR:
                for (let channel = 0; channel < 4; channel++) {
                    blendTo(out.slotColors, under.slotColors, target * 4 + channel, under.slotColors[target * 4 + channel], 1, mix);
                }
                break;
            case TIMELINE_ALPHA:
                blendTo(out.slotColors, under.slotColors, target * 4 + 3, under.slotColors[target * 4 + 3], 1, mix);
                break;
            case TIMELINE_DARK:
                for (let channel = 0; channel < 3; channel++) {
                    blendTo(out.slotDarks, under.slotDarks, target * 3 + channel, under.slotDarks[target * 3 + channel], 1, mix);
                }
                break;
            case TIMELINE_IK_MIX:
                blendTo(out.ikMix, under.ikMix, target, under.ikMix[target], 1, mix);
                break;
            case TIMELINE_IK_BEND:
                if (isDiscreteOn) {
                    out.ikBend[target] = under.ikBend[target];
                }
                break;
            case TIMELINE_SEQUENCE:
                if (isDiscreteOn) {
                    const q = target * SEQUENCE_FLOATS;
                    out.slotSequences.set(under.slotSequences.subarray(q, q + SEQUENCE_FLOATS), q);
                }
                break;
            case TIMELINE_DEFORM: {
                const deform = out.slotDeforms[target];
                const from = under.slotDeformAttachments[target] === out.slotDeformAttachments[target] ? under.slotDeforms[target] : null;
                for (let i = 0; i < deform.length; i++) {
                    deform[i] += ((from === null ? 0 : from[i]) - deform[i]) * Math.min(1, mix);
                }
                break;
            }
            case TIMELINE_TRANSFORM_MIX:
                blendTo(out.transformMix, under.transformMix, target, under.transformMix[target], 1, mix);
                break;
            case TIMELINE_PHYSICS_MIX:
                blendTo(out.physicsMix, under.physicsMix, target, under.physicsMix[target], 1, mix);
                break;
            case TIMELINE_SLIDER_TIME:
                blendTo(out.sliderTime, under.sliderTime, target, under.sliderTime[target], 1, mix);
                break;
            case TIMELINE_SLIDER_MIX:
                blendTo(out.sliderMix, under.sliderMix, target, under.sliderMix[target], 1, mix);
                break;
            case TIMELINE_PATH_POSITION:
                blendTo(out.pathPosition, under.pathPosition, target, under.pathPosition[target], 1, mix);
                break;
            case TIMELINE_PATH_SPACING:
                blendTo(out.pathSpacing, under.pathSpacing, target, under.pathSpacing[target], 1, mix);
                break;
            case TIMELINE_PATH_MIX:
                blendTo(out.pathMix, under.pathMix, target, under.pathMix[target], 1, mix);
                break;
        }
    }
    const drawOrderProperty = done.length - 1;
    if (animation.drawOrder !== null && (newerKeyed === null || newerKeyed[drawOrderProperty] === 0) && done[drawOrderProperty] === 0) {
        done[drawOrderProperty] = 1;
        if (isDiscreteOn) {
            out.drawOrder.set(under.drawOrder);
        }
    }
}
/**
 * Applies a shape key timeline: each corner offset moves `mix` of the way to the value `alpha` of
 * the way from `under`'s offset (0 if `under` shapes another attachment) to the keyed offset. The
 * key segment's curve is eased once for every corner.
 */
function applyDeform(timeline, key, time, alpha, mix, additive, out, under) {
    const target = timeline.target;
    const deform = out.slotDeforms[target];
    const count = timeline.stride;
    if (deform.length < count) {
        return;
    }
    const attachment = timeline.attachment ?? -1;
    if (out.slotDeformAttachments[target] !== attachment) {
        deform.fill(0);
        out.slotDeformAttachments[target] = attachment;
    }
    const from = under.slotDeformAttachments[target] === attachment ? under.slotDeforms[target] : null;
    const times = timeline.times;
    const values = timeline.values;
    const start = key * count;
    let progress = 0;
    if (key < times.length - 1) {
        const span = times[key + 1] - times[key];
        progress = applyCurve(timeline.curves[key], span > 0 ? (time - times[key]) / span : 1, timeline.bezier, key * BEZIER_SAMPLES * 2);
    }
    const weight = Math.min(1, mix);
    for (let i = 0; i < count; i++) {
        const keyed = progress === 0 ? values[start + i] : values[start + i] + (values[start + count + i] - values[start + i]) * progress;
        if (additive) {
            deform[i] += keyed * alpha * mix;
            continue;
        }
        const base = from === null ? 0 : from[i];
        deform[i] += (base + (keyed - base) * Math.min(1, alpha) - deform[i]) * weight;
    }
}
/**
 * Moves bone value `target` of `pose` `weight` of the way to `value`. A rotation goes the short way
 * round, or keeps last frame's way (in `memory` at `memoryIndex`) when the gap passes 180. A scale
 * whose sign changes takes the new sign at once and blends its size, so a flip never squashes to 0.
 */
function blendBone(pose, target, value, weight, property, memory, memoryIndex) {
    if (weight >= 1) {
        pose[target] = value;
        return;
    }
    const current = pose[target];
    if (property === BONE_ROTATION) {
        let turn = wrapDegrees(value - current);
        if (memory !== null) {
            const last = memory[memoryIndex];
            // The gap crossed 180 since last frame: keep turning the way it was going.
            if (last === last && Math.abs(last) > 90 && Math.abs(turn) > 90 && (last > 0) !== (turn > 0)) {
                turn += last > 0 ? 360 : -360;
            }
            memory[memoryIndex] = turn;
        }
        pose[target] = current + turn * weight;
    }
    else if ((property === BONE_SCALE_X || property === BONE_SCALE_Y) && value * current < 0) {
        const size = Math.abs(current) + (Math.abs(value) - Math.abs(current)) * weight;
        pose[target] = value < 0 ? -size : size;
    }
    else {
        pose[target] = current + (value - current) * weight;
    }
}
/** Moves `out[index]` `mix` of the way to the value `alpha` of the way from `under[index]` to `value`. */
function blendTo(out, under, index, value, alpha, mix) {
    const from = under[index];
    const goal = from + (value - from) * Math.min(1, alpha);
    out[index] += (goal - out[index]) * Math.min(1, mix);
}
/** Returns the index of the last key at or before `time`. `time` must be at or after the first key. */
function findKey(times, time) {
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (times[middle] <= time) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }
    return low;
}
/** Returns channel `channel` of the timeline's value at `time`, between key `key` and the next. */
function sampleValue(timeline, key, time, channel) {
    const values = timeline.values;
    const stride = timeline.stride;
    const from = values[key * stride + channel];
    const times = timeline.times;
    if (key === times.length - 1) {
        return from;
    }
    const span = times[key + 1] - times[key];
    const progress = span > 0 ? (time - times[key]) / span : 1;
    const eased = applyCurve(timeline.curves[key], progress, timeline.bezier, key * BEZIER_SAMPLES * 2);
    return from + (values[(key + 1) * stride + channel] - from) * eased;
}
