import {DEG_RAD} from './boneMath.js';
import {BLACK_KEY, getTintedName, getTintKey, makeDarkLayer, makeTinted, RigImage, RigImages, WHITE_KEY} from './imageAtlas.js';
import {Attachment, getChainU, MeshAttachment, RegionAttachment, WORLD_STRIDE} from './rigData.js';
import type {Skeleton} from './skeleton.js';
import {RigWebGlRenderer} from './webglRenderer.js';

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

const BLEND_RESET = 'source-over';
/** Tints made while drawing, kept per image before the oldest are dropped. */
const MAX_TINTS_PER_IMAGE = 32;
/** How far a run of mesh rows may miss where its rows are near the spine, in canvas pixels, and still draw as one strip. */
const STRIP_TOLERANCE = 1;
/** How far each mesh strip reaches into its neighbors, in canvas pixels, to hide seams. */
const STRIP_OVERLAP = 1;
/** How far each clipped mesh triangle is pushed out past its corners, in canvas pixels, to hide seams. */
const TRIANGLE_GROW = 1;

const dynamicTints = new WeakMap<RigImage, Map<number, RigImage>>();
const darkLayers = new WeakMap<RigImage, Map<number, RigImage>>();
const imageMemos = new WeakMap<Attachment, {images: RigImages; frame: number; tintKey: number; image: RigImage | undefined}>();
let meshScratch = new Float32Array(256);
const matrix = new Float64Array(6);

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
export function drawSkeleton(context: CanvasRenderingContext2D, skeleton: Skeleton, images: RigImages, debug?: RigDebugOptions) {
  drawSkeletons(context, [{skeleton, images}], debug);
}

/**
 * Draws `draws` on `context` in order, under whatever transform the context has, as
 * {@link drawSkeleton} does.
 *
 * @example
 * drawSkeletons(context, characters.map(character => ({skeleton: character.skeleton, images: character.rig.images})));
 */
export function drawSkeletons(context: CanvasRenderingContext2D, draws: readonly RigDraw[], debug?: RigDebugOptions) {
  for (const {skeleton, images} of draws) {
    drawSkeleton2d(context, skeleton, images);
  }
  if (debug) {
    for (const {skeleton} of draws) {
      drawSkeletonDebug(context, skeleton, debug);
    }
  }
}

