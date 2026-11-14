#!/usr/bin/env node
/**
 * The Foony Rig command line: how an LLM edits rigs without an editor. It checks a rig file,
 * prints poses as numbers, renders animation sheets to PNG (with no browser), lists part images
 * with joint hints, and benchmarks the runtime:
 *
 *   foony-rig check   rigs/hero.rig.json
 *   foony-rig pose    <rig> --anim walk --frames 4 [--bones thighL,shinL]
 *   foony-rig render  <rig> --anim walk [--frames 8 | --time 0.25] [--bones] [--mesh] [--overlay] [--skin a,b] [--size 240] [--out file.png]
 *   foony-rig render  <rig> --anim idle --then attackSide [--at 0.3] [--mix 0.1]
 *
 * `--then` previews a crossfade: it switches to the second animation `--at` seconds in (default
 * 0.25), with the rig's crossfade time or `--mix`, and its frames span the crossfade.
 *   foony-rig images  <rig or folder under the root>
 *   foony-rig atlas   <rig> [--name hero] [--out folder]
 *   foony-rig bench   <rig> [--anim walk] [--count 200]
 *
 * `atlas` packs the rig's images, each trimmed to its art, into `<name>.atlas.webp` pages and an
 * `<name>.atlas.json` in the rig's images folder. Set the rig's `"atlas": "<name>"` and the browser
 * loads those pages instead of every image, and parts draw only their trimmed art.
 *
 * Every command takes `--root <folder>`, the folder a rig's `images` path is relative to: the
 * site root the browser loads images from. It defaults to `public` in the current folder.
 *
 * Renders go to tmp/rig/ in the current folder unless --out says otherwise. Reading a WebP
 * without a PNG next to it needs python3 with PIL, and `atlas` needs `cwebp`.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AnimationState, updateRig} from '../animationState.js';
import {compileRig, getRigImageNames, RigCompileError} from '../compileRig.js';
import type {RigAtlasFile} from '../loadRig.js';
import {BONE_STRIDE, RigData, WORLD_STRIDE} from '../rigData.js';
import {Skeleton} from '../skeleton.js';
import {lintRig} from './lintRig.js';
import {Bitmap, decodePng, encodePng, readImageSize} from './png.js';
import {Raster, RasterClip, Texture} from './raster.js';

const OUT_DIR = path.resolve('tmp', 'rig');
/** WebP images converted to PNG, so the CLI reads them without an image library. */
const CACHE_DIR = path.join(tmpdir(), 'foony-rig-cache');
/** The folder rig `images` paths are relative to. Set from `--root` in main. */
let rootDir = path.resolve('public');
/** Seconds per simulation step when sampling poses, so physics plays as in the game. */
const SIMULATION_STEP = 1 / 60;
const BACKGROUND: [number, number, number] = [0.91, 0.91, 0.94];
const GROUND_COLOR: [number, number, number, number] = [0.55, 0.55, 0.62, 1];
const LABEL_COLOR: [number, number, number, number] = [0.25, 0.25, 0.3, 1];
const BONE_COLOR: [number, number, number, number] = [0.95, 0.2, 0.35, 0.9];
const TARGET_COLOR: [number, number, number, number] = [0.15, 0.45, 0.95, 0.95];
const MESH_COLOR: [number, number, number, number] = [0.1, 0.8, 0.4, 0.8];

type Flags = {[name: string]: string | true};

function main() {
  const [command, target, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!command || !target) {
    usage();
  }
  if (typeof flags.root === 'string') {
    rootDir = path.resolve(flags.root);
  }
  switch (command) {
    case 'check':
      return check(target);
    case 'pose':
      return pose(target, flags);
    case 'render':
      return render(target, flags);
    case 'images':
      return images(target);
    case 'bench':
      return bench(target, flags);
    case 'atlas':
      return atlas(target, flags);
    default:
      usage();
  }
}

function usage(): never {
  console.error('usage: foony-rig <check|pose|render|images|bench|atlas> <rig.json or folder> [--root public] [flags]. See the README for each command\'s flags.');
  process.exit(2);
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) {
      console.error(`[rig] unexpected argument "${args[i]}"`);
      process.exit(2);
    }
    const name = args[i].slice(2);
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith('--')) {
      flags[name] = value;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function numberFlag(flags: Flags, name: string, fallback: number): number {
  const value = flags[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`[rig] --${name} must be a number, got "${value}"`);
    process.exit(2);
  }
  return parsed;
}

