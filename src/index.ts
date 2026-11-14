/**
 * Foony Rig: 2D skeletal animation for the web. Rigs are JSON files (see rigFormat.ts for the
 * format), loaded with `loadRig` or `loadRigs`, posed with `Skeleton` and `AnimationState`, and
 * drawn on a 2D canvas with `drawSkeleton`.
 */
export {AnimationState, TrackEntry, updateRig} from './animationState.js';
export type {PlayOptions} from './animationState.js';
export {drawImageTriangles, drawSkeleton} from './canvasRenderer.js';
export type {RigDebugOptions} from './canvasRenderer.js';
export type {RigImage, RigImages} from './imageAtlas.js';
export {loadRig, loadRigs} from './loadRig.js';
export type {LoadedRig, LoadRigsOptions} from './loadRig.js';
export {BONE_ROTATION, BONE_SCALE_X, BONE_STRIDE, BONE_X, BONE_Y} from './rigData.js';
export type {AnimationData, EventKey, RigData} from './rigData.js';
export {Skeleton} from './skeleton.js';
