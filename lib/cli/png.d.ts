/**
 * A small PNG reader and writer for the rig CLI's previews, so it needs no image library. Reads
 * 8-bit, non-interlaced PNGs of any color type (gray, gray+alpha, rgb, rgba, palette), which covers
 * what common image tools write. Also reads a WebP's size from its header.
 */
/** An image as straight (not premultiplied) RGBA bytes, row by row. */
export type Bitmap = {
    width: number;
    height: number;
    data: Uint8Array;
};
/** Decodes a PNG. Throws on a file it can't read, naming why. */
export declare function decodePng(file: Buffer): Bitmap;
/** Encodes an RGBA bitmap as a PNG. */
export declare function encodePng(bitmap: Bitmap): Buffer;
/** Returns a PNG's or WebP's size from its header, or null if it is neither. */
export declare function readImageSize(file: Buffer): {
    width: number;
    height: number;
} | null;
//# sourceMappingURL=png.d.ts.map