/** A rig compiled for the CLI, with its file's folder and texture loader. */
type CliRig = {data: RigData; folder: string; texture: (image: string) => Texture | null};

/** Reads and compiles a rig, printing its problems and exiting if it doesn't compile. */
function loadRig(rigPath: string): CliRig {
  const text = readFileSync(rigPath, 'utf8');
  let file: {images?: unknown};
  try {
    file = JSON.parse(text);
  } catch (error) {
    const message = (error as Error).message;
    const position = Number(/position (\d+)/.exec(message)?.[1]);
    const where = Number.isFinite(position) ? ` (line ${text.slice(0, position).split('\n').length})` : '';
    console.error(`[rig] ${rigPath} is not valid JSON${where}: ${message}`);
    process.exit(1);
  }
  const folder = path.join(rootDir, typeof file.images === 'string' ? file.images : '');
  const sizes = new Map<string, {width: number; height: number} | undefined>();
  const getImageSize = (name: string) => {
    if (!sizes.has(name)) {
      const file = [`${name}.webp`, `${name}.png`].map(candidate => path.join(folder, candidate)).find(existsSync);
      sizes.set(name, file ? (readImageSize(readFileSync(file)) ?? undefined) : undefined);
    }
    return sizes.get(name);
  };
  // A rig with a prebuilt atlas draws only each image's trimmed art: compile with its trims, as the browser does.
  const atlasFile = typeof (file as {atlas?: unknown}).atlas === 'string' ? path.join(folder, `${(file as {atlas: string}).atlas}.atlas.json`) : null;
  const trims = atlasFile && existsSync(atlasFile) ? (JSON.parse(readFileSync(atlasFile, 'utf8')) as RigAtlasFile).images : {};
  const getSizeWithTrim = (name: string) => {
    const size = getImageSize(name);
    const entry = trims[name];
    // The atlas measured the full-size image: scale its trim to this image's size.
    return size && entry ? {...size, trim: entry.trim.map((value, index) => (value * (index % 2 === 0 ? size.width / entry.size[0] : size.height / entry.size[1]))) as [number, number, number, number]} : size;
  };
  let data: RigData;
  try {
    data = compileRig(file, getSizeWithTrim);
  } catch (error) {
    if (error instanceof RigCompileError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const textures = new Map<string, Texture | null>();
  const texture = (image: string): Texture | null => {
    if (!textures.has(image)) {
      textures.set(image, loadTexture(folder, image, getImageSize(image)));
    }
    return textures.get(image)!;
  };
  return {data, folder, texture};
}

/** Loads an image's pixels: the PNG if there is one, else the WebP converted by Python's PIL. */
function loadTexture(folder: string, image: string, size: {width: number; height: number} | undefined): Texture | null {
  const bitmap = readBitmap(folder, image);
  if (!bitmap || !size) {
    console.warn(`[rig] no pixels for image "${image}" in ${folder}: it shows as empty`);
    return null;
  }
  return {bitmap, scaleX: bitmap.width / size.width, scaleY: bitmap.height / size.height};
}

function readBitmap(folder: string, image: string): Bitmap | null {
  const png = path.join(folder, `${image}.png`);
  if (existsSync(png)) {
    return decodePng(readFileSync(png));
  }
  const webp = path.join(folder, `${image}.webp`);
  if (!existsSync(webp)) {
    return null;
  }
  const converted = path.join(CACHE_DIR, `${path.relative(rootDir, folder).replaceAll(path.sep, '_')}_${image}.png`);
  mkdirSync(path.dirname(converted), {recursive: true});
  try {
    execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2])', webp, converted]);
  } catch (error) {
    console.warn(`[rig] could not convert ${webp} to PNG (needs python3 with PIL): ${(error as Error).message}`);
    return null;
  }
  return decodePng(readFileSync(converted));
}

