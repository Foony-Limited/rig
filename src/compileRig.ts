import {DEG_RAD, updateBoneWorld} from './boneMath.js';
import {CURVE_NAMES, getCurveCode, writeBezierTable} from './curves.js';
import {
  AnimationData,
  Attachment,
  BEZIER_SAMPLES,
  BlendOperation,
  BONE_ROTATION,
  BONE_SCALE_X,
  BONE_SCALE_Y,
  BONE_SHEAR_X,
  BONE_SHEAR_Y,
  BONE_STRIDE,
  BONE_X,
  BONE_Y,
  BoneData,
  CONSTRAINT_KINDS_STRIDE,
  CURVE_BEZIER,
  CURVE_LINEAR,
  EventKey,
  getChainU,
  IkData,
  INHERIT_NO_ROTATION,
  INHERIT_NO_SCALE,
  INHERIT_NORMAL,
  INHERIT_ONLY_TRANSLATION,
  PhysicsData,
  RigData,
  MeshAttachment,
  SkinData,
  PathData,
  SliderData,
  SlotData,
  Timeline,
  TIMELINE_ALPHA,
  TIMELINE_ATTACHMENT,
  TIMELINE_BONE,
  TIMELINE_COLOR,
  TIMELINE_DARK,
  TIMELINE_DEFORM,
  TIMELINE_SEQUENCE,
  TIMELINE_IK_BEND,
  TIMELINE_IK_MIX,
  TIMELINE_PATH_MIX,
  TIMELINE_PATH_POSITION,
  TIMELINE_PATH_SPACING,
  TIMELINE_PHYSICS_MIX,
  TIMELINE_SLIDER_MIX,
  TIMELINE_SLIDER_TIME,
  TIMELINE_TRANSFORM_MIX,
  TransformData,
  TransformMap,
  UPDATE_IK,
  UPDATE_PHYSICS,
  UPDATE_PATH,
  UPDATE_SLIDER,
  UPDATE_TRANSFORM,
  WORLD_STRIDE,
} from './rigData.js';

/**
 * Turns a rig file (parsed JSON, see rigFormat.ts) into {@link RigData}. It checks everything
 * first and reports every problem at once, each with its JSON path, so an LLM can fix a whole
 * file in one pass instead of one error per run.
 *
 * Property ids (for crossfades, see {@link AnimationData.keyed}) are laid out as: bone properties,
 * then 6 per slot (attachment, color, alpha, dark, sequence, deform), 2 per IK (mix, bend), 1 per transform, 1 per
 * physics, 2 per slider (time, mix), then draw order.
 */

/** One problem in a rig file. */
export type RigProblem = {
  /** JSON path to the bad value, e.g. `animations.walk.bones.thighL.rotate[2]`. */
  path: string;
  message: string;
};

/** Thrown by {@link compileRig} with every problem found. The message lists them, one per line. */
export class RigCompileError extends Error {
  readonly problems: readonly RigProblem[];

  constructor(name: string, problems: readonly RigProblem[]) {
    super(`[rig] ${name}: ${problems.length} problem(s)\n${problems.map(problem => `${problem.path}: ${problem.message}`).join('\n')}`);
    this.problems = problems;
  }
}

/**
 * An image's size in pixels. A prebuilt atlas also gives `trim`, the box its art fills (left, top,
 * right, bottom): regions and mesh grids then cover only that box.
 */
export type RigImageSize = {readonly width: number; readonly height: number; readonly trim?: readonly [number, number, number, number]};

/**
 * Compiles a parsed rig file. `getImageSize` returns the size of an image by name (as the
 * browser loads it), or undefined if there is no such image.
 *
 * Throws {@link RigCompileError} listing every problem if the file is not valid.
 *
 * @example
 * const data = compileRig(await (await fetch('/rigs/hero.rig.json')).json(), name => sizes.get(name));
 */
export function compileRig(file: unknown, getImageSize: (image: string) => RigImageSize | undefined): RigData {
  const compiler = new Compiler(getImageSize);
  const data = compiler.compile(file);
  if (compiler.problems.length > 0 || !data) {
    throw new RigCompileError(isRecord(file) && typeof file.name === 'string' ? file.name : 'rig', compiler.problems);
  }
  return data;
}

/** A stand-in image size larger than any real image, so every size check passes when sizes aren't known yet. */
const UNKNOWN_IMAGE_SIZE: RigImageSize = {width: 1e6, height: 1e6};

/**
 * Returns the names of every image a parsed rig file uses, before its images are loaded, so a
 * loader knows what to fetch. Throws {@link RigCompileError} if the file is not valid apart from
 * image sizes.
 */
export function getRigImageNames(file: unknown): readonly string[] {
  return compileRig(file, () => UNKNOWN_IMAGE_SIZE).imageNames;
}

/** Returns the property id of a bone property. */
function boneProperty(bone: number, property: number): number {
  return bone * BONE_STRIDE + property;
}

const BONE_PROPERTIES: {readonly [name: string]: number} = {
  x: BONE_X,
  y: BONE_Y,
  rotate: BONE_ROTATION,
  scaleX: BONE_SCALE_X,
  scaleY: BONE_SCALE_Y,
  shearX: BONE_SHEAR_X,
  shearY: BONE_SHEAR_Y,
};

/** The properties transform constraints and slider drivers may use. */
const MAPPABLE_PROPERTIES = ['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY'];

/** Bone key names with two values, and the scalar properties they split into. */
const BONE_PAIRS: {readonly [name: string]: readonly [string, string]} = {
  translate: ['x', 'y'],
  scale: ['scaleX', 'scaleY'],
  shear: ['shearX', 'shearY'],
};

const INHERITS: {readonly [name: string]: number} = {
  normal: INHERIT_NORMAL,
  noRotation: INHERIT_NO_ROTATION,
  noScale: INHERIT_NO_SCALE,
  onlyTranslation: INHERIT_ONLY_TRANSLATION,
};

const BLENDS: {readonly [name: string]: BlendOperation} = {
  normal: 'source-over',
  add: 'lighter',
  multiply: 'multiply',
  screen: 'screen',
};

/** Flipbook mode names, by `SEQUENCE_*` code. */
const SEQUENCE_MODES = ['loop', 'once', 'pingpong', 'hold', 'loopReverse', 'onceReverse', 'pingpongReverse'];

type Json = {[key: string]: unknown};

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScaleProperty(property: number): boolean {
  return property === BONE_SCALE_X || property === BONE_SCALE_Y;
}

/** Returns the edit distance between two strings, for "did you mean" hints. */
function editDistance(a: string, b: string): number {
  const row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

/** Returns " Did you mean "x"?" for the closest of `names`, or "" if none is close. */
function suggest(name: string, names: Iterable<string>): string {
  let best = '';
  let bestDistance = Infinity;
  for (const candidate of names) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= Math.max(2, name.length / 3) ? ` Did you mean "${best}"?` : '';
}

/** Parses "#rrggbb" or "#rrggbbaa" into 0..1 channels, or null if it isn't one. */
function parseColor(value: unknown): [number, number, number, number] | null {
  if (typeof value !== 'string' || !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) {
    return null;
  }
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16) / 255;
  return [channel(1), channel(3), channel(5), value.length === 9 ? channel(7) : 1];
}

const WHITE: [number, number, number, number] = [1, 1, 1, 1];
/** Property ids per slot: attachment, color, alpha, dark, sequence, deform. */
const SLOT_PROPERTIES = 6;
const BLACK: [number, number, number, number] = [0, 0, 0, 1];

/** Keys for one scalar property, gathered before they become a {@link Timeline}. */
type ScalarKeys = {times: number[]; values: number[]; curves: unknown[]; paths: string[]};

class Compiler {
  readonly problems: RigProblem[] = [];
  private readonly getImageSize: (image: string) => RigImageSize | undefined;
  private readonly imageNames = new Set<string>();
  private bones: BoneData[] = [];
  private boneIndex = new Map<string, number>();
  private setup = new Float64Array(0);
  private setupWorld = new Float64Array(0);
  private slots: SlotData[] = [];
  private slotIndex = new Map<string, number>();
  private ikIndex = new Map<string, number>();
  private transformIndex = new Map<string, number>();
  private physicsIndex = new Map<string, number>();
  private sliderIndex = new Map<string, number>();
  private pathIndex = new Map<string, number>();
  /** Bones with a `skin`, resolved once the skins are compiled. */
  private boneSkins: {bone: number; name: unknown; path: string}[] = [];
  /** The default skin, then the named skins, once compiled: shape keys find their mesh here. */
  private skinList: SkinData[] = [];
  /** Each constraint's `order`, by update kind then index. */
  private constraintOrders: number[][] = [[], [], [], [], []];
  private animationIndex = new Map<string, number>();
  private eventDefaults = new Map<string, {int: number; float: number; string: string}>();
  private poses = new Map<string, Json>();
  private propertyBase = {slot: 0, ik: 0, transform: 0, physics: 0, slider: 0, path: 0, drawOrder: 0, count: 0};

  constructor(getImageSize: (image: string) => RigImageSize | undefined) {
    this.getImageSize = getImageSize;
  }

  compile(file: unknown): RigData | null {
    if (!isRecord(file)) {
      this.fail('', 'a rig file is a JSON object');
      return null;
    }
    if (file.format !== 'foony-rig@1') {
      this.fail('format', 'must be "foony-rig@1"');
    }
    const name = this.string(file, 'name', 'name') ?? 'rig';
    const images = this.string(file, 'images', 'images') ?? '';
    this.compileBones(file.bones);
    if (this.bones.length === 0) {
      return null;
    }
    this.compileSlotsHeader(file.slots);
    // Constraint and animation names first: keys, sliders, and each other refer to them.
    this.indexNames(file.ik, 'ik', this.ikIndex);
    this.indexNames(file.transforms, 'transforms', this.transformIndex);
    this.indexNames(file.physics, 'physics', this.physicsIndex);
    this.indexNames(file.sliders, 'sliders', this.sliderIndex);
    this.indexNames(file.paths, 'paths', this.pathIndex);
    if (file.animations !== undefined && !isRecord(file.animations)) {
      this.fail('animations', 'must be an object of animations by name');
    }
    const animationsJson = isRecord(file.animations) ? file.animations : {};
    Object.keys(animationsJson).forEach((animation, index) => this.animationIndex.set(animation, index));

    const base = this.propertyBase;
    base.slot = this.bones.length * BONE_STRIDE;
    base.ik = base.slot + this.slots.length * SLOT_PROPERTIES;
    base.transform = base.ik + this.ikIndex.size * 2;
    base.physics = base.transform + this.transformIndex.size;
    base.slider = base.physics + this.physicsIndex.size;
    base.path = base.slider + this.sliderIndex.size * 2;
    base.drawOrder = base.path + this.pathIndex.size * 3;
    base.count = base.drawOrder + 1;

    const {defaultSkin, skins} = this.compileSkins(file);
    this.skinList = [defaultSkin, ...skins];
    const skinNames = skins.map(skin => skin.name);
    for (const {bone, name, path} of this.boneSkins) {
      const skin = typeof name === 'string' ? skinNames.indexOf(name) : -1;
      if (skin === -1) {
        this.fail(path, `no skin ${JSON.stringify(name)}.${typeof name === 'string' ? suggest(name, skinNames) : ''}`);
      }
      this.bones[bone] = {...this.bones[bone], skin};
    }
    const ik = this.compileIk(file.ik);
    const transforms = this.compileTransforms(file.transforms);
    const physics = this.compilePhysics(file.physics);
    const sliders = this.compileSliders(file.sliders);
    const paths = this.compilePaths(file.paths);
    this.compileEvents(file.events);
    this.compilePoses(file.poses);
    const animations = Object.entries(animationsJson).map(([animation, json], index) =>
      this.compileAnimation(animation, index, json),
    );
    const mixes = this.compileMixes(file.mixes);
    const world = isRecord(file.world) ? file.world : {};
    return {
      name,
      images,
      bones: this.bones,
      setup: this.setup,
      setupWorld: this.setupWorld,
      slots: this.slots,
      defaultSkin,
      skins,
      ik,
      transforms,
      physics,
      sliders,
      paths,
      animations,
      mixes,
      defaultMix: this.number(file, 'defaultMix', 'defaultMix', 0.1, 0),
      gravity: this.number(world, 'gravity', 'world.gravity', 0),
      wind: this.number(world, 'wind', 'world.wind', 0),
      updateOrder: this.computeUpdateOrder(ik, transforms, physics, sliders, paths, animations),
      propertyCount: base.count,
      imageNames: [...this.imageNames],
    };
  }