/** Draws `skeleton` on `context` with the 2D canvas itself (see the file comment). */
function drawSkeleton2d(context: CanvasRenderingContext2D, skeleton: Skeleton, images: RigImages) {
  const base = context.getTransform();
  // The base transform times the skeleton's placement (y flipped: skeleton space is y-up).
  const viewA = base.a * skeleton.scaleX;
  const viewB = base.b * skeleton.scaleX;
  const viewC = -base.c * skeleton.scaleY;
  const viewD = -base.d * skeleton.scaleY;
  const viewE = base.a * skeleton.x + base.c * skeleton.y + base.e;
  const viewF = base.b * skeleton.x + base.d * skeleton.y + base.f;
  const data = skeleton.data;
  const colors = skeleton.slotColors;
  const darks = skeleton.slotDarks;
  const startAlpha = context.globalAlpha;
  let clipEnd = -1;
  let blend: GlobalCompositeOperation = BLEND_RESET;
  let lastAlpha = startAlpha;

  for (let i = 0; i < skeleton.drawOrder.length; i++) {
    const slot = skeleton.drawOrder[i];
    const attachment = skeleton.getAttachment(slot);
    if (attachment?.kind === 'clip' && clipEnd === -1) {
      context.save();
      setBoneTransform(context, skeleton, data.slots[slot].bone, viewA, viewB, viewC, viewD, viewE, viewF);
      context.beginPath();
      tracePolygon(context, attachment.points);
      if (attachment.inverse) {
        // A huge rectangle around the polygon: with even-odd filling the polygon becomes a hole.
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.rect(-1e5, -1e5, 2e5, 2e5);
        context.clip('evenodd');
      } else {
        context.clip();
      }
      clipEnd = attachment.endSlot;
    } else if (attachment?.kind === 'region' || attachment?.kind === 'mesh') {
      const color = attachment.color;
      const alpha = startAlpha * skeleton.alpha * colors[slot * 4 + 3] * color[3];
      const frame = skeleton.getFrame(slot, attachment);
      const tintKey = getTintKey(colors[slot * 4] * color[0], colors[slot * 4 + 1] * color[1], colors[slot * 4 + 2] * color[2]);
      const image = getImage(images, attachment, frame, tintKey);
      if (alpha > 0 && image) {
        const slotBlend = data.slots[slot].blend;
        if (slotBlend !== blend) {
          blend = slotBlend;
          context.globalCompositeOperation = blend;
        }
        if (alpha !== lastAlpha) {
          lastAlpha = alpha;
          context.globalAlpha = alpha;
        }
        if (attachment.kind === 'region') {
          drawRegion(context, skeleton, slot, attachment, image, viewA, viewB, viewC, viewD, viewE, viewF);
        } else {
          drawMesh(context, skeleton, slot, attachment, image, viewA, viewB, viewC, viewD, viewE, viewF);
        }
        // A dark tint (a hit flash) adds a second layer: the art's dark parts in the dark color.
        const darkKey = getTintKey(darks[slot * 3], darks[slot * 3 + 1], darks[slot * 3 + 2]);
        const plain = darkKey === BLACK_KEY ? undefined : findImage(images, attachment.images[frame], WHITE_KEY);
        if (plain) {
          const layer = findDarkLayer(plain, darkKey);
          context.globalCompositeOperation = 'lighter';
          if (attachment.kind === 'region') {
            drawRegion(context, skeleton, slot, attachment, layer, viewA, viewB, viewC, viewD, viewE, viewF);
          } else {
            drawMesh(context, skeleton, slot, attachment, layer, viewA, viewB, viewC, viewD, viewE, viewF);
          }
          context.globalCompositeOperation = blend;
        }
      }
    }
    if (slot === clipEnd) {
      context.restore();
      clipEnd = -1;
      blend = context.globalCompositeOperation;
      lastAlpha = context.globalAlpha;
    }
  }
  if (clipEnd !== -1) {
    context.restore();
  }
  context.globalCompositeOperation = BLEND_RESET;
  context.globalAlpha = startAlpha;
  context.setTransform(base);
}

/**
 * Draws the debug lines `debug` asks for over `skeleton` on `context`, under whatever transform
 * the context has. {@link drawSkeleton} calls it. Call it yourself to draw a skeleton's lines over
 * one drawn by {@link RigWebGlRenderer}.
 */
export function drawSkeletonDebug(context: CanvasRenderingContext2D, skeleton: Skeleton, debug: RigDebugOptions) {
  if (!debug.bones && !debug.boxes) {
    return;
  }
  const base = context.getTransform();
  drawDebug(
    context,
    skeleton,
    debug,
    base.a * skeleton.scaleX,
    base.b * skeleton.scaleX,
    -base.c * skeleton.scaleY,
    -base.d * skeleton.scaleY,
    base.a * skeleton.x + base.c * skeleton.y + base.e,
    base.b * skeleton.x + base.d * skeleton.y + base.f,
  );
  context.setTransform(base);
}

/**
 * Returns `attachment`'s image `frame` in tint `tintKey`: the atlas's baked copy, or one made now
 * and kept (a tint an animation keys). Undefined if the image isn't loaded. Remembers the last
 * answer per attachment, so a steady frame builds no lookup strings.
 */
function getImage(images: RigImages, attachment: Attachment, frame: number, tintKey: number): RigImage | undefined {
  const memo = imageMemos.get(attachment);
  if (memo && memo.images === images && memo.frame === frame && memo.tintKey === tintKey) {
    return memo.image;
  }
  const image = findImage(images, (attachment as RegionAttachment | MeshAttachment).images[frame], tintKey);
  imageMemos.set(attachment, {images, frame, tintKey, image});
  return image;
}

