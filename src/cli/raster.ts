import type {Bitmap} from './png.js';

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
export type RasterClip = {points: Float64Array; inverse: boolean};

/** Blend modes, as the rig compiles them. */
export type RasterBlend = 'source-over' | 'lighter' | 'multiply' | 'screen';

export class Raster {
  readonly width: number;
  readonly height: number;
  /** Premultiplied RGBA, 0 to 1. */
  private readonly pixels: Float32Array;

  constructor(width: number, height: number, background: [number, number, number]) {
    this.width = width;
    this.height = height;
    this.pixels = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.pixels.set([background[0], background[1], background[2], 1], i * 4);
    }
  }

  /**
   * Draws the `crop` rectangle (left, top, right, bottom, image pixels) of a texture through matrix
   * `m` (image pixels to canvas pixels, canvas order), with tint `color` (r, g, b, a, then an
   * optional dark tint r, g, b, all 0 to 1), limited to the sheet rectangle `bounds` (left, top,
   * right, bottom). See the rig's slot `dark` for the dark tint.
   */
  drawImage(texture: Texture, m: ArrayLike<number>, crop: readonly [number, number, number, number], color: ArrayLike<number>, blend: RasterBlend, clip: RasterClip | null, bounds: [number, number, number, number]) {
    const determinant = m[0] * m[3] - m[2] * m[1];
    if (Math.abs(determinant) < 1e-12) {
      return;
    }
    const [cropLeft, cropTop, cropRight, cropBottom] = crop;
    const corners = [
      [cropLeft, cropTop],
      [cropRight, cropTop],
      [cropRight, cropBottom],
      [cropLeft, cropBottom],
    ].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
    const left = Math.max(bounds[0], Math.floor(Math.min(...corners.map(corner => corner[0]))));
    const right = Math.min(bounds[2], Math.ceil(Math.max(...corners.map(corner => corner[0]))));
    const top = Math.max(bounds[1], Math.floor(Math.min(...corners.map(corner => corner[1]))));
    const bottom = Math.min(bounds[3], Math.ceil(Math.max(...corners.map(corner => corner[1]))));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        // Back from the pixel center to the image through the inverse matrix.
        const dx = x + 0.5 - m[4];
        const dy = y + 0.5 - m[5];
        const u = (m[3] * dx - m[2] * dy) / determinant;
        const v = (m[0] * dy - m[1] * dx) / determinant;
        if (u < cropLeft || v < cropTop || u >= cropRight || v >= cropBottom || (clip && !isClipped(clip, x + 0.5, y + 0.5))) {
          continue;
        }
        this.blendPixel(x, y, texture, u, v, color, blend);
      }
    }
  }

  /** Draws one textured triangle: canvas corners (x, y) with image corners (u, v), 3 of each. */
  drawTriangle(texture: Texture, xy: ArrayLike<number>, uv: ArrayLike<number>, color: ArrayLike<number>, blend: RasterBlend, clip: RasterClip | null, bounds: [number, number, number, number]) {
    const [x0, y0, x1, y1, x2, y2] = xy as number[];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) {
      return;
    }
    const left = Math.max(bounds[0], Math.floor(Math.min(x0, x1, x2)));
    const right = Math.min(bounds[2], Math.ceil(Math.max(x0, x1, x2)));
    const top = Math.max(bounds[1], Math.floor(Math.min(y0, y1, y2)));
    const bottom = Math.min(bounds[3], Math.ceil(Math.max(y0, y1, y2)));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
        const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0 || (clip && !isClipped(clip, px, py))) {
          continue;
        }
        this.blendPixel(x, y, texture, w0 * uv[0] + w1 * uv[2] + w2 * uv[4], w0 * uv[1] + w1 * uv[3] + w2 * uv[5], color, blend);
      }
    }
  }

  /** Returns pixel (x, y) as premultiplied r, g, b, a, 0 to 1. */
  getPixel(x: number, y: number): Float32Array {
    return this.pixels.slice((y * this.width + x) * 4, (y * this.width + x) * 4 + 4);
  }

  /** Draws a line, `thickness` pixels wide. */
  drawLine(x0: number, y0: number, x1: number, y1: number, thickness: number, color: [number, number, number, number]) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) {
      this.fillDot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, thickness / 2, color);
    }
  }

  /** Fills a round dot. */
  fillDot(cx: number, cy: number, radius: number, color: [number, number, number, number]) {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius) {
          this.blendColor(x, y, color);
        }
      }
    }
  }

  /** Writes digits, '.', '-', and lowercase letters in a 3x5 pixel font, `scale` pixels per dot. */
  drawText(text: string, x: number, y: number, scale: number, color: [number, number, number, number]) {
    let cursor = x;
    for (const character of text) {
      const glyph = FONT[character] ?? FONT['?'];
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 3; column++) {
          if (glyph[row][column] === '#') {
            for (let dy = 0; dy < scale; dy++) {
              for (let dx = 0; dx < scale; dx++) {
                this.blendColor(cursor + column * scale + dx, y + row * scale + dy, color);
              }
            }
          }
        }
      }
      cursor += 4 * scale;
    }
  }

  /** Returns the image as straight RGBA bytes. */
  toBitmap(): Bitmap {
    const data = new Uint8Array(this.width * this.height * 4);
    for (let i = 0; i < this.width * this.height; i++) {
      const alpha = this.pixels[i * 4 + 3];
      for (let channel = 0; channel < 3; channel++) {
        data[i * 4 + channel] = Math.round(Math.min(1, alpha > 0 ? this.pixels[i * 4 + channel] / alpha : 0) * 255);
      }
      data[i * 4 + 3] = Math.round(Math.min(1, alpha) * 255);
    }
    return {width: this.width, height: this.height, data};
  }

  private blendColor(x: number, y: number, color: [number, number, number, number]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const i = (y * this.width + x) * 4;
    const alpha = color[3];
    for (let channel = 0; channel < 3; channel++) {
      this.pixels[i + channel] = color[channel] * alpha + this.pixels[i + channel] * (1 - alpha);
    }
    this.pixels[i + 3] = alpha + this.pixels[i + 3] * (1 - alpha);
  }

  /** Samples the texture at image pixel (u, v), tints it, and blends it onto pixel (x, y). */
  private blendPixel(x: number, y: number, texture: Texture, u: number, v: number, color: ArrayLike<number>, blend: RasterBlend) {
    const bitmap = texture.bitmap;
    // Bilinear: mix the 4 bitmap pixels around the sample point, premultiplied so edges don't darken.
    const sx = Math.max(0, Math.min(bitmap.width - 1, u * texture.scaleX - 0.5));
    const sy = Math.max(0, Math.min(bitmap.height - 1, v * texture.scaleY - 0.5));
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const x1 = Math.min(bitmap.width - 1, x0 + 1);
    const y1 = Math.min(bitmap.height - 1, y0 + 1);
    const fx = sx - x0;
    const fy = sy - y0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    const corners: [number, number, number][] = [
      [x0, y0, (1 - fx) * (1 - fy)],
      [x1, y0, fx * (1 - fy)],
      [x0, y1, (1 - fx) * fy],
      [x1, y1, fx * fy],
    ];
    for (const [px, py, weight] of corners) {
      const i = (py * bitmap.width + px) * 4;
      const a = (bitmap.data[i + 3] / 255) * weight;
      red += (bitmap.data[i] / 255) * a;
      green += (bitmap.data[i + 1] / 255) * a;
      blue += (bitmap.data[i + 2] / 255) * a;
      alpha += a;
    }
    // Two-color tint, premultiplied: the art times the tint, plus the dark tint where the art is dark.
    const textureAlpha = alpha;
    alpha *= color[3];
    if (alpha <= 0) {
      return;
    }
    const darkRed = color.length > 4 ? color[4] : 0;
    const darkGreen = color.length > 4 ? color[5] : 0;
    const darkBlue = color.length > 4 ? color[6] : 0;
    red = (red * color[0] + (textureAlpha - red) * darkRed) * color[3];
    green = (green * color[1] + (textureAlpha - green) * darkGreen) * color[3];
    blue = (blue * color[2] + (textureAlpha - blue) * darkBlue) * color[3];
    const i = (y * this.width + x) * 4;
    const pixels = this.pixels;
    const source = [red, green, blue];
    for (let channel = 0; channel < 3; channel++) {
      const destination = pixels[i + channel];
      if (blend === 'lighter') {
        pixels[i + channel] = destination + source[channel];
      } else if (blend === 'multiply') {
        pixels[i + channel] = source[channel] * destination + source[channel] * (1 - pixels[i + 3]) + destination * (1 - alpha);
      } else if (blend === 'screen') {
        pixels[i + channel] = source[channel] + destination - source[channel] * destination;
      } else {
        pixels[i + channel] = source[channel] + destination * (1 - alpha);
      }
    }
    pixels[i + 3] = blend === 'lighter' ? Math.min(1, pixels[i + 3] + alpha) : alpha + pixels[i + 3] * (1 - alpha);
  }
}

/** Returns true if point (x, y) is drawn under `clip`: inside it, or outside for an inverse clip. */
function isClipped(clip: RasterClip, x: number, y: number): boolean {
  const points = clip.points;
  const count = points.length / 2;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside !== clip.inverse;
}

/** A 3x5 pixel font: '#' is a dot. */
const FONT: {[character: string]: string[]} = {
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['###', '..#', '###', '#..', '###'],
  '3': ['###', '..#', '###', '..#', '###'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '###', '..#', '###'],
  '6': ['###', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '..#', '..#', '..#'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '###'],
  '.': ['...', '...', '...', '...', '.#.'],
  '-': ['...', '...', '###', '...', '...'],
  ' ': ['...', '...', '...', '...', '...'],
  s: ['...', '.##', '##.', '..#', '##.'],
  '?': ['###', '..#', '.##', '...', '.#.'],
};