/** Packs a rig's images, each trimmed to its art, into atlas pages. See the file comment. */
function atlas(rigPath: string, flags: Flags) {
  const file = JSON.parse(readFileSync(rigPath, 'utf8')) as {name?: string; images?: string};
  const folder = path.join(rootDir, file.images ?? '');
  const name = typeof flags.name === 'string' ? flags.name : (file.name ?? path.basename(rigPath).replace(/\.rig\.json$/, ''));
  const outFolder = typeof flags.out === 'string' ? path.resolve(flags.out) : folder;
  const parts = getRigImageNames(file).map(image => {
    const bitmap = readFullBitmap(folder, image);
    if (!bitmap) {
      console.error(`[rig] atlas: no image "${image}" in ${folder}`);
      process.exit(1);
    }
    // The box of every pixel with any alpha: what the image draws.
    let left = bitmap.width;
    let top = bitmap.height;
    let right = 0;
    let bottom = 0;
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        if (bitmap.data[(y * bitmap.width + x) * 4 + 3] > 0) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
    }
    if (right <= left) {
      [left, top, right, bottom] = [0, 0, 1, 1];
    }
    return {image, bitmap, trim: [left, top, right, bottom] as [number, number, number, number]};
  });
  // Shelf packing, tallest first, with ATLAS_PADDING clear pixels around each image, at the page
  // width (in steps of 64, up to ATLAS_PAGE_WIDTH) that wastes the least area.
  const widest = Math.max(...parts.map(part => part.trim[2] - part.trim[0] + ATLAS_PADDING * 2));
  const shelfArea = (width: number) => {
    let x = 0;
    let y = 0;
    let shelf = 0;
    for (const part of [...parts].sort((first, second) => second.trim[3] - second.trim[1] - (first.trim[3] - first.trim[1]))) {
      const partWidth = part.trim[2] - part.trim[0] + ATLAS_PADDING * 2;
      if (x + partWidth > width) {
        y += shelf;
        x = 0;
        shelf = 0;
      }
      x += partWidth;
      shelf = Math.max(shelf, part.trim[3] - part.trim[1] + ATLAS_PADDING * 2);
    }
    return width * Math.min(y + shelf, ATLAS_MAX_PAGE_HEIGHT * 4);
  };
  let pageWidth = Math.max(ATLAS_PAGE_WIDTH, widest);
  for (let width = Math.ceil(widest / 64) * 64; width < ATLAS_PAGE_WIDTH; width += 64) {
    if (shelfArea(width) < shelfArea(pageWidth)) {
      pageWidth = width;
    }
  }
  const placed: {page: number; x: number; y: number}[] = [];
  const pageHeights = [0];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  const order = parts.map((_, index) => index).sort((first, second) => parts[second].trim[3] - parts[second].trim[1] - (parts[first].trim[3] - parts[first].trim[1]));
  for (const index of order) {
    const width = parts[index].trim[2] - parts[index].trim[0] + ATLAS_PADDING * 2;
    const height = parts[index].trim[3] - parts[index].trim[1] + ATLAS_PADDING * 2;
    if (shelfX + width > pageWidth) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    if (shelfY + height > ATLAS_MAX_PAGE_HEIGHT && shelfY > 0) {
      pageHeights.push(0);
      shelfX = 0;
      shelfY = 0;
      shelfHeight = 0;
    }
    placed[index] = {page: pageHeights.length - 1, x: shelfX + ATLAS_PADDING, y: shelfY + ATLAS_PADDING};
    shelfX += width;
    shelfHeight = Math.max(shelfHeight, height);
    pageHeights[pageHeights.length - 1] = Math.max(pageHeights[pageHeights.length - 1], shelfY + shelfHeight);
  }
  const pages = pageHeights.map(height => ({width: pageWidth, height, data: new Uint8Array(pageWidth * height * 4)}));
  const entries: RigAtlasFile['images'] = {};
  parts.forEach(({image, bitmap, trim}, index) => {
    const {page, x, y} = placed[index];
    const [left, top, right, bottom] = trim;
    for (let row = top; row < bottom; row++) {
      const from = (row * bitmap.width + left) * 4;
      pages[page].data.set(bitmap.data.subarray(from, from + (right - left) * 4), ((y + row - top) * pageWidth + x) * 4);
    }
    entries[image] = {page, x, y, width: right - left, height: bottom - top, trim, size: [bitmap.width, bitmap.height]};
  });
  mkdirSync(outFolder, {recursive: true});
  const pageNames = pages.map((page, index) => {
    const pageName = `${name}.atlas${index === 0 ? '' : `-${index + 1}`}.webp`;
    const png = path.join(CACHE_DIR, `${name}-atlas-${index}.png`);
    mkdirSync(path.dirname(png), {recursive: true});
    writeFileSync(png, encodePng(page));
    execFileSync('cwebp', ['-quiet', '-q', '92', '-alpha_q', '100', '-exact', png, '-o', path.join(outFolder, pageName)]);
    return pageName;
  });
  const atlasFile: RigAtlasFile = {format: 'foony-rig-atlas@1', pages: pageNames, images: entries};
  writeFileSync(path.join(outFolder, `${name}.atlas.json`), `${JSON.stringify(atlasFile, null, 1)}\n`);
  const fullArea = parts.reduce((sum, part) => sum + part.bitmap.width * part.bitmap.height, 0);
  const pageArea = pages.reduce((sum, page) => sum + page.width * page.height, 0);
  console.log(`[rig] atlas ${name}: ${parts.length} images on ${pages.length} page(s) ${pages.map(page => `${page.width}x${page.height}`).join(', ')}, ${Math.round((pageArea / fullArea) * 100)}% of the untrimmed images' pixels. Set "atlas": "${name}" in the rig.`);
}