function findImage(images: RigImages, name: string, tintKey: number): RigImage | undefined {
  const baked = images.get(getTintedName(name, tintKey));
  if (baked || tintKey === WHITE_KEY) {
    return baked;
  }
  const plain = images.get(name);
  if (!plain) {
    return undefined;
  }
  let tints = dynamicTints.get(plain);
  if (!tints) {
    tints = new Map();
    dynamicTints.set(plain, tints);
  }
  let tinted = tints.get(tintKey);
  if (!tinted) {
    if (tints.size >= MAX_TINTS_PER_IMAGE) {
      tints.delete(tints.keys().next().value!);
    }
    const canvas = makeTinted(plain, tintKey);
    tinted = {source: canvas, x: 0, y: 0, width: canvas.width, height: canvas.height};
    tints.set(tintKey, tinted);
  }
  return tinted;
}

/** Returns `image`'s dark-tint layer for `darkKey` (see makeDarkLayer), made once and kept. */
function findDarkLayer(image: RigImage, darkKey: number): RigImage {
  let layers = darkLayers.get(image);
  if (!layers) {
    layers = new Map();
    darkLayers.set(image, layers);
  }
  let layer = layers.get(darkKey);
  if (!layer) {
    if (layers.size >= MAX_TINTS_PER_IMAGE) {
      layers.delete(layers.keys().next().value!);
    }
    const canvas = makeDarkLayer(image, darkKey);
    layer = {source: canvas, x: 0, y: 0, width: canvas.width, height: canvas.height};
    layers.set(darkKey, layer);
  }
  return layer;
}

function setBoneTransform(context: CanvasRenderingContext2D, skeleton: Skeleton, bone: number, a: number, b: number, c: number, d: number, e: number, f: number) {
  const w = bone * WORLD_STRIDE;
  const world = skeleton.world;
  context.setTransform(
    a * world[w] + c * world[w + 1],
    b * world[w] + d * world[w + 1],
    a * world[w + 2] + c * world[w + 3],
    b * world[w + 2] + d * world[w + 3],
    a * world[w + 4] + c * world[w + 5] + e,
    b * world[w + 4] + d * world[w + 5] + f,
  );
}

function tracePolygon(context: CanvasRenderingContext2D, points: Float64Array) {
  context.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) {
    context.lineTo(points[i], points[i + 1]);
  }
  context.closePath();
}

function drawRegion(context: CanvasRenderingContext2D, skeleton: Skeleton, slot: number, region: RegionAttachment, image: RigImage, a: number, b: number, c: number, d: number, e: number, f: number) {
  skeleton.getRegionMatrix(slot, region, matrix);
  context.setTransform(
    a * matrix[0] + c * matrix[1],
    b * matrix[0] + d * matrix[1],
    a * matrix[2] + c * matrix[3],
    b * matrix[2] + d * matrix[3],
    a * matrix[4] + c * matrix[5] + e,
    b * matrix[4] + d * matrix[5] + f,
  );
  const [left, top, right, bottom] = region.crop;
  // The atlas holds the image at its loaded size, which may differ from the size the rig declared.
  const scaleX = image.width / region.width;
  const scaleY = image.height / region.height;
  context.drawImage(image.source, image.x + left * scaleX, image.y + top * scaleY, (right - left) * scaleX, (bottom - top) * scaleY, left, top, right - left, bottom - top);
}

/**
 * Draws a grid mesh as image strips, with no clipping.
 * A run of rows that moves rigidly maps to the canvas as one transformed image strip, and a bent row
 * is one strip too. Every strip reaches into its neighbors, further the more it turns from them, so
 * no gap opens on the outside of a bend.
 */
