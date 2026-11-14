import { AnimationData, EventKey } from './rigData.js';
import type { Skeleton } from './skeleton.js';
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
export declare class AnimationState {
    readonly skeleton: Skeleton;
    /** Playback speed of every track. 0 pauses. @defaultValue 1 */
    timeScale: number;
    /** Called when an entry starts playing (set, or its queue turn comes). */
    onStart: ((entry: TrackEntry) => void) | null;
    /** Called when another entry replaces a playing one. It may still be fading out. Cancel its hitboxes here. */
    onInterrupt: ((entry: TrackEntry) => void) | null;
    /** Called when an entry stops being applied for good: its fade out ended, it was replaced with no fade, or its track was cleared. */
    onEnd: ((entry: TrackEntry) => void) | null;
    /**
     * Called for each event key an animation passes. An entry fading out under the entry queued
     * after it keeps firing its events and completion until its fade ends. One replaced by
     * setAnimation or setEmpty stops firing them at once.
     */
    onEvent: ((event: EventKey, entry: TrackEntry) => void) | null;
    /** Called each time an animation reaches its end (every pass when looping). */
    onComplete: ((entry: TrackEntry) => void) | null;
    /** The playing entry per track, or null. */
    readonly tracks: (TrackEntry | null)[];
    private readonly empty;
    private readonly animationIndex;
    /** The skeleton's live values, with the local pose as the bones. */
    private readonly live;
    /** The values under a track (lower tracks over setup), copied before a crossfade chain applies. */
    private readonly under;
    /** Per property: 1 once a crossfade step has faded it back this frame. */
    private readonly done;
    /** Scratch: a track's crossfade chain, oldest entry first. */
    private readonly chain;
    /** Listener calls waiting for the current call to finish. */
    private readonly pending;
    private isDraining;
    constructor(skeleton: Skeleton);
    /**
     * Plays animation `name` on `track` now, crossfading from what was playing, and drops anything
     * queued there. Returns the new entry. Throws on an unknown animation name.
     */
    setAnimation(track: number, name: string, options?: PlayOptions): TrackEntry;
    /**
     * Queues animation `name` on `track` after the last queued (or playing) entry. Without a
     * delay it starts so its crossfade ends as the one before it ends (for a looping one, as its
     * current loop ends). On an empty track it plays at once, or after `delay` seconds.
     * Returns the new entry. Throws on an unknown animation name.
     */
    addAnimation(track: number, name: string, options?: PlayOptions & {
        delay?: number;
    }): TrackEntry;
    /** Fades `track` out to what is under it over `mix` seconds. @defaultValue mix: the rig's default mix */
    setEmpty(track: number, mix?: number): TrackEntry;
    /** Queues a fade-out of `track`, like {@link AnimationState.addAnimation}. */
    addEmpty(track: number, mix?: number, delay?: number): TrackEntry;
    /** Stops `track` at once, with no fade. */
    clearTrack(track: number): void;
    /** Stops every track at once. */
    clearTracks(): void;
    /**
     * Advances every track by `seconds`: moves time, ends finished crossfades, starts queued
     * entries, and calls the event and complete listeners for what was passed. A queued entry starts
     * on the update after the one before it reaches its start, so with no crossfade the old
     * animation's last frame still shows once.
     */
    update(seconds: number): void;
    /**
     * Resets the skeleton's local pose to setup, then writes every track into it. Game overrides
     * (bone positions, slider times, attachments) go after this and before
     * {@link Skeleton.updateWorld}.
     */
    apply(): void;
    private findAnimation;
    private start;
    private queue;
    /** Makes `entry` the playing entry on `track`, crossfading from `from` if there is one. */
    private begin;
    /** Reports the end of `entry` and of every entry it was still fading from. */
    private endChain;
    /** Queues a listener call for {@link AnimationState.drain}. */
    private notify;
    /** Calls the queued listeners, including any a listener queues. A nested call leaves them to the outer one. */
    private drain;
    private getMix;
    private updateMixingFrom;
    /**
     * Applies `entry` and the entries it is crossfading from, oldest first. Each newer entry moves
     * the pose by its crossfade progress: the values it keys toward its own, and the values only
     * older entries key back toward what is under the track. An additive entry fades by its
     * progress times what the newer entries have left of theirs.
     */
    private applyChain;
    /**
     * Fires event keys and physics resets in (before, after] of `entry`'s track time, and
     * completes at each loop end. A loop's keys at time 0 fire at the start of every pass. One
     * update passes at most one loop end, so a long stall (a tab back from the background) doesn't
     * replay every loop it skipped. An animation with no length fires its keys and completes on its
     * first update (and completes every update when looping).
     */
    private passKeys;
    private passKeysBetween;
    private complete;
}
/** How to play an animation. */
export type PlayOptions = {
    /** If true (the default), it repeats. If false, it holds its last frame. */
    loop?: boolean;
    /** Crossfade seconds from what was playing. @defaultValue the rig's `mixes` entry, else its `defaultMix` */
    mix?: number;
    /** Easing of the crossfade, a curve name like `"sine"`. @defaultValue 'linear' */
    mixCurve?: string;
    /** If true, adds to the tracks below instead of replacing what it keys. @defaultValue false */
    additive?: boolean;
    /** How strongly it applies, 0 to 1. @defaultValue 1 */
    alpha?: number;
    /** Speed. 2 plays twice as fast. @defaultValue 1 */
    timeScale?: number;
    /**
     * Share of the crossfade after which the outgoing animations' attachments, draw order, and IK
     * bends give way to what is under them. 0 swaps them at once, so a slash effect doesn't linger.
     * @defaultValue 0
     */
    attachmentThreshold?: number;
};
/** One animation playing (or queued) on a track. Change its fields to adjust it while it plays. */
export declare class TrackEntry {
    readonly track: number;
    readonly animation: AnimationData;
    loop: boolean;
    additive: boolean;
    alpha: number;
    timeScale: number;
    /** Seconds played, times its speed. Set it to seek. */
    trackTime: number;
    /** For a queued entry: the previous entry's track time at which this one starts. */
    delay: number;
    /** Seconds into the crossfade from {@link TrackEntry.mixingFrom}. */
    mixTime: number;
    /** Crossfade length in seconds. */
    mixDuration: number;
    /** The entry this one is crossfading from, or null. */
    mixingFrom: TrackEntry | null;
    /**
     * The entry queued after this one, or null. It stays set while that entry fades in over this
     * one, and is cleared when setAnimation or setEmpty replaces the track.
     */
    next: TrackEntry | null;
    /** Called when this entry starts playing. */
    onStart: ((entry: TrackEntry) => void) | null;
    /** Called when another entry replaces this one. It may still be fading out. */
    onInterrupt: ((entry: TrackEntry) => void) | null;
    /** Called when this entry stops being applied for good. */
    onEnd: ((entry: TrackEntry) => void) | null;
    /** Called for each event key this entry passes. */
    onEvent: ((event: EventKey, entry: TrackEntry) => void) | null;
    /** Called each time this entry reaches its end. */
    onComplete: ((entry: TrackEntry) => void) | null;
    /** See {@link PlayOptions.attachmentThreshold}. */
    attachmentThreshold: number;
    readonly mixOverride: number | undefined;
    readonly mixCurve: number;
    /** Per property, the way each rotation turned last frame of this entry's crossfade. */
    rotationMemory: Float64Array | null;
    constructor(track: number, animation: AnimationData, options: PlayOptions);
}
/** Runs a whole frame with no game overrides: animations, then physics and world matrices. */
export declare function updateRig(state: AnimationState, seconds: number): void;
//# sourceMappingURL=animationState.d.ts.map