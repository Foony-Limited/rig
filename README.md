# @foony/rig

Foony Rig is Spine-style 2D skeletal animation for the web. A character is a rig: bones, the images attached to them, and named animations, all in one JSON file (`*.rig.json`). The runtime compiles that file, poses it every frame with crossfades, IK, physics and other constraints, and draws it on a 2D canvas. The format is meant to be written and edited by hand or by an LLM, without a visual editor, and a command line tool checks rigs and renders them to PNG so you can see a change without a browser.

It covers most of what Spine 4.3 does: bones, slots, skins, IK, transform and path constraints, physics, sliders, events, clipping, meshes, flipbooks, draw order keys and additive tracks.

## Install

npm publishing is coming soon. Until then, install from a GitHub tag:

```bash
npm install github:Foony-Limited/rig#v0.1.0
```

Tagged releases include the compiled `lib/` folder, so this works with no build step. The package ships ESM and TypeScript declarations, and has no runtime dependencies.

## Usage

A minimal rig, saved as `public/rigs/box.rig.json`, with `body.webp` and `arm.webp` in `public/img/box/`:

```json
{
  "format": "foony-rig@1",
  "name": "box",
  "images": "img/box",
  "bones": [
    {"name": "root"},
    {"name": "body", "parent": "root", "rotation": 90, "length": 80},
    {"name": "arm", "parent": "body", "x": 70, "rotation": -90, "length": 60}
  ],
  "slots": [
    {"name": "body", "bone": "body", "attachment": "body", "attachments": {"body": {"pivot": [20, 80], "tip": [20, 0]}}},
    {"name": "arm", "bone": "arm", "attachment": "arm", "attachments": {"arm": {"pivot": [0, 8], "tip": [60, 8]}}}
  ],
  "events": {"wave": {}},
  "animations": {
    "wave": {
      "duration": 1,
      "bones": {"arm": {"rotate": [[0, 0, "sine"], [0.5, 40, "sine"], [1, 0]]}},
      "events": [[0.5, "wave"]]
    }
  }
}
```

Load it, play an animation, and draw it each frame:

```ts
import {AnimationState, drawSkeleton, loadRig, Skeleton, updateRig} from '@foony/rig';

const rig = await loadRig('/rigs/box.rig.json');
const skeleton = new Skeleton(rig.data);
skeleton.x = 200;
skeleton.y = 300;

const state = new AnimationState(skeleton);
state.setAnimation(0, 'wave');
state.onEvent = event => {
  if (event.name === 'wave') {
    console.log('waved');
  }
};

const context = canvas.getContext('2d')!;
let last = performance.now();
function frame(now: number) {
  updateRig(state, (now - last) / 1000);
  last = now;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawSkeleton(context, skeleton, rig.images);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

`loadRig` fetches each image from `/<images>/<name>.webp` on the page's origin, or from a prebuilt atlas when the rig sets `atlas`. `loadRigs` loads several rigs into shared atlas pages, which draws faster when they appear together. If a rig file is not valid, both reject with an error that lists every problem in the file with its JSON path.

## Command line

The package installs a `foony-rig` command. Each command takes a rig file, and `--root <folder>` says which folder a rig's `images` path is relative to (default: `public` in the current folder).

```bash
foony-rig check  public/rigs/box.rig.json     # compile, lint, and summarize the rig
foony-rig pose   <rig> --anim wave --frames 4 # print bone positions as numbers
foony-rig render <rig> --anim wave --frames 8 # draw a contact sheet to tmp/rig/
foony-rig render <rig> --anim idle --then walk # preview a crossfade from idle to walk
foony-rig images img/box                      # list images under the root with sizes and joint hints
foony-rig atlas  <rig>                        # pack the rig's images into atlas pages
foony-rig bench  <rig> --count 200            # time the runtime with many skeletons
```

`render` takes `--bones`, `--mesh`, `--overlay`, `--skin a,b`, `--size`, `--time` and `--out`. The CLI reads `<name>.png` when it exists. Reading a WebP without a PNG next to it needs `python3` with Pillow, and `atlas` needs `cwebp`. See [src/cli/rigCli.ts](src/cli/rigCli.ts) for every flag.

## Rig format

[src/rigFormat.ts](src/rigFormat.ts) is the format spec. It defines every field of a `*.rig.json` file as TypeScript types, with a comment on what each one does and its default.

## Development

```bash
npm install         # install TypeScript and Vitest
npm test            # run the tests
npm run typecheck   # type-check the source and tests
npm run build       # compile src/ to lib/
```

The runtime is in `src/`, the CLI in `src/cli/`, and the tests in `src/rig.test.ts`. Run `npm run build` and commit `lib/` before tagging a release, since GitHub installs use it as is.

## License

MIT. See [LICENSE](LICENSE).