function drawMesh(context: CanvasRenderingContext2D, skeleton: Skeleton, slot: number, mesh: MeshAttachment, image: RigImage, a: number, b: number, c: number, d: number, e: number, f: number) {
  if (meshScratch.length < mesh.vertexCount * 2) {
    meshScratch = new Float32Array(mesh.vertexCount * 4);
  }
  const vertices = meshScratch;
  skeleton.computeMeshVertices(mesh, vertices, slot);
  for (let i = 0; i < mesh.vertexCount * 2; i += 2) {
    const x = vertices[i];
    const y = vertices[i + 1];
    vertices[i] = a * x + c * y + e;
    vertices[i + 1] = b * x + d * y + f;
  }
  if (mesh.columns === 0) {
    drawMeshTriangles(context, mesh, image, vertices, 0, mesh.triangles.length);
    return;
  }
  const count = planMeshStrips(mesh, vertices, stripPlan);
  const scaleX = image.width / mesh.width;
  const scaleY = image.height / mesh.height;
  // Only the grid's columns: a trimmed image's neighbors on its atlas page lie outside them.
  const gridWidth = mesh.right - mesh.left;
  for (let i = 0; i < count; i++) {
    const p = i * MESH_STRIP_FLOATS;
    const exactRow = stripPlan[p + 8];
    if (exactRow >= 0) {
      drawMeshTriangles(context, mesh, image, vertices, exactRow * mesh.columns * 6, (exactRow + 1) * mesh.columns * 6);
      continue;
    }
    context.setTransform(stripPlan[p], stripPlan[p + 1], stripPlan[p + 2], stripPlan[p + 3], stripPlan[p + 4], stripPlan[p + 5]);
    const top = stripPlan[p + 6];
    const bottom = stripPlan[p + 7];
    context.drawImage(image.source, image.x + mesh.left * scaleX, image.y + top * scaleY, gridWidth * scaleX, (bottom - top) * scaleY, mesh.left, top, gridWidth, bottom - top);
  }
}

/**
 * Draws a mesh's triangles from index `from` to `to` (in `mesh.triangles`, 3 a triangle) one at a
 * time (see {@link drawImageTriangles}). About 6 us a triangle in Chrome, so it draws hand-placed
 * meshes (no grid rows to cut into strips) and a grid's sharply bent rows only.
 */
function drawMeshTriangles(context: CanvasRenderingContext2D, mesh: MeshAttachment, image: RigImage, vertices: Float32Array, from: number, to: number) {
  drawImageTriangles(context, image.source, image.x, image.y, image.width, image.height, mesh.width, mesh.height, mesh.uvs, mesh.triangles, vertices, from, to);
}

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
export function drawImageTriangles(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  width: number,
  height: number,
  uvs: ArrayLike<number>,
  triangles: ArrayLike<number>,
  vertices: ArrayLike<number>,
  from = 0,
  to = triangles.length,
) {
  const pattern = typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement && sx === 0 && sy === 0 && sw === source.naturalWidth && sh === source.naturalHeight ? patternOf(context, source) : null;
  if (pattern) {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = pattern;
  }
  for (let t = from; t < to; t += 3) {
    const i0 = triangles[t]! * 2;
    const i1 = triangles[t + 1]! * 2;
    const i2 = triangles[t + 2]! * 2;
    const x0 = vertices[i0]!;
    const y0 = vertices[i0 + 1]!;
    const u0 = uvs[i0]!;
    const v0 = uvs[i0 + 1]!;
    const du1 = uvs[i1]! - u0;
    const dv1 = uvs[i1 + 1]! - v0;
    const du2 = uvs[i2]! - u0;
    const dv2 = uvs[i2 + 1]! - v0;
    const determinant = du1 * dv2 - du2 * dv1;
    if (Math.abs(determinant) < 1e-9) {
      continue;
    }
    const dx1 = vertices[i1]! - x0;
    const dy1 = vertices[i1 + 1]! - y0;
    const dx2 = vertices[i2]! - x0;
    const dy2 = vertices[i2 + 1]! - y0;
    // The image-to-canvas matrix that takes the triangle's image corners to its canvas corners.
    const ma = (dx1 * dv2 - dx2 * dv1) / determinant;
    const mb = (dy1 * dv2 - dy2 * dv1) / determinant;
    const mc = (dx2 * du1 - dx1 * du2) / determinant;
    const md = (dy2 * du1 - dy1 * du2) / determinant;
    const centerX = (x0 + vertices[i1]! + vertices[i2]!) / 3;
    const centerY = (y0 + vertices[i1 + 1]! + vertices[i2 + 1]!) / 3;
    if (!pattern) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    context.beginPath();
    for (const index of [i0, i1, i2]) {
      const offsetX = vertices[index]! - centerX;
      const offsetY = vertices[index + 1]! - centerY;
      const grow = TRIANGLE_GROW / (Math.sqrt(offsetX * offsetX + offsetY * offsetY) || 1);
      context.lineTo(vertices[index]! + offsetX * grow, vertices[index + 1]! + offsetY * grow);
    }
    context.closePath();
    if (pattern) {
      // The pattern is in picture pixels: scaled into mesh units, then the triangle's matrix.
      patternMatrix.a = (ma * width) / sw;
      patternMatrix.b = (mb * width) / sw;
      patternMatrix.c = (mc * height) / sh;
      patternMatrix.d = (md * height) / sh;
      patternMatrix.e = x0 - ma * u0 - mc * v0;
      patternMatrix.f = y0 - mb * u0 - md * v0;
      pattern.setTransform(patternMatrix);
      context.fill();
      continue;
    }
    context.clip();
    context.setTransform(ma, mb, mc, md, x0 - ma * u0 - mc * v0, y0 - mb * u0 - md * v0);
    context.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    context.restore();
  }
  if (pattern) {
    context.restore();
  }
}

