import { RigData } from './rigData.js';
/**
 * Turns a rig file (parsed JSON, see rigFormat.ts) into {@link RigData}. It checks everything
 * first and reports every problem at once, each with its JSON path, so an LLM can fix a whole
 * file in one pass instead of one error per run.
 *
 * Property ids (for crossfades, see {@link AnimationData.keyed}) are laid out as: bone properties,
 * then 6 per slot (attachment, color, alpha, dark, sequence, deform), 2 per IK (mix, bend), 1 per transform, 1 per
 * physics, 2 per slider (time, mix), then draw order.
 */
/** One problem in a rig file. */
export type RigProblem = {
    /** JSON path to the bad value, e.g. `animations.walk.bones.thighL.rotate[2]`. */
    path: string;
    message: string;
};
/** Thrown by {@link compileRig} with every problem found. The message lists them, one per line. */
export declare class RigCompileError extends Error {
    readonly problems: readonly RigProblem[];
    constructor(name: string, problems: readonly RigProblem[]);
}
/**
 * An image's size in pixels. A prebuilt atlas also gives `trim`, the box its art fills (left, top,
 * right, bottom): regions and mesh grids then cover only that box.
 */
export type RigImageSize = {
    readonly width: number;
    readonly height: number;
    readonly trim?: readonly [number, number, number, number];
};
/**
 * Compiles a parsed rig file. `getImageSize` returns the size of an image by name (as the
 * browser loads it), or undefined if there is no such image.
 *
 * Throws {@link RigCompileError} listing every problem if the file is not valid.
 *
 * @example
 * const data = compileRig(await (await fetch('/rigs/hero.rig.json')).json(), name => sizes.get(name));
 */
export declare function compileRig(file: unknown, getImageSize: (image: string) => RigImageSize | undefined): RigData;
/**
 * Returns the names of every image a parsed rig file uses, before its images are loaded, so a
 * loader knows what to fetch. Throws {@link RigCompileError} if the file is not valid apart from
 * image sizes.
 */
export declare function getRigImageNames(file: unknown): readonly string[];
//# sourceMappingURL=compileRig.d.ts.map