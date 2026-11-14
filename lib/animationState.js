import { applyAnimation, copyPoseValues, fadeTowardUnder, getPoseValues, makePoseValues } from './animation.js';
import { applyCurve, getCurveCode } from './curves.js';
import { CURVE_LINEAR } from './rigData.js';
/**
 * Plays animations on a {@link Skeleton} in numbered tracks. Track 0 is the base (idle, walk,
 * attack). Higher tracks draw over it: an `additive` track adds on top (a breathing or recoil
 * layer), a normal one replaces only what it keys (an aim pose on the arms).
 *
 * Switching animations on a track crossfades. Properties both animations key go straight from
 * one to the other, and properties only the old one keys fade back to what is under them, so a
 * crossfade never sags toward the setup pose halfway (Spine 4.3's hold behavior, with no flag).
 * Each entry in a chain of crossfades (a move cancelled mid-fade) blends from the pose of the
 * entries before it by its own progress, so an interrupted crossfade, or one between entries with
 * an alpha below 1, ends exactly on the new animation with no pop.
 *
 * Listeners (`onStart`, `onInterrupt`, `onEnd`, `onEvent`, `onComplete`, here and on each
 * {@link TrackEntry}) run after the call that caused them has finished changing the tracks, so a
 * listener can safely set or queue animations.
 *
 * @example
 * const state = new AnimationState(skeleton);
 * state.setAnimation(0, 'walk');
 * state.addAnimation(0, 'idle', {loop: true});
 * state.onEvent = event => event.name === 'step' && playSound('footstep');
 * // Each frame:
 * updateRig(state, deltaSeconds);
 */
