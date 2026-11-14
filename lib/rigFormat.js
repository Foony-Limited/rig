/**
 * The Foony Rig file format (`*.rig.json`): a 2D bone rig and its animations, written and edited
 * by LLMs, not by a visual editor. It covers most of Spine 4.3 (bones, slots, skins,
 * IK, transform constraints with property mapping, physics, sliders, events, clipping, meshes,
 * flipbooks, partial draw order, additive tracks) in a form that is easy to write by hand:
 *
 * - Everything is referenced by name, never by index. `foony-rig check` names any unknown
 *   name and suggests the closest one.
 * - Space is y-up and angles are in degrees, counterclockwise (Spine's convention). Rotation 0
 *   points right (+x) and 90 points up (+y). The ground is usually y = 0.
 * - Images are placed by `pivot`, the pixel in the image that sits on the bone's origin, in the
 *   image's own pixel coordinates (x right, y down, as an image viewer shows them).
 * - Bone keys are offsets from the setup pose, as in Spine: a rotate key of 10 means "setup
 *   rotation + 10". Scale keys multiply the setup scale.
 * - `poses` name a set of bone offsets once. An animation can key whole poses by name.
 *
 * The compiler is {@link compileRig}. Its errors carry a JSON path (e.g.
 * `animations.walk.bones.thighL.rotate[2]`) so a fix can go straight to the line.
 */
export {};
