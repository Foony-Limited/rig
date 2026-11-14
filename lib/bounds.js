import { WORLD_STRIDE } from './rigData.js';
/**
 * The box attachments a skeleton shows, as polygons in canvas pixels, for hit and hurt boxes.
 * {@link Skeleton.hitTest} finds only the front-most box at a point. This finds every box at a
 * point or along a segment, and every pair of boxes two skeletons overlap with, after a cheap
 * bounding-box check.
 *
 * @example
 * attackerBounds.update(attacker);
 * defenderBounds.update(defender);
 * for (const [hitbox, hurtbox] of attackerBounds.overlaps(defenderBounds)) {
 *   if (hitbox === 'fist' && hurtbox === 'body') applyHit();
 * }
 */
export class SkeletonBounds {
    /** The bounding box of every box polygon, in canvas pixels. 0 when there are none. */
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
    /** Number of boxes from the last {@link SkeletonBounds.update}. */
    count = 0;
    /** Per box, its slot's name. Only the first {@link SkeletonBounds.count} are current. */
    names = [];
    /** Per box, its corners in canvas pixels, x then y. Only the first {@link SkeletonBounds.count} are current. */
    polygons = [];
    /** Reads the boxes `skeleton` shows now. Call after {@link Skeleton.updateWorld}. */
    update(skeleton) {
        this.count = 0;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const world = skeleton.world;
        for (let i = 0; i < skeleton.drawOrder.length; i++) {
            const slot = skeleton.drawOrder[i];
            const attachment = skeleton.getAttachment(slot);
            if (attachment?.kind !== 'box') {
                continue;
            }
            const points = attachment.points;
            let polygon = this.polygons[this.count];
            if (!polygon || polygon.length !== points.length) {
                polygon = new Float64Array(points.length);
                this.polygons[this.count] = polygon;
            }
            this.names[this.count] = skeleton.data.slots[slot].name;
            this.count++;
            const w = skeleton.data.slots[slot].bone * WORLD_STRIDE;
            for (let p = 0; p < points.length; p += 2) {
                const worldX = world[w] * points[p] + world[w + 2] * points[p + 1] + world[w + 4];
                const worldY = world[w + 1] * points[p] + world[w + 3] * points[p + 1] + world[w + 5];
                const x = skeleton.x + worldX * skeleton.scaleX;
                const y = skeleton.y - worldY * skeleton.scaleY;
                polygon[p] = x;
                polygon[p + 1] = y;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
        const isEmpty = this.count === 0;
        this.minX = isEmpty ? 0 : minX;
        this.minY = isEmpty ? 0 : minY;
        this.maxX = isEmpty ? 0 : maxX;
        this.maxY = isEmpty ? 0 : maxY;
    }
    /** Returns true if canvas point (x, y) is inside the bounding box of all the boxes. */
    aabbContainsPoint(x, y) {
        return this.count > 0 && x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
    }
    /** Returns true if the segment from (x1, y1) to (x2, y2) may touch the boxes: it crosses their bounding box. */
    aabbIntersectsSegment(x1, y1, x2, y2) {
        if (this.count === 0 || Math.max(x1, x2) < this.minX || Math.min(x1, x2) > this.maxX || Math.max(y1, y2) < this.minY || Math.min(y1, y2) > this.maxY) {
            return false;
        }
        if (this.aabbContainsPoint(x1, y1) || this.aabbContainsPoint(x2, y2)) {
            return true;
        }
        const { minX, minY, maxX, maxY } = this;
        return segmentsCross(x1, y1, x2, y2, minX, minY, maxX, minY) || segmentsCross(x1, y1, x2, y2, maxX, minY, maxX, maxY) || segmentsCross(x1, y1, x2, y2, maxX, maxY, minX, maxY) || segmentsCross(x1, y1, x2, y2, minX, maxY, minX, minY);
    }
    /** Returns true if these boxes' bounding box overlaps `other`'s. */
    aabbIntersects(other) {
        return this.count > 0 && other.count > 0 && this.minX <= other.maxX && this.maxX >= other.minX && this.minY <= other.maxY && this.maxY >= other.minY;
    }
    /** Returns the slot names of every box containing canvas point (x, y), back to front. */
    containsPoint(x, y) {
        const found = [];
        if (this.aabbContainsPoint(x, y)) {
            for (let i = 0; i < this.count; i++) {
                if (polygonContains(this.polygons[i], x, y)) {
                    found.push(this.names[i]);
                }
            }
        }
        return found;
    }
    /** Returns the slot names of every box the segment from (x1, y1) to (x2, y2) touches, back to front. */
    intersectsSegment(x1, y1, x2, y2) {
        const found = [];
        if (this.aabbIntersectsSegment(x1, y1, x2, y2)) {
            for (let i = 0; i < this.count; i++) {
                if (polygonTouchesSegment(this.polygons[i], x1, y1, x2, y2)) {
                    found.push(this.names[i]);
                }
            }
        }
        return found;
    }
    /**
     * Returns every pair of boxes, `[this box's slot name, other's slot name]`, that overlap.
     * Both bounds must be updated for the same frame.
     */
    overlaps(other) {
        const pairs = [];
        if (!this.aabbIntersects(other)) {
            return pairs;
        }
        for (let i = 0; i < this.count; i++) {
            for (let j = 0; j < other.count; j++) {
                if (polygonsOverlap(this.polygons[i], other.polygons[j])) {
                    pairs.push([this.names[i], other.names[j]]);
                }
            }
        }
        return pairs;
    }
    /** Returns the canvas corners of the box on slot `name`, or null if it shows none. */
    getPolygon(name) {
        const index = this.names.indexOf(name);
        return index === -1 || index >= this.count ? null : this.polygons[index];
    }
}
/** Returns true if (x, y) is inside `polygon` (x, y pairs), by the even-odd rule. */
function polygonContains(polygon, x, y) {
    let inside = false;
    const count = polygon.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
        const xi = polygon[i * 2];
        const yi = polygon[i * 2 + 1];
        const xj = polygon[j * 2];
        const yj = polygon[j * 2 + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}
/** Returns true if the segment touches `polygon`: an end is inside, or it crosses an edge. */
function polygonTouchesSegment(polygon, x1, y1, x2, y2) {
    if (polygonContains(polygon, x1, y1) || polygonContains(polygon, x2, y2)) {
        return true;
    }
    const count = polygon.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
        if (segmentsCross(x1, y1, x2, y2, polygon[j * 2], polygon[j * 2 + 1], polygon[i * 2], polygon[i * 2 + 1])) {
            return true;
        }
    }
    return false;
}
/** Returns true if two polygons overlap: an edge of one crosses the other, or one holds a corner of the other. */
function polygonsOverlap(first, second) {
    const count = first.length / 2;
    for (let i = 0, j = count - 1; i < count; j = i++) {
        if (polygonTouchesSegment(second, first[j * 2], first[j * 2 + 1], first[i * 2], first[i * 2 + 1])) {
            return true;
        }
    }
    return polygonContains(first, second[0], second[1]);
}
/** Returns true if segment (x1, y1)-(x2, y2) crosses or touches segment (x3, y3)-(x4, y4). */
function segmentsCross(x1, y1, x2, y2, x3, y3, x4, y4) {
    const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
    const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
    const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
    return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0 && (Math.max(x1, x2) < Math.min(x3, x4) || Math.max(x3, x4) < Math.min(x1, x2) || Math.max(y1, y2) < Math.min(y3, y4) || Math.max(y3, y4) < Math.min(y1, y2)));
}
