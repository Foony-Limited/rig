import type { Skeleton } from './skeleton.js';
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
export declare class SkeletonBounds {
    /** The bounding box of every box polygon, in canvas pixels. 0 when there are none. */
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    /** Number of boxes from the last {@link SkeletonBounds.update}. */
    count: number;
    /** Per box, its slot's name. Only the first {@link SkeletonBounds.count} are current. */
    readonly names: string[];
    /** Per box, its corners in canvas pixels, x then y. Only the first {@link SkeletonBounds.count} are current. */
    readonly polygons: Float64Array[];
    /** Reads the boxes `skeleton` shows now. Call after {@link Skeleton.updateWorld}. */
    update(skeleton: Skeleton): void;
    /** Returns true if canvas point (x, y) is inside the bounding box of all the boxes. */
    aabbContainsPoint(x: number, y: number): boolean;
    /** Returns true if the segment from (x1, y1) to (x2, y2) may touch the boxes: it crosses their bounding box. */
    aabbIntersectsSegment(x1: number, y1: number, x2: number, y2: number): boolean;
    /** Returns true if these boxes' bounding box overlaps `other`'s. */
    aabbIntersects(other: SkeletonBounds): boolean;
    /** Returns the slot names of every box containing canvas point (x, y), back to front. */
    containsPoint(x: number, y: number): string[];
    /** Returns the slot names of every box the segment from (x1, y1) to (x2, y2) touches, back to front. */
    intersectsSegment(x1: number, y1: number, x2: number, y2: number): string[];
    /**
     * Returns every pair of boxes, `[this box's slot name, other's slot name]`, that overlap.
     * Both bounds must be updated for the same frame.
     */
    overlaps(other: SkeletonBounds): [string, string][];
    /** Returns the canvas corners of the box on slot `name`, or null if it shows none. */
    getPolygon(name: string): Float64Array | null;
}
//# sourceMappingURL=bounds.d.ts.map