/** Each whole picture's pattern for {@link drawImageTriangles}, made once. */
const patterns = new WeakMap<HTMLImageElement, CanvasPattern>();
/** The pattern's transform, reused for every triangle. */
const patternMatrix = {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0};

/** Returns `image`'s pattern for {@link drawImageTriangles}, or null while it can't make one (not decoded yet). */
function patternOf(context: CanvasRenderingContext2D, image: HTMLImageElement): CanvasPattern | null {
  let pattern = patterns.get(image) ?? null;
  if (!pattern) {
    pattern = context.createPattern(image, 'no-repeat');
    if (pattern) {
      patterns.set(image, pattern);
    }
  }
  return pattern;
}

/**
 * Floats per planned strip in {@link planMeshStrips}' plan: its transform (canvas order), the image
 * rows it draws (top and bottom), then the grid row to draw as exact triangles instead, or -1.
 */
export const MESH_STRIP_FLOATS = 9;
let stripPlan = new Float64Array(MESH_STRIP_FLOATS * 64);

/**
 * Plans how to draw a grid mesh as image strips (see {@link drawMesh}): writes each strip's
 * transform from mesh image units to canvas pixels and its image rows into `out`, which grows if
 * needed, and returns how many strips there are. A single row bent too far for one transform is
 * planned as its grid row, to draw as triangles. `vertices` are the mesh's corners in canvas pixels.
 */
