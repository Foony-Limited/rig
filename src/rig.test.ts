import {describe, expect, it} from 'vitest';
import {AnimationState, updateRig} from './animationState.js';
import {compileRig, getRigImageNames, RigCompileError} from './compileRig.js';
import {applyCurve, getCurveCode} from './curves.js';
import type {RigFile} from './rigFormat.js';
import {BONE_ROTATION, BONE_SCALE_X, BONE_STRIDE, MeshAttachment, RegionAttachment} from './rigData.js';
import {SkeletonBounds} from './bounds.js';
import {MESH_STRIP_FLOATS, planMeshStrips} from './canvasRenderer.js';
import {Raster} from './cli/raster.js';
import {Skeleton} from './skeleton.js';

const IMAGE_SIZES: {[name: string]: {width: number; height: number}} = {
  arm: {width: 100, height: 20},
  hat: {width: 40, height: 40},
  crown: {width: 50, height: 30},
  tail: {width: 200, height: 40},
};

function getImageSize(name: string) {
  return IMAGE_SIZES[name];
}

/** A two-bone arm on a root, with an IK target, plus whatever the test adds. */
function makeArmRig(extra: Partial<RigFile> = {}): RigFile {
  return {
    format: 'foony-rig@1',
    name: 'test',
    images: 'img/test',
    bones: [
      {name: 'root'},
      {name: 'upper', parent: 'root', rotation: 0, length: 50},
      {name: 'lower', parent: 'upper', x: 50, length: 50},
      {name: 'target', parent: 'root', x: 60, y: 30},
      {name: 'gear', parent: 'root'},
      {name: 'gear2', parent: 'root'},
    ],
    slots: [
      {name: 'upper', bone: 'upper', attachment: 'arm', attachments: {arm: {pivot: [0, 10], tip: [100, 10]}}},
      {name: 'lower', bone: 'lower', attachment: 'arm', attachments: {arm: {pivot: [0, 10], tip: [100, 10]}}},
      {name: 'hat', bone: 'root', attachment: 'hat', attachments: {hat: {}}},
    ],
    ...extra,
  };
}

function compileError(file: unknown): string {
  try {
    compileRig(file, getImageSize);
  } catch (error) {
    if (error instanceof RigCompileError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('expected a compile error');
}

function boneRotation(skeleton: Skeleton, name: string): number {
  return skeleton.local[skeleton.findBone(name) * BONE_STRIDE + BONE_ROTATION];
}

describe('compileRig', () => {
  it('suggests the closest name for an unknown parent', () => {
    const file = makeArmRig();
    file.bones[2] = {name: 'lower', parent: 'uper'};
    expect(compileError(file)).toContain('bones[2].parent: no bone "uper". Did you mean "upper"?');
  });

  it('names the path of an unknown bone in an animation', () => {
    const file = makeArmRig({animations: {wave: {bones: {lowr: {rotate: [[0, 0]]}}}}});
    expect(compileError(file)).toContain('animations.wave.bones.lowr: no bone "lowr". Did you mean "lower"?');
  });

  it('rejects keys out of time order', () => {
    const file = makeArmRig({animations: {wave: {bones: {lower: {rotate: [[0.5, 0], [0.2, 10]]}}}}});
    expect(compileError(file)).toContain('animations.wave.bones.lower.rotate[1]');
  });

  it('rejects an IK target inside its own chain', () => {
    const file = makeArmRig({ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'lower'}]});
    expect(compileError(file)).toContain('ik[0].target');
  });

  it('rejects a property keyed by both a pose and bone keys', () => {
    const file = makeArmRig({
      poses: {up: {upper: {rotate: 90}}},
      animations: {wave: {pose: [[0, 'up']], bones: {upper: {rotate: [[0, 10]]}}}},
    });
    expect(compileError(file)).toContain('animations.wave.bones.upper.rotate');
  });

  it('lists a cropped rig\'s images before their sizes are known', () => {
    const file = makeArmRig();
    file.slots[2].attachments = {hat: {crop: [0, 10, 40, 40]}};
    expect(getRigImageNames(file)).toEqual(['arm', 'hat']);
  });

  it('reports a slot that is not an object, and still finds the slots after it', () => {
    const file = makeArmRig({animations: {wave: {slots: {hat: {alpha: [[0, 0.5]]}}}}});
    (file.slots as unknown[]).unshift(null);
    expect(compileError(file)).toBe('[rig] test: 1 problem(s)\nslots[0]: must be an object');
  });

  it('reports a bone that is not an object, and still finds the bones after it', () => {
    const file = makeArmRig();
    (file.bones as unknown[]).splice(1, 0, 7);
    expect(compileError(file)).toBe('[rig] test: 1 problem(s)\nbones[1]: must be an object');
  });

  it('fits a region with a tip onto its bone', () => {
    const data = compileRig(makeArmRig(), getImageSize);
    const arm = data.defaultSkin.attachments[0][0] as RegionAttachment;
    const [a, b, c, d, e, f] = arm.matrix;
    // The tip pixel (100, 10) lands on the bone tip (50, 0) and the pivot (0, 10) on the origin.
    expect(a * 100 + c * 10 + e).toBeCloseTo(50);
    expect(b * 100 + d * 10 + f).toBeCloseTo(0);
    expect(a * 0 + c * 10 + e).toBeCloseTo(0);
    expect(b * 0 + d * 10 + f).toBeCloseTo(0);
  });
});

describe('Skeleton world transforms', () => {
  it('carries a parent turn to its child', () => {
    const file = makeArmRig();
    file.bones[1].rotation = 90;
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    expect(skeleton.getWorldX(skeleton.findBone('lower'))).toBeCloseTo(0);
    expect(skeleton.getWorldY(skeleton.findBone('lower'))).toBeCloseTo(50);
    expect(skeleton.getWorldRotation(skeleton.findBone('lower'))).toBeCloseTo(90);
  });

  it('keeps a noRotation bone upright and a noScale bone its size', () => {
    const file = makeArmRig();
    file.bones[1].rotation = 90;
    file.bones[1].scaleX = 2;
    file.bones[2].inherit = 'noRotation';
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    const lower = skeleton.findBone('lower');
    expect(skeleton.getWorldRotation(lower)).toBeCloseTo(0);
    expect(skeleton.getWorldY(lower)).toBeCloseTo(100);

    file.bones[2].inherit = 'noScale';
    const scaled = new Skeleton(compileRig(file, getImageSize));
    scaled.updateWorld();
    expect(scaled.getWorldRotation(lower)).toBeCloseTo(90);
    expect(scaled.getWorldScaleX(lower)).toBeCloseTo(1);
  });
});

