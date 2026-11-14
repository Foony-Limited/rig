import { RigImages } from './imageAtlas.js';
import type { Skeleton } from './skeleton.js';
/**
 * Draws skeletons with WebGL. Prefer it over {@link drawSkeleton} when rigs have meshes: a 2D canvas
 * can only draw a textured triangle through a clip (about 6 us each in Chrome), while the GPU draws
 * thousands of triangles in one call. Tints are vertex colors, so they cost nothing and need no
 * tinted image copies. Clipping uses the stencil buffer.
 *
 * Every vertex is moved to canvas pixels on the CPU, so all skeletons share one projection and
 * consecutive parts using the same image and blend mode go out in one draw call. A 2D canvas game
 * can draw this canvas onto its own with `drawImage` once a frame.
 *
 * @example
 * const renderer = new RigWebGlRenderer(canvas);
 * renderer.begin();
 * renderer.draw(skeleton, rig.images);
 * renderer.end();
 */
export declare class RigWebGlRenderer {
    private readonly gl;
    private readonly canMipmap;
    private readonly program;
    private readonly buffer;
    private readonly indexBuffer;
    private readonly projection;
    private readonly textures;
    /** x, y, u, v, r, g, b, a per vertex, for the batch being built. */
    private vertices;
    private vertexCount;
    /** Each triangle's three vertices, as indexes into {@link RigWebGlRenderer.vertices}, for the batch being built. A mesh corner is shared by up to six triangles, so it is written once. */
    private indices;
    private indexCount;
    private batchTexture;
    private batchBlend;
    private transform;
    private meshScratch;
    private readonly matrix;
    /** The dark tint of the slot being added, r, g, b. */
    private readonly dark;
    /** Throws if the browser can't make a WebGL context on `canvas`. */
    constructor(canvas: HTMLCanvasElement | OffscreenCanvas);
    /**
     * Starts a frame: sizes the viewport to the canvas, clears it to transparent, and sets the
     * transform from canvas-space units to canvas pixels, in canvas order `[a, b, c, d, e, f]` (as a
     * 2D context's `setTransform` takes it, e.g. `[2, 0, 0, 2, 0, 0]` for a 2x pixel ratio).
     */
    begin(transform?: readonly number[]): void;
    /** Draws `skeleton` with its images. Images that haven't loaded are skipped. Call between {@link RigWebGlRenderer.begin} and {@link RigWebGlRenderer.end}. */
    draw(skeleton: Skeleton, images: RigImages): void;
    /** Draws what is still batched. Call once after the frame's last {@link RigWebGlRenderer.draw}. */
    end(): void;
    private setBlend;
    private getTexture;
    /** Makes room for `vertexCount` more vertices and `indexCount` more indexes in the batch, drawing it first if 16-bit indexes would run out. */
    private reserve;
    private pushVertex;
    private addRegion;
    private addMesh;
    private flush;
    /**
     * Marks the clip polygon in the stencil buffer. Drawing it as a triangle fan with INVERT flips each
     * pixel once per triangle that covers it, so pixels inside any simple polygon (convex or not) end
     * up odd (1) and the rest even (0).
     */
    private startClip;
    private endClip;
}
//# sourceMappingURL=webglRenderer.d.ts.map