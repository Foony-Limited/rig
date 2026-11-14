import {deflateSync, inflateSync} from 'node:zlib';

/**
 * A small PNG reader and writer for the rig CLI's previews, so it needs no image library. Reads
 * 8-bit, non-interlaced PNGs of any color type (gray, gray+alpha, rgb, rgba, palette), which covers
 * what common image tools write. Also reads a WebP's size from its header.
 */

/** An image as straight (not premultiplied) RGBA bytes, row by row. */
export type Bitmap = {width: number; height: number; data: Uint8Array};

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decodes a PNG. Throws on a file it can't read, naming why. */
export function decodePng(file: Buffer): Bitmap {
  if (!file.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('[rig] not a PNG file');
  }
  let width = 0;
  let height = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0) {
        throw new Error(`[rig] PNG bit depth ${body[8]} or interlace ${body[12]} is not supported, only 8-bit non-interlaced`);
      }
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];
  if (channels === undefined) {
    throw new Error(`[rig] PNG color type ${colorType} is not supported`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  // Undo each row's filter. Each filter predicts a byte from its left (a), up (b), and up-left (c) neighbors.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) {
        predicted = a;
      } else if (filter === 2) {
        predicted = b;
      } else if (filter === 3) {
        predicted = (a + b) >> 1;
      } else if (filter === 4) {
        const estimate = a + b - c;
        const distanceA = Math.abs(estimate - a);
        const distanceB = Math.abs(estimate - b);
        const distanceC = Math.abs(estimate - c);
        predicted = distanceA <= distanceB && distanceA <= distanceC ? a : distanceB <= distanceC ? b : c;
      }
      pixels[row + x] = (raw[source + x] + predicted) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const out = i * 4;
    if (colorType === 6) {
      data.set(pixels.subarray(i * 4, i * 4 + 4), out);
    } else if (colorType === 2) {
      data.set(pixels.subarray(i * 3, i * 3 + 3), out);
      data[out + 3] = 255;
    } else if (colorType === 3) {
      const index = pixels[i];
      data[out] = palette![index * 3];
      data[out + 1] = palette![index * 3 + 1];
      data[out + 2] = palette![index * 3 + 2];
      data[out + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else {
      const gray = pixels[i * channels];
      data[out] = gray;
      data[out + 1] = gray;
      data[out + 2] = gray;
      data[out + 3] = colorType === 4 ? pixels[i * 2 + 1] : 255;
    }
  }
  return {width, height, data};
}

/** Encodes an RGBA bitmap as a PNG. */
export function encodePng(bitmap: Bitmap): Buffer {
  const stride = bitmap.width * 4;
  const raw = Buffer.alloc((stride + 1) * bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(bitmap.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(bitmap.width, 0);
  header.writeUInt32BE(bitmap.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Returns a PNG's or WebP's size from its header, or null if it is neither. */
export function readImageSize(file: Buffer): {width: number; height: number} | null {
  if (file.subarray(0, 8).equals(SIGNATURE)) {
    return {width: file.readUInt32BE(16), height: file.readUInt32BE(20)};
  }
  if (file.toString('latin1', 0, 4) !== 'RIFF' || file.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const format = file.toString('latin1', 12, 16);
  if (format === 'VP8X') {
    return {width: file.readUIntLE(24, 3) + 1, height: file.readUIntLE(27, 3) + 1};
  }
  if (format === 'VP8L') {
    const bits = file.readUInt32LE(21);
    return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
  }
  if (format === 'VP8 ') {
    return {width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff};
  }
  return null;
}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  let crc = 0xffffffff;
  for (const byte of typed) {
    crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  }
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, typed, crcBuffer]);
}
