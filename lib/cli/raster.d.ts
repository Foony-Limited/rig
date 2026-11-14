import type { Bitmap } from './png.js';
/**
 * A tiny software renderer for the rig CLI's preview sheets, so an LLM can see an animation
 * without a browser. It draws textured parallelograms (regions) and triangles (meshes) with
 * bilinear sampling, tint, the four blend modes, and polygon clipping, plus lines, dots, and a
 * 3x5 pixel font for labels. It favors short code over speed: a sheet takes well under a second.
 */
/** A texture plus how its pixels relate to the rig's declared image size. */
export type Texture = {
    bitmap: Bitmap;
    /** Bitmap pixels per declared image pixel (the PNG can be a smaller copy of the WebP). */
    scaleX: number;
    scaleY: number;
};
/** A clip polygon in canvas pixels, x then y. */
export type RasterClip = {
    points: Float64Array;
    inverse: boolean;
};
/** Blend modes, as the rig compiles them. */
export type RasterBlend = 'source-over' | 'lighter' | 'multiply' | 'screen';
export declare class Raster {
    readonly width: number;
    readonly height: number;
    /** Premultiplied RGBA, 0 to 1. */
    private readonly pixels;
    constructor(width: number, height: number, background: [number, number, number]);
    /**
     * Draws the `crop` rectangle (left, top, right, bottom, image pixels) of a texture through matrix
     * `m` (image pixels to canvas pixels, canvas order), with tint `color` (r, g, b, a, then an
     * optional dark tint r, g, b, all 0 to 1), limited to the sheet rectangle `bounds` (left, top,
     * right, bottom). See the rig's slot `dark` for the dark tint.
     */
    drawImage(texture: Texture, m: ArrayLike<number>, crop: readonly [number, number, number, number], color: ArrayLike<number>, blend: RasterBlend, clip: RasterClip | null, bounds: [number, number, number, number]): void;
    /** Draws one textured triangle: canvas corners (x, y) with image corners (u, v), 3 of each. */
    drawTriangle(texture: Texture, xy: ArrayLike<number>, uv: ArrayLike<number>, color: ArrayLike<number>, blend: RasterBlend, clip: RasterClip | null, bounds: [number, number, number, number]): void;
    /** Returns pixel (x, y) as premultiplied r, g, b, a, 0 to 1. */
    getPixel(x: number, y: number): Float32Array;
    /** Draws a line, `thickness` pixels wide. */
    drawLine(x0: number, y0: number, x1: number, y1: number, thickness: number, color: [number, number, number, number]): void;
    /** Fills a round dot. */
    fillDot(cx: number, cy: number, radius: number, color: [number, number, number, number]): void;
    /** Writes digits, '.', '-', and lowercase letters in a 3x5 pixel font, `scale` pixels per dot. */
    drawText(text: string, x: number, y: number, scale: number, color: [number, number, number, number]): void;
    /** Returns the image as straight RGBA bytes. */
    toBitmap(): Bitmap;
    private blendColor;
    /** Samples the texture at image pixel (u, v), tints it, and blends it onto pixel (x, y). */
    private blendPixel;
}
//# sourceMappingURL=raster.d.ts.map