/** Widest atlas page the `atlas` command makes, in pixels, unless an image is wider. */
const ATLAS_PAGE_WIDTH = 2048;
/** Tallest atlas page before the `atlas` command starts another. */
const ATLAS_MAX_PAGE_HEIGHT = 4096;
/** Clear pixels around each packed image, so smoothing never samples a neighbor. */
const ATLAS_PADDING = 2;

/** Loads an image at full size for the atlas: the WebP (as the browser loads it) through PIL, else the PNG. */
function readFullBitmap(folder: string, image: string): Bitmap | null {
  const webp = path.join(folder, `${image}.webp`);
  if (!existsSync(webp)) {
    return readBitmap(folder, image);
  }
  const converted = path.join(CACHE_DIR, `full_${path.relative(rootDir, folder).replaceAll(path.sep, '_')}_${image}.png`);
  mkdirSync(path.dirname(converted), {recursive: true});
  execFileSync('python3', ['-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2])', webp, converted]);
  return decodePng(readFileSync(converted));
}

function check(rigPath: string) {
  const {data} = loadRig(rigPath);
  const warnings = lintRig(data);
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  const animations = data.animations.map(animation => `${animation.name} (${round(animation.duration)}s${animation.loop ? ', loop' : ''})`);
  console.log(
    `OK ${data.name}: ${data.bones.length} bones, ${data.slots.length} slots, ${data.skins.length} skins, ` +
      `${data.ik.length} ik, ${data.transforms.length} transforms, ${data.physics.length} physics, ${data.sliders.length} sliders, ${data.paths.length} paths, ` +
      `${warnings.length} warnings\nanimations: ${animations.join(', ') || 'none'}\nskins: ${data.skins.map(skin => skin.name).join(', ') || 'none'}`,
  );
}

/** Returns the sample times for `--time`, or `--frames` spread over the animation. */
function sampleTimes(data: RigData, animationName: string | null, flags: Flags): number[] {
  const animation = animationName === null ? null : data.animations.find(candidate => candidate.name === animationName);
  if (flags.time !== undefined) {
    return [numberFlag(flags, 'time', 0)];
  }
  const count = Math.max(1, Math.round(numberFlag(flags, 'frames', animation ? 8 : 1)));
  const then = getThen(data, animationName, flags);
  if (then) {
    // From a little before the switch to a little after the crossfade ends.
    const start = Math.max(0, then.at - 0.1);
    const end = then.at + then.mix + 0.15;
    return Array.from({length: count}, (_, i) => start + ((end - start) * i) / Math.max(1, count - 1));
  }
  if (!animation || count === 1) {
    return [0];
  }
  // A loop's last frame would repeat its first, so loops spread over [0, duration).
  const divisions = animation.loop ? count : count - 1;
  return Array.from({length: count}, (_, i) => (animation.duration * i) / divisions);
}

/** Returns the `--then` crossfade to preview: the second animation, when to switch, and the crossfade time. Null without `--then`. */
function getThen(data: RigData, animationName: string | null, flags: Flags): {name: string; at: number; mix: number} | null {
  if (typeof flags.then !== 'string') {
    return null;
  }
  const name = flags.then;
  if (!data.animations.some(candidate => candidate.name === name)) {
    console.error(`[rig] --then: no animation "${name}". Animations: ${data.animations.map(candidate => candidate.name).join(', ')}`);
    process.exit(1);
  }
  const mix = flags.mix !== undefined ? numberFlag(flags, 'mix', 0) : (data.mixes.get(`${animationName}>${name}`) ?? data.defaultMix);
  return {name, at: numberFlag(flags, 'at', 0.25), mix};
}

/**
 * Plays the animation from the start with fixed steps, as a game would, and calls `visit` at each
 * sample time. A loop plays one whole pass first so physics has settled into the loop. With
 * `then`, it switches to that animation at its time, crossfading as the game would.
 */
