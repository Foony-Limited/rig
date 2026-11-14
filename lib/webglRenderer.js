import { WORLD_STRIDE } from './rigData.js';
/**
 * Draws skeletons with WebGL. Prefer it over {@link drawSkeleton} when rigs have meshes: a 2D canvas
 * can only draw a textured triangle through a clip (about 6 us each in Chrome), while the GPU draws
 * thousands of triangles in one call. Tints are vertex colors, so they cost nothing and need no
 * tinted image copies. Clipping uses the stencil buffer.
 *
 * Every vertex is moved to canvas pixels on the CPU, so all skeletons share one projection and
 * consecutive parts using the same image and blend mode go out in one draw call. A 2D canvas game
 * can draw this canvas onto its own with `drawImage` once a frame.
 *
 * @example
 * const renderer = new RigWebGlRenderer(canvas);
 * renderer.begin();
 * renderer.draw(skeleton, rig.images);
 * renderer.end();
 */
export class RigWebGlRenderer {
    gl;
    canMipmap;
    program;
    buffer;
    indexBuffer;
    projection;
    textures = new WeakMap();
    /** x, y, u, v, r, g, b, a per vertex, for the batch being built. */
    vertices = new Float32Array(FLOATS_PER_VERTEX * 6 * 512);
    vertexCount = 0;
    /** Each triangle's three vertices, as indexes into {@link RigWebGlRenderer.vertices}, for the batch being built. A mesh corner is shared by up to six triangles, so it is written once. */
    indices = new Uint16Array(6 * 512);
    indexCount = 0;
    batchTexture = null;
    batchBlend = 'source-over';
    transform = [1, 0, 0, 1, 0, 0];
    meshScratch = new Float32Array(256);
    matrix = new Float64Array(6);
    /** The dark tint of the slot being added, r, g, b. */
    dark = new Float32Array(3);
    /** Throws if the browser can't make a WebGL context on `canvas`. */
    constructor(canvas) {
        // WebGL 2 can mipmap images of any size, which keeps big art from shimmering when it's drawn small.
        // Safari 14.1 has only WebGL 1, which draws the same without mipmaps.
        const options = { alpha: true, premultipliedAlpha: true, stencil: true, antialias: true };
        const gl2 = canvas.getContext('webgl2', options);
        const gl = gl2 ?? canvas.getContext('webgl', options);
        if (!gl) {
            throw new Error('[rig] WebGL is not available for RigWebGlRenderer');
        }
        this.gl = gl;
        this.canMipmap = gl2 !== null;
        this.program = linkProgram(gl);
        this.buffer = gl.createBuffer();
        this.indexBuffer = gl.createBuffer();
        this.projection = gl.getUniformLocation(this.program, 'projection');
    }
    /**
     * Starts a frame: sizes the viewport to the canvas, clears it to transparent, and sets the
     * transform from canvas-space units to canvas pixels, in canvas order `[a, b, c, d, e, f]` (as a
     * 2D context's `setTransform` takes it, e.g. `[2, 0, 0, 2, 0, 0]` for a 2x pixel ratio).
     */
    begin(transform = [1, 0, 0, 1, 0, 0]) {
        const gl = this.gl;
        const canvas = gl.canvas;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clearStencil(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.useProgram(this.program);
        // Canvas pixels to clip space: x right, y down.
        gl.uniformMatrix3fv(this.projection, false, [2 / canvas.width, 0, 0, 0, -2 / canvas.height, 0, -1, 1, 1]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        const stride = FLOATS_PER_VERTEX * 4;
        for (const [name, size, offset] of [['position', 2, 0], ['uv', 2, 2], ['color', 4, 4], ['dark', 3, 8]]) {
            const location = gl.getAttribLocation(this.program, name);
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
        }
        gl.enable(gl.BLEND);
        gl.disable(gl.STENCIL_TEST);
        this.setBlend('source-over');
        this.transform = [...transform];
    }
    /** Draws `skeleton` with its images. Images that haven't loaded are skipped. Call between {@link RigWebGlRenderer.begin} and {@link RigWebGlRenderer.end}. */
    draw(skeleton, images) {
        const [ta, tb, tc, td, te, tf] = this.transform;
        // The frame transform times the skeleton's placement (y flipped: skeleton space is y-up).
        const a = ta * skeleton.scaleX;
        const b = tb * skeleton.scaleX;
        const c = -tc * skeleton.scaleY;
        const d = -td * skeleton.scaleY;
        const e = ta * skeleton.x + tc * skeleton.y + te;
        const f = tb * skeleton.x + td * skeleton.y + tf;
        const data = skeleton.data;
        const colors = skeleton.slotColors;
        const darks = skeleton.slotDarks;
        let clipEnd = -1;
        for (let i = 0; i < skeleton.drawOrder.length; i++) {
            const slot = skeleton.drawOrder[i];
            const attachment = skeleton.getAttachment(slot);
            if (attachment?.kind === 'clip' && clipEnd === -1) {
                this.startClip(skeleton, slot, attachment, a, b, c, d, e, f);
                clipEnd = attachment.endSlot;
            }
            else if (attachment?.kind === 'region' || attachment?.kind === 'mesh') {
                const tint = attachment.color;
                const alpha = skeleton.alpha * colors[slot * 4 + 3] * tint[3];
                const frame = skeleton.getFrame(slot, attachment);
                const image = images.get(attachment.images[frame]);
                if (alpha > 0 && image) {
                    const texture = this.getTexture(image.source);
                    const blend = data.slots[slot].blend;
                    if (texture !== this.batchTexture || blend !== this.batchBlend) {
                        this.flush();
                        this.batchTexture = texture;
                        this.setBlend(blend);
                    }
                    const red = colors[slot * 4] * tint[0];
                    const green = colors[slot * 4 + 1] * tint[1];
                    const blue = colors[slot * 4 + 2] * tint[2];
                    this.dark[0] = darks[slot * 3];
                    this.dark[1] = darks[slot * 3 + 1];
                    this.dark[2] = darks[slot * 3 + 2];
                    if (attachment.kind === 'region') {
                        this.addRegion(skeleton, slot, attachment, image, a, b, c, d, e, f, red, green, blue, alpha);
                    }
                    else {
                        this.addMesh(skeleton, slot, attachment, image, a, b, c, d, e, f, red, green, blue, alpha);
                    }
                }
            }
            if (slot === clipEnd) {
                this.endClip();
                clipEnd = -1;
            }
        }
        if (clipEnd !== -1) {
            this.endClip();
        }
    }
    /** Draws what is still batched. Call once after the frame's last {@link RigWebGlRenderer.draw}. */
    end() {
        this.flush();
    }
    setBlend(blend) {
        const gl = this.gl;
        this.batchBlend = blend;
        // Textures are premultiplied, so "normal" is ONE, ONE_MINUS_SRC_ALPHA. Every mode writes alpha
        // the normal way except "lighter", which leaves it alone: light adds to what is behind, so once
        // the game draws this canvas over its scene, a glow brightens the scene instead of covering it.
        if (blend === 'lighter') {
            gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        }
        else if (blend === 'multiply') {
            gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        else if (blend === 'screen') {
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
        else {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        }
    }
    getTexture(image) {
        let texture = this.textures.get(image);
        if (!texture) {
            const gl = this.gl;
            texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            // WebGL 1 can't mipmap or repeat images whose sides aren't powers of two.
            if (this.canMipmap) {
                gl.generateMipmap(gl.TEXTURE_2D);
            }
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.canMipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.textures.set(image, texture);
        }
        return texture;
    }
    /** Makes room for `vertexCount` more vertices and `indexCount` more indexes in the batch, drawing it first if 16-bit indexes would run out. */
    reserve(vertexCount, indexCount) {
        if (this.vertexCount + vertexCount > MAX_BATCH_VERTICES) {
            this.flush();
        }
        const needed = (this.vertexCount + vertexCount) * FLOATS_PER_VERTEX;
        if (needed > this.vertices.length) {
            const grown = new Float32Array(Math.max(needed, this.vertices.length * 2));
            grown.set(this.vertices);
            this.vertices = grown;
        }
        if (this.indexCount + indexCount > this.indices.length) {
            const grown = new Uint16Array(Math.max(this.indexCount + indexCount, this.indices.length * 2));
            grown.set(this.indices);
            this.indices = grown;
        }
    }
    pushVertex(x, y, u, v, red, green, blue, alpha) {
        const out = this.vertices;
        let i = this.vertexCount * FLOATS_PER_VERTEX;
        out[i++] = x;
        out[i++] = y;
        out[i++] = u;
        out[i++] = v;
        // Premultiplied, to match the textures.
        out[i++] = red * alpha;
        out[i++] = green * alpha;
        out[i++] = blue * alpha;
        out[i++] = alpha;
        out[i++] = this.dark[0] * alpha;
        out[i++] = this.dark[1] * alpha;
        out[i] = this.dark[2] * alpha;
        this.vertexCount++;
    }
    addRegion(skeleton, slot, region, image, a, b, c, d, e, f, red, green, blue, alpha) {
        const m = this.matrix;
        skeleton.getRegionMatrix(slot, region, m);
        const [left, top, right, bottom] = region.crop;
        const corners = [left, top, right, top, right, bottom, left, bottom];
        // Texture coordinates of the image's place on its atlas page.
        const pageWidth = sourceWidth(image.source);
        const pageHeight = sourceHeight(image.source);
        const uScale = image.width / region.width / pageWidth;
        const vScale = image.height / region.height / pageHeight;
        this.reserve(4, 6);
        const first = this.vertexCount;
        const indices = this.indices;
        let n = this.indexCount;
        for (const corner of REGION_TRIANGLES) {
            indices[n++] = first + corner;
        }
        this.indexCount = n;
        for (let i = 0; i < 8; i += 2) {
            const u = corners[i];
            const v = corners[i + 1];
            const x = m[0] * u + m[2] * v + m[4];
            const y = m[1] * u + m[3] * v + m[5];
            this.pushVertex(a * x + c * y + e, b * x + d * y + f, image.x / pageWidth + u * uScale, image.y / pageHeight + v * vScale, red, green, blue, alpha);
        }
    }
    addMesh(skeleton, slot, mesh, image, a, b, c, d, e, f, red, green, blue, alpha) {
        if (this.meshScratch.length < mesh.vertexCount * 2) {
            this.meshScratch = new Float32Array(mesh.vertexCount * 4);
        }
        const positions = this.meshScratch;
        skeleton.computeMeshVertices(mesh, positions, slot);
        const triangles = mesh.triangles;
        const uvs = mesh.uvs;
        const pageWidth = sourceWidth(image.source);
        const pageHeight = sourceHeight(image.source);
        const uScale = image.width / mesh.width / pageWidth;
        const vScale = image.height / mesh.height / pageHeight;
        this.reserve(mesh.vertexCount, triangles.length);
        const first = this.vertexCount;
        const indices = this.indices;
        let n = this.indexCount;
        for (let i = 0; i < triangles.length; i++) {
            indices[n++] = first + triangles[i];
        }
        this.indexCount = n;
        for (let vertex = 0; vertex < mesh.vertexCount * 2; vertex += 2) {
            const x = positions[vertex];
            const y = positions[vertex + 1];
            this.pushVertex(a * x + c * y + e, b * x + d * y + f, image.x / pageWidth + uvs[vertex] * uScale, image.y / pageHeight + uvs[vertex + 1] * vScale, red, green, blue, alpha);
        }
    }
    flush() {
        if (this.indexCount === 0 || !this.batchTexture) {
            this.vertexCount = 0;
            this.indexCount = 0;
            return;
        }
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.batchTexture);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, this.vertexCount * FLOATS_PER_VERTEX), gl.STREAM_DRAW);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.subarray(0, this.indexCount), gl.STREAM_DRAW);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
        this.vertexCount = 0;
        this.indexCount = 0;
    }
    /**
     * Marks the clip polygon in the stencil buffer. Drawing it as a triangle fan with INVERT flips each
     * pixel once per triangle that covers it, so pixels inside any simple polygon (convex or not) end
     * up odd (1) and the rest even (0).
     */
    startClip(skeleton, slot, clip, a, b, c, d, e, f) {
        this.flush();
        const gl = this.gl;
        const w = skeleton.data.slots[slot].bone * WORLD_STRIDE;
        const world = skeleton.world;
        const points = clip.points;
        const count = points.length / 2;
        this.reserve((count - 2) * 3, 0);
        const corner = (index) => {
            const px = points[index * 2];
            const py = points[index * 2 + 1];
            const x = world[w] * px + world[w + 2] * py + world[w + 4];
            const y = world[w + 1] * px + world[w + 3] * py + world[w + 5];
            this.pushVertex(a * x + c * y + e, b * x + d * y + f, 0, 0, 0, 0, 0, 0);
        };
        for (let i = 1; i < count - 1; i++) {
            corner(0);
            corner(i);
            corner(i + 1);
        }
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.STENCIL_TEST);
        gl.colorMask(false, false, false, false);
        gl.stencilFunc(gl.ALWAYS, 0, 1);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, this.vertexCount * FLOATS_PER_VERTEX), gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
        this.vertexCount = 0;
        gl.colorMask(true, true, true, true);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.stencilFunc(gl.EQUAL, clip.inverse ? 0 : 1, 1);
    }
    endClip() {
        this.flush();
        this.gl.disable(this.gl.STENCIL_TEST);
    }
}
/** Returns an atlas page's width in pixels. */
function sourceWidth(source) {
    return source.naturalWidth || source.width;
}
/** Returns an atlas page's height in pixels. */
function sourceHeight(source) {
    return source.naturalHeight || source.height;
}
/** Floats per vertex: x, y, u, v, r, g, b, a, then the dark tint r, g, b (all colors premultiplied). */
const FLOATS_PER_VERTEX = 11;
/** Most vertices in one batch: 16-bit indexes reach 65535. */
const MAX_BATCH_VERTICES = 65535;
/** A region's two triangles, as its corners top-left, top-right, bottom-right, bottom-left. */
const REGION_TRIANGLES = [0, 1, 2, 0, 2, 3];
const VERTEX_SHADER = `
attribute vec2 position;
attribute vec2 uv;
attribute vec4 color;
attribute vec3 dark;
uniform mat3 projection;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vDark;
void main() {
  vUv = uv;
  vColor = color;
  vDark = dark;
  gl_Position = vec4((projection * vec3(position, 1.0)).xy, 0.0, 1.0);
}`;
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D image;
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vDark;
void main() {
  // Two-color tint, premultiplied: the art times the tint, plus the dark tint where the art is dark.
  vec4 texel = texture2D(image, vUv);
  gl_FragColor = vec4(texel.rgb * vColor.rgb + (texel.a - texel.rgb) * vDark, texel.a * vColor.a);
}`;
function linkProgram(gl) {
    const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(`[rig] WebGL shader did not compile: ${gl.getShaderInfoLog(shader)}`);
        }
        return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`[rig] WebGL program did not link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
}
