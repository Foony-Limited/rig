import {compileRig, getRigImageNames} from './compileRig.js';
import {AtlasEntry, getTintedName, getTintKey, makeTinted, packAtlas, RigImage, RigImages} from './imageAtlas.js';
import type {RigData} from './rigData.js';

/** A rig ready to draw: its compiled data and its loaded images. */
export type LoadedRig = {
  readonly data: RigData;
  /** The rig's images, packed into an atlas with baked tints. */
  readonly images: RigImages;
};

const cache = new Map<string, Promise<LoadedRig>>();

/**
 * Loads a rig and its images in the browser and compiles it. `source` is a URL to a
 * `*.rig.json`, or the parsed file (e.g. imported with `import hero from './hero.rig.json'`).
 * Images load from `/<images>/<name>.webp` on the page's origin, or with the rig's `atlas` set, from its prebuilt
 * atlas pages (see RigAtlasFile). A URL is loaded once per page and shared.
 *
 * Resolves with the rig. Rejects with a {@link RigCompileError} if the file is not valid, or an
 * Error naming the image that failed to load.
 *
 * @example
 * const hero = await loadRig('/rigs/hero.rig.json');
 * const skeleton = new Skeleton(hero.data);
 */
export function loadRig(source: string | object): Promise<LoadedRig> {
  if (typeof source !== 'string') {
    return loadParsed(source);
  }
  let loading = cache.get(source);
  if (!loading) {
    loading = fetch(source)
      .then(response => {
        if (!response.ok) {
          throw new Error(`[rig] ${source}: HTTP ${response.status}`);
        }
        return response.json();
      })
      .then(loadParsed);
    // Let a failed load try again next time instead of caching the failure.
    loading.catch(() => cache.delete(source));
    cache.set(source, loading);
  }
  return loading;
}

/** Options for {@link loadRigs}. */
export type LoadRigsOptions = {
  /**
   * Size the atlas stores each image at, as a share of its file's size. Store images no larger
   * than they are drawn: Chrome's 2D canvas draws about twice as slowly once its atlas pages pass
   * about 32 MB, and a cast of 8 detailed characters can be about 150 MB at full size. The rig's sizes and
   * anchors stay in the files' pixels. A prebuilt atlas keeps its pages' size.
   * @defaultValue 1
   */
  scale?: number;
};

/**
 * Loads several parsed rig files (see {@link loadRig}) and packs all their images into shared atlas
 * pages. A 2D canvas pays a setup cost for each distinct page it draws from in a frame, so a cast
 * drawn together should load together: 8 characters draw from 2 pages instead of 8.
 *
 * Resolves with the rigs in the order given. Rejects as {@link loadRig} does.
 *
 * @example
 * // Drawn at about a third of their painted size, so store them at half.
 * const cast = await loadRigs(characterFiles, {scale: 0.5});
 */
export async function loadRigs(files: readonly object[], options: LoadRigsOptions = {}): Promise<LoadedRig[]> {
  const rigs = await Promise.all(files.map(loadUnpacked));
  // Prefix each rig's entries with its place in the list, since rigs share image names.
  const entries = rigs.flatMap((rig, index) => getAtlasEntries(rig).map(entry => ({...entry, name: `${index}/${entry.name}`, group: index})));
  const atlas = packAtlas(entries, options.scale);
  return rigs.map(({data, originals, isPrebuilt}, index) => {
    const prefix = `${index}/`;
    const images = new Map<string, RigImage>(isPrebuilt ? originals : []);
    for (const [name, image] of atlas) {
      if (name.startsWith(prefix)) {
        images.set(name.slice(prefix.length), image);
      }
    }
    return {data, images};
  });
}

async function loadParsed(file: object): Promise<LoadedRig> {
  return (await loadRigs([file]))[0];
}