function simulate(data: RigData, animationName: string | null, skins: string[], times: number[], visit: (skeleton: Skeleton, time: number, index: number) => void, then: {name: string; at: number; mix: number} | null = null) {
  const skeleton = new Skeleton(data);
  skeleton.setSkins(skins);
  const state = new AnimationState(skeleton);
  let warmup = 0;
  if (animationName !== null) {
    const animation = data.animations.find(candidate => candidate.name === animationName);
    if (!animation) {
      console.error(`[rig] no animation "${animationName}". Animations: ${data.animations.map(candidate => candidate.name).join(', ')}`);
      process.exit(1);
    }
    state.setAnimation(0, animationName, {loop: animation.loop});
    warmup = animation.loop && data.physics.length > 0 ? animation.duration : 0;
  }
  state.apply();
  skeleton.updateWorld('reset');
  let clock = 0;
  let hasSwitched = false;
  const order = times.map((time, index) => ({time, index})).sort((first, second) => first.time - second.time);
  for (const {time, index} of order) {
    while (clock < warmup + time - 1e-9) {
      if (then && !hasSwitched && clock >= warmup + then.at - 1e-9) {
        const next = data.animations.find(candidate => candidate.name === then.name)!;
        state.setAnimation(0, then.name, {mix: then.mix, loop: next.loop});
        hasSwitched = true;
      }
      // Stop on the switch time too, so the crossfade starts exactly there.
      const switchAt = then && !hasSwitched ? warmup + then.at : Infinity;
      const step = Math.min(SIMULATION_STEP, warmup + time - clock, switchAt > clock ? switchAt - clock : Infinity);
      updateRig(state, step);
      clock += step;
    }
    visit(skeleton, time, index);
  }
}

function pose(rigPath: string, flags: Flags) {
  const {data} = loadRig(rigPath);
  const animationName = typeof flags.anim === 'string' ? flags.anim : null;
  const filter = typeof flags.bones === 'string' ? flags.bones.split(',') : null;
  const skins = typeof flags.skin === 'string' ? flags.skin.split(',') : [];
  const bones = data.bones.filter(bone => !filter || filter.includes(bone.name));
  const width = Math.max(4, ...bones.map(bone => bone.name.length));
  const then = getThen(data, animationName, flags);
  simulate(data, animationName, skins, sampleTimes(data, animationName, flags), (skeleton, time) => {
    console.log(`t=${round(time)}s  (skeleton space, y up; rot = world degrees counterclockwise; local = animated local rotation)`);
    console.log(`${'bone'.padEnd(width)}       x       y     rot   local    tipX    tipY`);
    for (const bone of bones) {
      const tip = skeleton.getBoneTip(bone.index);
      const local = skeleton.local[bone.index * BONE_STRIDE + 2];
      const columns = [skeleton.getWorldX(bone.index), skeleton.getWorldY(bone.index), skeleton.getWorldRotation(bone.index), local, tip.x, tip.y];
      console.log(`${bone.name.padEnd(width)} ${columns.map(value => round(value).toFixed(1).padStart(7)).join(' ')}`);
    }
    for (const slot of data.slots) {
      const attachment = skeleton.getAttachment(slot.index);
      if (attachment?.kind === 'point') {
        const spot = skeleton.getPoint(slot.index, attachment.name)!;
        console.log(`point ${slot.name}/${attachment.name}: x ${round(spot.x)} y ${round(spot.y)} rot ${round(spot.rotation)}`);
      }
    }
    const order = Array.from(skeleton.drawOrder, slot => data.slots[slot].name);
    console.log(`draw order (back to front): ${order.join(' ')}\n`);
  }, then);
}

/** Returns the skeleton-space box around everything drawn and every bone, plus the ground line. */
function measure(skeleton: Skeleton, bounds: [number, number, number, number]) {
  const extend = (x: number, y: number) => {
    bounds[0] = Math.min(bounds[0], x);
    bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x);
    bounds[3] = Math.max(bounds[3], y);
  };
  const matrix = new Float64Array(6);
  for (const slot of skeleton.data.slots) {
    const attachment = skeleton.getAttachment(slot.index);
    if (attachment?.kind === 'region') {
      skeleton.getRegionMatrix(slot.index, attachment, matrix);
      for (const [u, v] of [[0, 0], [attachment.width, 0], [0, attachment.height], [attachment.width, attachment.height]]) {
        extend(matrix[0] * u + matrix[2] * v + matrix[4], matrix[1] * u + matrix[3] * v + matrix[5]);
      }
    } else if (attachment?.kind === 'mesh') {
      const vertices = new Float64Array(attachment.vertexCount * 2);
      skeleton.computeMeshVertices(attachment, vertices, slot.index);
      for (let i = 0; i < vertices.length; i += 2) {
        extend(vertices[i], vertices[i + 1]);
      }
    }
  }
  for (const bone of skeleton.data.bones) {
    extend(skeleton.getWorldX(bone.index), skeleton.getWorldY(bone.index));
  }
  extend(bounds[0], 0);
}

