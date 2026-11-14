/**
 * Packs a rig's images into one atlas page (or a few), so a renderer draws from one source per rig.
 * A 2D canvas in Chrome pays a setup cost the first time each distinct image is drawn in a frame
 * (about 3 us for an image, 6 us for a bitmap), on top of about 1 us per draw: a character with 10
 * images and tinted copies spent most of its draw time on that. The loader also bakes in the tinted
 * copies a rig's setup needs, so nothing is made while drawing.
 */
/** One image in an atlas: its page, and where it sits on the page in page pixels. */
export type RigImage = {
    readonly source: CanvasImageSource;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
};
/**
 * A rig's images by name, as {@link loadRig} returns them. Besides the rig's own image names it
 * holds baked tinted copies ({@link getTintedName}).
 */
export type RigImages = ReadonlyMap<string, RigImage>;
/**
 * Returns `image` turned into its dark-tint layer for tint key `darkKey`: each pixel is (1 - its
 * color) times the dark tint, with the image's own alpha. Drawn over the tinted image with
 * "lighter", it adds the dark tint where the art is dark: the canvas form of a two-color tint.
 */
export declare function makeDarkLayer(image: RigImage, darkKey: number): HTMLCanvasElement | OffscreenCanvas;
/** The tint key of black: no dark tint. */
export declare const BLACK_KEY = 0;
/** Returns a tint's cache key: each channel rounded to 32 steps. */
export declare function getTintKey(red: number, green: number, blue: number): number;
/** Returns the name a tinted copy of `image` is stored under, or `image` itself for no tint. */
export declare function getTintedName(image: string, tintKey: number): string;
/** The tint key of no tint. */
export declare const WHITE_KEY: number;
/** Returns a new canvas of the given size, offscreen when the browser has OffscreenCanvas. */
export declare function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
/** Returns `image` copied with its rgb multiplied by the tint whose key is `tintKey`. */
export declare function makeTinted(image: RigImage, tintKey: number): HTMLCanvasElement | OffscreenCanvas;
/** One image to pack. */
export type AtlasEntry = {
    readonly name: string;
    /** Entries of one group (one rig) pack next to each other, so a rig draws from as few pages as it can. @defaultValue 0 */
    readonly group?: number;
    readonly source: CanvasImageSource;
    readonly width: number;
    readonly height: number;
};
/**
 * Packs `entries` into atlas pages group by group, tallest first in rows (shelf packing), and
 * returns where each one landed. Each image is stored at `scale` times its size. Pages become
 * bitmaps where the browser can make them synchronously.
 */
export declare function packAtlas(entries: readonly AtlasEntry[], scale?: number): Map<string, RigImage>;
//# sourceMappingURL=imageAtlas.d.ts.map