/**
 * A prebuilt atlas, as `foony-rig atlas` writes it next to a rig's images: its page images,
 * and per image name its place on a page (the trimmed art's box, in page pixels), the box its art
 * fills in the image (`trim`: left, top, right, bottom), and the image's full size.
 */
export type RigAtlasFile = {
  format: 'foony-rig-atlas@1';
  pages: string[];
  images: {[image: string]: {page: number; x: number; y: number; width: number; height: number; trim: [number, number, number, number]; size: [number, number]}};
};

/** A rig's compiled data and its images, before tints are baked. `isPrebuilt` if they come from a prebuilt atlas's pages. */
type UnpackedRig = {data: RigData; originals: ReadonlyMap<string, RigImage>; isPrebuilt: boolean};

/** Loads a rig file's images (or its prebuilt atlas, see RigAtlasFile) and compiles it. */
async function loadUnpacked(file: object): Promise<UnpackedRig> {
  const folder = (file as {images?: string}).images ?? '';
  const atlasName = (file as {atlas?: string}).atlas;
  if (typeof atlasName === 'string') {
    const response = await fetch(`/${folder}/${atlasName}.atlas.json`);
    if (!response.ok) {
      throw new Error(`[rig] atlas /${folder}/${atlasName}.atlas.json: HTTP ${response.status}`);
    }
    const atlas = (await response.json()) as RigAtlasFile;
    const pages = await Promise.all(atlas.pages.map(page => loadImage(`/${folder}/${page}`)));
    // Each image as its whole rectangle on the page: only its trimmed art is ever drawn, and that part is its own.
    const originals = new Map<string, RigImage>(
      Object.entries(atlas.images).map(([name, entry]) => [name, {source: pages[entry.page], x: entry.x - entry.trim[0], y: entry.y - entry.trim[1], width: entry.size[0], height: entry.size[1]}]),
    );
    const data = compileRig(file, name => {
      const entry = atlas.images[name];
      return entry && {width: entry.size[0], height: entry.size[1], trim: entry.trim};
    });
    return {data, originals, isPrebuilt: true};
  }
  // Compiling twice is cheap, and it keeps one place that knows where images are named.
  const names = getRigImageNames(file);
  const loaded = await Promise.all(names.map(name => loadImage(`/${folder}/${name}.webp`).then(image => [name, image] as const)));
  const originals = new Map<string, RigImage>(loaded.map(([name, image]) => [name, {source: image, x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight}]));
  const data = compileRig(file, name => {
    const image = originals.get(name);
    return image && {width: image.width, height: image.height};
  });
  return {data, originals, isPrebuilt: false};
}

/**
 * Lists what a rig's atlas holds: every image (unless they already sit on prebuilt pages), and a
 * tinted copy of each image a slot tints in the setup pose (the far limbs' shade).
 * Tints an animation keys later are made while drawing instead.
 */
function getAtlasEntries({data, originals, isPrebuilt}: UnpackedRig): AtlasEntry[] {
  const entries = new Map<string, AtlasEntry>();
  if (!isPrebuilt) {
    for (const [name, image] of originals) {
      entries.set(name, {name, source: image.source, width: image.width, height: image.height});
    }
  }
  for (const slot of data.slots) {
    for (const skin of [data.defaultSkin, ...data.skins]) {
      for (const attachment of skin.attachments[slot.index]) {
        if (attachment?.kind !== 'region' && attachment?.kind !== 'mesh') {
          continue;
        }
        const tintKey = getTintKey(slot.color[0] * attachment.color[0], slot.color[1] * attachment.color[1], slot.color[2] * attachment.color[2]);
        for (const image of attachment.images) {
          const name = getTintedName(image, tintKey);
          if (name !== image && !entries.has(name)) {
            const tinted = makeTinted(originals.get(image)!, tintKey);
            entries.set(name, {name, source: tinted, width: tinted.width, height: tinted.height});
          }
        }
      }
    }
  }
  return [...entries.values()];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`[rig] image ${url} did not load`));
    image.src = url;
  });
}