function render(rigPath: string, flags: Flags) {
  const rig = loadRig(rigPath);
  const {data} = rig;
  const animationName = typeof flags.anim === 'string' ? flags.anim : null;
  const skins = typeof flags.skin === 'string' ? flags.skin.split(',') : [];
  const times = sampleTimes(data, animationName, flags);
  const isOverlay = flags.overlay === true;
  const cellSize = Math.round(numberFlag(flags, 'size', 240));
  const columns = isOverlay ? 1 : Math.min(times.length, Math.round(numberFlag(flags, 'columns', 4)));
  const rows = isOverlay ? 1 : Math.ceil(times.length / columns);

  // First pass: one scale for every frame, so motion between cells is true to size.
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const then = getThen(data, animationName, flags);
  simulate(data, animationName, skins, times, skeleton => measure(skeleton, bounds), then);
  const padding = 10;
  const labelSpace = 16;
  const scale = Math.min((cellSize - padding * 2) / Math.max(1, bounds[2] - bounds[0]), (cellSize - padding * 2 - labelSpace) / Math.max(1, bounds[3] - bounds[1]));
  const raster = new Raster(columns * cellSize, rows * cellSize, BACKGROUND);

  simulate(data, animationName, skins, times, (skeleton, time, index) => {
    const cell = isOverlay ? 0 : index;
    const cellX = (cell % columns) * cellSize;
    const cellY = Math.floor(cell / columns) * cellSize;
    const offsetX = cellX + (cellSize - (bounds[2] - bounds[0]) * scale) / 2 - bounds[0] * scale;
    const offsetY = cellY + labelSpace + padding + bounds[3] * scale;
    const view = [scale, 0, 0, -scale, offsetX, offsetY];
    const clipBounds: [number, number, number, number] = [cellX, cellY, cellX + cellSize, cellY + cellSize];
    if (!isOverlay || index === 0) {
      raster.drawLine(cellX, offsetY, cellX + cellSize - 1, offsetY, 1, GROUND_COLOR);
    }
    const fade = isOverlay ? 0.25 + (0.75 * (index + 1)) / times.length : 1;
    drawSkeleton(raster, skeleton, rig, view, clipBounds, fade);
    if (flags.mesh) {
      drawMeshEdges(raster, skeleton, view);
    }
    if (flags.bones) {
      drawBones(raster, skeleton, view);
    }
    if (!isOverlay) {
      raster.drawText(`${round(time)}s`, cellX + 4, cellY + 4, 2, LABEL_COLOR);
    }
  }, then);
  if (!isOverlay) {
    for (let column = 1; column < columns; column++) {
      raster.drawLine(column * cellSize, 0, column * cellSize, rows * cellSize - 1, 1, GROUND_COLOR);
    }
    for (let row = 1; row < rows; row++) {
      raster.drawLine(0, row * cellSize, columns * cellSize - 1, row * cellSize, 1, GROUND_COLOR);
    }
  }
  const out = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(OUT_DIR, `${data.name}-${animationName ?? 'setup'}${isOverlay ? '-overlay' : ''}.png`);
  mkdirSync(path.dirname(out), {recursive: true});
  writeFileSync(out, encodePng(raster.toBitmap()));
  console.log(`wrote ${out}`);
  console.log(`${isOverlay ? 'overlay of' : 'cells, left to right then down:'} ${times.map(time => `${round(time)}s`).join(', ')}; ${round(scale)} px per rig unit; gray line = y 0`);
}