export function planMeshStrips(mesh: MeshAttachment, vertices: Float32Array | Float64Array, out: Float64Array): number {
  const stride = mesh.columns + 1;
  const rows = mesh.rows;
  // The grid spans image x gridLeft to gridLeft + gridWidth: the whole image, or its trimmed art.
  const gridLeft = mesh.left;
  const gridWidth = mesh.right - mesh.left;
  const reach = mesh.joints ? mesh.width * SPINE_REACH : gridWidth / 2;
  // Strips are fitted around the mesh's spine: a chain mesh's chain, else its middle. A chain mesh's
  // art lies near its chain, and at a sharp bend the inside folds over almost to it.
  const joints = mesh.joints;
  const spineAt = (k: number) => (joints ? getChainU(joints, mesh.uvs[k * stride * 2 + 1]) : gridLeft + gridWidth / 2);
  // Row k's left and right corners, and its image y.
  const left = (k: number) => k * stride * 2;
  const right = (k: number) => (k * stride + mesh.columns) * 2;
  const rowV = (k: number) => mesh.uvs[k * stride * 2 + 1];
  const gridTop = rowV(0);
  const gridBottom = rowV(rows);
  let count = 0;
  // How far row `to` is turned from row `from`, in radians.
  const turnBetween = (from: number, to: number) => {
    const turn = Math.atan2(vertices[right(to) + 1] - vertices[left(to) + 1], vertices[right(to)] - vertices[left(to)]) - Math.atan2(vertices[right(from) + 1] - vertices[left(from) + 1], vertices[right(from)] - vertices[left(from)]);
    return Math.abs(turn > Math.PI ? turn - Math.PI * 2 : turn < -Math.PI ? turn + Math.PI * 2 : turn);
  };
  const emit = (v0: number, v1: number, turn: number, exactRow: number) => {
    if ((count + 1) * MESH_STRIP_FLOATS > out.length) {
      const grown = new Float64Array(out.length * 2);
      grown.set(out);
      out = stripPlan = grown;
    }
    const p = count * MESH_STRIP_FLOATS;
    out.set(fitted, p);
    // Reach past both ends, so no seam shows between strips: STRIP_OVERLAP canvas pixels, plus the
    // gap a turned strip opens against its neighbor at the edge of the art on the outside of a bend:
    // half its turn times the art's distance from the spine.
    const reachPixels = STRIP_OVERLAP + (turn / 2) * reach * Math.sqrt(fitted[0] * fitted[0] + fitted[1] * fitted[1]);
    const margin = reachPixels / (Math.sqrt(fitted[2] * fitted[2] + fitted[3] * fitted[3]) || 1);
    out[p + 6] = Math.max(gridTop, v0 - margin);
    out[p + 7] = Math.min(gridBottom, v1 + margin);
    out[p + 8] = exactRow;
    count++;
  };
  let start = 0;
  while (start < rows) {
    // Grow the run while one transform still puts every row's corners where they are.
    let end = start + 1;
    while (end < rows && fitsRows(vertices, start, end + 1, left, right, rowV, gridLeft, gridWidth, spineAt, reach)) {
      end++;
    }
    // A run of one row bent past the tolerance draws as its triangles: as one strip reaching into its
    // neighbors, its art poked out past the inside of the knee as a spike.
    if (end === start + 1 && !fitsRows(vertices, start, end, left, right, rowV, gridLeft, gridWidth, spineAt, reach)) {
      emit(rowV(start), rowV(end), 0, start);
      start = end;
      continue;
    }
    fitStrip(gridLeft, gridWidth, spineAt(start), spineAt(end), vertices[left(start)], vertices[left(start) + 1], vertices[right(start)], vertices[right(start) + 1], vertices[left(end)], vertices[left(end) + 1], vertices[right(end)], vertices[right(end) + 1], rowV(start), rowV(end));
    emit(rowV(start), rowV(end), turnBetween(start, end), -1);
    start = end;
  }
  return count;
}

/** The transform {@link fitStrip} found last, mesh image units to canvas pixels, canvas order. */
const fitted = new Float64Array(6);

/**
 * Finds the transform that maps the image rectangle (gridLeft, v0)-(gridLeft + gridWidth, v1) onto
 * the canvas quad with corners top-left (x0, y0), top-right, bottom-left, bottom-right, into {@link fitted}. Rows of a
 * mesh move as straight lines, so the strip's width axis is its two rows averaged, and the spine's
 * points on both rows (image x `at0` and `at1`) land exactly. A parallelogram fits exactly.
 */
function fitStrip(gridLeft: number, gridWidth: number, at0: number, at1: number, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, v0: number, v1: number) {
  const span = v1 - v0;
  const a = (x1 - x0 + x3 - x2) / (2 * gridWidth);
  const b = (y1 - y0 + y3 - y2) / (2 * gridWidth);
  // The spine's point on each row.
  const topX = x0 + ((x1 - x0) * (at0 - gridLeft)) / gridWidth;
  const topY = y0 + ((y1 - y0) * (at0 - gridLeft)) / gridWidth;
  const bottomX = x2 + ((x3 - x2) * (at1 - gridLeft)) / gridWidth;
  const bottomY = y2 + ((y3 - y2) * (at1 - gridLeft)) / gridWidth;
  fitted[0] = a;
  fitted[1] = b;
  fitted[2] = (bottomX - topX - a * (at1 - at0)) / span;
  fitted[3] = (bottomY - topY - b * (at1 - at0)) / span;
  fitted[4] = (topX + bottomX - a * (at0 + at1) - fitted[2] * (v0 + v1)) / 2;
  fitted[5] = (topY + bottomY - b * (at0 + at1) - fitted[3] * (v0 + v1)) / 2;
}