  private fail(path: string, message: string) {
    this.problems.push({path, message});
  }

  private string(json: Json, key: string, path: string): string | undefined {
    const value = json[key];
    if (typeof value !== 'string' || value === '') {
      this.fail(path, 'must be a non-empty string');
      return undefined;
    }
    return value;
  }

  /** Reads an optional number, failing if it's present but not a finite number in range. */
  private number(json: Json, key: string, path: string, fallback: number, min = -Infinity, max = Infinity): number {
    const value = json[key];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      const range = min > -Infinity || max < Infinity ? ` from ${min} to ${max}` : '';
      this.fail(path, `must be a number${range}, got ${JSON.stringify(value)}`);
      return fallback;
    }
    return value;
  }

  private boolean(json: Json, key: string, path: string): boolean {
    const value = json[key];
    if (value !== undefined && typeof value !== 'boolean') {
      this.fail(path, `must be true or false, got ${JSON.stringify(value)}`);
    }
    return value === true;
  }

  /** Looks a name up, failing with a suggestion if it's unknown. */
  private find(names: ReadonlyMap<string, number>, name: unknown, path: string, kind: string): number {
    if (typeof name !== 'string') {
      this.fail(path, `must be a ${kind} name`);
      return -1;
    }
    const index = names.get(name);
    if (index === undefined) {
      this.fail(path, `no ${kind} "${name}".${suggest(name, names.keys())}`);
      return -1;
    }
    return index;
  }

  /** Warns about keys an object has that the format doesn't, so a typo'd key isn't silently ignored. */
  private checkKeys(json: Json, path: string, allowed: readonly string[]) {
    for (const key of Object.keys(json)) {
      if (!allowed.includes(key)) {
        this.fail(`${path}${path ? '.' : ''}${key}`, `unknown field.${suggest(key, allowed)}`);
      }
    }
  }

  private indexNames(list: unknown, path: string, names: Map<string, number>) {
    if (list === undefined) {
      return;
    }
    if (!Array.isArray(list)) {
      this.fail(path, 'must be an array');
      return;
    }
    list.forEach((item, index) => {
      const name = isRecord(item) ? item.name : undefined;
      if (typeof name !== 'string' || name === '') {
        this.fail(`${path}[${index}].name`, 'must be a non-empty string');
      } else if (names.has(name)) {
        this.fail(`${path}[${index}].name`, `"${name}" is used twice`);
      } else {
        names.set(name, index);
      }
    });
  }

  private compileBones(json: unknown) {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail('bones', 'must be a non-empty array, the root bone first');
      return;
    }
    this.setup = new Float64Array(json.length * BONE_STRIDE);
    json.forEach((bone, index) => {
      const path = `bones[${index}]`;
      if (!isRecord(bone)) {
        this.fail(path, 'must be an object');
        // A stand-in no name can find keeps every later bone at its own index.
        this.bones.push({index, name: `#${index}`, parent: index === 0 ? -1 : 0, length: 0, inherit: INHERIT_NORMAL, limits: null, skin: -1});
        return;
      }
      this.checkKeys(bone, path, ['name', 'parent', 'x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearX', 'shearY', 'length', 'inherit', 'limits', 'skin']);
      if (bone.skin !== undefined) {
        this.boneSkins.push({bone: index, name: bone.skin, path: `${path}.skin`});
      }
      const name = this.string(bone, 'name', `${path}.name`) ?? `#${index}`;
      if (this.boneIndex.has(name)) {
        this.fail(`${path}.name`, `"${name}" is used twice`);
      }
      let parent = -1;
      if (index === 0 && bone.parent !== undefined) {
        this.fail(`${path}.parent`, 'the first bone is the root and has no parent');
      } else if (index > 0) {
        if (bone.parent === undefined) {
          this.fail(`${path}.parent`, 'every bone but the first needs a parent');
        } else if (typeof bone.parent === 'string' && !this.boneIndex.has(bone.parent) && json.some(other => isRecord(other) && other.name === bone.parent)) {
          this.fail(`${path}.parent`, `"${bone.parent}" must come before "${name}" in bones`);
        } else {
          parent = Math.max(0, this.find(this.boneIndex, bone.parent, `${path}.parent`, 'bone'));
        }
      }
      const inheritName = bone.inherit ?? 'normal';
      const inherit = INHERITS[inheritName as string];
      if (inherit === undefined) {
        this.fail(`${path}.inherit`, `must be one of ${Object.keys(INHERITS).join(', ')}`);
      }
      let limits: [number, number] | null = null;
      if (bone.limits !== undefined) {
        const value = bone.limits;
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number' || value[0] > value[1]) {
          this.fail(`${path}.limits`, 'must be [min, max] in degrees');
        } else {
          limits = [value[0], value[1]];
        }
      }
      const p = index * BONE_STRIDE;
      this.setup[p + BONE_X] = this.number(bone, 'x', `${path}.x`, 0);
      this.setup[p + BONE_Y] = this.number(bone, 'y', `${path}.y`, 0);
      this.setup[p + BONE_ROTATION] = this.number(bone, 'rotation', `${path}.rotation`, 0);
      this.setup[p + BONE_SCALE_X] = this.number(bone, 'scaleX', `${path}.scaleX`, 1);
      this.setup[p + BONE_SCALE_Y] = this.number(bone, 'scaleY', `${path}.scaleY`, 1);
      this.setup[p + BONE_SHEAR_X] = this.number(bone, 'shearX', `${path}.shearX`, 0);
      this.setup[p + BONE_SHEAR_Y] = this.number(bone, 'shearY', `${path}.shearY`, 0);
      this.boneIndex.set(name, index);
      this.bones.push({
        index,
        name,
        parent,
        length: this.number(bone, 'length', `${path}.length`, 0, 0),
        inherit: inherit ?? INHERIT_NORMAL,
        limits,
        skin: -1,
      });
    });
    this.setupWorld = new Float64Array(this.bones.length * WORLD_STRIDE);
    for (let i = 0; i < this.bones.length; i++) {
      updateBoneWorld(this.bones, this.setup, this.setupWorld, i);
    }
  }

  /** Reads the slot list (names, bones, colors). Attachments come later with the skins. */
  private compileSlotsHeader(json: unknown) {
    if (!Array.isArray(json)) {
      this.fail('slots', 'must be an array, back to front');
      return;
    }
    json.forEach((slot, index) => {
      const path = `slots[${index}]`;
      if (!isRecord(slot)) {
        this.fail(path, 'must be an object');
        // A stand-in no name can find keeps every later slot at its own index.
        this.slots.push({index, name: `#${index}`, bone: 0, attachmentNames: [], setupAttachment: -1, color: WHITE, dark: [0, 0, 0], blend: 'source-over'});
        return;
      }
      this.checkKeys(slot, path, ['name', 'bone', 'attachment', 'color', 'dark', 'blend', 'attachments']);
      const name = this.string(slot, 'name', `${path}.name`) ?? `#${index}`;
      if (this.slotIndex.has(name)) {
        this.fail(`${path}.name`, `"${name}" is used twice`);
      }
      this.slotIndex.set(name, index);
      const color = slot.color === undefined ? WHITE : parseColor(slot.color);
      if (!color) {
        this.fail(`${path}.color`, 'must be "#rrggbb" or "#rrggbbaa"');
      }
      const dark = slot.dark === undefined ? BLACK : parseColor(slot.dark);
      if (!dark) {
        this.fail(`${path}.dark`, 'must be "#rrggbb"');
      }
      const blend = BLENDS[(slot.blend ?? 'normal') as string];
      if (!blend) {
        this.fail(`${path}.blend`, `must be one of ${Object.keys(BLENDS).join(', ')}`);
      }
      this.slots.push({
        index,
        name,
        bone: Math.max(0, this.find(this.boneIndex, slot.bone, `${path}.bone`, 'bone')),
        attachmentNames: [],
        setupAttachment: -1,
        color: color ?? WHITE,
        dark: [(dark ?? BLACK)[0], (dark ?? BLACK)[1], (dark ?? BLACK)[2]],
        blend: blend ?? 'source-over',
      });
    });
  }

  private compileSkins(file: Json): {defaultSkin: SkinData; skins: SkinData[]} {
    const slotsJson = Array.isArray(file.slots) ? file.slots : [];
    const skinsJson = file.skins === undefined ? {} : file.skins;
    if (!isRecord(skinsJson)) {
      this.fail('skins', 'must be an object of skins by name');
    }
    const skinEntries = Object.entries(isRecord(skinsJson) ? skinsJson : {});
    // Attachment names per slot: the slot's own, then each skin's, in order of first use.
    const names = this.slots.map(() => [] as string[]);
    const addName = (slot: number, name: string) => {
      if (!names[slot].includes(name)) {
        names[slot].push(name);
      }
    };
    slotsJson.forEach((slot, index) => {
      if (isRecord(slot) && slot.attachments !== undefined) {
        if (!isRecord(slot.attachments)) {
          this.fail(`slots[${index}].attachments`, 'must be an object of attachments by name');
          return;
        }
        Object.keys(slot.attachments).forEach(name => addName(index, name));
      }
    });
    for (const [skin, slots] of skinEntries) {
      if (!isRecord(slots)) {
        this.fail(`skins.${skin}`, 'must be an object: slot name to attachment name to attachment');
        continue;
      }
      for (const [slotName, attachments] of Object.entries(slots)) {
        const slot = this.find(this.slotIndex, slotName, `skins.${skin}.${slotName}`, 'slot');
        if (slot === -1) {
          continue;
        }
        if (!isRecord(attachments)) {
          this.fail(`skins.${skin}.${slotName}`, 'must be an object of attachments by name');
          continue;
        }
        Object.keys(attachments).forEach(name => addName(slot, name));
      }
    }
    this.slots = this.slots.map((slot, index) => {
      const json = slotsJson[index];
      let setupAttachment = -1;
      if (isRecord(json) && json.attachment !== undefined) {
        setupAttachment = names[index].indexOf(json.attachment as string);
        if (setupAttachment === -1) {
          this.fail(`slots[${index}].attachment`, `no attachment "${json.attachment}" on slot "${slot.name}" in any skin.${suggest(String(json.attachment), names[index])}`);
        }
      }
      return {...slot, attachmentNames: names[index], setupAttachment};
    });

    const compileSkin = (name: string, bySlot: (slot: number) => {json: unknown; path: string} | undefined): SkinData => ({
      name,
      attachments: this.slots.map((slot, index) => {
        const entry = bySlot(index);
        const result: (Attachment | undefined)[] = slot.attachmentNames.map(() => undefined);
        if (entry && isRecord(entry.json)) {
          for (const [attachmentName, attachment] of Object.entries(entry.json)) {
            result[slot.attachmentNames.indexOf(attachmentName)] = this.compileAttachment(slot, attachmentName, attachment, `${entry.path}.${attachmentName}`);
          }
        }
        return result;
      }),
    });
    const defaultSkin = compileSkin('default', index => {
      const json = slotsJson[index];
      return isRecord(json) ? {json: json.attachments, path: `slots[${index}].attachments`} : undefined;
    });
    const skins = skinEntries
      .filter(([, slots]) => isRecord(slots))
      .map(([skin, slots]) =>
        compileSkin(skin, index => {
          const slotName = this.slots[index].name;
          const json = (slots as Json)[slotName];
          return json === undefined ? undefined : {json, path: `skins.${skin}.${slotName}`};
        }),
      );
    return {defaultSkin, skins};
  }

  private imageSize(image: unknown, path: string): RigImageSize | undefined {
    if (typeof image !== 'string' || image === '') {
      this.fail(path, 'must be an image name');
      return undefined;
    }
    this.imageNames.add(image);
    const size = this.getImageSize(image);
    if (!size) {
      this.fail(path, `no image "${image}" in the rig's images folder`);
    }
    return size;
  }

  private point(value: unknown, path: string): [number, number] | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
      this.fail(path, 'must be [x, y]');
      return undefined;
    }
    return [value[0], value[1]];
  }

  private polygon(json: Json, path: string): Float64Array {
    const points = json.points;
    if (!Array.isArray(points) || points.length < 3) {
      this.fail(`${path}.points`, 'must be at least 3 [x, y] corners');
      return new Float64Array(0);
    }
    const result = new Float64Array(points.length * 2);
    points.forEach((point, index) => {
      const [x, y] = this.point(point, `${path}.points[${index}]`) ?? [0, 0];
      result[index * 2] = x;
      result[index * 2 + 1] = y;
    });
    return result;
  }

  /**
   * Returns the matrix that takes image pixels into the bone's space: the pivot pixel lands on
   * (x, y), the image turns by `rotation` and scales by `scale`, and image y (down) becomes bone
   * y (up). With `tip`, rotation and scale are solved so the tip pixel lands on `tipTarget` (in
   * the bone's space, measured from the pivot's spot).
   */
  private placement(json: Json, path: string, width: number, height: number, tipTarget: [number, number] | null): [number, number, number, number, number, number] {
    const pivot = this.point(json.pivot, `${path}.pivot`) ?? [width / 2, height / 2];
    const tip = this.point(json.tip, `${path}.tip`);
    const flip = this.boolean(json, 'flipX', `${path}.flipX`) ? -1 : 1;
    let rotation = this.number(json, 'rotation', `${path}.rotation`, 0) * DEG_RAD;
    let scale = this.number(json, 'scale', `${path}.scale`, 1, 0);
    if (tip) {
      if (json.rotation !== undefined || json.scale !== undefined) {
        this.fail(`${path}.tip`, 'use tip or rotation/scale, not both');
      }
      const dx = (tip[0] - pivot[0]) * flip;
      const dy = -(tip[1] - pivot[1]);
      const distance = Math.hypot(dx, dy);
      if (!tipTarget) {
        this.fail(`${path}.tip`, "the slot's bone needs a length to fit a tip to");
      } else if (distance === 0) {
        this.fail(`${path}.tip`, 'must differ from pivot');
      } else {
        rotation = Math.atan2(tipTarget[1], tipTarget[0]) - Math.atan2(dy, dx);
        scale = Math.hypot(tipTarget[0], tipTarget[1]) / distance;
      }
    }
    const cos = Math.cos(rotation) * scale;
    const sin = Math.sin(rotation) * scale;
    // Columns: image x (times the flip) turned and scaled, and image y flipped up, turned and scaled.
    const a = cos * flip;
    const b = sin * flip;
    const c = sin;
    const d = -cos;
    const x = this.number(json, 'x', `${path}.x`, 0);
    const y = this.number(json, 'y', `${path}.y`, 0);
    return [a, b, c, d, x - (a * pivot[0] + c * pivot[1]), y - (b * pivot[0] + d * pivot[1])];
  }

  private compileAttachment(slot: SlotData, name: string, json: unknown, path: string): Attachment | undefined {
    if (!isRecord(json)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    const type = json.type ?? 'region';
    const boneLength = this.bones[slot.bone].length;
    let tipTarget: [number, number] | null = boneLength > 0 ? [boneLength, 0] : null;
    if (type === 'mesh' && Array.isArray(json.bones) && json.bones.length > 0) {
      // A mesh's tip lands on the tip of the last bone it bends with, so one image spans the chain.
      const last = this.boneIndex.get(json.bones[json.bones.length - 1] as string);
      if (last !== undefined) {
        tipTarget = this.setupTipInBone(last, slot.bone);
      }
    }
    const placementKeys = ['type', 'image', 'pivot', 'tip', 'x', 'y', 'rotation', 'scale', 'flipX', 'color'];
    if (type === 'region' || type === 'mesh') {
      const image = (json.image ?? name) as string;
      const size = this.imageSize(image, `${path}.image`);
      const color = json.color === undefined ? WHITE : parseColor(json.color);
      if (!color) {
        this.fail(`${path}.color`, 'must be "#rrggbb" or "#rrggbbaa"');
      }
      if (!size) {
        return undefined;
      }
      const matrix = this.placement(json, path, size.width, size.height, tipTarget);
      if (type === 'mesh') {
        this.checkKeys(json, path, [...placementKeys, 'grid', 'points', 'outline', 'triangles', 'paint', 'bones', 'smooth', 'frames', 'fps', 'mode']);
        return this.compileMesh(slot, name, json, path, image, size, matrix, color ?? WHITE);
      }
      this.checkKeys(json, path, [...placementKeys, 'frames', 'fps', 'mode', 'crop']);
      const flipbook = this.compileFlipbook(json, path, image, size);
      // A trimmed image draws only its art's box, so nothing reads past it on an atlas page.
      const trim = size.trim ?? [0, 0, size.width, size.height];
      let crop: [number, number, number, number] = [trim[0], trim[1], trim[2], trim[3]];
      if (json.crop !== undefined) {
        const value = json.crop;
        if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === 'number') || value[0] < 0 || value[1] < 0 || value[2] > size.width || value[3] > size.height || value[0] >= value[2] || value[1] >= value[3]) {
          this.fail(`${path}.crop`, `must be [left, top, right, bottom] inside the ${size.width}x${size.height} image, left < right and top < bottom`);
        } else {
          crop = [Math.max(trim[0], value[0]), Math.max(trim[1], value[1]), Math.min(trim[2], value[2]), Math.min(trim[3], value[3])];
        }
      }
      return {
        kind: 'region',
        name,
        width: size.width,
        height: size.height,
        matrix,
        crop,
        color: color ?? WHITE,
        ...flipbook,
      };
    }
    if (type === 'clip') {
      this.checkKeys(json, path, ['type', 'points', 'end', 'inverse']);
      const endSlot = json.end === undefined ? this.slots.length - 1 : this.find(this.slotIndex, json.end, `${path}.end`, 'slot');
      if (endSlot !== -1 && endSlot < slot.index) {
        this.fail(`${path}.end`, `"${json.end}" draws before "${slot.name}", so there is nothing to clip`);
      }
      return {kind: 'clip', name, points: this.polygon(json, path), endSlot: Math.max(endSlot, slot.index), inverse: this.boolean(json, 'inverse', `${path}.inverse`)};
    }
    if (type === 'point') {
      this.checkKeys(json, path, ['type', 'x', 'y', 'rotation']);
      return {
        kind: 'point',
        name,
        x: this.number(json, 'x', `${path}.x`, 0),
        y: this.number(json, 'y', `${path}.y`, 0),
        rotation: this.number(json, 'rotation', `${path}.rotation`, 0),
      };
    }
    if (type === 'box') {
      this.checkKeys(json, path, ['type', 'points']);
      return {kind: 'box', name, points: this.polygon(json, path)};
    }
    if (type === 'path') {
      this.checkKeys(json, path, ['type', 'points', 'closed', 'bones']);
      return this.compilePathAttachment(slot, name, json, path);
    }
    this.fail(`${path}.type`, 'must be one of region, mesh, clip, point, box, path');
    return undefined;
  }

  /**
   * Builds a grid mesh and weights each grid point to the nearest bones of `bones` by distance along
   * each bone (see distanceAlongSegment) in the setup pose: a point follows every bone whose distance
   * is within `smooth` of the nearest, weighted (1 - extra distance / smooth) squared, up to 4 bones.
   */
  /** Reads an attachment's flipbook fields: its images (`image`, or every one of `frames`), fps, and mode code. */
  private compileFlipbook(json: Json, path: string, image: string, size: RigImageSize): {images: string[]; fps: number; mode: number} {
    let images = [image];
    if (json.frames !== undefined) {
      if (!Array.isArray(json.frames) || json.frames.length === 0) {
        this.fail(`${path}.frames`, 'must be a non-empty array of image names');
      } else {
        images = json.frames as string[];
        images.forEach((frame, index) => {
          const frameSize = this.imageSize(frame, `${path}.frames[${index}]`);
          if (frameSize && (frameSize.width !== size.width || frameSize.height !== size.height)) {
            this.fail(`${path}.frames[${index}]`, `is ${frameSize.width}x${frameSize.height}, but "${image}" is ${size.width}x${size.height}. Frames must match it`);
          }
        });
      }
    }
    const mode = SEQUENCE_MODES.indexOf((json.mode ?? 'loop') as string);
    if (mode === -1) {
      this.fail(`${path}.mode`, `must be one of ${SEQUENCE_MODES.join(', ')}`);
    }
    return {images, fps: this.number(json, 'fps', `${path}.fps`, 12, 0.001), mode: Math.max(0, mode)};
  }

  private compileMesh(
    slot: SlotData,
    name: string,
    json: Json,
    path: string,
    image: string,
    size: RigImageSize,
    matrix: [number, number, number, number, number, number],
    color: [number, number, number, number],
  ): Attachment {
    let columns = 4;
    let rows = 4;
    if (json.grid !== undefined) {
      const grid = json.grid;
      if (!Array.isArray(grid) || grid.length !== 2 || !grid.every(value => Number.isInteger(value) && value >= 1 && value <= 64)) {
        this.fail(`${path}.grid`, 'must be [columns, rows], whole numbers from 1 to 64');
      } else {
        [columns, rows] = grid as [number, number];
      }
    }
    let influenceBones = [slot.bone];
    if (json.bones !== undefined) {
      if (!Array.isArray(json.bones) || json.bones.length === 0) {
        this.fail(`${path}.bones`, 'must be a non-empty array of bone names');
      } else {
        influenceBones = json.bones.map((bone, index) => Math.max(0, this.find(this.boneIndex, bone, `${path}.bones[${index}]`, 'bone')));
      }
    }
    const averageLength = influenceBones.reduce((sum, bone) => sum + this.bones[bone].length, 0) / influenceBones.length;
    const smooth = this.number(json, 'smooth', `${path}.smooth`, Math.max(averageLength / 4, 1), 0.0001);

    const w = slot.bone * WORLD_STRIDE;
    const world = this.setupWorld;
    // Each influence bone's setup segment, origin to tip, in world space.
    const segments = influenceBones.map(bone => {
      const q = bone * WORLD_STRIDE;
      const length = this.bones[bone].length;
      return {bone, x0: world[q + 4], y0: world[q + 5], x1: world[q + 4] + world[q] * length, y1: world[q + 5] + world[q + 1] * length};
    });
    // The image's setup placement in skeleton space, and where the chain's joints fall in the image.
    const bindMatrix: [number, number, number, number, number, number] = [
      world[w] * matrix[0] + world[w + 2] * matrix[1],
      world[w + 1] * matrix[0] + world[w + 3] * matrix[1],
      world[w] * matrix[2] + world[w + 2] * matrix[3],
      world[w + 1] * matrix[2] + world[w + 3] * matrix[3],
      world[w] * matrix[4] + world[w + 2] * matrix[5] + world[w + 4],
      world[w + 1] * matrix[4] + world[w + 3] * matrix[5] + world[w + 5],
    ];
    const bindDeterminant = bindMatrix[0] * bindMatrix[3] - bindMatrix[2] * bindMatrix[1];
    const toImage = (x: number, y: number): [number, number] => {
      const dx = x - bindMatrix[4];
      const dy = y - bindMatrix[5];
      return [(bindMatrix[3] * dx - bindMatrix[2] * dy) / bindDeterminant, (bindMatrix[0] * dy - bindMatrix[1] * dx) / bindDeterminant];
    };
    const chainStart = toImage(segments[0].x0, segments[0].y0);
    const chainEnd = toImage(segments[segments.length - 1].x1, segments[segments.length - 1].y1);
    // A 2D canvas can draw a chain as rigid pieces cut along image rows only if the chain runs down the rows.
    const isAlongRows = Math.abs(chainEnd[0] - chainStart[0]) <= Math.abs(chainEnd[1] - chainStart[1]) * 0.35;
    const joints = isAlongRows && segments.length > 1 ? Float32Array.from([...chainStart, ...segments.slice(1).flatMap(segment => toImage(segment.x0, segment.y0)), ...chainEnd]) : null;
    // A chain running down the rows gets extra rows at each joint and half and one blend width either
    // side of it, so the bend there is a smooth curve instead of one kink across a tall cell.
    // The grid covers the image, or only its art's box when an atlas trimmed it.
    const [gridLeft, gridTop, gridRight, gridBottom] = size.trim ?? [0, 0, size.width, size.height];
    const rowVs = Array.from({length: rows + 1}, (_, row) => gridTop + (row / rows) * (gridBottom - gridTop));
    // How wide the bend between two of the chain's bones is, in world units: `smooth`, capped by the shorter bone.
    const blendWidth = (first: number, second: number) => Math.min(smooth, JOINT_BLEND_CAP * Math.min(this.bones[first].length, this.bones[second].length));
    if (joints) {
      const unitsPerPixel = Math.hypot(matrix[2], matrix[3]);
      for (let k = 2; k < joints.length - 2; k += 2) {
        const blend = blendWidth(segments[k / 2 - 1].bone, segments[k / 2].bone) / unitsPerPixel;
        for (const step of [-1, -0.5, 0, 0.5, 1]) {
          rowVs.push(joints[k + 1] + step * blend);
        }
      }
    }
    // Corners: listed points, or a grid with rows kept inside the image, dropping any too close to
    // the row before (a cell under 1.5% of the image's height).
    const points = this.meshPoints(json, path, size);
    const gridHeight = gridBottom - gridTop;
    const keptRows = [gridTop];
    for (const v of rowVs.filter(v => v > gridTop && v < gridBottom).sort((first, second) => first - second)) {
      if (v - keptRows[keptRows.length - 1] > gridHeight * MIN_ROW_GAP && gridBottom - v > gridHeight * MIN_ROW_GAP) {
        keptRows.push(v);
      }
    }
    keptRows.push(gridBottom);
    const gridRows = points ? 0 : keptRows.length - 1;
    const gridColumns = points ? 0 : columns;
    const vertexCount = points ? points.length : (columns + 1) * (gridRows + 1);
    const uvs = new Float32Array(vertexCount * 2);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      uvs[vertex * 2] = points ? points[vertex].at[0] : gridLeft + ((vertex % (columns + 1)) / columns) * (gridRight - gridLeft);
      uvs[vertex * 2 + 1] = points ? points[vertex].at[1] : keptRows[Math.floor(vertex / (columns + 1))];
    }
    const paint = this.meshPaint(json, path);
    const weights: number[] = [];
    const bindPositions = new Float32Array(vertexCount * 2);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const u = uvs[vertex * 2];
      const v = uvs[vertex * 2 + 1];
      // Image pixel to slot bone space to world space.
      const boneX = matrix[0] * u + matrix[2] * v + matrix[4];
      const boneY = matrix[1] * u + matrix[3] * v + matrix[5];
      const worldX = world[w] * boneX + world[w + 2] * boneY + world[w + 4];
      const worldY = world[w + 1] * boneX + world[w + 3] * boneY + world[w + 5];
      bindPositions[vertex * 2] = worldX;
      bindPositions[vertex * 2 + 1] = worldY;
      // A chain grid weights each row by where the chain crosses it, so the row bends as one straight line.
      const chainU = joints && !points ? getChainU(joints, v) : u;
      const weightX = bindMatrix[0] * chainU + bindMatrix[2] * v + bindMatrix[4];
      const weightY = bindMatrix[1] * chainU + bindMatrix[3] * v + bindMatrix[5];
      const distances = segments.map(segment => distanceAlongSegment(weightX, weightY, segment.x0, segment.y0, segment.x1, segment.y1));
      const nearest = Math.min(...distances);
      const nearestBone = segments[distances.indexOf(nearest)].bone;
      let shares = new Map<number, number>();
      segments.forEach((segment, index) => {
        shares.set(segment.bone, (shares.get(segment.bone) ?? 0) + Math.pow(Math.max(0, 1 - (distances[index] - nearest) / blendWidth(nearestBone, segment.bone)), 2));
      });
      shares = normalizeShares(points?.[vertex].bones ?? shares);
      // Paint blends the weights toward its own, fading by a cosine over its radius.
      for (const stroke of paint) {
        const distance = Math.hypot(u - stroke.at[0], v - stroke.at[1]);
        const strength = distance >= stroke.radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / stroke.radius));
        if (strength > 0) {
          const blended = new Map<number, number>();
          for (const [bone, share] of shares) {
            blended.set(bone, share * (1 - strength));
          }
          for (const [bone, share] of stroke.bones) {
            blended.set(bone, (blended.get(bone) ?? 0) + share * strength);
          }
          shares = normalizeShares(blended);
        }
      }
      const influences = [...shares]
        .filter(([, share]) => share > 0)
        .sort((first, second) => second[1] - first[1])
        .slice(0, 4);
      const total = influences.reduce((sum, [, share]) => sum + share, 0);
      weights.push(influences.length);
      for (const [bone, share] of influences) {
        // The point in the bone's own space, through the inverse of its setup world matrix.
        const q = bone * WORLD_STRIDE;
        const determinant = world[q] * world[q + 3] - world[q + 2] * world[q + 1];
        const dx = worldX - world[q + 4];
        const dy = worldY - world[q + 5];
        weights.push(bone, (world[q + 3] * dx - world[q + 2] * dy) / determinant, (world[q] * dy - world[q + 1] * dx) / determinant, share / total);
      }
    }
    let triangles: Uint16Array;
    if (points) {
      triangles = this.meshTriangles(json, path, points.map(point => point.at));
    } else {
      triangles = new Uint16Array(columns * gridRows * 6);
      let t = 0;
      for (let row = 0; row < gridRows; row++) {
        for (let column = 0; column < columns; column++) {
          const topLeft = row * (columns + 1) + column;
          const bottomLeft = topLeft + columns + 1;
          triangles.set([topLeft, topLeft + 1, bottomLeft, topLeft + 1, bottomLeft + 1, bottomLeft], t);
          t += 6;
        }
      }
    }
    return {kind: 'mesh', name, ...this.compileFlipbook(json, path, image, size), width: size.width, height: size.height, color, uvs, triangles, weights: new Float32Array(weights), vertexCount, bindPositions, columns: gridColumns, rows: gridRows, left: points ? 0 : gridLeft, right: points ? size.width : gridRight, bindMatrix, chain: influenceBones, joints: points ? null : joints};
  }

  /**
   * Reads a mesh's `points`: each `[x, y]` or `{at: [x, y], bones: {name: weight}}`, in image
   * pixels. Returns null when the mesh uses a grid instead.
   */
  private meshPoints(json: Json, path: string, size: RigImageSize): {at: [number, number]; bones: Map<number, number> | null}[] | null {
    if (json.points === undefined) {
      return null;
    }
    if (!Array.isArray(json.points) || json.points.length < 3) {
      this.fail(`${path}.points`, 'must be at least 3 points, [x, y] or {"at": [x, y], "bones": {"name": weight}}, the outline first');
      return null;
    }
    return json.points.map((item, index) => {
      const itemPath = `${path}.points[${index}]`;
      const record: Json = isRecord(item) ? item : {at: item};
      if (isRecord(item)) {
        this.checkKeys(item, itemPath, ['at', 'bones']);
      }
      const at = this.point(record.at, isRecord(item) ? `${itemPath}.at` : itemPath) ?? [0, 0];
      if (at[0] < 0 || at[1] < 0 || at[0] > size.width || at[1] > size.height) {
        this.fail(itemPath, `[${at[0]}, ${at[1]}] is outside the ${size.width}x${size.height} image`);
      }
      return {at, bones: record.bones === undefined ? null : this.boneShares(record.bones, `${itemPath}.bones`)};
    });
  }

  /** Reads a mesh's `paint` strokes: `{at: [x, y], radius?, bones: {name: weight}}`, in image pixels. */
  private meshPaint(json: Json, path: string): {at: [number, number]; radius: number; bones: Map<number, number>}[] {
    if (json.paint === undefined) {
      return [];
    }
    if (!Array.isArray(json.paint)) {
      this.fail(`${path}.paint`, 'must be an array of {"at": [x, y], "radius": r, "bones": {"name": weight}}');
      return [];
    }
    return json.paint.map((item, index) => {
      const itemPath = `${path}.paint[${index}]`;
      const record = isRecord(item) ? item : {};
      this.checkKeys(record, itemPath, ['at', 'radius', 'bones']);
      const at = this.point(record.at, `${itemPath}.at`);
      if (!at) {
        this.fail(`${itemPath}.at`, 'is required: [x, y] in image pixels');
      }
      return {at: at ?? [0, 0], radius: this.number(record, 'radius', `${itemPath}.radius`, 30, 0.001), bones: normalizeShares(this.boneShares(record.bones, `${itemPath}.bones`))};
    });
  }

  /** Reads `{bone name: weight}` into shares by bone index. */
  private boneShares(json: unknown, path: string): Map<number, number> {
    const shares = new Map<number, number>();
    if (!isRecord(json) || Object.keys(json).length === 0) {
      this.fail(path, 'must be {"bone name": weight, ...} with at least one bone');
      return shares;
    }
    for (const [boneName, weight] of Object.entries(json)) {
      const bone = this.find(this.boneIndex, boneName, `${path}.${boneName}`, 'bone');
      if (typeof weight !== 'number' || !(weight >= 0)) {
        this.fail(`${path}.${boneName}`, `must be a weight of 0 or more, got ${JSON.stringify(weight)}`);
      } else if (bone !== -1) {
        shares.set(bone, weight);
      }
    }
    return shares;
  }

  /**
   * Returns a point mesh's triangles: its `triangles` (corner index triples), or the points
   * triangulated. The first `outline` points (all by default) are the mesh's edge in order: with
   * no points inside, the outline is cut into triangles ear by ear. With points inside, they are
   * triangulated together and triangles outside the outline dropped.
   */
  private meshTriangles(json: Json, path: string, points: [number, number][]): Uint16Array {
    if (json.triangles !== undefined) {
      const list = json.triangles;
      if (!Array.isArray(list) || !list.every(item => Array.isArray(item) && item.length === 3 && item.every(corner => Number.isInteger(corner) && corner >= 0 && corner < points.length))) {
        this.fail(`${path}.triangles`, `must be [a, b, c] point index triples, each from 0 to ${points.length - 1}`);
        return new Uint16Array(0);
      }
      return Uint16Array.from((list as number[][]).flat());
    }
    const outline = this.number(json, 'outline', `${path}.outline`, points.length, 3, points.length);
    if (!Number.isInteger(outline)) {
      this.fail(`${path}.outline`, 'must be a whole number of points');
    }
    const edge = points.slice(0, outline);
    const triangles = outline === points.length ? triangulateOutline(edge) : triangulatePoints(points).filter(([a, b, c]) => {
      const centerX = (points[a][0] + points[b][0] + points[c][0]) / 3;
      const centerY = (points[a][1] + points[b][1] + points[c][1]) / 3;
      return isInsidePolygon(edge, centerX, centerY);
    });
    if (triangles.length === 0) {
      this.fail(`${path}.points`, 'make no triangles: the outline must be a simple shape with some area');
    }
    return Uint16Array.from(triangles.flat());
  }

  /** Returns bone `bone`'s setup tip in bone `space`'s setup space. */
  private setupTipInBone(bone: number, space: number): [number, number] {
    const world = this.setupWorld;
    const w = bone * WORLD_STRIDE;
    const length = this.bones[bone].length;
    const q = space * WORLD_STRIDE;
    const dx = world[w] * length + world[w + 4] - world[q + 4];
    const dy = world[w + 1] * length + world[w + 5] - world[q + 5];
    const determinant = world[q] * world[q + 3] - world[q + 2] * world[q + 1];
    return [(world[q + 3] * dx - world[q + 2] * dy) / determinant, (world[q] * dy - world[q + 1] * dx) / determinant];
  }

  private constraintList(json: unknown): Json[] {
    return Array.isArray(json) ? json.map(item => (isRecord(item) ? item : {})) : [];
  }

  /** Returns true if `bone` is `ancestor` or below it. */
  private isWithin(bone: number, ancestor: number): boolean {
    for (let current = bone; current !== -1; current = this.bones[current].parent) {
      if (current === ancestor) {
        return true;
      }
    }
    return false;
  }

  private compileIk(json: unknown): IkData[] {
    return this.constraintList(json).map((ik, index) => {
      const path = `ik[${index}]`;
      this.checkKeys(ik, path, ['name', 'order', 'bones', 'target', 'mix', 'bend', 'softness', 'stretch', 'volume']);
      this.constraintOrders[UPDATE_IK][index] = this.number(ik, 'order', `${path}.order`, 0);
      let bones: number[] = [];
      if (!Array.isArray(ik.bones) || ik.bones.length < 1 || ik.bones.length > 2) {
        this.fail(`${path}.bones`, 'must be [bone] or [parent, child]');
      } else {
        bones = ik.bones.map((bone, boneIndex) => Math.max(0, this.find(this.boneIndex, bone, `${path}.bones[${boneIndex}]`, 'bone')));
        if (bones.length === 2 && this.bones[bones[1]].parent !== bones[0]) {
          this.fail(`${path}.bones[1]`, `"${ik.bones[1]}" must be a direct child of "${ik.bones[0]}"`);
        }
      }
      const target = Math.max(0, this.find(this.boneIndex, ik.target, `${path}.target`, 'bone'));
      if (bones.length > 0 && this.isWithin(target, bones[0])) {
        this.fail(`${path}.target`, `"${ik.target}" is "${ik.bones && (ik.bones as string[])[0]}" or below it, so moving the chain would move the target. Parent it elsewhere (often the root)`);
      }
      const bend = ik.bend ?? 1;
      if (bend !== 1 && bend !== -1) {
        this.fail(`${path}.bend`, 'must be 1 or -1');
      }
      return {
        index,
        name: ik.name as string,
        bones,
        target,
        mix: this.number(ik, 'mix', `${path}.mix`, 1, 0, 1),
        bend: bend === -1 ? -1 : 1,
        softness: this.number(ik, 'softness', `${path}.softness`, 0, 0),
        stretch: this.boolean(ik, 'stretch', `${path}.stretch`),
        volume: this.boolean(ik, 'volume', `${path}.volume`),
      };
    });
  }

  private mappableProperty(value: unknown, path: string): number {
    if (typeof value !== 'string' || !MAPPABLE_PROPERTIES.includes(value)) {
      this.fail(path, `must be one of ${MAPPABLE_PROPERTIES.join(', ')}`);
      return BONE_ROTATION;
    }
    return BONE_PROPERTIES[value];
  }

  private compileTransforms(json: unknown): TransformData[] {
    return this.constraintList(json).map((transform, index) => {
      const path = `transforms[${index}]`;
      this.checkKeys(transform, path, ['name', 'order', 'source', 'bones', 'space', 'map', 'additive', 'mix']);
      this.constraintOrders[UPDATE_TRANSFORM][index] = this.number(transform, 'order', `${path}.order`, 0);
      const source = Math.max(0, this.find(this.boneIndex, transform.source, `${path}.source`, 'bone'));
      const isWorld = transform.space === 'world';
      if (transform.space !== undefined && transform.space !== 'world' && transform.space !== 'local') {
        this.fail(`${path}.space`, 'must be "local" or "world"');
      }
      let bones: number[] = [];
      if (!Array.isArray(transform.bones) || transform.bones.length === 0) {
        this.fail(`${path}.bones`, 'must be a non-empty array of bone names');
      } else {
        bones = transform.bones.map((bone, boneIndex) => {
          const found = Math.max(0, this.find(this.boneIndex, bone, `${path}.bones[${boneIndex}]`, 'bone'));
          if (found === source || (isWorld && this.isWithin(source, found))) {
            this.fail(`${path}.bones[${boneIndex}]`, `"${bone}" is the source or above it, so it would move its own source`);
          }
          return found;
        });
      }
      let map: TransformMap[] = MAPPABLE_PROPERTIES.map(name => ({from: BONE_PROPERTIES[name], to: BONE_PROPERTIES[name], scale: 1, offset: 0, min: -Infinity, max: Infinity}));
      if (transform.map !== undefined) {
        if (!Array.isArray(transform.map) || transform.map.length === 0) {
          this.fail(`${path}.map`, 'must be a non-empty array of {from, to}');
        } else {
          map = transform.map.map((entry, entryIndex) => {
            const entryPath = `${path}.map[${entryIndex}]`;
            const item = isRecord(entry) ? entry : {};
            this.checkKeys(item, entryPath, ['from', 'to', 'scale', 'offset', 'min', 'max']);
            return {
              from: this.mappableProperty(item.from, `${entryPath}.from`),
              to: this.mappableProperty(item.to, `${entryPath}.to`),
              scale: this.number(item, 'scale', `${entryPath}.scale`, 1),
              offset: this.number(item, 'offset', `${entryPath}.offset`, 0),
              min: this.number(item, 'min', `${entryPath}.min`, -Infinity),
              max: this.number(item, 'max', `${entryPath}.max`, Infinity),
            };
          });
        }
      }
      return {
        index,
        name: transform.name as string,
        source,
        bones,
        isWorld,
        map,
        additive: this.boolean(transform, 'additive', `${path}.additive`),
        mix: this.number(transform, 'mix', `${path}.mix`, 1, 0, 1),
      };
    });
  }

  private compilePhysics(json: unknown): PhysicsData[] {
    return this.constraintList(json).map((physics, index) => {
      const path = `physics[${index}]`;
      this.checkKeys(physics, path, ['name', 'order', 'bone', 'rotate', 'translate', 'stretch', 'inertia', 'strength', 'damping', 'mass', 'gravity', 'wind', 'limit', 'mix']);
      this.constraintOrders[UPDATE_PHYSICS][index] = this.number(physics, 'order', `${path}.order`, 0);
      const bone = Math.max(0, this.find(this.boneIndex, physics.bone, `${path}.bone`, 'bone'));
      const rotate = this.number(physics, 'rotate', `${path}.rotate`, 1, 0, 1);
      const stretch = this.number(physics, 'stretch', `${path}.stretch`, 0, 0, 1);
      if ((rotate > 0 || stretch > 0) && this.bones[bone].length <= 0) {
        this.fail(`${path}.bone`, `"${physics.bone}" needs a length to swing. Give the bone a length, or set rotate and stretch to 0`);
      }
      return {
        index,
        name: physics.name as string,
        bone,
        rotate,
        translate: this.number(physics, 'translate', `${path}.translate`, 0, 0, 1),
        stretch,
        inertia: this.number(physics, 'inertia', `${path}.inertia`, 1, 0, 1),
        strength: this.number(physics, 'strength', `${path}.strength`, 100, 0),
        damping: this.number(physics, 'damping', `${path}.damping`, 0.9, 0, 1),
        mass: this.number(physics, 'mass', `${path}.mass`, 1, 0.001),
        gravity: this.number(physics, 'gravity', `${path}.gravity`, 0),
        wind: this.number(physics, 'wind', `${path}.wind`, 0),
        limit: this.number(physics, 'limit', `${path}.limit`, 5000, 0),
        mix: this.number(physics, 'mix', `${path}.mix`, 1, 0, 1),
      };
    });
  }

  /** Builds a path attachment, weighting each point to the nearest of its `bones` like a mesh corner. */
  private compilePathAttachment(slot: SlotData, name: string, json: Json, path: string): Attachment {
    const pointsJson = Array.isArray(json.points) ? json.points : [];
    if (pointsJson.length < 2) {
      this.fail(`${path}.points`, 'must be at least 2 [x, y] points in the bone\'s space');
    }
    const points = new Float64Array(pointsJson.length * 2);
    pointsJson.forEach((item, index) => {
      const point = this.point(item, `${path}.points[${index}]`) ?? [0, 0];
      points[index * 2] = point[0];
      points[index * 2 + 1] = point[1];
    });
    let weights: Float32Array | null = null;
    if (json.bones !== undefined) {
      if (!Array.isArray(json.bones) || json.bones.length === 0) {
        this.fail(`${path}.bones`, 'must be a non-empty array of bone names');
      } else {
        const bones = json.bones.map((bone, index) => Math.max(0, this.find(this.boneIndex, bone, `${path}.bones[${index}]`, 'bone')));
        const world = this.setupWorld;
        const w = slot.bone * WORLD_STRIDE;
        const smooth = Math.max(bones.reduce((sum, bone) => sum + this.bones[bone].length, 0) / bones.length / 4, 1);
        const list: number[] = [];
        for (let p = 0; p < points.length; p += 2) {
          const x = world[w] * points[p] + world[w + 2] * points[p + 1] + world[w + 4];
          const y = world[w + 1] * points[p] + world[w + 3] * points[p + 1] + world[w + 5];
          const distances = bones.map(bone => {
            const q = bone * WORLD_STRIDE;
            const length = this.bones[bone].length;
            return distanceAlongSegment(x, y, world[q + 4], world[q + 5], world[q + 4] + world[q] * length, world[q + 5] + world[q + 1] * length);
          });
          const nearest = Math.min(...distances);
          const shares = bones.map((bone, index) => [bone, Math.pow(Math.max(0, 1 - (distances[index] - nearest) / smooth), 2)]).filter(([, share]) => share > 0);
          const total = shares.reduce((sum, [, share]) => sum + share, 0);
          list.push(shares.length);
          for (const [bone, share] of shares) {
            const q = bone * WORLD_STRIDE;
            const determinant = world[q] * world[q + 3] - world[q + 2] * world[q + 1];
            const dx = x - world[q + 4];
            const dy = y - world[q + 5];
            list.push(bone, (world[q + 3] * dx - world[q + 2] * dy) / determinant, (world[q] * dy - world[q + 1] * dx) / determinant, share / total);
          }
        }
        weights = new Float32Array(list);
      }
    }
    return {kind: 'path', name, points, closed: this.boolean(json, 'closed', `${path}.closed`), weights};
  }

  private compilePaths(json: unknown): PathData[] {
    return this.constraintList(json).map((constraint, index) => {
      const path = `paths[${index}]`;
      this.checkKeys(constraint, path, ['name', 'order', 'path', 'bones', 'position', 'spacing', 'rotate', 'mix']);
      this.constraintOrders[UPDATE_PATH][index] = this.number(constraint, 'order', `${path}.order`, 0);
      const slot = Math.max(0, this.find(this.slotIndex, constraint.path, `${path}.path`, 'slot'));
      if (this.slotIndex.has(constraint.path as string) && !this.skinList.some(skin => skin.attachments[slot].some(attachment => attachment?.kind === 'path'))) {
        this.fail(`${path}.path`, `slot "${constraint.path}" has no path attachment in any skin`);
      }
      let bones: number[] = [];
      if (!Array.isArray(constraint.bones) || constraint.bones.length === 0) {
        this.fail(`${path}.bones`, 'must be a non-empty array of bone names, parent first');
      } else {
        bones = constraint.bones.map((bone, boneIndex) => Math.max(0, this.find(this.boneIndex, bone, `${path}.bones[${boneIndex}]`, 'bone')));
      }
      const rotate = ['tangent', 'chain', 'none'].indexOf((constraint.rotate ?? 'tangent') as string);
      if (rotate === -1) {
        this.fail(`${path}.rotate`, 'must be one of tangent, chain, none');
      }
      const isLengthSpacing = constraint.spacing === undefined || constraint.spacing === 'length';
      return {
        index,
        name: constraint.name as string,
        slot,
        bones,
        position: this.number(constraint, 'position', `${path}.position`, 0),
        spacing: isLengthSpacing ? 0 : this.number(constraint, 'spacing', `${path}.spacing`, 0, 0),
        isLengthSpacing,
        rotate: Math.max(0, rotate),
        mix: this.number(constraint, 'mix', `${path}.mix`, 1, 0, 1),
      };
    });
  }

  private compileSliders(json: unknown): SliderData[] {
    return this.constraintList(json).map((slider, index) => {
      const path = `sliders[${index}]`;
      this.checkKeys(slider, path, ['name', 'order', 'animation', 'time', 'mix', 'additive', 'driver']);
      this.constraintOrders[UPDATE_SLIDER][index] = this.number(slider, 'order', `${path}.order`, 0);
      let driver: SliderData['driver'] = null;
      if (slider.driver !== undefined) {
        const driverJson = isRecord(slider.driver) ? slider.driver : {};
        this.checkKeys(driverJson, `${path}.driver`, ['bone', 'property', 'from']);
        const from = this.point(driverJson.from, `${path}.driver.from`);
        if (!from || from[0] === from[1]) {
          this.fail(`${path}.driver.from`, 'must be [start, end] with start and end different');
        }
        driver = {
          bone: Math.max(0, this.find(this.boneIndex, driverJson.bone, `${path}.driver.bone`, 'bone')),
          property: this.mappableProperty(driverJson.property, `${path}.driver.property`),
          from: from ?? [0, 1],
        };
      }
      return {
        index,
        name: slider.name as string,
        animation: Math.max(0, this.find(this.animationIndex, slider.animation, `${path}.animation`, 'animation')),
        time: this.number(slider, 'time', `${path}.time`, 0, 0),
        mix: this.number(slider, 'mix', `${path}.mix`, 1, 0, 1),
        additive: this.boolean(slider, 'additive', `${path}.additive`),
        driver,
      };
    });
  }

  private compileEvents(json: unknown) {
    if (json === undefined) {
      return;
    }
    if (!isRecord(json)) {
      this.fail('events', 'must be an object of events by name');
      return;
    }
    for (const [name, defaults] of Object.entries(json)) {
      const item = isRecord(defaults) ? defaults : {};
      this.checkKeys(item, `events.${name}`, ['int', 'float', 'string']);
      this.eventDefaults.set(name, {
        int: this.number(item, 'int', `events.${name}.int`, 0),
        float: this.number(item, 'float', `events.${name}.float`, 0),
        string: typeof item.string === 'string' ? item.string : '',
      });
    }
  }

  private compilePoses(json: unknown) {
    if (json === undefined) {
      return;
    }
    if (!isRecord(json)) {
      this.fail('poses', 'must be an object of poses by name');
      return;
    }
    for (const [name, pose] of Object.entries(json)) {
      if (!isRecord(pose)) {
        this.fail(`poses.${name}`, 'must be an object: bone name to properties');
        continue;
      }
      for (const [bone, properties] of Object.entries(pose)) {
        this.find(this.boneIndex, bone, `poses.${name}.${bone}`, 'bone');
        if (!isRecord(properties)) {
          this.fail(`poses.${name}.${bone}`, 'must be an object like {"rotate": 10}');
          continue;
        }
        this.checkKeys(properties, `poses.${name}.${bone}`, Object.keys(BONE_PROPERTIES));
        for (const property of Object.keys(properties)) {
          this.number(properties, property, `poses.${name}.${bone}.${property}`, 0);
        }
      }
      this.poses.set(name, pose);
    }
  }

  private curve(value: unknown, path: string): number {
    if (value === undefined) {
      return CURVE_LINEAR;
    }
    if (Array.isArray(value)) {
      if (value.length !== 4 || !value.every(item => typeof item === 'number' && Number.isFinite(item)) || value[0] < 0 || value[0] > 1 || value[2] < 0 || value[2] > 1) {
        this.fail(path, 'a bezier curve is [x1, y1, x2, y2] with x1 and x2 from 0 to 1');
        return CURVE_LINEAR;
      }
      return CURVE_BEZIER;
    }
    const code = typeof value === 'string' ? getCurveCode(value) : -1;
    if (code === -1) {
      this.fail(path, `unknown curve ${JSON.stringify(value)}.${typeof value === 'string' ? suggest(value, CURVE_NAMES) : ''} Curves: ${CURVE_NAMES.join(', ')}, or [x1, y1, x2, y2]`);
      return CURVE_LINEAR;
    }
    return code;
  }

  /** Builds a timeline from gathered keys, checking key times rise. */
  private timeline(kind: number, target: number, property: number, keys: ScalarKeys, stride: number): Timeline {
    const count = keys.times.length;
    const curves = new Uint8Array(count);
    let bezier: Float64Array | null = null;
    for (let i = 0; i < count; i++) {
      if (i > 0 && keys.times[i] < keys.times[i - 1]) {
        this.fail(keys.paths[i], `time ${keys.times[i]} comes before the previous key's ${keys.times[i - 1]}. Keys must be in time order`);
      }
      const code = this.curve(keys.curves[i], keys.paths[i]);
      curves[i] = code;
      if (code === CURVE_BEZIER) {
        bezier ??= new Float64Array(count * BEZIER_SAMPLES * 2);
        const [x1, y1, x2, y2] = keys.curves[i] as number[];
        writeBezierTable(x1, y1, x2, y2, bezier, i * BEZIER_SAMPLES * 2);
      }
    }
    return {kind, target, property, times: Float64Array.from(keys.times), values: Float64Array.from(keys.values), stride, curves, bezier};
  }

  /** Reads `[time, ...values, curve?]` keys. Returns null and fails if the list is malformed. */
  private readKeys(json: unknown, path: string, valueCount: number): {time: number; values: number[]; curve: unknown; path: string}[] | null {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, `must be a non-empty array of [time, ${valueCount === 1 ? 'value' : 'x, y'}, curve?] keys`);
      return null;
    }
    const result = [];
    for (let i = 0; i < json.length; i++) {
      const key = json[i];
      const keyPath = `${path}[${i}]`;
      const values = Array.isArray(key) ? key.slice(1, 1 + valueCount) : [];
      if (!Array.isArray(key) || typeof key[0] !== 'number' || key[0] < 0 || values.length !== valueCount || !values.every(value => typeof value === 'number' && Number.isFinite(value)) || key.length > valueCount + 2) {
        this.fail(keyPath, `must be [time, ${valueCount === 1 ? 'value' : 'x, y'}, curve?] with time >= 0, got ${JSON.stringify(key)}`);
        return null;
      }
      result.push({time: key[0], values, curve: key[valueCount + 1], path: keyPath});
    }
    return result;
  }

  private compileAnimation(name: string, index: number, json: unknown): AnimationData {
    const path = `animations.${name}`;
    const timelines: Timeline[] = [];
    const keyed = new Uint8Array(this.propertyBase.count);
    const events: EventKey[] = [];
    const physicsResets: {time: number; physics: number}[] = [];
    let drawOrder: AnimationData['drawOrder'] = null;
    let lastTime = 0;
    const animation = isRecord(json) ? json : {};
    if (!isRecord(json)) {
      this.fail(path, 'must be an object');
    }
    this.checkKeys(animation, path, ['duration', 'loop', 'pose', 'bones', 'slots', 'deform', 'ik', 'transforms', 'physics', 'sliders', 'paths', 'drawOrder', 'events']);

    const add = (kind: number, target: number, property: number, keys: ScalarKeys, stride = 1) => {
      timelines.push(this.timeline(kind, target, property, keys, stride));
      keyed[property] = 1;
      lastTime = Math.max(lastTime, keys.times[keys.times.length - 1] ?? 0);
    };
    const scalar = (kind: number, target: number, property: number, keysJson: unknown, keysPath: string) => {
      const keys = this.readKeys(keysJson, keysPath, 1);
      if (keys) {
        add(kind, target, property, {times: keys.map(key => key.time), values: keys.map(key => key.values[0]), curves: keys.map(key => key.curve), paths: keys.map(key => key.path)});
      }
    };
    const section = (key: string): Json => {
      const value = animation[key];
      if (value !== undefined && !isRecord(value)) {
        this.fail(`${path}.${key}`, 'must be an object by name');
      }
      return isRecord(value) ? value : {};
    };

    // Bone keys: gather every scalar property's keys, from `pose` first, then `bones`.
    const boneKeys = new Map<number, ScalarKeys>();
    if (animation.pose !== undefined) {
      this.expandPoseKeys(animation.pose, `${path}.pose`, boneKeys);
    }
    const poseKeyed = new Set(boneKeys.keys());
    for (const [boneName, keysJson] of Object.entries(section('bones'))) {
      const bonePath = `${path}.bones.${boneName}`;
      const bone = this.find(this.boneIndex, boneName, bonePath, 'bone');
      if (bone === -1 || !isRecord(keysJson)) {
        if (bone !== -1) {
          this.fail(bonePath, 'must be an object like {"rotate": [[0, 0], [0.5, 20]]}');
        }
        continue;
      }
      this.checkKeys(keysJson, bonePath, [...Object.keys(BONE_PROPERTIES), ...Object.keys(BONE_PAIRS)]);
      for (const [propertyName, propertyKeys] of Object.entries(keysJson)) {
        const pair = BONE_PAIRS[propertyName];
        const keys = this.readKeys(propertyKeys, `${bonePath}.${propertyName}`, pair ? 2 : 1);
        if (!keys) {
          continue;
        }
        const scalarNames = pair ?? [propertyName];
        scalarNames.forEach((scalarName, valueIndex) => {
          const target = boneProperty(bone, BONE_PROPERTIES[scalarName]);
          if (poseKeyed.has(target)) {
            this.fail(`${bonePath}.${propertyName}`, `${boneName}.${scalarName} is also keyed by this animation's pose keys. Key it in one place: add it to the poses, or drop it from them`);
            return;
          }
          if (boneKeys.has(target)) {
            this.fail(`${bonePath}.${propertyName}`, `${boneName}.${scalarName} is keyed twice (e.g. by both "translate" and "x")`);
            return;
          }
          boneKeys.set(target, {times: keys.map(key => key.time), values: keys.map(key => key.values[valueIndex]), curves: keys.map(key => key.curve), paths: keys.map(key => key.path)});
        });
      }
    }
    for (const [target, keys] of boneKeys) {
      add(TIMELINE_BONE, target, target, keys);
    }

    const base = this.propertyBase;
    for (const [slotName, keysJson] of Object.entries(section('slots'))) {
      const slotPath = `${path}.slots.${slotName}`;
      const slot = this.find(this.slotIndex, slotName, slotPath, 'slot');
      if (slot === -1 || !isRecord(keysJson)) {
        continue;
      }
      this.checkKeys(keysJson, slotPath, ['attachment', 'color', 'alpha', 'dark', 'sequence']);
      const slotBase = base.slot + slot * SLOT_PROPERTIES;
      if (keysJson.attachment !== undefined) {
        this.attachmentKeys(keysJson.attachment, `${slotPath}.attachment`, slot, keys => add(TIMELINE_ATTACHMENT, slot, slotBase, keys));
      }
      if (keysJson.color !== undefined) {
        this.colorKeys(keysJson.color, `${slotPath}.color`, keys => add(TIMELINE_COLOR, slot, slotBase + 1, keys, 4));
      }
      if (keysJson.alpha !== undefined) {
        scalar(TIMELINE_ALPHA, slot, slotBase + 2, keysJson.alpha, `${slotPath}.alpha`);
      }
      if (keysJson.dark !== undefined) {
        this.colorKeys(keysJson.dark, `${slotPath}.dark`, keys => add(TIMELINE_DARK, slot, slotBase + 3, keys, 4));
      }
      if (keysJson.sequence !== undefined) {
        this.sequenceKeys(keysJson.sequence, `${slotPath}.sequence`, keys => add(TIMELINE_SEQUENCE, slot, slotBase + 4, keys, 3));
      }
    }
    for (const [slotName, attachmentsJson] of Object.entries(section('deform'))) {
      const slotPath = `${path}.deform.${slotName}`;
      const slot = this.find(this.slotIndex, slotName, slotPath, 'slot');
      if (slot === -1 || !isRecord(attachmentsJson)) {
        if (slot !== -1) {
          this.fail(slotPath, 'must be an object of shape keys by attachment name');
        }
        continue;
      }
      for (const [attachmentName, keysJson] of Object.entries(attachmentsJson)) {
        const keysPath = `${slotPath}.${attachmentName}`;
        const nameIndex = this.slots[slot].attachmentNames.indexOf(attachmentName);
        const mesh = this.skinList.map(skin => skin.attachments[slot][nameIndex]).find(attachment => attachment?.kind === 'mesh') as MeshAttachment | undefined;
        if (!mesh) {
          this.fail(keysPath, `slot "${slotName}" has no mesh named "${attachmentName}".${suggest(attachmentName, this.slots[slot].attachmentNames)}`);
          continue;
        }
        const keys = this.deformKeys(keysJson, keysPath, mesh);
        if (keys) {
          timelines.push({...this.timeline(TIMELINE_DEFORM, slot, base.slot + slot * SLOT_PROPERTIES + 5, keys, mesh.vertexCount * 2), attachment: nameIndex});
          keyed[base.slot + slot * SLOT_PROPERTIES + 5] = 1;
          lastTime = Math.max(lastTime, keys.times[keys.times.length - 1] ?? 0);
        }
      }
    }
    for (const [ikName, keysJson] of Object.entries(section('ik'))) {
      const ikPath = `${path}.ik.${ikName}`;
      const ik = this.find(this.ikIndex, ikName, ikPath, 'ik constraint');
      if (ik === -1 || !isRecord(keysJson)) {
        continue;
      }
      this.checkKeys(keysJson, ikPath, ['mix', 'bend']);
      if (keysJson.mix !== undefined) {
        scalar(TIMELINE_IK_MIX, ik, base.ik + ik * 2, keysJson.mix, `${ikPath}.mix`);
      }
      if (keysJson.bend !== undefined) {
        const keys = this.readKeys(keysJson.bend, `${ikPath}.bend`, 1);
        if (keys) {
          keys.forEach(key => key.values[0] !== 1 && key.values[0] !== -1 && this.fail(key.path, 'bend must be 1 or -1'));
          add(TIMELINE_IK_BEND, ik, base.ik + ik * 2 + 1, {times: keys.map(key => key.time), values: keys.map(key => key.values[0]), curves: keys.map(() => 'step'), paths: keys.map(key => key.path)});
        }
      }
    }
    for (const [transformName, keysJson] of Object.entries(section('transforms'))) {
      const transformPath = `${path}.transforms.${transformName}`;
      const transform = this.find(this.transformIndex, transformName, transformPath, 'transform constraint');
      if (transform !== -1 && isRecord(keysJson)) {
        this.checkKeys(keysJson, transformPath, ['mix']);
        scalar(TIMELINE_TRANSFORM_MIX, transform, base.transform + transform, keysJson.mix, `${transformPath}.mix`);
      }
    }
    for (const [physicsName, keysJson] of Object.entries(section('physics'))) {
      const physicsPath = `${path}.physics.${physicsName}`;
      const physics = this.find(this.physicsIndex, physicsName, physicsPath, 'physics constraint');
      if (physics === -1 || !isRecord(keysJson)) {
        continue;
      }
      this.checkKeys(keysJson, physicsPath, ['mix', 'reset']);
      if (keysJson.mix !== undefined) {
        scalar(TIMELINE_PHYSICS_MIX, physics, base.physics + physics, keysJson.mix, `${physicsPath}.mix`);
      }
      if (keysJson.reset !== undefined) {
        if (!Array.isArray(keysJson.reset) || !keysJson.reset.every(time => typeof time === 'number' && time >= 0)) {
          this.fail(`${physicsPath}.reset`, 'must be an array of times in seconds');
        } else {
          for (const time of keysJson.reset as number[]) {
            physicsResets.push({time, physics});
            lastTime = Math.max(lastTime, time);
          }
        }
      }
    }
    for (const [sliderName, keysJson] of Object.entries(section('sliders'))) {
      const sliderPath = `${path}.sliders.${sliderName}`;
      const slider = this.find(this.sliderIndex, sliderName, sliderPath, 'slider');
      if (slider === -1 || !isRecord(keysJson)) {
        continue;
      }
      this.checkKeys(keysJson, sliderPath, ['time', 'mix']);
      if (keysJson.time !== undefined) {
        scalar(TIMELINE_SLIDER_TIME, slider, base.slider + slider * 2, keysJson.time, `${sliderPath}.time`);
      }
      if (keysJson.mix !== undefined) {
        scalar(TIMELINE_SLIDER_MIX, slider, base.slider + slider * 2 + 1, keysJson.mix, `${sliderPath}.mix`);
      }
    }
    for (const [pathName, keysJson] of Object.entries(section('paths'))) {
      const keysPath = `${path}.paths.${pathName}`;
      const constraint = this.find(this.pathIndex, pathName, keysPath, 'path constraint');
      if (constraint === -1 || !isRecord(keysJson)) {
        continue;
      }
      this.checkKeys(keysJson, keysPath, ['position', 'spacing', 'mix']);
      if (keysJson.position !== undefined) {
        scalar(TIMELINE_PATH_POSITION, constraint, base.path + constraint * 3, keysJson.position, `${keysPath}.position`);
      }
      if (keysJson.spacing !== undefined) {
        scalar(TIMELINE_PATH_SPACING, constraint, base.path + constraint * 3 + 1, keysJson.spacing, `${keysPath}.spacing`);
      }
      if (keysJson.mix !== undefined) {
        scalar(TIMELINE_PATH_MIX, constraint, base.path + constraint * 3 + 2, keysJson.mix, `${keysPath}.mix`);
      }
    }
    if (animation.drawOrder !== undefined) {
      drawOrder = this.drawOrderKeys(animation.drawOrder, `${path}.drawOrder`);
      if (drawOrder) {
        keyed[base.drawOrder] = 1;
        lastTime = Math.max(lastTime, drawOrder.times[drawOrder.times.length - 1] ?? 0);
      }
    }
    if (animation.events !== undefined) {
      if (!Array.isArray(animation.events)) {
        this.fail(`${path}.events`, 'must be an array of [time, event name, payload?]');
      } else {
        animation.events.forEach((event, eventIndex) => {
          const eventPath = `${path}.events[${eventIndex}]`;
          if (!Array.isArray(event) || typeof event[0] !== 'number' || event[0] < 0) {
            this.fail(eventPath, 'must be [time, event name, payload?]');
            return;
          }
          const defaults = this.eventDefaults.get(event[1]);
          if (!defaults) {
            this.fail(`${eventPath}[1]`, `no event ${JSON.stringify(event[1])}. Declare it in "events".${suggest(String(event[1]), this.eventDefaults.keys())}`);
            return;
          }
          const payload = isRecord(event[2]) ? event[2] : {};
          events.push({
            time: event[0],
            name: event[1],
            int: this.number(payload, 'int', `${eventPath}[2].int`, defaults.int),
            float: this.number(payload, 'float', `${eventPath}[2].float`, defaults.float),
            string: typeof payload.string === 'string' ? payload.string : defaults.string,
          });
          lastTime = Math.max(lastTime, event[0]);
        });
        events.sort((first, second) => first.time - second.time);
      }
    }
    physicsResets.sort((first, second) => first.time - second.time);
    return {
      index,
      name,
      duration: this.number(animation, 'duration', `${path}.duration`, lastTime, 0),
      loop: animation.loop !== false,
      timelines,
      keyed,
      events,
      drawOrder,
      physicsResets,
    };
  }

  /** Turns `pose` keys into scalar keys for every bone property any used pose sets. */
  private expandPoseKeys(json: unknown, path: string, out: Map<number, ScalarKeys>) {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, pose name or null, curve?]');
      return;
    }
    const keys: {time: number; pose: Json | null; curve: unknown; path: string}[] = [];
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!Array.isArray(key) || typeof key[0] !== 'number' || key[0] < 0 || (key[1] !== null && typeof key[1] !== 'string')) {
        this.fail(keyPath, `must be [time, pose name or null, curve?], got ${JSON.stringify(key)}`);
        return;
      }
      let pose: Json | null = null;
      if (key[1] !== null) {
        pose = this.poses.get(key[1]) ?? null;
        if (!pose) {
          this.fail(`${keyPath}[1]`, `no pose "${key[1]}".${suggest(key[1], this.poses.keys())}`);
          return;
        }
      }
      keys.push({time: key[0], pose, curve: key[2], path: keyPath});
    });
    const targets = new Map<number, [string, string]>();
    for (const key of keys) {
      for (const [boneName, properties] of Object.entries(key.pose ?? {})) {
        const bone = this.boneIndex.get(boneName);
        if (bone === undefined || !isRecord(properties)) {
          continue;
        }
        for (const propertyName of Object.keys(properties)) {
          if (BONE_PROPERTIES[propertyName] !== undefined) {
            targets.set(boneProperty(bone, BONE_PROPERTIES[propertyName]), [boneName, propertyName]);
          }
        }
      }
    }
    for (const [target, [boneName, propertyName]] of targets) {
      const identity = isScaleProperty(target % BONE_STRIDE) ? 1 : 0;
      out.set(target, {
        times: keys.map(key => key.time),
        values: keys.map(key => {
          const value = (key.pose?.[boneName] as Json | undefined)?.[propertyName];
          return typeof value === 'number' ? value : identity;
        }),
        curves: keys.map(key => key.curve),
        paths: keys.map(key => key.path),
      });
    }
  }

  private attachmentKeys(json: unknown, path: string, slot: number, done: (keys: ScalarKeys) => void) {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, attachment name or null]');
      return;
    }
    const names = this.slots[slot].attachmentNames;
    const keys: ScalarKeys = {times: [], values: [], curves: [], paths: []};
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!Array.isArray(key) || typeof key[0] !== 'number' || (key[1] !== null && typeof key[1] !== 'string')) {
        this.fail(keyPath, 'must be [time, attachment name or null]');
        return;
      }
      const value = key[1] === null ? -1 : names.indexOf(key[1]);
      if (value === -1 && key[1] !== null) {
        this.fail(keyPath, `no attachment "${key[1]}" on slot "${this.slots[slot].name}".${suggest(key[1], names)}`);
      }
      keys.times.push(key[0]);
      keys.values.push(value);
      keys.curves.push('step');
      keys.paths.push(keyPath);
    });
    done(keys);
  }

  /**
   * Reads shape keys, `[time, handles, curve?]`, into an x, y offset per corner of `mesh` in
   * setup skeleton space: each handle's move, fading by a cosine over its radius.
   */
  private deformKeys(json: unknown, path: string, mesh: MeshAttachment): ScalarKeys | null {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, [{at, move, radius?}], curve?]');
      return null;
    }
    const keys: ScalarKeys = {times: [], values: [], curves: [], paths: []};
    const [a, b, c, d] = mesh.bindMatrix;
    const defaultRadius = Math.max(mesh.width, mesh.height) / 4;
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!Array.isArray(key) || typeof key[0] !== 'number' || !Array.isArray(key[1]) || key.length > 3) {
        this.fail(keyPath, `must be [time, [{at, move, radius?}], curve?], got ${JSON.stringify(key).slice(0, 80)}`);
        return;
      }
      const offsets = new Float64Array(mesh.vertexCount * 2);
      (key[1] as unknown[]).forEach((handle, handleIndex) => {
        const handlePath = `${keyPath}[1][${handleIndex}]`;
        const handleJson = isRecord(handle) ? handle : {};
        this.checkKeys(handleJson, handlePath, ['at', 'move', 'radius']);
        const at = this.point(handleJson.at, `${handlePath}.at`);
        const move = this.point(handleJson.move, `${handlePath}.move`);
        const radius = this.number(handleJson, 'radius', `${handlePath}.radius`, defaultRadius, 0.001);
        if (!at || !move) {
          this.fail(handlePath, 'needs "at": [x, y] and "move": [x, y], in image pixels');
          return;
        }
        // Image pixels to setup skeleton space: the bind matrix without its move.
        const moveX = a * move[0] + c * move[1];
        const moveY = b * move[0] + d * move[1];
        for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
          const distance = Math.hypot(mesh.uvs[vertex * 2] - at[0], mesh.uvs[vertex * 2 + 1] - at[1]);
          const weight = distance >= radius ? 0 : 0.5 * (1 + Math.cos((Math.PI * distance) / radius));
          offsets[vertex * 2] += moveX * weight;
          offsets[vertex * 2 + 1] += moveY * weight;
        }
      });
      keys.times.push(key[0]);
      keys.values.push(...offsets);
      keys.curves.push(key[2]);
      keys.paths.push(keyPath);
    });
    return keys;
  }

  /** Reads `[time, {mode?, fps?, frame?}]` keys into steps of (mode or -1, fps or -1, frame). */
  private sequenceKeys(json: unknown, path: string, done: (keys: ScalarKeys) => void) {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, {mode?, fps?, frame?}]');
      return;
    }
    const keys: ScalarKeys = {times: [], values: [], curves: [], paths: []};
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!Array.isArray(key) || typeof key[0] !== 'number' || !isRecord(key[1])) {
        this.fail(keyPath, `must be [time, {mode?, fps?, frame?}], got ${JSON.stringify(key)}`);
        return;
      }
      const settings = key[1];
      this.checkKeys(settings, `${keyPath}[1]`, ['mode', 'fps', 'frame']);
      const mode = settings.mode === undefined ? -1 : SEQUENCE_MODES.indexOf(settings.mode as string);
      if (mode === -1 && settings.mode !== undefined) {
        this.fail(`${keyPath}[1].mode`, `must be one of ${SEQUENCE_MODES.join(', ')}`);
      }
      const frame = this.number(settings, 'frame', `${keyPath}[1].frame`, 0, 0);
      if (!Number.isInteger(frame)) {
        this.fail(`${keyPath}[1].frame`, 'must be a whole frame number');
      }
      keys.times.push(key[0]);
      keys.values.push(mode, this.number(settings, 'fps', `${keyPath}[1].fps`, -1, 0.001), frame);
      keys.curves.push('step');
      keys.paths.push(keyPath);
    });
    done(keys);
  }

  private colorKeys(json: unknown, path: string, done: (keys: ScalarKeys) => void) {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, "#rrggbbaa", curve?]');
      return;
    }
    const keys: ScalarKeys = {times: [], values: [], curves: [], paths: []};
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      const color = Array.isArray(key) && typeof key[0] === 'number' ? parseColor(key[1]) : null;
      if (!color) {
        this.fail(keyPath, `must be [time, "#rrggbb" or "#rrggbbaa", curve?], got ${JSON.stringify(key)}`);
        return;
      }
      keys.times.push(key[0]);
      keys.values.push(...color);
      keys.curves.push(key[2]);
      keys.paths.push(keyPath);
    });
    done(keys);
  }

  private drawOrderKeys(json: unknown, path: string): AnimationData['drawOrder'] {
    if (!Array.isArray(json) || json.length === 0) {
      this.fail(path, 'must be a non-empty array of [time, slot names or null]');
      return null;
    }
    const times: number[] = [];
    const orders: (Int16Array | null)[] = [];
    json.forEach((key, index) => {
      const keyPath = `${path}[${index}]`;
      if (!Array.isArray(key) || typeof key[0] !== 'number' || (key[1] !== null && !Array.isArray(key[1]))) {
        this.fail(keyPath, 'must be [time, slot names or null]');
        return;
      }
      if (times.length > 0 && key[0] < times[times.length - 1]) {
        this.fail(keyPath, 'keys must be in time order');
      }
      times.push(key[0]);
      if (key[1] === null) {
        orders.push(null);
        return;
      }
      const listed = (key[1] as unknown[]).map((slot, slotIndex) => this.find(this.slotIndex, slot, `${keyPath}[1][${slotIndex}]`, 'slot'));
      if (new Set(listed).size !== listed.length) {
        this.fail(`${keyPath}[1]`, 'lists a slot twice');
      }
      // The listed slots take the setup places they already hold, in the listed order.
      const places = [...listed].sort((first, second) => first - second);
      const order = Int16Array.from(this.slots, slot => slot.index);
      places.forEach((place, placeIndex) => (order[place] = listed[placeIndex]));
      orders.push(order);
    });
    return {times: Float64Array.from(times), orders};
  }

  private compileMixes(json: unknown): Map<string, number> {
    const mixes = new Map<string, number>();
    if (json === undefined) {
      return mixes;
    }
    if (!isRecord(json)) {
      this.fail('mixes', 'must be an object like {"idle>walk": 0.15}');
      return mixes;
    }
    for (const key of Object.keys(json)) {
      const [from, to, extra] = key.split('>');
      if (to === undefined || extra !== undefined) {
        this.fail(`mixes.${key}`, 'the key must be "from>to", e.g. "idle>walk"');
        continue;
      }
      this.find(this.animationIndex, from, `mixes.${key}`, 'animation');
      this.find(this.animationIndex, to, `mixes.${key}`, 'animation');
      mixes.set(key, this.number(json, key, `mixes.${key}`, 0, 0));
    }
    return mixes;
  }

  /**
   * Orders bone and constraint updates so each constraint runs after the bones it reads and
   * before the bones under the ones it moves (Spine's update cache). A bone a constraint moved
   * gets its children recomputed after the constraint, so a bone can appear more than once.
   * Constraints run by `order`, then sliders, IK, transforms, paths, and physics, each in file order.
   */
  private computeUpdateOrder(ik: IkData[], transforms: TransformData[], physics: PhysicsData[], sliders: SliderData[], paths: PathData[], animations: AnimationData[]): Int32Array {
    const sorted = new Uint8Array(this.bones.length);
    const children = this.bones.map(() => [] as number[]);
    for (const bone of this.bones) {
      if (bone.parent >= 0) {
        children[bone.parent].push(bone.index);
      }
    }
    const order: number[] = [];
    const sortBone = (bone: number) => {
      if (sorted[bone]) {
        return;
      }
      if (this.bones[bone].parent >= 0) {
        sortBone(this.bones[bone].parent);
      }
      order.push(bone);
      sorted[bone] = 1;
    };
    const sortReset = (bones: readonly number[]) => {
      for (const bone of bones) {
        if (sorted[bone]) {
          sortReset(children[bone]);
          sorted[bone] = 0;
        }
      }
    };
    const constraintEntry = (kind: number, index: number) => -1 - (kind * CONSTRAINT_KINDS_STRIDE + index);
    // Ties run in kind order: sliders, IK, transforms, paths, physics. Indexed by UPDATE_* kind.
    const kindRank = [1, 2, 4, 0, 3];
    const queue = [
      ...ik.map(constraint => ({kind: UPDATE_IK, index: constraint.index})),
      ...transforms.map(constraint => ({kind: UPDATE_TRANSFORM, index: constraint.index})),
      ...physics.map(constraint => ({kind: UPDATE_PHYSICS, index: constraint.index})),
      ...sliders.map(constraint => ({kind: UPDATE_SLIDER, index: constraint.index})),
      ...paths.map(constraint => ({kind: UPDATE_PATH, index: constraint.index})),
    ].sort(
      (first, second) =>
        (this.constraintOrders[first.kind][first.index] ?? 0) - (this.constraintOrders[second.kind][second.index] ?? 0) ||
        kindRank[first.kind] - kindRank[second.kind] ||
        first.index - second.index,
    );
    for (const {kind, index} of queue) {
      if (kind === UPDATE_IK) {
        const constraint = ik[index];
        if (constraint.bones.length === 0) {
          continue;
        }
        sortBone(constraint.target);
        const parent = constraint.bones[0];
        sortBone(parent);
        const child = constraint.bones[constraint.bones.length - 1];
        sortBone(child);
        order.push(constraintEntry(UPDATE_IK, index));
        sortReset(children[parent]);
        sorted[child] = 1;
      } else if (kind === UPDATE_TRANSFORM) {
        const constraint = transforms[index];
        sortBone(constraint.source);
        constraint.bones.forEach(sortBone);
        order.push(constraintEntry(UPDATE_TRANSFORM, index));
        constraint.bones.forEach(bone => sortReset(children[bone]));
        constraint.bones.forEach(bone => (sorted[bone] = 1));
      } else if (kind === UPDATE_PATH) {
        // The path's points ride its slot's bone (and any bones they are weighted to).
        const constraint = paths[index];
        sortBone(this.slots[constraint.slot].bone);
        for (const skin of this.skinList) {
          for (const attachment of skin.attachments[constraint.slot]) {
            if (attachment?.kind === 'path' && attachment.weights) {
              for (let read = 0; read < attachment.weights.length; read += 1 + attachment.weights[read] * 4) {
                for (let i = 0; i < attachment.weights[read]; i++) {
                  sortBone(attachment.weights[read + 1 + i * 4]);
                }
              }
            }
          }
        }
        constraint.bones.forEach(sortBone);
        order.push(constraintEntry(UPDATE_PATH, index));
        constraint.bones.forEach(bone => sortReset(children[bone]));
        constraint.bones.forEach(bone => (sorted[bone] = 1));
      } else if (kind === UPDATE_PHYSICS) {
        const constraint = physics[index];
        sortBone(constraint.bone);
        order.push(constraintEntry(UPDATE_PHYSICS, index));
        sortReset(children[constraint.bone]);
        sorted[constraint.bone] = 1;
      } else {
        // A slider writes the local pose of the bones its animation keys: those (and their
        // children) update after it, so they see what it wrote.
        const slider = sliders[index];
        if (slider.driver) {
          sortBone(slider.driver.bone);
        }
        order.push(constraintEntry(UPDATE_SLIDER, index));
        const keyedBones = new Set<number>();
        for (const timeline of animations[slider.animation]?.timelines ?? []) {
          if (timeline.kind === TIMELINE_BONE) {
            keyedBones.add(Math.floor(timeline.target / BONE_STRIDE));
          }
        }
        sortReset([...keyedBones]);
      }
    }
    this.bones.forEach(bone => sortBone(bone.index));
    return Int32Array.from(order);
  }
}