/** Rasterizes a posed skeleton through `view` (skeleton space to sheet pixels). */
function drawSkeleton(raster: Raster, skeleton: Skeleton, rig: CliRig, view: number[], bounds: [number, number, number, number], fade: number) {
  const data = skeleton.data;
  const matrix = new Float64Array(6);
  const composed = new Float64Array(6);
  let clip: RasterClip | null = null;
  let clipEnd = -1;
  for (const slot of skeleton.drawOrder) {
    const attachment = skeleton.getAttachment(slot);
    const color = skeleton.slotColors.subarray(slot * 4, slot * 4 + 4);
    if (attachment?.kind === 'clip' && !clip) {
      const w = data.slots[slot].bone * WORLD_STRIDE;
      const points = new Float64Array(attachment.points.length);
      for (let i = 0; i < points.length; i += 2) {
        const x = skeleton.world[w] * attachment.points[i] + skeleton.world[w + 2] * attachment.points[i + 1] + skeleton.world[w + 4];
        const y = skeleton.world[w + 1] * attachment.points[i] + skeleton.world[w + 3] * attachment.points[i + 1] + skeleton.world[w + 5];
        points[i] = view[0] * x + view[2] * y + view[4];
        points[i + 1] = view[1] * x + view[3] * y + view[5];
      }
      clip = {points, inverse: attachment.inverse};
      clipEnd = attachment.endSlot;
    } else if (attachment?.kind === 'region' || attachment?.kind === 'mesh') {
      const dark = skeleton.slotDarks.subarray(slot * 3, slot * 3 + 3);
      const tint = [color[0] * attachment.color[0], color[1] * attachment.color[1], color[2] * attachment.color[2], color[3] * attachment.color[3] * skeleton.alpha * fade, dark[0], dark[1], dark[2]];
      const frame = skeleton.getFrame(slot, attachment);
      const texture = rig.texture(attachment.images[frame]);
      if (texture && tint[3] > 0) {
        const blend = data.slots[slot].blend;
        if (attachment.kind === 'region') {
          skeleton.getRegionMatrix(slot, attachment, matrix);
          composed[0] = view[0] * matrix[0] + view[2] * matrix[1];
          composed[1] = view[1] * matrix[0] + view[3] * matrix[1];
          composed[2] = view[0] * matrix[2] + view[2] * matrix[3];
          composed[3] = view[1] * matrix[2] + view[3] * matrix[3];
          composed[4] = view[0] * matrix[4] + view[2] * matrix[5] + view[4];
          composed[5] = view[1] * matrix[4] + view[3] * matrix[5] + view[5];
          raster.drawImage(texture, composed, attachment.crop, tint, blend, clip, bounds);
        } else {
          const vertices = new Float64Array(attachment.vertexCount * 2);
          skeleton.computeMeshVertices(attachment, vertices, slot);
          const xy = new Float64Array(6);
          const uv = new Float64Array(6);
          for (let t = 0; t < attachment.triangles.length; t += 3) {
            for (let corner = 0; corner < 3; corner++) {
              const vertex = attachment.triangles[t + corner] * 2;
              const x = vertices[vertex];
              const y = vertices[vertex + 1];
              xy[corner * 2] = view[0] * x + view[2] * y + view[4];
              xy[corner * 2 + 1] = view[1] * x + view[3] * y + view[5];
              uv[corner * 2] = attachment.uvs[vertex];
              uv[corner * 2 + 1] = attachment.uvs[vertex + 1];
            }
            raster.drawTriangle(texture, xy, uv, tint, blend, clip, bounds);
          }
        }
      }
    }
    if (slot === clipEnd) {
      clip = null;
      clipEnd = -1;
    }
  }
}

/** Draws every shown mesh's triangle edges, to check how a mesh bends. */
function drawMeshEdges(raster: Raster, skeleton: Skeleton, view: number[]) {
  for (const slot of skeleton.drawOrder) {
    const attachment = skeleton.getAttachment(slot);
    if (attachment?.kind !== 'mesh') {
      continue;
    }
    const vertices = new Float64Array(attachment.vertexCount * 2);
    skeleton.computeMeshVertices(attachment, vertices, slot);
    const toSheet = (vertex: number) => [view[0] * vertices[vertex * 2] + view[2] * vertices[vertex * 2 + 1] + view[4], view[1] * vertices[vertex * 2] + view[3] * vertices[vertex * 2 + 1] + view[5]];
    for (let t = 0; t < attachment.triangles.length; t += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const [x0, y0] = toSheet(attachment.triangles[t + corner]);
        const [x1, y1] = toSheet(attachment.triangles[t + ((corner + 1) % 3)]);
        raster.drawLine(x0, y0, x1, y1, 1, MESH_COLOR);
      }
    }
  }
}

