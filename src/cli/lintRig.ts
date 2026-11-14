import {AnimationState} from '../animationState.js';
import {BONE_ROTATION, BONE_SCALE_X, BONE_SCALE_Y, BONE_STRIDE, RigData, TIMELINE_BONE} from '../rigData.js';
import {Skeleton} from '../skeleton.js';

/**
 * Checks a compiled rig for mistakes that compile fine but look wrong: a loop that jumps at its
 * seam, a rotation that spins the long way between keys, a bone leaving its `limits`, and keys
 * past an animation's end. Each warning names the animation, bone, and time.
 */

const PROPERTY_NAMES = ['x', 'y', 'rotate', 'scaleX', 'scaleY', 'shearX', 'shearY'];
/** Seconds between samples when checking limits. */
const SAMPLE_STEP = 1 / 30;
/** Differences below this are rounding, not a jump. */
const EPSILON = 1e-3;

/** Returns every warning for `data`, one line each. */
export function lintRig(data: RigData): string[] {
  const warnings: string[] = [];
  for (const animation of data.animations) {
    const path = `animations.${animation.name}`;
    for (const timeline of animation.timelines) {
      if (timeline.kind !== TIMELINE_BONE) {
        continue;
      }
      const bone = data.bones[Math.floor(timeline.target / BONE_STRIDE)].name;
      const property = timeline.target % BONE_STRIDE;
      const name = `${bone}.${PROPERTY_NAMES[property]}`;
      const {times, values} = timeline;
      const last = times.length - 1;
      if (times[last] > animation.duration + EPSILON) {
        warnings.push(`${path}: ${name} has a key at ${times[last]}s, past the animation's end at ${animation.duration}s, so it never plays`);
      }
      if (property === BONE_ROTATION) {
        for (let i = 1; i < times.length; i++) {
          const turn = values[i] - values[i - 1];
          if (Math.abs(turn) > 180) {
            warnings.push(`${path}: ${name} turns ${round(turn)} degrees from ${times[i - 1]}s to ${times[i]}s, the long way round. If you meant the short way, use ${round(values[i] - Math.sign(turn) * 360)}`);
          }
        }
      }
      if (animation.loop && animation.duration > 0) {
        const identity = property === BONE_SCALE_X || property === BONE_SCALE_Y ? 1 : 0;
        const start = times[0] <= EPSILON ? values[0] : identity;
        const end = values[last];
        const jump = property === BONE_ROTATION ? ((end - start) % 360 + 540) % 360 - 180 : end - start;
        if (Math.abs(jump) > EPSILON) {
          warnings.push(`${path}: ${name} is ${round(end)} at the end but ${round(start)} at the start, so the loop jumps. Add a last key at ${animation.duration}s equal to the first, or set "loop": false`);
        }
      }
    }
  }
  warnings.push(...lintLimits(data));
  return warnings;
}

/** Plays each animation and reports the first time each limited bone leaves its range. */
function lintLimits(data: RigData): string[] {
  const limited = data.bones.filter(bone => bone.limits);
  if (limited.length === 0) {
    return [];
  }
  const warnings: string[] = [];
  const skeleton = new Skeleton(data);
  const state = new AnimationState(skeleton);
  for (const animation of data.animations) {
    state.clearTracks();
    state.setAnimation(0, animation.name, {loop: false});
    const reported = new Set<number>();
    for (let time = 0; time <= animation.duration + EPSILON; time += SAMPLE_STEP) {
      state.tracks[0]!.trackTime = time;
      state.apply();
      for (const bone of limited) {
        const rotation = skeleton.local[bone.index * BONE_STRIDE + BONE_ROTATION];
        const [min, max] = bone.limits!;
        if (!reported.has(bone.index) && (rotation < min - EPSILON || rotation > max + EPSILON)) {
          reported.add(bone.index);
          warnings.push(`animations.${animation.name}: ${bone.name} rotation is ${round(rotation)} at ${round(time)}s, outside its limits [${min}, ${max}]`);
        }
      }
    }
  }
  return warnings;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