/**
 * Returns how far point (x, y) is from the segment (x0, y0)-(x1, y1) along the segment's own
 * direction: 0 anywhere beside it, else the distance past its nearer end. Sideways distance only
 * breaks ties. Measured this way, every point across a limb (a grid row) gets the same weights, so
 * rows stay straight and only the rows near a joint bend. Straight-line distance would let a row's
 * outer corners lean toward the next bone sooner than its middle, twisting the row.
 */
function distanceAlongSegment(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return Math.hypot(x - x0, y - y0);
  }
  const along = ((x - x0) * dx + (y - y0) * dy) / length;
  const sideways = Math.abs((x - x0) * dy - (y - y0) * dx) / length;
  return Math.max(0, -along, along - length) + sideways * SIDEWAYS_TIEBREAK;
}

/** Most of the shorter bone a mesh joint's bend may cover, so a short foot bends at its ankle instead of all along. */
const JOINT_BLEND_CAP = 0.3;

/** Smallest mesh row height kept when extra rows go in around joints, as a share of the image height. */
const MIN_ROW_GAP = 0.015;

/** Share of sideways distance counted in {@link distanceAlongSegment}, only to break ties. */
const SIDEWAYS_TIEBREAK = 0.001;

/** Returns `shares` scaled to add up to 1 (or unchanged if they add up to 0). */
function normalizeShares(shares: Map<number, number>): Map<number, number> {
  let total = 0;
  for (const share of shares.values()) {
    total += share;
  }
  if (total <= 0) {
    return shares;
  }
  return new Map([...shares].map(([bone, share]) => [bone, share / total]));
}