export class AnimationState {
    skeleton;
    /** Playback speed of every track. 0 pauses. @defaultValue 1 */
    timeScale = 1;
    /** Called when an entry starts playing (set, or its queue turn comes). */
    onStart = null;
    /** Called when another entry replaces a playing one. It may still be fading out. Cancel its hitboxes here. */
    onInterrupt = null;
    /** Called when an entry stops being applied for good: its fade out ended, it was replaced with no fade, or its track was cleared. */
    onEnd = null;
    /**
     * Called for each event key an animation passes. An entry fading out under the entry queued
     * after it keeps firing its events and completion until its fade ends. One replaced by
     * setAnimation or setEmpty stops firing them at once.
     */
    onEvent = null;
    /** Called each time an animation reaches its end (every pass when looping). */
    onComplete = null;
    /** The playing entry per track, or null. */
    tracks = [];
    empty;
    animationIndex;
    /** The skeleton's live values, with the local pose as the bones. */
    live;
    /** The values under a track (lower tracks over setup), copied before a crossfade chain applies. */
    under;
    /** Per property: 1 once a crossfade step has faded it back this frame. */
    done;
    /** Scratch: a track's crossfade chain, oldest entry first. */
    chain = [];
    /** Listener calls waiting for the current call to finish. */
    pending = [];
    isDraining = false;
    constructor(skeleton) {
        this.skeleton = skeleton;
        const data = skeleton.data;
        this.empty = { index: -1, name: '<empty>', duration: 0, loop: false, timelines: [], keyed: new Uint8Array(data.propertyCount), events: [], drawOrder: null, physicsResets: [] };
        this.animationIndex = new Map(data.animations.map(animation => [animation.name, animation]));
        this.live = getPoseValues(skeleton, skeleton.local);
        this.under = makePoseValues(this.live);
        this.done = new Uint8Array(data.propertyCount);
    }
    /**
     * Plays animation `name` on `track` now, crossfading from what was playing, and drops anything
     * queued there. Returns the new entry. Throws on an unknown animation name.
     */
    setAnimation(track, name, options = {}) {
        const entry = this.start(track, this.findAnimation(name), options);
        this.drain();
        return entry;
    }
    /**
     * Queues animation `name` on `track` after the last queued (or playing) entry. Without a
     * delay it starts so its crossfade ends as the one before it ends (for a looping one, as its
     * current loop ends). On an empty track it plays at once, or after `delay` seconds.
     * Returns the new entry. Throws on an unknown animation name.
     */
    addAnimation(track, name, options = {}) {
        const entry = this.queue(track, this.findAnimation(name), options);
        this.drain();
        return entry;
    }
    /** Fades `track` out to what is under it over `mix` seconds. @defaultValue mix: the rig's default mix */
    setEmpty(track, mix = this.skeleton.data.defaultMix) {
        const entry = this.start(track, this.empty, { mix });
        this.drain();
        return entry;
    }
    /** Queues a fade-out of `track`, like {@link AnimationState.addAnimation}. */
    addEmpty(track, mix = this.skeleton.data.defaultMix, delay) {
        const entry = this.queue(track, this.empty, { mix, delay });
        this.drain();
        return entry;
    }
    /** Stops `track` at once, with no fade. */
    clearTrack(track) {
        const entry = this.tracks[track];
        if (entry) {
            this.tracks[track] = null;
            this.endChain(entry);
            this.drain();
        }
    }
    /** Stops every track at once. */
    clearTracks() {
        for (let track = 0; track < this.tracks.length; track++) {
            this.clearTrack(track);
        }
        this.tracks.length = 0;
    }
    /**
     * Advances every track by `seconds`: moves time, ends finished crossfades, starts queued
     * entries, and calls the event and complete listeners for what was passed. A queued entry starts
     * on the update after the one before it reaches its start, so with no crossfade the old
     * animation's last frame still shows once.
     */
    update(seconds) {
        const delta = seconds * this.timeScale;
        for (let track = 0; track < this.tracks.length; track++) {
            let entry = this.tracks[track];
            if (!entry) {
                continue;
            }
            const next = entry.next;
            if (next && entry.trackTime >= next.delay) {
                // Carry the time past the start over in real seconds, so a queue plays without drift.
                const over = entry.timeScale === 0 ? 0 : (entry.trackTime - next.delay) / entry.timeScale;
                next.trackTime = (over + delta) * next.timeScale;
                this.begin(track, next, entry);
                this.passKeys(next, 0, next.trackTime);
                this.updateMixingFrom(next, delta);
                entry = next;
            }
            else {
                const before = entry.trackTime;
                entry.trackTime += delta * entry.timeScale;
                this.passKeys(entry, before, entry.trackTime);
                this.updateMixingFrom(entry, delta);
            }
            if (entry.animation === this.empty && !entry.mixingFrom && !entry.next) {
                this.tracks[track] = null;
                this.notify('end', entry);
            }
        }
        this.drain();
    }
    /**
     * Resets the skeleton's local pose to setup, then writes every track into it. Game overrides
     * (bone positions, slider times, attachments) go after this and before
     * {@link Skeleton.updateWorld}.
     */
    apply() {
        const skeleton = this.skeleton;
        skeleton.setToSetupPose();
        const setup = skeleton.data.setup;
        const live = this.live;
        for (let track = 0; track < this.tracks.length; track++) {
            const entry = this.tracks[track];
            if (!entry) {
                continue;
            }
            if (!entry.mixingFrom) {
                applyAnimation(entry.animation, animationTime(entry), entry.alpha, 1, entry.additive, 0, live, live, setup, null);
                continue;
            }
            this.applyChain(entry);
        }
    }
    findAnimation(name) {
        const animation = this.animationIndex.get(name);
        if (!animation) {
            throw new Error(`[rig] ${this.skeleton.data.name}: no animation "${name}". Animations: ${[...this.animationIndex.keys()].join(', ')}`);
        }
        return animation;
    }
    start(track, animation, options) {
        const entry = new TrackEntry(track, animation, options);
        const current = this.tracks[track] ?? null;
        // Drops what was queued, and stops every entry still fading out from firing its keys.
        for (let link = current; link; link = link.mixingFrom) {
            link.next = null;
        }
        this.begin(track, entry, current);
        return entry;
    }
    queue(track, animation, options) {
        let last = this.tracks[track] ?? null;
        if (!last) {
            if (!options.delay || options.delay <= 0) {
                return this.start(track, animation, options);
            }
            // Wait out the delay on an empty entry, which shows nothing.
            last = this.start(track, this.empty, { mix: 0 });
        }
        while (last.next) {
            last = last.next;
        }
        const entry = new TrackEntry(track, animation, options);
        const mix = options.mix ?? this.getMix(last.animation, animation);
        entry.delay = options.delay ?? Math.max(0, getTrackEnd(last) - mix);
        last.next = entry;
        return entry;
    }
    /** Makes `entry` the playing entry on `track`, crossfading from `from` if there is one. */
    begin(track, entry, from) {
        while (this.tracks.length <= track) {
            this.tracks.push(null);
        }
        this.tracks[track] = entry;
        if (from) {
            this.notify('interrupt', from);
        }
        this.notify('start', entry);
        if (!from) {
            return;
        }
        entry.mixDuration = entry.mixOverride ?? this.getMix(from.animation, entry.animation);
        entry.mixTime = 0;
        entry.mixingFrom = entry.mixDuration > 0 ? from : null;
        if (entry.mixingFrom) {
            entry.rotationMemory = new Float64Array(this.skeleton.data.propertyCount).fill(NaN);
        }
        else {
            this.endChain(from);
        }
    }
    /** Reports the end of `entry` and of every entry it was still fading from. */
    endChain(entry) {
        for (let link = entry; link; link = link.mixingFrom) {
            this.notify('end', link);
        }
    }
    /** Queues a listener call for {@link AnimationState.drain}. */
    notify(kind, entry, event = null) {
        this.pending.push({ kind, entry, event });
    }
    /** Calls the queued listeners, including any a listener queues. A nested call leaves them to the outer one. */
    drain() {
        if (this.isDraining) {
            return;
        }
        this.isDraining = true;
        const pending = this.pending;
        for (let i = 0; i < pending.length; i++) {
            const { kind, entry, event } = pending[i];
            if (kind === 'event') {
                this.onEvent?.(event, entry);
                entry.onEvent?.(event, entry);
            }
            else {
                this[LISTENERS[kind]]?.(entry);
                entry[LISTENERS[kind]]?.(entry);
            }
        }
        pending.length = 0;
        this.isDraining = false;
    }
    getMix(from, to) {
        const data = this.skeleton.data;
        return data.mixes.get(`${from.name}>${to.name}`) ?? data.defaultMix;
    }
    updateMixingFrom(entry, delta) {
        const from = entry.mixingFrom;
        if (!from) {
            return;
        }
        const before = from.trackTime;
        from.trackTime += delta * from.timeScale;
        // An entry fading out under the entry queued after it is still finishing, so its events and
        // its end still fire. One replaced by setAnimation or setEmpty no longer has that next (see start).
        if (from.next === entry) {
            this.passKeys(from, before, from.trackTime);
        }
        this.updateMixingFrom(from, delta);
        entry.mixTime += delta;
        if (entry.mixTime >= entry.mixDuration) {
            entry.mixingFrom = null;
            this.endChain(from);
        }
    }
    /**
     * Applies `entry` and the entries it is crossfading from, oldest first. Each newer entry moves
     * the pose by its crossfade progress: the values it keys toward its own, and the values only
     * older entries key back toward what is under the track. An additive entry fades by its
     * progress times what the newer entries have left of theirs.
     */
    applyChain(entry) {
        const chain = this.chain;
        chain.length = 0;
        for (let link = entry; link; link = link.mixingFrom) {
            chain.push(link);
        }
        chain.reverse();
        const live = this.live;
        const under = this.under;
        const setup = this.skeleton.data.setup;
        copyPoseValues(live, under);
        for (let i = 0; i < chain.length; i++) {
            const link = chain[i];
            const mix = i === 0 ? 1 : mixProgress(link);
            if (i > 0) {
                this.done.fill(0);
                for (let j = 0; j < i; j++) {
                    if (!chain[j].additive) {
                        fadeTowardUnder(chain[j].animation, link.additive ? null : link.animation.keyed, mix, live, under, this.done, link.rotationMemory, link.attachmentThreshold);
                    }
                }
            }
            if (link.additive) {
                let weight = link.alpha * mix;
                for (let k = i + 1; k < chain.length; k++) {
                    weight *= 1 - mixProgress(chain[k]);
                }
                applyAnimation(link.animation, animationTime(link), weight, 1, true, 0, live, live, setup, null);
            }
            else {
                applyAnimation(link.animation, animationTime(link), link.alpha, mix, false, 0, live, under, setup, link.rotationMemory);
            }
        }
    }
    /**
     * Fires event keys and physics resets in (before, after] of `entry`'s track time, and
     * completes at each loop end. A loop's keys at time 0 fire at the start of every pass. One
     * update passes at most one loop end, so a long stall (a tab back from the background) doesn't
     * replay every loop it skipped. An animation with no length fires its keys and completes on its
     * first update (and completes every update when looping).
     */
    passKeys(entry, before, after) {
        const duration = entry.animation.duration;
        if (after <= before) {
            return;
        }
        if (duration <= 0) {
            if (before === 0) {
                this.passKeysBetween(entry, 0, 0, true);
            }
            if (before === 0 || entry.loop) {
                this.complete(entry);
            }
            return;
        }
        if (!entry.loop) {
            this.passKeysBetween(entry, before, Math.min(after, duration), before <= 0);
            if (before < duration && after >= duration) {
                this.complete(entry);
            }
            return;
        }
        const firstPass = Math.floor(before / duration);
        const lastPass = Math.floor(after / duration);
        const from = Math.max(0, before - firstPass * duration);
        const to = Math.max(0, after - lastPass * duration);
        // Only the first update includes time 0 itself. An update that starts on a seam, the one
        // after an update that ended there, would otherwise fire the keys at 0 a second time.
        const isFirstUpdate = before <= 0;
        if (firstPass === lastPass) {
            this.passKeysBetween(entry, from, to, isFirstUpdate);
            return;
        }
        this.passKeysBetween(entry, from, duration, isFirstUpdate);
        this.complete(entry);
        this.passKeysBetween(entry, 0, to, true);
    }
    passKeysBetween(entry, from, to, includeStart) {
        const animation = entry.animation;
        for (const event of animation.events) {
            if (event.time > to) {
                break;
            }
            if (event.time > from || (includeStart && event.time === from)) {
                this.notify('event', entry, event);
            }
        }
        for (const reset of animation.physicsResets) {
            if (reset.time > to) {
                break;
            }
            if (reset.time > from || (includeStart && reset.time === from)) {
                this.skeleton.resetPhysics(reset.physics);
            }
        }
    }
    complete(entry) {
        this.notify('complete', entry);
    }
}
/** The listener field for each kind but 'event'. */
const LISTENERS = { start: 'onStart', interrupt: 'onInterrupt', end: 'onEnd', complete: 'onComplete' };
/** One animation playing (or queued) on a track. Change its fields to adjust it while it plays. */
export class TrackEntry {
    track;
    animation;
    loop;
    additive;
    alpha;
    timeScale;
    /** Seconds played, times its speed. Set it to seek. */
    trackTime = 0;
    /** For a queued entry: the previous entry's track time at which this one starts. */
    delay = 0;
    /** Seconds into the crossfade from {@link TrackEntry.mixingFrom}. */
    mixTime = 0;
    /** Crossfade length in seconds. */
    mixDuration = 0;
    /** The entry this one is crossfading from, or null. */
    mixingFrom = null;
    /**
     * The entry queued after this one, or null. It stays set while that entry fades in over this
     * one, and is cleared when setAnimation or setEmpty replaces the track.
     */
    next = null;
    /** Called when this entry starts playing. */
    onStart = null;
    /** Called when another entry replaces this one. It may still be fading out. */
    onInterrupt = null;
    /** Called when this entry stops being applied for good. */
    onEnd = null;
    /** Called for each event key this entry passes. */
    onEvent = null;
    /** Called each time this entry reaches its end. */
    onComplete = null;
    /** See {@link PlayOptions.attachmentThreshold}. */
    attachmentThreshold;
    mixOverride;
    mixCurve;
    /** Per property, the way each rotation turned last frame of this entry's crossfade. */
    rotationMemory = null;
    constructor(track, animation, options) {
        this.track = track;
        this.animation = animation;
        this.loop = options.loop ?? true;
        this.additive = options.additive ?? false;
        this.alpha = options.alpha ?? 1;
        this.timeScale = options.timeScale ?? 1;
        this.attachmentThreshold = options.attachmentThreshold ?? 0;
        this.mixOverride = options.mix;
        const curve = options.mixCurve === undefined ? CURVE_LINEAR : getCurveCode(options.mixCurve);
        if (curve === -1) {
            throw new Error(`[rig] unknown mixCurve "${options.mixCurve}" for animation "${animation.name}"`);
        }
        this.mixCurve = curve;
    }
}
/** Runs a whole frame with no game overrides: animations, then physics and world matrices. */
export function updateRig(state, seconds) {
    state.update(seconds);
    state.apply();
    state.skeleton.update(seconds);
    state.skeleton.updateWorld();
}
/** Returns the track time at which `entry` ends: its duration, or for a looping one the end of its current loop. */
function getTrackEnd(entry) {
    const duration = entry.animation.duration;
    if (duration <= 0) {
        return entry.trackTime;
    }
    if (entry.loop) {
        return duration * (Math.floor(entry.trackTime / duration) + 1);
    }
    return Math.max(duration, entry.trackTime);
}
/** Returns the animation time to show for `entry`: wrapped when looping, held at the end otherwise. */
function animationTime(entry) {
    const duration = entry.animation.duration;
    if (entry.loop) {
        return duration > 0 ? entry.trackTime % duration : 0;
    }
    return Math.min(entry.trackTime, duration);
}
/** Returns how far `entry`'s crossfade is, eased, 0 to 1. 1 when it isn't crossfading. */
function mixProgress(entry) {
    if (!entry.mixingFrom || entry.mixDuration <= 0) {
        return 1;
    }
    return applyCurve(entry.mixCurve, Math.min(1, entry.mixTime / entry.mixDuration), null, 0);
}
