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
export function makeDarkLayer(image: RigImage, darkKey: number): HTMLCanvasElement | OffscreenCanvas {
  const canvas = makeCanvas(Math.round(image.width), Math.round(image.height));
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.drawImage(image.source, image.x, image.y, image.width, image.height, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'difference';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = `rgb(${((darkKey >> 10) & 31) * (255 / 31)},${((darkKey >> 5) & 31) * (255 / 31)},${(darkKey & 31) * (255 / 31)})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(image.source, image.x, image.y, image.width, image.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The tint key of black: no dark tint. */
export const BLACK_KEY = 0;

/** Widest atlas page, in pixels. Pages grow down to {@link MAX_PAGE_HEIGHT}, then a new page starts. */
const PAGE_WIDTH = 2048;
const MAX_PAGE_HEIGHT = 4096;
/** Empty pixels around each packed image, so smoothing never samples a neighbor. */
const PADDING = 2;

/** Returns a tint's cache key: each channel rounded to 32 steps. */
export function getTintKey(red: number, green: number, blue: number): number {
  return (Math.round(red * 31) << 10) | (Math.round(green * 31) << 5) | Math.round(blue * 31);
}

/** Returns the name a tinted copy of `image` is stored under, or `image` itself for no tint. */
export function getTintedName(image: string, tintKey: number): string {
  return tintKey === WHITE_KEY ? image : `${image}@${tintKey}`;
}

/** The tint key of no tint. */
export const WHITE_KEY = getTintKey(1, 1, 1);

/** Returns a new canvas of the given size, offscreen when the browser has OffscreenCanvas. */
export function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  return typeof OffscreenCanvas === 'undefined' ? Object.assign(document.createElement('canvas'), {width, height}) : new OffscreenCanvas(width, height);
}

/** Returns `image` copied with its rgb multiplied by the tint whose key is `tintKey`. */
export function makeTinted(image: RigImage, tintKey: number): HTMLCanvasElement | OffscreenCanvas {
  const canvas = makeCanvas(Math.round(image.width), Math.round(image.height));
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.drawImage(image.source, image.x, image.y, image.width, image.height, 0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = 'multiply';
  context.fillStyle = `rgb(${((tintKey >> 10) & 31) * (255 / 31)},${((tintKey >> 5) & 31) * (255 / 31)},${(tintKey & 31) * (255 / 31)})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  // Multiply fills the transparent pixels too, so cut the result back to the image's own alpha.
  context.globalCompositeOperation = 'destination-in';
  context.drawImage(image.source, image.x, image.y, image.width, image.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

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
export function packAtlas(entries: readonly AtlasEntry[], scale = 1): Map<string, RigImage> {
  if (entries.length === 0) {
    return new Map();
  }
  const sorted = [...entries].sort((first, second) => (first.group ?? 0) - (second.group ?? 0) || second.height - first.height);
  type Placed = {entry: AtlasEntry; page: number; x: number; y: number};
  const placed: Placed[] = [];
  const pageSizes: {width: number; height: number}[] = [{width: 0, height: 0}];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  for (const entry of sorted) {
    const width = Math.ceil(entry.width * scale) + PADDING * 2;
    const height = Math.ceil(entry.height * scale) + PADDING * 2;
    if (shelfX + width > Math.max(PAGE_WIDTH, width)) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    if (shelfY + height > MAX_PAGE_HEIGHT && shelfY > 0) {
      pageSizes.push({width: 0, height: 0});
      shelfX = 0;
      shelfY = 0;
      shelfHeight = 0;
    }
    const page = pageSizes.length - 1;
    placed.push({entry, page, x: shelfX + PADDING, y: shelfY + PADDING});
    shelfX += width;
    shelfHeight = Math.max(shelfHeight, height);
    pageSizes[page].width = Math.max(pageSizes[page].width, shelfX);
    pageSizes[page].height = Math.max(pageSizes[page].height, shelfY + shelfHeight);
  }
  const pages = pageSizes.map(size => {
    const canvas = makeCanvas(size.width, size.height);
    return {canvas, context: canvas.getContext('2d') as CanvasRenderingContext2D};
  });
  for (const {entry, page, x, y} of placed) {
    pages[page].context.drawImage(entry.source, x, y, entry.width * scale, entry.height * scale);
  }
  const sources = pages.map(({canvas}) => ('transferToImageBitmap' in canvas ? canvas.transferToImageBitmap() : canvas));
  const result = new Map<string, RigImage>();
  for (const {entry, page, x, y} of placed) {
    result.set(entry.name, {source: sources[page], x, y, width: entry.width * scale, height: entry.height * scale});
  }
  return result;
}