/** Returns true if (x, y) is inside `polygon`, by the even-odd rule. */
function isInsidePolygon(polygon: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Cuts a simple polygon (points in order, either way round) into triangles, one ear at a time. */
function triangulateOutline(polygon: [number, number][]): [number, number, number][] {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  }
  const turn = area > 0 ? 1 : -1;
  const cross = (a: number, b: number, c: number) => (polygon[b][0] - polygon[a][0]) * (polygon[c][1] - polygon[a][1]) - (polygon[b][1] - polygon[a][1]) * (polygon[c][0] - polygon[a][0]);
  const remaining = polygon.map((_, index) => index);
  const triangles: [number, number, number][] = [];
  let guard = remaining.length * remaining.length;
  while (remaining.length > 3 && guard-- > 0) {
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length];
      const b = remaining[i];
      const c = remaining[(i + 1) % remaining.length];
      // An ear: a corner that turns the outline's way, with no other corner inside it.
      if (cross(a, b, c) * turn <= 0) {
        continue;
      }
      const isEar = remaining.every(other => other === a || other === b || other === c || cross(a, b, other) * turn < 0 || cross(b, c, other) * turn < 0 || cross(c, a, other) * turn < 0);
      if (isEar) {
        triangles.push([a, b, c]);
        remaining.splice(i, 1);
        break;
      }
    }
  }
  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }
  return triangles;
}