/** How far either side of a chain mesh's spine its strips must land, as a share of the image's width. */
const SPINE_REACH = 0.2;

/**
 * Returns true if one transform, fitted to rows `from` and `to`, puts every row between them within
 * {@link STRIP_TOLERANCE} canvas pixels of where it is, checked `reach` either side of the spine.
 * Leaves that transform in {@link fitted}.
 */
function fitsRows(vertices: Float32Array | Float64Array, from: number, to: number, left: (k: number) => number, right: (k: number) => number, rowV: (k: number) => number, gridLeft: number, gridWidth: number, spineAt: (k: number) => number, reach: number): boolean {
  fitStrip(gridLeft, gridWidth, spineAt(from), spineAt(to), vertices[left(from)], vertices[left(from) + 1], vertices[right(from)], vertices[right(from) + 1], vertices[left(to)], vertices[left(to) + 1], vertices[right(to)], vertices[right(to) + 1], rowV(from), rowV(to));
  for (let k = from; k <= to; k++) {
    // The row's points either side of the spine: where they are, and where the strip puts them.
    const v = rowV(k);
    const l = left(k);
    const r = right(k);
    for (let side = -1; side <= 1; side += 2) {
      const u = spineAt(k) + side * reach;
      const t = (u - gridLeft) / gridWidth;
      const errorX = fitted[0] * u + fitted[2] * v + fitted[4] - (vertices[l] + (vertices[r] - vertices[l]) * t);
      const errorY = fitted[1] * u + fitted[3] * v + fitted[5] - (vertices[l + 1] + (vertices[r + 1] - vertices[l + 1]) * t);
      if (errorX * errorX + errorY * errorY > STRIP_TOLERANCE * STRIP_TOLERANCE) {
        return false;
      }
    }
  }
  return true;
}

function drawDebug(context: CanvasRenderingContext2D, skeleton: Skeleton, debug: RigDebugOptions, a: number, b: number, c: number, d: number, e: number, f: number) {
  const world = skeleton.world;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.lineWidth = 2;
  if (debug.bones) {
    context.strokeStyle = 'rgba(255, 60, 90, 0.9)';
    context.fillStyle = 'rgba(255, 60, 90, 0.9)';
    for (const bone of skeleton.data.bones) {
      const w = bone.index * WORLD_STRIDE;
      const x = world[w + 4];
      const y = world[w + 5];
      const tipX = x + world[w] * bone.length;
      const tipY = y + world[w + 1] * bone.length;
      context.beginPath();
      context.moveTo(a * x + c * y + e, b * x + d * y + f);
      context.lineTo(a * tipX + c * tipY + e, b * tipX + d * tipY + f);
      context.stroke();
      context.beginPath();
      context.arc(a * x + c * y + e, b * x + d * y + f, 3, 0, Math.PI * 2);
      context.fill();
    }
  }
  if (debug.boxes) {
    context.strokeStyle = 'rgba(60, 200, 255, 0.9)';
    for (let slot = 0; slot < skeleton.data.slots.length; slot++) {
      const attachment = skeleton.getAttachment(slot);
      if (attachment?.kind === 'box') {
        setBoneTransform(context, skeleton, skeleton.data.slots[slot].bone, a, b, c, d, e, f);
        context.beginPath();
        tracePolygon(context, attachment.points);
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.stroke();
      } else if (attachment?.kind === 'point') {
        const spot = skeleton.getPoint(slot, attachment.name)!;
        const x = a * spot.x + c * spot.y + e;
        const y = b * spot.x + d * spot.y + f;
        const cos = Math.cos(spot.rotation * DEG_RAD);
        const sin = Math.sin(spot.rotation * DEG_RAD);
        const angle = Math.atan2(b * cos + d * sin, a * cos + c * sin);
        context.beginPath();
        context.arc(x, y, 4, 0, Math.PI * 2);
        context.moveTo(x, y);
        context.lineTo(x + Math.cos(angle) * 14, y + Math.sin(angle) * 14);
        context.stroke();
      }
    }
  }
}