function drawBones(raster: Raster, skeleton: Skeleton, view: number[]) {
  const toSheet = (x: number, y: number) => [view[0] * x + view[2] * y + view[4], view[1] * x + view[3] * y + view[5]];
  for (const bone of skeleton.data.bones) {
    const [x, y] = toSheet(skeleton.getWorldX(bone.index), skeleton.getWorldY(bone.index));
    const tip = skeleton.getBoneTip(bone.index);
    const [tipX, tipY] = toSheet(tip.x, tip.y);
    raster.drawLine(x, y, tipX, tipY, 2, BONE_COLOR);
    raster.fillDot(x, y, 3, BONE_COLOR);
  }
  for (const ik of skeleton.data.ik) {
    const [x, y] = toSheet(skeleton.getWorldX(ik.target), skeleton.getWorldY(ik.target));
    raster.fillDot(x, y, 4, TARGET_COLOR);
  }
  // Path attachments, as the curve a path constraint lays bones along.
  for (const slot of skeleton.data.slots) {
    const samples = skeleton.getPathSamples(slot.index);
    for (let i = 2; samples && i < samples.length; i += 2) {
      const [x0, y0] = toSheet(samples[i - 2], samples[i - 1]);
      const [x1, y1] = toSheet(samples[i], samples[i + 1]);
      raster.drawLine(x0, y0, x1, y1, 1, TARGET_COLOR);
    }
  }
}

/** Lists a folder's images with their size, opaque box, and likely joint points. */
function images(target: string) {
  let folder = path.resolve(rootDir, target);
  let used = new Set<string>();
  if (target.endsWith('.json')) {
    const rig = loadRig(target);
    folder = rig.folder;
    used = new Set(rig.data.imageNames);
  }
  if (!existsSync(folder)) {
    console.error(`[rig] no folder ${folder}`);
    process.exit(1);
  }
  const names = [...new Set(readdirSync(folder).filter(file => /\.(webp|png)$/.test(file)).map(file => file.replace(/\.(webp|png)$/, '')))].sort();
  console.log(`${folder}\nPixel coordinates are x right, y down, in the browser image's size (use them for "pivot" and "tip").`);
  for (const name of names) {
    const sizeFile = [`${name}.webp`, `${name}.png`].map(file => path.join(folder, file)).find(existsSync)!;
    const size = readImageSize(readFileSync(sizeFile));
    const bitmap = readBitmap(folder, name);
    if (!size || !bitmap) {
      console.log(`${name}: unreadable`);
      continue;
    }
    const scaleX = size.width / bitmap.width;
    const scaleY = size.height / bitmap.height;
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        if (bitmap.data[(y * bitmap.width + x) * 4 + 3] > 16) {
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
        }
      }
    }
    const box = [left * scaleX, top * scaleY, right * scaleX, bottom * scaleY].map(Math.round);
    const centerX = Math.round((box[0] + box[2]) / 2);
    const centerY = Math.round((box[1] + box[3]) / 2);
    console.log(
      `${name}${used.size > 0 ? (used.has(name) ? '' : ' (unused)') : ''}: ${size.width}x${size.height}, opaque box [${box.join(', ')}], ` +
        `top-center [${centerX}, ${box[1]}], bottom-center [${centerX}, ${box[3]}], left-center [${box[0]}, ${centerY}], right-center [${box[2]}, ${centerY}]`,
    );
  }
}

function bench(rigPath: string, flags: Flags) {
  const {data} = loadRig(rigPath);
  const count = Math.round(numberFlag(flags, 'count', 200));
  const animationName = typeof flags.anim === 'string' ? flags.anim : data.animations.find(animation => animation.loop)?.name;
  if (!animationName) {
    console.error('[rig] bench needs a looping animation, or --anim');
    process.exit(1);
  }
  const states = Array.from({length: count}, (_, i) => {
    const skeleton = new Skeleton(data);
    const state = new AnimationState(skeleton);
    state.setAnimation(0, animationName).trackTime = (i * 0.37) % 1;
    return state;
  });
  const frames = 600;
  const run = () => {
    for (let frame = 0; frame < frames; frame++) {
      for (const state of states) {
        updateRig(state, 1 / 60);
      }
    }
  };
  run();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  run();
  const elapsed = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  console.log(
    `${count} skeletons x ${frames} frames of "${animationName}" (${data.bones.length} bones, ${data.ik.length + data.transforms.length + data.physics.length} constraints): ` +
      `${round(elapsed / frames)} ms per frame, ${round((elapsed * 1000) / frames / count)} us per skeleton update, heap +${Math.round(heapGrowth / 1024)} KiB`,
  );
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

main();