/** Triangulates points by Delaunay (Bowyer-Watson): no point inside any triangle's circumcircle. */
function triangulatePoints(points: [number, number][]): [number, number, number][] {
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1) * 20;
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  // A huge triangle around every point, its corners at indexes n, n + 1, n + 2.
  const all: [number, number][] = [...points, [centerX - span, centerY - span], [centerX + span, centerY - span], [centerX, centerY + span]];
  const n = points.length;
  let triangles: [number, number, number][] = [[n, n + 1, n + 2]];
  const inCircle = ([a, b, c]: [number, number, number], x: number, y: number) => {
    const [ax, ay] = all[a];
    const [bx, by] = all[b];
    const [cx, cy] = all[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (d === 0) {
      return false;
    }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return (x - ux) ** 2 + (y - uy) ** 2 < (ax - ux) ** 2 + (ay - uy) ** 2 - 1e-9;
  };
  for (let p = 0; p < n; p++) {
    const [x, y] = all[p];
    const bad = triangles.filter(triangle => inCircle(triangle, x, y));
    // The hole's edges: those only one bad triangle has.
    const edges: [number, number][] = [];
    for (const [a, b, c] of bad) {
      for (const [from, to] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const shared = bad.some(other => other !== bad.find(item => item[0] === a && item[1] === b && item[2] === c) && other.includes(from) && other.includes(to));
        if (!shared) {
          edges.push([from, to]);
        }
      }
    }
    triangles = triangles.filter(triangle => !bad.includes(triangle));
    for (const [from, to] of edges) {
      triangles.push([from, to, p]);
    }
  }
  return triangles.filter(triangle => triangle.every(corner => corner < n));
}
