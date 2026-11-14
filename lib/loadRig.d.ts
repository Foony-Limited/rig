import { RigImages } from './imageAtlas.js';
import type { RigData } from './rigData.js';
/** A rig ready to draw: its compiled data and its loaded images. */
export type LoadedRig = {
    readonly data: RigData;
    /** The rig's images, packed into an atlas with baked tints. */
    readonly images: RigImages;
};
/**
 * Loads a rig and its images in the browser and compiles it. `source` is a URL to a
 * `*.rig.json`, or the parsed file (e.g. imported with `import hero from './hero.rig.json'`).
 * Images load from `/<images>/<name>.webp` on the page's origin, or with the rig's `atlas` set, from its prebuilt
 * atlas pages (see RigAtlasFile). A URL is loaded once per page and shared.
 *
 * Resolves with the rig. Rejects with a {@link RigCompileError} if the file is not valid, or an
 * Error naming the image that failed to load.
 *
 * @example
 * const hero = await loadRig('/rigs/hero.rig.json');
 * const skeleton = new Skeleton(hero.data);
 */
export declare function loadRig(source: string | object): Promise<LoadedRig>;
/** Options for {@link loadRigs}. */
export type LoadRigsOptions = {
    /**
     * Size the atlas stores each image at, as a share of its file's size. Store images no larger
     * than they are drawn: Chrome's 2D canvas draws about twice as slowly once its atlas pages pass
     * about 32 MB, and a cast of 8 detailed characters can be about 150 MB at full size. The rig's sizes and
     * anchors stay in the files' pixels. A prebuilt atlas keeps its pages' size.
     * @defaultValue 1
     */
    scale?: number;
};
/**
 * Loads several parsed rig files (see {@link loadRig}) and packs all their images into shared atlas
 * pages. A 2D canvas pays a setup cost for each distinct page it draws from in a frame, so a cast
 * drawn together should load together: 8 characters draw from 2 pages instead of 8.
 *
 * Resolves with the rigs in the order given. Rejects as {@link loadRig} does.
 *
 * @example
 * // Drawn at about a third of their painted size, so store them at half.
 * const cast = await loadRigs(characterFiles, {scale: 0.5});
 */
export declare function loadRigs(files: readonly object[], options?: LoadRigsOptions): Promise<LoadedRig[]>;
/**
 * A prebuilt atlas, as `foony-rig atlas` writes it next to a rig's images: its page images,
 * and per image name its place on a page (the trimmed art's box, in page pixels), the box its art
 * fills in the image (`trim`: left, top, right, bottom), and the image's full size.
 */
export type RigAtlasFile = {
    format: 'foony-rig-atlas@1';
    pages: string[];
    images: {
        [image: string]: {
            page: number;
            x: number;
            y: number;
            width: number;
            height: number;
            trim: [number, number, number, number];
            size: [number, number];
        };
    };
};
//# sourceMappingURL=loadRig.d.ts.map