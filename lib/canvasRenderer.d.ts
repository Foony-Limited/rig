import { RigImages } from './imageAtlas.js';
import { MeshAttachment } from './rigData.js';
import type { Skeleton } from './skeleton.js';
/**
 * Draws skeletons on a 2D canvas. Every draw is one `setTransform` and one `drawImage` from the
 * rig's atlas:
 * - A region is one draw.
 * - A mesh draws as image strips across its grid rows (see planMeshStrips): a run of rows that
 *   moves rigidly is one draw. A row bent too far for one flat transform (a sharp knee) draws as
 *   its own triangles, each clipped, so it bends exactly as the GPU would.
 * The atlas holds baked tinted copies, so nothing is made while drawing. A tint
 * an animation keys is made once per (image, tint), each channel rounded to 32 steps. Clipping
 * uses the canvas's own clip path.
 *
 * It never copies a WebGL picture in: in a busy game canvas each copy waits for the GPU to finish
 * all the canvas's earlier drawing (about 10 ms a copy in one game, which held four characters to 15 fps).
 * A page that owns a WebGL canvas can draw with {@link RigWebGlRenderer} itself.
 */
/** Extra things to draw over the skeleton, for checking a rig. */
export type RigDebugOptions = {
    /** If true, draws each bone as a line from origin to tip, with a dot at the origin. @defaultValue false */
    bones?: boolean;
    /** If true, outlines box attachments and marks point attachments. @defaultValue false */
    boxes?: boolean;
};
/** One skeleton for {@link drawSkeletons} to draw, with its images. */
export type RigDraw = {
    readonly skeleton: Skeleton;
    readonly images: RigImages;
};
/**
 * Draws `skeleton` on `context` with its images, under whatever transform the context has.
 * Images that haven't loaded are skipped. Call after {@link Skeleton.updateWorld}.
 *
 * @example
 * context.setTransform(1, 0, 0, 1, 0, 0);
 * drawSkeleton(context, skeleton, rig.images);
 */
export declare function drawSkeleton(context: CanvasRenderingContext2D, skeleton: Skeleton, images: RigImages, debug?: RigDebugOptions): void;
/**
 * Draws `draws` on `context` in order, under whatever transform the context has, as
 * {@link drawSkeleton} does.
 *
 * @example
 * drawSkeletons(context, characters.map(character => ({skeleton: character.skeleton, images: character.rig.images})));
 */
export declare function drawSkeletons(context: CanvasRenderingContext2D, draws: readonly RigDraw[], debug?: RigDebugOptions): void;
/**
 * Draws the debug lines `debug` asks for over `skeleton` on `context`, under whatever transform
 * the context has. {@link drawSkeleton} calls it. Call it yourself to draw a skeleton's lines over
 * one drawn by {@link RigWebGlRenderer}.
 */
export declare function drawSkeletonDebug(context: CanvasRenderingContext2D, skeleton: Skeleton, debug: RigDebugOptions): void;
/**
 * Draws a picture bent onto a triangle mesh, one triangle at a time: each clipped to its corners,
 * pushed out TRIANGLE_GROW so neighbors leave no seam, with the transform that maps its picture
 * corners onto them. The picture is `source`'s `sx`, `sy`, `sw`, `sh` rectangle, stretched over
 * `width` by `height` mesh units: `uvs` are each vertex's place on it in those units, `vertices`
 * its place on the canvas in pixels (with the context's transform ignored), and `triangles` 3
 * vertex indexes a triangle, drawn from index `from` to `to`.
 *
 * A whole loaded picture (a painted swoosh, not a piece of an atlas page) fills each triangle with a
 * pattern of itself instead: about 1.5 times as fast in Chrome as a clip and a drawImage, and the
 * same to the eye. An atlas piece keeps the clip, which never shows its neighbors on the page.
 */
export declare function drawImageTriangles(context: CanvasRenderingContext2D, source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, width: number, height: number, uvs: ArrayLike<number>, triangles: ArrayLike<number>, vertices: ArrayLike<number>, from?: number, to?: number): void;
/**
 * Floats per planned strip in {@link planMeshStrips}' plan: its transform (canvas order), the image
 * rows it draws (top and bottom), then the grid row to draw as exact triangles instead, or -1.
 */
export declare const MESH_STRIP_FLOATS = 9;
/**
 * Plans how to draw a grid mesh as image strips (see {@link drawMesh}): writes each strip's
 * transform from mesh image units to canvas pixels and its image rows into `out`, which grows if
 * needed, and returns how many strips there are. A single row bent too far for one transform is
 * planned as its grid row, to draw as triangles. `vertices` are the mesh's corners in canvas pixels.
 */
export declare function planMeshStrips(mesh: MeshAttachment, vertices: Float32Array | Float64Array, out: Float64Array): number;
//# sourceMappingURL=canvasRenderer.d.ts.map