describe('constraints', () => {
  it('reaches a target with a 2-bone IK chain', () => {
    const skeleton = new Skeleton(compileRig(makeArmRig({ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target'}]}), getImageSize));
    skeleton.updateWorld();
    const tip = skeleton.getBoneTip(skeleton.findBone('lower'));
    expect(tip.x).toBeCloseTo(60, 3);
    expect(tip.y).toBeCloseTo(30, 3);
  });

  it('bends the other way with bend -1', () => {
    const up = new Skeleton(compileRig(makeArmRig({ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target', bend: 1}]}), getImageSize));
    const down = new Skeleton(compileRig(makeArmRig({ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target', bend: -1}]}), getImageSize));
    up.updateWorld();
    down.updateWorld();
    const lower = up.findBone('lower');
    expect(Math.sign(up.getWorldY(lower) - 15)).not.toBe(Math.sign(down.getWorldY(lower) - 15));
    expect(down.getBoneTip(lower).x).toBeCloseTo(60, 3);
  });

  it('points a 1-bone IK at its target and stretches to it', () => {
    const skeleton = new Skeleton(
      compileRig(makeArmRig({ik: [{name: 'aim', bones: ['upper'], target: 'target', stretch: true}]}), getImageSize),
    );
    skeleton.updateWorld();
    const tip = skeleton.getBoneTip(skeleton.findBone('upper'));
    expect(tip.x).toBeCloseTo(60, 3);
    expect(tip.y).toBeCloseTo(30, 3);
  });

  it('maps one bone property onto another with a transform constraint', () => {
    const file = makeArmRig({
      transforms: [{name: 'gears', source: 'gear', bones: ['gear2'], map: [{from: 'rotate', to: 'rotate', scale: -2}]}],
    });
    file.bones[4].rotation = 30;
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    expect(skeleton.getWorldRotation(skeleton.findBone('gear2'))).toBeCloseTo(-60);
  });

  it('swings a physics bone the same way at any frame rate, then settles', () => {
    const file = makeArmRig({physics: [{name: 'tail', bone: 'lower', strength: 80, damping: 0.99}]});
    const data = compileRig(file, getImageSize);
    const lower = data.bones.findIndex(bone => bone.name === 'lower');
    const samples: number[][] = [];
    // Rates whose frames land on the 0.1 second samples, so only the physics can differ.
    for (const fps of [30, 60, 120, 240]) {
      const skeleton = new Skeleton(data);
      skeleton.updateWorld();
      const rotations: number[] = [];
      let nextSample = 0.1;
      for (let frame = 1; frame <= fps * 3; frame++) {
        // Move the whole skeleton up the canvas for the first 0.2 seconds, then stop.
        if (frame <= fps * 0.2) {
          skeleton.y -= 400 / fps;
        }
        skeleton.update(1 / fps);
        skeleton.updateWorld();
        if (frame / fps >= nextSample - 1e-9) {
          rotations.push(skeleton.getWorldRotation(lower));
          nextSample += 0.1;
        }
      }
      samples.push(rotations);
    }
    // Sampled every 0.1 seconds: a real swing, close at every frame rate, and back at rest by 3 seconds.
    expect(Math.min(...samples[1])).toBeLessThan(-10);
    for (const rotations of samples) {
      for (let i = 0; i < samples[1].length; i++) {
        expect(Math.abs(rotations[i] - samples[1][i])).toBeLessThan(0.5);
      }
    }
    expect(Math.abs(samples[1][samples[1].length - 1])).toBeLessThan(0.5);
  });

  it('drives a slider from a bone', () => {
    const file = makeArmRig({
      sliders: [{name: 'aim', animation: 'aimRange', driver: {bone: 'gear', property: 'rotate', from: [0, 90]}}],
      animations: {aimRange: {loop: false, bones: {upper: {rotate: [[0, 0], [1, 40]]}}}},
    });
    file.bones[4].rotation = 45;
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    expect(skeleton.getWorldRotation(skeleton.findBone('upper'))).toBeCloseTo(20);
  });
});

describe('animation', () => {
  it('interpolates keys as offsets from setup, with curves', () => {
    const file = makeArmRig({
      animations: {
        wave: {bones: {upper: {rotate: [[0, 0, 'step'], [1, 40], [2, 0]]}, lower: {rotate: [[0, 0], [2, 40]]}}},
      },
    });
    file.bones[1].rotation = 10;
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'wave', {loop: false});
    state.update(0.5);
    state.apply();
    expect(boneRotation(skeleton, 'upper')).toBeCloseTo(10);
    expect(boneRotation(skeleton, 'lower')).toBeCloseTo(10);
    state.update(1);
    state.apply();
    expect(boneRotation(skeleton, 'upper')).toBeCloseTo(30);
    expect(boneRotation(skeleton, 'lower')).toBeCloseTo(30);
  });

  it('keys whole poses', () => {
    const file = makeArmRig({
      poses: {up: {upper: {rotate: 90}, lower: {rotate: -20}}, down: {upper: {rotate: -90}}},
      animations: {flap: {pose: [[0, 'up'], [1, 'down']]}},
    });
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'flap', {loop: false});
    state.update(0.5);
    state.apply();
    expect(boneRotation(skeleton, 'upper')).toBeCloseTo(0);
    expect(boneRotation(skeleton, 'lower')).toBeCloseTo(-10);
  });

  it('crossfades without dipping toward setup', () => {
    const file = makeArmRig({
      defaultMix: 1,
      animations: {
        a: {bones: {upper: {rotate: [[0, 40]]}, lower: {rotate: [[0, 40]]}}},
        b: {bones: {upper: {rotate: [[0, 40]]}}},
      },
    });
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'a');
    state.update(0.1);
    state.apply();
    state.setAnimation(0, 'b');
    state.update(0.5);
    state.apply();
    // Both key upper at 40, so it holds. Only a keys lower, so it fades halfway back to setup.
    expect(boneRotation(skeleton, 'upper')).toBeCloseTo(40);
    expect(boneRotation(skeleton, 'lower')).toBeCloseTo(20);
    state.update(0.6);
    state.apply();
    expect(boneRotation(skeleton, 'lower')).toBeCloseTo(0);
  });

  it('adds an additive track on top of track 0', () => {
    const file = makeArmRig({
      animations: {base: {bones: {upper: {rotate: [[0, 30]]}}}, nod: {bones: {upper: {rotate: [[0, 5]]}}}},
    });
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'base');
    state.setAnimation(1, 'nod', {additive: true});
    state.update(0.1);
    state.apply();
    expect(boneRotation(skeleton, 'upper')).toBeCloseTo(35);
  });

  it('fires each event once per pass, also across the loop seam', () => {
    const file = makeArmRig({
      events: {step: {int: 1}},
      animations: {walk: {duration: 1, bones: {upper: {rotate: [[0, 0], [1, 0]]}}, events: [[0.25, 'step'], [0.75, 'step', {int: 2}]]}},
    });
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    const fired: number[] = [];
    state.onEvent = event => fired.push(event.int);
    state.setAnimation(0, 'walk');
    state.update(0.5);
    state.update(0.6);
    state.update(0.3);
    expect(fired).toEqual([1, 2, 1]);
  });

  it('fires a key at time 0 once per pass when an update ends exactly on the loop seam', () => {
    const file = makeArmRig({events: {step: {}}, animations: {walk: {duration: 1, events: [[0, 'step']]}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const firedAt: number[] = [];
    state.onEvent = (_, entry) => firedAt.push(entry.trackTime);
    state.setAnimation(0, 'walk');
    // Track times 0.5, 1, 1.5, 2, then 3: the last update starts on one seam and ends on the next.
    for (const seconds of [0.5, 0.5, 0.5, 0.5, 1]) {
      state.update(seconds);
    }
    expect(firedAt).toEqual([0.5, 1, 2, 3]);
  });

  it('completes once per pass over many loops of an inexact duration', () => {
    const file = makeArmRig({animations: {walk: {duration: 0.8, bones: {upper: {rotate: [[0, 0], [0.8, 0]]}}}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    let completes = 0;
    state.onComplete = () => completes++;
    state.setAnimation(0, 'walk');
    // 80 seconds and a frame: 100 passes of 0.8s, with the 100th end safely passed.
    for (let frame = 0; frame <= 60 * 80; frame++) {
      state.update(1 / 60);
    }
    expect(completes).toBe(100);
  });

  it('swaps attachments with skins and reorders a subset of slots', () => {
    const file = makeArmRig({
      skins: {royal: {hat: {hat: {image: 'crown'}}}},
      animations: {swap: {drawOrder: [[0, ['hat', 'upper']]]}},
    });
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const hat = skeleton.findSlot('hat');
    expect((skeleton.getAttachment(hat) as RegionAttachment).images[0]).toBe('hat');
    skeleton.setSkins(['royal']);
    expect((skeleton.getAttachment(hat) as RegionAttachment).images[0]).toBe('crown');

    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'swap');
    state.update(0.1);
    state.apply();
    expect(Array.from(skeleton.drawOrder)).toEqual([2, 1, 0]);
  });

  it('bends a mesh corner with the nearest bone', () => {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', pivot: [0, 20], grid: [4, 2], bones: ['upper', 'lower']}}});
    file.bones[2].rotation = 0;
    const data = compileRig(file, getImageSize);
    const skeleton = new Skeleton(data);
    skeleton.local[skeleton.findBone('lower') * BONE_STRIDE + BONE_ROTATION] = 90;
    skeleton.updateWorld();
    const vertices = new Float32Array(64);
    const slot = skeleton.findSlot('tail');
    skeleton.computeMeshVertices(skeleton.getAttachment(slot) as MeshAttachment, vertices);
    // The middle of the image's far edge sits 150 past the lower bone's origin, so it turns straight up.
    expect(vertices[9 * 2]).toBeCloseTo(50, 3);
    expect(vertices[9 * 2 + 1]).toBeCloseTo(150, 3);
  });

  it('gives every point across a limb the same bones, so cross-sections stay straight', () => {
    const file = makeArmRig();
    // The image runs along the bones (x), so its columns cross the limb: each column's top and bottom corner must match.
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', pivot: [0, 20], grid: [8, 1], bones: ['upper', 'lower'], tip: [100, 20]}}});
    const data = compileRig(file, getImageSize);
    const mesh = data.defaultSkin.attachments[data.slots.length - 1][0] as MeshAttachment;
    // Read each corner's influences: count, then (bone, x, y, weight) per influence.
    const influences: string[] = [];
    for (let read = 0, vertex = 0; vertex < mesh.vertexCount; vertex++) {
      const count = mesh.weights[read++];
      influences.push(Array.from({length: count}, (_, i) => `${mesh.weights[read + i * 4]}:${mesh.weights[read + i * 4 + 3].toFixed(3)}`).join(','));
      read += count * 4;
    }
    for (let column = 0; column <= 8; column++) {
      expect(influences[9 + column]).toBe(influences[column]);
    }
  });

  it('keeps a bent joint its full width instead of pinching it', () => {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', pivot: [0, 20], grid: [4, 2], bones: ['upper', 'lower']}}});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.local[skeleton.findBone('lower') * BONE_STRIDE + BONE_ROTATION] = 120;
    skeleton.updateWorld();
    const vertices = new Float32Array(64);
    skeleton.computeMeshVertices(skeleton.getAttachment(skeleton.findSlot('tail')) as MeshAttachment, vertices);
    // Corner 1 sits on the elbow's outline, 20 above the joint at (50, 0), weighted half to each bone.
    // Averaging the two bones' positions would pull it to 10 from the joint: the elbow would pinch.
    expect(Math.hypot(vertices[2] - 50, vertices[3])).toBeCloseTo(20, 3);
  });
});

describe('limb meshes', () => {
  it('adds rows at each joint and half and one blend width either side', () => {
    const file = makeArmRig();
    file.bones[1].rotation = -90;
    file.slots.push({name: 'limb', bone: 'upper', attachment: 'limb', attachments: {limb: {type: 'mesh', image: 'tail', pivot: [20, 0], tip: [20, 200], grid: [1, 6], bones: ['upper', 'lower']}}});
    const skeleton = new Skeleton(compileRig(file, () => ({width: 40, height: 200})));
    const mesh = skeleton.getAttachment(skeleton.findSlot('limb')) as MeshAttachment;
    const rowVs = Array.from({length: mesh.rows + 1}, (_, row) => mesh.uvs[row * (mesh.columns + 1) * 2 + 1]);
    const jointV = mesh.joints![3];
    expect(rowVs).toContainEqual(expect.closeTo(jointV, 3));
    expect(rowVs.filter(v => Math.abs(v - jointV) < 30).length).toBeGreaterThanOrEqual(5);
    expect(rowVs[0]).toBe(0);
    expect(rowVs[rowVs.length - 1]).toBe(200);
    rowVs.slice(1).forEach((v, i) => expect(v).toBeGreaterThan(rowVs[i]));
  });

  it('keeps each row a straight line when a slanted chain bends', () => {
    const file = makeArmRig();
    // A setup elbow off the line from shoulder to wrist, so the chain runs slanted down the image.
    file.bones[1].rotation = -80;
    file.bones[2].rotation = -25;
    file.slots.push({name: 'limb', bone: 'upper', attachment: 'limb', attachments: {limb: {type: 'mesh', image: 'tail', pivot: [60, 0], tip: [60, 200], grid: [4, 6], bones: ['upper', 'lower']}}});
    const skeleton = new Skeleton(compileRig(file, () => ({width: 120, height: 200})));
    skeleton.local[skeleton.findBone('lower') * BONE_STRIDE + BONE_ROTATION] = 100;
    skeleton.updateWorld();
    const mesh = skeleton.getAttachment(skeleton.findSlot('limb')) as MeshAttachment;
    expect(Math.abs(mesh.joints![2] - mesh.joints![0])).toBeGreaterThan(5);
    const vertices = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, vertices);
    const stride = mesh.columns + 1;
    for (let row = 0; row <= mesh.rows; row++) {
      const left = row * stride * 2;
      const right = (row * stride + mesh.columns) * 2;
      for (let column = 1; column < mesh.columns; column++) {
        const t = column / mesh.columns;
        const vertex = (row * stride + column) * 2;
        expect(vertices[vertex]).toBeCloseTo(vertices[left] + (vertices[right] - vertices[left]) * t, 3);
        expect(vertices[vertex + 1]).toBeCloseTo(vertices[left + 1] + (vertices[right + 1] - vertices[left + 1]) * t, 3);
      }
    }
  });
});

describe('stretched limb meshes', () => {
  it('keeps the bend at a joint on the joint when the lower bone is stretched', () => {
    // A limb running down from the shoulder, far from the skeleton's origin, its lower bone bent and
    // stretched to 3 times its length, as a lunging attack might stretch a forearm.
    const file = makeArmRig();
    file.bones[1] = {name: 'upper', parent: 'root', x: 400, y: 300, rotation: -90, length: 100};
    file.bones[2] = {name: 'lower', parent: 'upper', x: 100, length: 100};
    file.slots.push({name: 'limb', bone: 'upper', attachment: 'limb', attachments: {limb: {type: 'mesh', image: 'tail', pivot: [20, 0], tip: [20, 200], grid: [1, 6], bones: ['upper', 'lower']}}});
    const skeleton = new Skeleton(compileRig(file, () => ({width: 40, height: 200})));
    const lower = skeleton.findBone('lower');
    skeleton.local[lower * BONE_STRIDE + BONE_ROTATION] = 60;
    skeleton.local[lower * BONE_STRIDE + BONE_SCALE_X] = 3;
    skeleton.updateWorld();
    const mesh = skeleton.getAttachment(skeleton.findSlot('limb')) as MeshAttachment;
    const vertices = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, vertices);
    // The row at the joint (both bones' weights) stays at the elbow, not flung off by the stretch.
    const jointRow = Array.from({length: mesh.rows + 1}, (_, row) => mesh.uvs[row * (mesh.columns + 1) * 2 + 1]).findIndex(v => Math.abs(v - mesh.joints![3]) < 0.5);
    const middle = jointRow * (mesh.columns + 1) * 2;
    const middleX = (vertices[middle] + vertices[middle + 2]) / 2;
    const middleY = (vertices[middle + 1] + vertices[middle + 3]) / 2;
    const miss = Math.hypot(middleX - skeleton.getWorldX(lower), middleY - skeleton.getWorldY(lower));
    expect(miss, `the joint row is ${miss.toFixed(1)} from the elbow`).toBeLessThan(15);
  });
});

describe('spine parity: constraints and points', () => {
  /** A rig whose root is squashed to `scaleY`, so every bone under it has uneven parent scale. */
  function squashed(extra: Partial<RigFile>, scaleY = 0.6): Skeleton {
    const file = makeArmRig(extra);
    file.bones[0] = {name: 'root', scaleY};
    return new Skeleton(compileRig(file, getImageSize));
  }

  it('points a 1-bone IK at its target under a squashed parent', () => {
    const skeleton = squashed({ik: [{name: 'aim', bones: ['upper'], target: 'target'}]});
    skeleton.updateWorld();
    const upper = skeleton.findBone('upper');
    const target = skeleton.findBone('target');
    const tip = skeleton.getBoneTip(upper);
    const want = Math.atan2(skeleton.getWorldY(target), skeleton.getWorldX(target));
    expect(Math.atan2(tip.y - skeleton.getWorldY(upper), tip.x - skeleton.getWorldX(upper))).toBeCloseTo(want, 3);
  });

  it('reaches a target with a 2-bone IK chain under a squashed parent', () => {
    const skeleton = squashed({ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target'}]});
    skeleton.updateWorld();
    const tip = skeleton.getBoneTip(skeleton.findBone('lower'));
    const target = skeleton.findBone('target');
    expect(Math.hypot(tip.x - skeleton.getWorldX(target), tip.y - skeleton.getWorldY(target))).toBeLessThan(0.5);
  });

  it('copies a world rotation under a squashed parent', () => {
    const file = makeArmRig({transforms: [{name: 'copy', source: 'gear', bones: ['gear2'], space: 'world', map: [{from: 'rotate', to: 'rotate'}]}]});
    file.bones[0] = {name: 'root', scaleY: 0.6};
    file.bones[4] = {name: 'gear', parent: 'root', rotation: 50};
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    expect(skeleton.getWorldRotation(skeleton.findBone('gear2'))).toBeCloseTo(skeleton.getWorldRotation(skeleton.findBone('gear')), 3);
  });

  it('turns a point attachment the right way on a mirrored bone', () => {
    const file = makeArmRig();
    file.bones[1] = {name: 'upper', parent: 'root', scaleX: -1, length: 50};
    file.slots[0].attachments = {...file.slots[0].attachments, muzzle: {type: 'point', x: 10, y: 0, rotation: 30}};
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    const point = skeleton.getPoint(skeleton.findSlot('upper'), 'muzzle')!;
    expect(point.x).toBeCloseTo(-10);
    expect(point.rotation).toBeCloseTo(150);
  });

  it('keeps world values finite when a parent is scaled to 0', () => {
    const file = makeArmRig({
      ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target', stretch: true}],
      physics: [{name: 'tail', bone: 'lower', strength: 80, damping: 0.9, stretch: 1, translate: 1}],
    });
    file.bones[1] = {name: 'upper', parent: 'root', scaleX: 0, scaleY: 0, length: 50};
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    for (let frame = 0; frame < 5; frame++) {
      skeleton.y -= 10;
      skeleton.update(1 / 60);
      skeleton.updateWorld();
    }
    skeleton.setBoneWorldPosition(skeleton.findBone('lower'), 5, 5);
    skeleton.updateWorld();
    expect(Array.from(skeleton.world).every(Number.isFinite)).toBe(true);
    expect(Array.from(skeleton.applied).every(Number.isFinite)).toBe(true);
    skeleton.scaleX = 0;
    expect(Number.isFinite(skeleton.toSkeleton(10, 10).x)).toBe(true);
  });
});

describe('spine parity: constraint order', () => {
  it('runs a transform before an IK that aims at the bone it moves, when ordered so', () => {
    const file = makeArmRig({
      ik: [{name: 'arm', bones: ['upper', 'lower'], target: 'target'}],
      transforms: [{name: 'follow', source: 'gear', bones: ['target'], space: 'world', map: [{from: 'x', to: 'x'}, {from: 'y', to: 'y'}], order: -1}],
    });
    file.bones[4] = {name: 'gear', parent: 'root', x: 40, y: 50};
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    const tip = skeleton.getBoneTip(skeleton.findBone('lower'));
    expect(tip.x).toBeCloseTo(40, 3);
    expect(tip.y).toBeCloseTo(50, 3);
  });

  it('runs a slider after the transform that sets its driver, when ordered so', () => {
    const file = makeArmRig({
      transforms: [{name: 'copy', source: 'gear', bones: ['gear2'], map: [{from: 'rotate', to: 'rotate'}]}],
      sliders: [{name: 'aim', animation: 'aimRange', driver: {bone: 'gear2', property: 'rotate', from: [0, 90]}, order: 1}],
      animations: {aimRange: {loop: false, bones: {upper: {rotate: [[0, 0], [1, 40]]}}}},
    });
    file.bones[4].rotation = 90;
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.updateWorld();
    expect(skeleton.getWorldRotation(skeleton.findBone('upper'))).toBeCloseTo(40);
  });
});

describe('spine parity: dark tint', () => {
  it('sets up and keys a slot\'s dark color', () => {
    const file = makeArmRig({animations: {flash: {slots: {upper: {dark: [[0, '#000000'], [1, '#ffffff']]}}}}});
    file.slots[1].dark = '#204060';
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const lower = skeleton.findSlot('lower');
    expect(Array.from(skeleton.slotDarks.subarray(lower * 3, lower * 3 + 3)).map(value => Math.round(value * 255))).toEqual([32, 64, 96]);
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'flash', {loop: false});
    state.update(0.5);
    state.apply();
    const upper = skeleton.findSlot('upper');
    expect(skeleton.slotDarks[upper * 3]).toBeCloseTo(0.5);
  });

  it('turns art white with a white dark color in the CLI raster', () => {
    const raster = new Raster(1, 1, [0, 0, 0]);
    const texture = {bitmap: {width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255])}, scaleX: 1, scaleY: 1};
    raster.drawImage(texture, [1, 0, 0, 1, 0, 0], [0, 0, 1, 1], [1, 1, 1, 1, 1, 1, 1], 'source-over', null, [0, 0, 1, 1]);
    expect(Array.from(raster.getPixel(0, 0)).map(value => Math.round(value * 255))).toEqual([255, 255, 255, 255]);
  });
});

describe('spine parity: flipbooks', () => {
  /** A rig whose hat slot is a 4-frame flipbook, with `animations`. */
  function makeFlipbook(animations: RigFile['animations'], mesh = false): Skeleton {
    const file = makeArmRig({animations});
    file.slots[2].attachments = {hat: mesh ? {type: 'mesh', frames: ['hat', 'hat', 'hat', 'hat'], fps: 4} : {frames: ['hat', 'hat', 'hat', 'hat'], fps: 4}};
    return new Skeleton(compileRig(file, getImageSize));
  }

  function frameOf(skeleton: Skeleton): number {
    const hat = skeleton.findSlot('hat');
    return skeleton.getFrame(hat, skeleton.getAttachment(hat) as RegionAttachment);
  }

  it('plays a keyed flipbook by animation time, so it freezes with the animation', () => {
    const skeleton = makeFlipbook({spin: {duration: 2, slots: {hat: {sequence: [[0, {fps: 4}]]}}}});
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'spin');
    updateRig(state, 0.6);
    expect(frameOf(skeleton)).toBe(2);
    state.timeScale = 0;
    updateRig(state, 1);
    expect(frameOf(skeleton)).toBe(2);
  });

  it('holds a keyed frame and plays in reverse', () => {
    const skeleton = makeFlipbook({hold: {slots: {hat: {sequence: [[0, {mode: 'hold', frame: 3}]]}}}, back: {duration: 2, slots: {hat: {sequence: [[0, {mode: 'loopReverse'}]]}}}});
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'hold');
    updateRig(state, 0.6);
    expect(frameOf(skeleton)).toBe(3);
    state.setAnimation(0, 'back', {mix: 0});
    updateRig(state, 0.3);
    expect(frameOf(skeleton)).toBe(2);
  });

  it('flips a mesh through its frames', () => {
    const skeleton = makeFlipbook({}, true);
    skeleton.updateWorld();
    skeleton.update(0.6);
    skeleton.updateWorld();
    const hat = skeleton.findSlot('hat');
    const mesh = skeleton.getAttachment(hat) as MeshAttachment;
    expect(mesh.images.length).toBe(4);
    expect(skeleton.getFrame(hat, mesh)).toBe(2);
  });
});

describe('spine parity: listeners', () => {
  it('reports start, interrupt, end, and complete in order, after the update', () => {
    const file = makeArmRig({animations: {a: {duration: 1}, b: {duration: 0.25}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const log: string[] = [];
    state.onStart = entry => log.push(`start ${entry.animation.name}`);
    state.onInterrupt = entry => log.push(`interrupt ${entry.animation.name}`);
    state.onEnd = entry => log.push(`end ${entry.animation.name}`);
    state.onComplete = entry => log.push(`complete ${entry.animation.name}`);
    state.setAnimation(0, 'a');
    state.update(0.5);
    state.setAnimation(0, 'b', {mix: 0.2, loop: false});
    state.update(0.1);
    state.update(0.2);
    state.clearTrack(0);
    expect(log).toEqual(['start a', 'interrupt a', 'start b', 'complete b', 'end a', 'end b']);
  });

  it('fires the keys and completion of an entry while the entry queued after it fades in', () => {
    const file = makeArmRig({events: {hit: {}}, animations: {attack: {duration: 1, events: [[0.9, 'hit']]}, idle: {duration: 1}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const log: string[] = [];
    state.onEvent = (event, entry) => log.push(`${event.name} ${entry.animation.name}`);
    state.onComplete = entry => log.push(`complete ${entry.animation.name}`);
    state.onEnd = entry => log.push(`end ${entry.animation.name}`);
    state.setAnimation(0, 'attack', {loop: false});
    // Starts fading in at 0.75, so attack's last quarter, its hit, and its end play under the fade.
    state.addAnimation(0, 'idle', {mix: 0.25});
    for (const seconds of [0.75, 0.1, 0.1, 0.1]) {
      state.update(seconds);
    }
    expect(log).toEqual(['hit attack', 'complete attack', 'end attack']);
  });

  it('stops firing a fading entry\'s keys once a new animation interrupts it', () => {
    const file = makeArmRig({
      events: {hit: {}},
      animations: {attack: {duration: 1, events: [[0.75, 'hit'], [0.95, 'hit']]}, idle: {duration: 1}, hurt: {duration: 1}},
    });
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const log: string[] = [];
    state.onEvent = (event, entry) => log.push(`${event.name} ${entry.animation.name}`);
    state.onComplete = entry => log.push(`complete ${entry.animation.name}`);
    state.setAnimation(0, 'attack', {loop: false});
    state.addAnimation(0, 'idle', {mix: 0.3});
    state.update(0.7);
    state.update(0.1);
    // attack is at 0.8, fading out under idle. hurt interrupts both before attack's second hit.
    state.setAnimation(0, 'hurt', {mix: 0.4});
    for (const seconds of [0.1, 0.1, 0.1]) {
      state.update(seconds);
    }
    expect(log).toEqual(['hit attack']);
  });

  it('lets a listener switch animations without the old one firing on', () => {
    const file = makeArmRig({events: {step: {}}, animations: {a: {duration: 0.5, events: [[0.1, 'step'], [0.4, 'step']]}, b: {duration: 1}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const log: string[] = [];
    state.onEvent = (event, entry) => {
      log.push(`${event.name} ${entry.animation.name}`);
      if (entry.animation.name === 'a') {
        state.setAnimation(0, 'b', {mix: 0});
      }
    };
    state.setAnimation(0, 'a');
    state.update(0.2);
    state.update(0.3);
    expect(log).toEqual(['step a']);
    expect(state.tracks[0]!.animation.name).toBe('b');
  });
});

describe('spine parity: bounds', () => {
  /** A rig with a hitbox on the lower arm and a hurtbox on the root, placed at canvas (x, 0). */
  function boxed(x: number): Skeleton {
    const file = makeArmRig();
    file.slots.push(
      {name: 'hurt', bone: 'root', attachment: 'hurt', attachments: {hurt: {type: 'box', points: [[-10, 0], [10, 0], [10, 40], [-10, 40]]}}},
      {name: 'hit', bone: 'lower', attachment: 'hit', attachments: {hit: {type: 'box', points: [[40, -5], [60, -5], [60, 5], [40, 5]]}}},
    );
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    skeleton.x = x;
    skeleton.updateWorld();
    return skeleton;
  }

  it('finds every box at a point and along a segment, in canvas space', () => {
    const bounds = new SkeletonBounds();
    bounds.update(boxed(0));
    expect(bounds.aabbContainsPoint(95, 0)).toBe(true);
    expect(bounds.aabbContainsPoint(200, 0)).toBe(false);
    expect(bounds.containsPoint(95, 0)).toEqual(['hit']);
    expect(bounds.containsPoint(0, -20)).toEqual(['hurt']);
    expect(bounds.intersectsSegment(-50, -20, 150, -20)).toEqual(['hurt']);
  });

  it('pairs up the boxes of two skeletons that overlap', () => {
    const attacker = new SkeletonBounds();
    const defender = new SkeletonBounds();
    attacker.update(boxed(0));
    defender.update(boxed(100));
    expect(attacker.overlaps(defender)).toEqual([['hit', 'hurt']]);
    defender.update(boxed(300));
    expect(attacker.overlaps(defender)).toEqual([]);
  });

  it('measures the whole skeleton for culling', () => {
    const skeleton = boxed(0);
    const box = skeleton.getBounds();
    // The arm's two 50-unit regions run right from the root to x 100. The hat sits around the root.
    expect(box.minX).toBeLessThan(0);
    expect(box.maxX).toBeCloseTo(100);
    expect(box.maxY - box.minY).toBeGreaterThan(5);
  });
});

describe('spine parity: physics movement', () => {
  /** A physics tail on the lower arm, settled, then `move` run each frame for 1 s. Returns the largest swing in degrees. */
  function swing(move: (skeleton: Skeleton, frame: number) => void, limit = 5000): number {
    const file = makeArmRig({physics: [{name: 'tail', bone: 'lower', strength: 80, damping: 0.9, limit}]});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const lower = skeleton.findBone('lower');
    skeleton.updateWorld();
    let largest = 0;
    for (let frame = 0; frame < 60; frame++) {
      move(skeleton, frame);
      skeleton.update(1 / 60);
      skeleton.updateWorld();
      largest = Math.max(largest, Math.abs(skeleton.getWorldRotation(lower)));
    }
    return largest;
  }

  it('teleports without swinging physics parts', () => {
    expect(swing((skeleton, frame) => frame === 5 && (skeleton.x += 3000))).toBeGreaterThan(10);
    expect(swing((skeleton, frame) => frame === 5 && skeleton.teleport(skeleton.x + 3000, skeleton.y))).toBeLessThan(0.01);
  });

  it('lets physics feel only some of the skeleton\'s movement', () => {
    const rise = (skeleton: Skeleton) => (skeleton.y -= 10);
    expect(swing(rise)).toBeGreaterThan(5);
    expect(
      swing(skeleton => {
        skeleton.physicsMoveY = 0;
        rise(skeleton);
      }),
    ).toBeLessThan(0.01);
  });

  it('caps the lag a sudden jump shows at the limit', () => {
    // The tip can't lag more than 10 units behind a 50-unit bone, so the swing stays near atan(10 / 50).
    expect(swing((skeleton, frame) => frame === 5 && (skeleton.y -= 3000), 10)).toBeLessThan(13);
  });
});

describe('spine parity: shape keys', () => {
  /** The tail mesh on the upper bone with a shape key pushing its middle up 10 image pixels. */
  function shaped(): {skeleton: Skeleton; state: AnimationState; mesh: MeshAttachment; slot: number} {
    const file = makeArmRig({
      animations: {puff: {loop: false, deform: {tail: {tail: [[0, []], [1, [{at: [100, 20], move: [0, -10], radius: 60}]]]}}}},
    });
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', image: 'tail', pivot: [0, 20], tip: [200, 20], grid: [4, 2]}}});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const slot = skeleton.findSlot('tail');
    return {skeleton, state: new AnimationState(skeleton), mesh: skeleton.getAttachment(slot) as MeshAttachment, slot};
  }

  it('moves the mesh around a handle by the key, fading with distance', () => {
    const {skeleton, state, mesh, slot} = shaped();
    skeleton.updateWorld();
    const before = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, before, slot);
    state.setAnimation(0, 'puff', {loop: false});
    updateRig(state, 1);
    const after = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, after, slot);
    // Corner (column 2, row 1) sits on the handle: it moves the full 10 image pixels up, 2.5 rig units (200 pixels span the 50-unit bone).
    const middle = (1 * 5 + 2) * 2;
    expect(after[middle] - before[middle]).toBeCloseTo(0, 3);
    expect(after[middle + 1] - before[middle + 1]).toBeCloseTo(2.5, 3);
    // Corner (column 0, row 0) is 100 pixels away, past the radius: it stays.
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it('blends a shape key by time', () => {
    const {skeleton, state, mesh, slot} = shaped();
    state.setAnimation(0, 'puff', {loop: false});
    updateRig(state, 0.5);
    const half = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, half, slot);
    const rest = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, rest);
    expect(half[(1 * 5 + 2) * 2 + 1] - rest[(1 * 5 + 2) * 2 + 1]).toBeCloseTo(1.25, 3);
  });
});

describe('spine parity: skin bones', () => {
  /** A rig whose "royal" skin brings a feather bone (with physics and a hit box) on the root. */
  function feathered(): RigFile {
    const file = makeArmRig({
      skins: {royal: {hat: {hat: {image: 'crown'}}}},
      physics: [{name: 'sway', bone: 'feather', strength: 80, damping: 0.9}],
    });
    file.bones.push({name: 'feather', parent: 'root', y: 40, length: 20, skin: 'royal'}, {name: 'tip', parent: 'feather', x: 20, skin: 'royal'});
    file.slots.push({name: 'plume', bone: 'tip', attachment: 'plume', attachments: {plume: {type: 'box', points: [[0, 0], [5, 0], [5, 5]]}}});
    return file;
  }

  it('updates a skin\'s bones and constraints only while the skin is on', () => {
    const skeleton = new Skeleton(compileRig(feathered(), getImageSize));
    const feather = skeleton.findBone('feather');
    const tip = skeleton.findBone('tip');
    skeleton.updateWorld();
    expect(skeleton.isBoneActive(feather)).toBe(false);
    expect(skeleton.isBoneActive(tip)).toBe(false);
    const bounds = new SkeletonBounds();
    bounds.update(skeleton);
    expect(bounds.count).toBe(0);
    skeleton.setSkins(['royal']);
    skeleton.updateWorld();
    expect(skeleton.isBoneActive(tip)).toBe(true);
    expect(skeleton.getWorldX(tip)).toBeCloseTo(20);
    expect(skeleton.getWorldY(tip)).toBeCloseTo(40);
    bounds.update(skeleton);
    expect(bounds.names.slice(0, bounds.count)).toEqual(['plume']);
  });

  it('names an unknown skin on a bone', () => {
    const file = feathered();
    file.bones[file.bones.length - 2].skin = 'roayl';
    expect(compileError(file)).toContain('no skin "roayl". Did you mean "royal"?');
  });
});

describe('spine parity: hand-placed meshes', () => {
  /** The arm rig plus a tail slot on the upper bone holding `mesh` over the 200x40 tail image. */
  function meshRig(mesh: object): {skeleton: Skeleton; mesh: MeshAttachment; slot: number} {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', image: 'tail', pivot: [0, 20], tip: [200, 20], bones: ['upper', 'lower'], ...mesh} as never}});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const slot = skeleton.findSlot('tail');
    return {skeleton, mesh: skeleton.getAttachment(slot) as MeshAttachment, slot};
  }

  /** Returns `mesh` corner `vertex`'s bone weights, by bone index. */
  function weightsOf(mesh: MeshAttachment, vertex: number): Map<number, number> {
    let read = 0;
    for (let i = 0; i < vertex; i++) {
      read += 1 + mesh.weights[read] * 4;
    }
    const found = new Map<number, number>();
    for (let i = 0; i < mesh.weights[read]; i++) {
      found.set(mesh.weights[read + 1 + i * 4], mesh.weights[read + 4 + i * 4]);
    }
    return found;
  }

  it('uses listed points, triangulates them, and takes their own bone weights', () => {
    const {skeleton, mesh, slot} = meshRig({points: [[0, 0], [200, 0], [200, 40], [0, 40], {at: [150, 20], bones: {lower: 1}}]});
    expect(mesh.vertexCount).toBe(5);
    expect(mesh.triangles.length / 3).toBe(3);
    const lower = skeleton.findBone('lower');
    expect(weightsOf(mesh, 4).get(lower)).toBeCloseTo(1);
    // Turn the lower bone: the point on it follows the lower bone exactly.
    skeleton.local[lower * BONE_STRIDE + BONE_ROTATION] = 90;
    skeleton.updateWorld();
    const vertices = new Float64Array(mesh.vertexCount * 2);
    skeleton.computeMeshVertices(mesh, vertices, slot);
    // The chain mesh spans both bones (200 pixels over 100 units), so image (150, 20) is 25 units
    // past the lower bone's origin at x 50. Turned 90 degrees about that origin, it lands 25 above it.
    expect(vertices[8]).toBeCloseTo(50, 3);
    expect(vertices[9]).toBeCloseTo(25, 3);
  });

  it('triangulates an outline with a point inside', () => {
    const {mesh} = meshRig({points: [[0, 0], [200, 0], [200, 40], [0, 40], [100, 20]], outline: 4});
    expect(mesh.triangles.length / 3).toBe(4);
  });

  it('paints an area of a grid mesh toward given weights', () => {
    const {skeleton, mesh} = meshRig({grid: [4, 2], paint: [{at: [0, 20], radius: 30, bones: {lower: 1}}]});
    const lower = skeleton.findBone('lower');
    // Corner (column 0, row 1) sits on the paint's center: all lower. Corner (column 1, row 1) is past
    // the paint's radius, on the upper bone: still mostly upper.
    expect(weightsOf(mesh, 5).get(lower)).toBeCloseTo(1);
    expect(weightsOf(mesh, 6).get(lower) ?? 0).toBeLessThan(0.2);
  });
});

describe('spine parity: trimmed atlas images', () => {
  /** Image sizes as a prebuilt atlas reports them: the tail's art fills only x 20..180, y 5..35. */
  function trimmedSize(name: string) {
    return name === 'tail' ? {...IMAGE_SIZES.tail, trim: [20, 5, 180, 35] as const} : IMAGE_SIZES[name];
  }

  it('crops a region to its trimmed art', () => {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {image: 'tail', pivot: [0, 20], tip: [200, 20]}}});
    const skeleton = new Skeleton(compileRig(file, trimmedSize));
    const region = skeleton.getAttachment(skeleton.findSlot('tail')) as RegionAttachment;
    expect(region.crop).toEqual([20, 5, 180, 35]);
  });

  it('spreads a mesh grid over its trimmed art only, and draws canvas strips inside it', () => {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', image: 'tail', pivot: [0, 20], tip: [200, 20], grid: [4, 2]}}});
    const skeleton = new Skeleton(compileRig(file, trimmedSize));
    const mesh = skeleton.getAttachment(skeleton.findSlot('tail')) as MeshAttachment;
    const us = Array.from(mesh.uvs).filter((_, index) => index % 2 === 0);
    const vs = Array.from(mesh.uvs).filter((_, index) => index % 2 === 1);
    expect(Math.min(...us)).toBe(20);
    expect(Math.max(...us)).toBe(180);
    expect(Math.min(...vs)).toBe(5);
    expect(Math.max(...vs)).toBe(35);
    // Rigid in setup, so one strip: it must put image x 20 where the corner at x 20 is, not where x 0 would be.
    const vertices = new Float64Array(mesh.uvs);
    const plan = new Float64Array(8 * 8);
    expect(planMeshStrips(mesh, vertices, plan)).toBe(1);
    expect(plan[0] * 20 + plan[2] * 5 + plan[4]).toBeCloseTo(20, 3);
    expect(plan[1] * 20 + plan[3] * 5 + plan[5]).toBeCloseTo(5, 3);
  });

  it('draws a sharply bent grid row as exact triangles, and the rigid rows either side as strips', () => {
    const file = makeArmRig();
    file.slots.push({name: 'tail', bone: 'upper', attachment: 'tail', attachments: {tail: {type: 'mesh', image: 'tail', pivot: [0, 20], tip: [200, 20], grid: [1, 4]}}});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const mesh = skeleton.getAttachment(skeleton.findSlot('tail')) as MeshAttachment;
    // A knee in row 1: rows 2 to 4 turned 50 degrees about row 1's middle, so row 1's edges aren't parallel.
    const vertices = new Float64Array(mesh.uvs);
    const turn = (50 * Math.PI) / 180;
    for (let index = 2 * 2 * 2; index < vertices.length; index += 2) {
      const x = vertices[index] - 100;
      const y = vertices[index + 1] - 10;
      vertices[index] = 100 + x * Math.cos(turn) - y * Math.sin(turn);
      vertices[index + 1] = 10 + x * Math.sin(turn) + y * Math.cos(turn);
    }
    const plan = new Float64Array(MESH_STRIP_FLOATS * 8);
    const count = planMeshStrips(mesh, vertices, plan);
    const exactRows = Array.from({length: count}, (_, i) => plan[i * MESH_STRIP_FLOATS + 8]).filter(row => row >= 0);
    expect(exactRows).toEqual([1]);
    expect(count).toBe(3);
  });
});

describe('spine parity: path constraints', () => {
  /** A three-bone rope on the root, laid along a path through `points` on the root. */
  function roped(points: [number, number][], constraint: object = {}, animations: RigFile['animations'] = {}): Skeleton {
    const file = makeArmRig({animations});
    file.bones.push({name: 'rope1', parent: 'root', length: 50}, {name: 'rope2', parent: 'rope1', x: 50, length: 50}, {name: 'rope3', parent: 'rope2', x: 50, length: 50});
    file.slots.push({name: 'track', bone: 'root', attachment: 'track', attachments: {track: {type: 'path', points}}});
    file.paths = [{name: 'rope', path: 'track', bones: ['rope1', 'rope2', 'rope3'], ...constraint}];
    return new Skeleton(compileRig(file, getImageSize));
  }

  function origins(skeleton: Skeleton): number[][] {
    return ['rope1', 'rope2', 'rope3'].map(name => [skeleton.getWorldX(skeleton.findBone(name)), skeleton.getWorldY(skeleton.findBone(name))]);
  }

  it('spaces bones along a path by their lengths, from a position', () => {
    const skeleton = roped([[0, 0], [100, 0], [200, 0]], {position: 0.25});
    skeleton.updateWorld();
    origins(skeleton).forEach(([x, y], i) => {
      expect(x).toBeCloseTo(50 + i * 50, 3);
      expect(y).toBeCloseTo(0, 3);
    });
  });

  it('turns bones along a curved path', () => {
    // A quarter circle of radius 100 from (100, 0) round to (0, 100).
    const arc = Array.from({length: 9}, (_, i) => [100 * Math.cos((i / 8) * (Math.PI / 2)), 100 * Math.sin((i / 8) * (Math.PI / 2))] as [number, number]);
    const skeleton = roped(arc, {spacing: 0});
    skeleton.updateWorld();
    const rope1 = skeleton.findBone('rope1');
    expect(skeleton.getWorldX(rope1)).toBeCloseTo(100, 1);
    // At the arc's start the tangent points straight up.
    expect(skeleton.getWorldRotation(rope1)).toBeCloseTo(90, 0);
  });

  it('points each bone at the next with rotate chain, and keys the position', () => {
    const skeleton = roped([[0, 0], [100, 0], [200, 0]], {rotate: 'chain'}, {slide: {loop: false, paths: {rope: {position: [[0, 0], [1, 0.5]]}}}});
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'slide', {loop: false});
    updateRig(state, 1);
    expect(skeleton.getWorldX(skeleton.findBone('rope1'))).toBeCloseTo(100, 3);
    expect(skeleton.getWorldRotation(skeleton.findBone('rope1'))).toBeCloseTo(0, 3);
  });
});

describe('spine parity: playback', () => {
  /** Samples `bone`'s local rotation every 1/60 s for `seconds`, with `before` run first. */
  function sample(state: AnimationState, bone: string, seconds: number): number[] {
    const values: number[] = [];
    for (let frame = 0; frame < seconds * 60; frame++) {
      state.update(1 / 60);
      state.apply();
      values.push(boneRotation(state.skeleton, bone));
    }
    return values;
  }

  function largestStep(values: number[]): number {
    return Math.max(...values.slice(1).map((value, i) => Math.abs(value - values[i])));
  }

  it('fires the keys of an animation with no length', () => {
    const file = makeArmRig({events: {hit: {}}, animations: {pose: {bones: {upper: {rotate: [[0, 30]]}}, events: [[0, 'hit']]}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    const fired: string[] = [];
    state.onEvent = event => fired.push(event.name);
    state.setAnimation(0, 'pose', {loop: false});
    state.update(0.1);
    state.update(0.1);
    expect(fired).toEqual(['hit']);
  });

  it('passes at most one loop of keys in one huge update', () => {
    const file = makeArmRig({events: {step: {}}, animations: {walk: {duration: 0.5, events: [[0.25, 'step']]}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    let steps = 0;
    let completes = 0;
    state.onEvent = () => steps++;
    state.onComplete = () => completes++;
    state.setAnimation(0, 'walk');
    state.update(600);
    expect(steps).toBeLessThanOrEqual(2);
    expect(completes).toBe(1);
  });

  it('fades a held property smoothly when a crossfade is interrupted', () => {
    const file = makeArmRig({
      defaultMix: 1,
      animations: {
        a: {bones: {lower: {rotate: [[0, 40]]}}},
        b: {bones: {lower: {rotate: [[0, 40]]}}},
        c: {bones: {upper: {rotate: [[0, 10]]}}},
      },
    });
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'a');
    sample(state, 'lower', 0.2);
    state.setAnimation(0, 'b');
    sample(state, 'lower', 0.5);
    state.setAnimation(0, 'c');
    const values = sample(state, 'lower', 1.5);
    expect(largestStep(values)).toBeLessThan(3);
    expect(values[values.length - 1]).toBeCloseTo(0);
  });

  it('ends a crossfade between part-weight entries without a pop', () => {
    const file = makeArmRig({defaultMix: 1, animations: {a: {bones: {upper: {rotate: [[0, 40]]}}}, b: {bones: {upper: {rotate: [[0, 80]]}}}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'a', {alpha: 0.5});
    sample(state, 'upper', 0.2);
    state.setAnimation(0, 'b', {alpha: 0.5});
    const values = sample(state, 'upper', 1.5);
    expect(largestStep(values)).toBeLessThan(2);
    expect(values[values.length - 1]).toBeCloseTo(40);
  });

  it('keeps turning the same way when a crossfade gap passes 180 degrees', () => {
    const file = makeArmRig({
      defaultMix: 1,
      animations: {still: {bones: {upper: {rotate: [[0, 0]]}}}, spin: {loop: false, bones: {upper: {rotate: [[0, 170], [1, 190]]}}}},
    });
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'still');
    sample(state, 'upper', 0.1);
    state.setAnimation(0, 'spin', {loop: false});
    const values = sample(state, 'upper', 0.9);
    // Without memory the shortest way flips from +170 to -170 once spin passes 180, jumping the bone across.
    expect(largestStep(values)).toBeLessThan(10);
  });

  it('flips a scale sign at once instead of squashing through 0', () => {
    const file = makeArmRig({defaultMix: 1, animations: {a: {bones: {upper: {rotate: [[0, 0]]}}}, b: {bones: {upper: {scaleX: [[0, -1]]}}}}});
    const skeleton = new Skeleton(compileRig(file, getImageSize));
    const state = new AnimationState(skeleton);
    state.setAnimation(0, 'a');
    sample(state, 'upper', 0.1);
    state.setAnimation(0, 'b');
    sample(state, 'upper', 0.5);
    expect(Math.abs(skeleton.local[skeleton.findBone('upper') * BONE_STRIDE + BONE_SCALE_X])).toBeGreaterThan(0.9);
  });

  it('starts an entry queued after a looping one at the next loop end', () => {
    const file = makeArmRig({animations: {walk: {duration: 1}, idle: {duration: 1}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'walk');
    state.update(1.5);
    state.addAnimation(0, 'idle', {mix: 0});
    state.update(0.2);
    expect(state.tracks[0]!.animation.name).toBe('walk');
    state.update(0.4);
    state.update(0.1);
    expect(state.tracks[0]!.animation.name).toBe('idle');
  });

  it('waits out a delay on an empty track', () => {
    const file = makeArmRig({animations: {wave: {bones: {upper: {rotate: [[0, 30]]}}}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.addAnimation(0, 'wave', {delay: 0.5, mix: 0});
    state.update(0.2);
    state.apply();
    expect(boneRotation(state.skeleton, 'upper')).toBeCloseTo(0);
    state.update(0.4);
    state.update(0.1);
    state.apply();
    expect(boneRotation(state.skeleton, 'upper')).toBeCloseTo(30);
  });

  it('shows the last frame of an entry before a queued one with no crossfade', () => {
    const file = makeArmRig({animations: {swing: {loop: false, bones: {upper: {rotate: [[0, 0], [1, 100]]}}}, idle: {bones: {upper: {rotate: [[0, 0]]}}}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'swing', {loop: false});
    state.addAnimation(0, 'idle', {mix: 0});
    const values = sample(state, 'upper', 1.2);
    expect(Math.max(...values)).toBeCloseTo(100);
  });

  it('carries leftover time into a queued entry in real seconds', () => {
    const file = makeArmRig({animations: {fast: {duration: 1}, slow: {duration: 1}}});
    const state = new AnimationState(new Skeleton(compileRig(file, getImageSize)));
    state.setAnimation(0, 'fast', {loop: false, timeScale: 2});
    const next = state.addAnimation(0, 'slow', {mix: 0, delay: 1});
    state.update(0.6);
    state.update(0.1);
    expect(state.tracks[0]).toBe(next);
    // 0.2 track seconds past the start at speed 2 is 0.1 real seconds, plus this frame's 0.1.
    expect(next.trackTime).toBeCloseTo(0.2);
  });
});

describe('curves', () => {
  it('eases', () => {
    expect(applyCurve(getCurveCode('sineIn'), 0.5, null, 0)).toBeCloseTo(1 - Math.cos(Math.PI / 4));
    expect(applyCurve(getCurveCode('cubic'), 0.5, null, 0)).toBeCloseTo(0.5);
    expect(getCurveCode('nope')).toBe(-1);
  });
});
