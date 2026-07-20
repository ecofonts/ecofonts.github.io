/**
 * TrueType "glyf surgeon": subtracts eco holes from every glyph of a raw
 * TrueType binary by rewriting only the glyf/loca tables (plus minimal
 * head/maxp patches). Every other table is copied byte-for-byte.
 *
 * This exists for PDF-embedded fonts, which are usually subset and lack the
 * cmap/name tables opentype.js needs to round-trip a font. Working directly
 * on the binary also guarantees glyph IDs, widths, and encodings stay
 * exactly as the PDF expects them.
 *
 * Glyphs that receive holes are written as simple glyphs with on-curve
 * points only (composites are resolved first); untouched glyphs keep their
 * original bytes, including hinting instructions.
 */
import type { Path as ClipPath, Paths as ClipPaths } from "clipper-lib";
import { SCALE, subtractEcoHoles } from "./ecofont";

const YIELD_EVERY = 24;

export interface EcoTrueTypeResult {
    buffer: ArrayBuffer;
    glyphCount: number;
    glyphsChanged: number;
}

interface TableRecord {
    tag: string;
    offset: number;
    length: number;
}

function readTableDirectory(bytes: Uint8Array, view: DataView): TableRecord[] {
    const numTables = view.getUint16(4);
    const tables: TableRecord[] = [];
    for (let i = 0; i < numTables; i++) {
        const p = 12 + i * 16;
        tables.push({
            tag: String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]),
            offset: view.getUint32(p + 8),
            length: view.getUint32(p + 12),
        });
    }
    return tables;
}

/** Extract one table's bytes from an sfnt container, or null if absent. */
export function findSfntTable(bytes: Uint8Array, tag: string): Uint8Array | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const table = readTableDirectory(bytes, view).find((t) => t.tag === tag);
    return table ? bytes.slice(table.offset, table.offset + table.length) : null;
}

/** Rebuild an sfnt container with one table's contents replaced. */
export function replaceSfntTable(bytes: Uint8Array, tag: string, data: Uint8Array): ArrayBuffer {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = readTableDirectory(bytes, view);
    if (!tables.some((t) => t.tag === tag)) {
        throw new Error(`font has no ${tag} table`);
    }
    return assembleSfnt(view.getUint32(0), tables, bytes, new Map([[tag, data]]));
}

export async function ecoProcessTrueType(
    data: Uint8Array,
    intensity: number,
    onGlyph?: (done: number, total: number) => void,
    keepGlyphs?: Set<number>,
): Promise<EcoTrueTypeResult> {
    // Copy into an owned, offset-free buffer so DataView indices are simple.
    const bytes = new Uint8Array(data);
    const view = new DataView(bytes.buffer);

    const sfntVersion = view.getUint32(0);
    if (sfntVersion === 0x4f54544f) {
        throw new Error("CFF-based OpenType font (no TrueType outlines)");
    }
    if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565) {
        throw new Error("not a TrueType font program");
    }

    const tables = readTableDirectory(bytes, view);
    const byTag = new Map(tables.map((t) => [t.tag, t]));
    const head = byTag.get("head");
    const maxp = byTag.get("maxp");
    const loca = byTag.get("loca");
    const glyf = byTag.get("glyf");
    if (!head || !maxp || !loca || !glyf) {
        throw new Error("font has no TrueType outlines (glyf/loca missing)");
    }

    const upem = view.getUint16(head.offset + 18) || 1000;
    const indexToLocFormat = view.getInt16(head.offset + 50);
    const numGlyphs = view.getUint16(maxp.offset + 4);

    const offsets = new Array<number>(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
        offsets[i] =
            indexToLocFormat === 0
                ? view.getUint16(loca.offset + i * 2) * 2
                : view.getUint32(loca.offset + i * 4);
    }

    // When a keep set is given (embedding an installed font into a PDF —
    // documents reach at most 256 codes of a simple font, the full face may
    // hold thousands of glyphs), glyphs outside it are emptied instead of
    // copied: their metrics survive in hmtx but their outlines vanish, which
    // keeps the embedded file small. Expand the set over composite
    // components first so kept glyphs never lose a piece.
    let keep: Set<number> | null = null;
    if (keepGlyphs) {
        keep = new Set(keepGlyphs);
        keep.add(0); // .notdef
        const stack = [...keep];
        while (stack.length > 0) {
            const gid = stack.pop()!;
            if (gid < 0 || gid >= numGlyphs) continue;
            for (const component of compositeComponents(view, glyf.offset, offsets, gid)) {
                if (!keep.has(component)) {
                    keep.add(component);
                    stack.push(component);
                }
            }
        }
    }

    const segLen = upem / 50; // curve flattening tolerance, as in ecofont.ts
    const newGlyphs: Uint8Array[] = new Array(numGlyphs);
    let glyphsChanged = 0;
    let maxPoints = 0;
    let maxContours = 0;

    for (let gid = 0; gid < numGlyphs; gid++) {
        if (keep && !keep.has(gid)) {
            newGlyphs[gid] = new Uint8Array(0);
            if ((gid + 1) % YIELD_EVERY === 0) {
                onGlyph?.(gid + 1, numGlyphs);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            continue;
        }
        const raw = bytes.subarray(glyf.offset + offsets[gid], glyf.offset + offsets[gid + 1]);
        let replacement: Uint8Array | null = null;
        if (raw.length > 0) {
            const contours = readGlyphContours(view, bytes, glyf.offset, offsets, gid, segLen, 0);
            if (contours && contours.length > 0) {
                const holed = subtractEcoHoles(contours, upem, intensity);
                if (holed && holed.length > 0) {
                    const serialized = serializeSimpleGlyph(holed);
                    if (serialized) {
                        replacement = serialized.bytes;
                        maxPoints = Math.max(maxPoints, serialized.pointCount);
                        maxContours = Math.max(maxContours, serialized.contourCount);
                    }
                }
            }
        }
        if (replacement) {
            newGlyphs[gid] = replacement;
            glyphsChanged++;
        } else {
            // Keep the original bytes (padded to even length for loca).
            newGlyphs[gid] =
                raw.length % 2 === 0 ? raw.slice() : concatBytes([raw, new Uint8Array(1)]);
        }
        if ((gid + 1) % YIELD_EVERY === 0) {
            onGlyph?.(gid + 1, numGlyphs);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    onGlyph?.(numGlyphs, numGlyphs);

    // New glyf + long-format loca.
    const newLoca = new Uint8Array((numGlyphs + 1) * 4);
    const locaView = new DataView(newLoca.buffer);
    let glyfSize = 0;
    for (let gid = 0; gid < numGlyphs; gid++) {
        locaView.setUint32(gid * 4, glyfSize);
        glyfSize += newGlyphs[gid].length;
    }
    locaView.setUint32(numGlyphs * 4, glyfSize);
    const newGlyf = concatBytes(newGlyphs);

    // Patched head: long loca format, checkSumAdjustment zeroed (recomputed
    // during reassembly).
    const newHead = bytes.slice(head.offset, head.offset + head.length);
    new DataView(newHead.buffer).setUint32(8, 0);
    new DataView(newHead.buffer).setInt16(50, 1);

    // Patched maxp: our rewritten glyphs may have more points/contours than
    // any original glyph. Only ever increase the limits.
    const newMaxp = bytes.slice(maxp.offset, maxp.offset + maxp.length);
    if (newMaxp.length >= 10) {
        const maxpView = new DataView(newMaxp.buffer);
        maxpView.setUint16(6, Math.max(maxpView.getUint16(6), maxPoints));
        maxpView.setUint16(8, Math.max(maxpView.getUint16(8), maxContours));
    }

    const replacements = new Map<string, Uint8Array>([
        ["glyf", newGlyf],
        ["loca", newLoca],
        ["head", newHead],
        ["maxp", newMaxp],
    ]);
    const buffer = assembleSfnt(sfntVersion, tables, bytes, replacements);
    return { buffer, glyphCount: numGlyphs, glyphsChanged };
}

/**
 * Read one glyph as flattened closed contours in Clipper coordinates
 * (font units × SCALE). Returns null when the glyph uses features we do not
 * rewrite (e.g. point-matching composites) and should be kept verbatim.
 */
function readGlyphContours(
    view: DataView,
    bytes: Uint8Array,
    glyfBase: number,
    offsets: number[],
    gid: number,
    segLen: number,
    depth: number,
): ClipPaths | null {
    if (depth > 5 || gid < 0 || gid + 1 >= offsets.length + 1 || gid >= offsets.length - 1) {
        return null;
    }
    const start = glyfBase + offsets[gid];
    const end = glyfBase + offsets[gid + 1];
    if (end <= start) return []; // empty glyph (e.g. space)

    const numContours = view.getInt16(start);
    if (numContours >= 0) {
        return readSimpleGlyph(view, bytes, start, numContours, segLen);
    }

    // Composite glyph: resolve each component recursively.
    const result: ClipPaths = [];
    let p = start + 10;
    for (;;) {
        const flags = view.getUint16(p);
        const componentGid = view.getUint16(p + 2);
        p += 4;
        let dx = 0;
        let dy = 0;
        if (flags & 0x0001) {
            // ARG_1_AND_2_ARE_WORDS
            if (flags & 0x0002) {
                dx = view.getInt16(p);
                dy = view.getInt16(p + 2);
            }
            p += 4;
        } else {
            if (flags & 0x0002) {
                dx = view.getInt8(p);
                dy = view.getInt8(p + 1);
            }
            p += 2;
        }
        // Without ARGS_ARE_XY_VALUES the offsets are point-matching indices,
        // which we do not implement — keep the original glyph.
        if (!(flags & 0x0002)) return null;

        let a = 1;
        let b = 0;
        let c = 0;
        let d = 1;
        if (flags & 0x0008) {
            // WE_HAVE_A_SCALE
            a = d = f2dot14(view.getInt16(p));
            p += 2;
        } else if (flags & 0x0040) {
            // WE_HAVE_AN_X_AND_Y_SCALE
            a = f2dot14(view.getInt16(p));
            d = f2dot14(view.getInt16(p + 2));
            p += 4;
        } else if (flags & 0x0080) {
            // WE_HAVE_A_TWO_BY_TWO
            a = f2dot14(view.getInt16(p));
            b = f2dot14(view.getInt16(p + 2));
            c = f2dot14(view.getInt16(p + 4));
            d = f2dot14(view.getInt16(p + 6));
            p += 8;
        }

        const sub = readGlyphContours(view, bytes, glyfBase, offsets, componentGid, segLen, depth + 1);
        if (sub === null) return null;
        for (const contour of sub) {
            result.push(
                contour.map((pt) => ({
                    X: Math.round(a * pt.X + c * pt.Y + dx * SCALE),
                    Y: Math.round(b * pt.X + d * pt.Y + dy * SCALE),
                })),
            );
        }

        if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
    return result;
}

function readSimpleGlyph(
    view: DataView,
    bytes: Uint8Array,
    start: number,
    numContours: number,
    segLen: number,
): ClipPaths {
    let p = start + 10;
    const endPts: number[] = [];
    for (let i = 0; i < numContours; i++) {
        endPts.push(view.getUint16(p));
        p += 2;
    }
    const numPoints = numContours > 0 ? endPts[numContours - 1] + 1 : 0;
    const instructionLength = view.getUint16(p);
    p += 2 + instructionLength;

    const flags = new Uint8Array(numPoints);
    for (let i = 0; i < numPoints; ) {
        const flag = bytes[p++];
        flags[i++] = flag;
        if (flag & 0x08) {
            // REPEAT_FLAG
            let repeats = bytes[p++];
            while (repeats-- > 0 && i < numPoints) flags[i++] = flag;
        }
    }

    const xs = new Int32Array(numPoints);
    let x = 0;
    for (let i = 0; i < numPoints; i++) {
        const flag = flags[i];
        if (flag & 0x02) {
            const delta = bytes[p++];
            x += flag & 0x10 ? delta : -delta;
        } else if (!(flag & 0x10)) {
            x += view.getInt16(p);
            p += 2;
        }
        xs[i] = x;
    }
    const ys = new Int32Array(numPoints);
    let y = 0;
    for (let i = 0; i < numPoints; i++) {
        const flag = flags[i];
        if (flag & 0x04) {
            const delta = bytes[p++];
            y += flag & 0x20 ? delta : -delta;
        } else if (!(flag & 0x20)) {
            y += view.getInt16(p);
            p += 2;
        }
        ys[i] = y;
    }

    const contours: ClipPaths = [];
    let first = 0;
    for (let ci = 0; ci < numContours; ci++) {
        const last = endPts[ci];
        const pts: { x: number; y: number; on: boolean }[] = [];
        for (let i = first; i <= last; i++) {
            pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 0x01) !== 0 });
        }
        first = last + 1;
        const flattened = flattenQuadContour(pts, segLen);
        if (flattened.length >= 3) contours.push(flattened);
    }
    return contours;
}

/**
 * Flatten one TrueType quadratic contour (on/off-curve points, with implied
 * on-curve midpoints between consecutive off-curve points) into a polygon in
 * Clipper coordinates.
 */
function flattenQuadContour(
    pts: { x: number; y: number; on: boolean }[],
    segLen: number,
): ClipPath {
    const n = pts.length;
    if (n === 0) return [];

    const out: ClipPath = [];
    const push = (px: number, py: number): void => {
        const X = Math.round(px * SCALE);
        const Y = Math.round(py * SCALE);
        const last = out[out.length - 1];
        if (!last || last.X !== X || last.Y !== Y) out.push({ X, Y });
    };
    const quad = (
        x0: number,
        y0: number,
        cx: number,
        cy: number,
        x1: number,
        y1: number,
    ): void => {
        const est = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
        const steps = Math.min(16, Math.max(2, Math.ceil(est / segLen)));
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const mt = 1 - t;
            push(mt * mt * x0 + 2 * mt * t * cx + t * t * x1, mt * mt * y0 + 2 * mt * t * cy + t * t * y1);
        }
    };

    // Establish a starting on-curve anchor: either a real on-curve point or
    // the implied midpoint between the last and first off-curve points.
    const firstOn = pts.findIndex((pt) => pt.on);
    let anchorX: number;
    let anchorY: number;
    let orderedFrom: number;
    if (firstOn >= 0) {
        anchorX = pts[firstOn].x;
        anchorY = pts[firstOn].y;
        orderedFrom = firstOn + 1;
    } else {
        anchorX = (pts[n - 1].x + pts[0].x) / 2;
        anchorY = (pts[n - 1].y + pts[0].y) / 2;
        orderedFrom = 0;
    }
    push(anchorX, anchorY);
    const startX = anchorX;
    const startY = anchorY;

    let curX = anchorX;
    let curY = anchorY;
    let pendingCx: number | null = null;
    let pendingCy = 0;
    for (let k = 0; k < n; k++) {
        const pt = pts[(orderedFrom + k) % n];
        if (pt.on) {
            if (pendingCx !== null) {
                quad(curX, curY, pendingCx, pendingCy, pt.x, pt.y);
                pendingCx = null;
            } else {
                push(pt.x, pt.y);
            }
            curX = pt.x;
            curY = pt.y;
        } else if (pendingCx === null) {
            pendingCx = pt.x;
            pendingCy = pt.y;
        } else {
            // Two consecutive off-curve points: implied on-curve midpoint.
            const midX = (pendingCx + pt.x) / 2;
            const midY = (pendingCy + pt.y) / 2;
            quad(curX, curY, pendingCx, pendingCy, midX, midY);
            curX = midX;
            curY = midY;
            pendingCx = pt.x;
            pendingCy = pt.y;
        }
    }
    // Close the contour back to the anchor.
    if (pendingCx !== null) {
        quad(curX, curY, pendingCx, pendingCy, startX, startY);
    }
    const firstPt = out[0];
    const lastPt = out[out.length - 1];
    if (firstPt && lastPt && firstPt !== lastPt && firstPt.X === lastPt.X && firstPt.Y === lastPt.Y) {
        out.pop();
    }
    return out;
}

/** Serialize Clipper polygons as one simple glyph (all points on-curve). */
function serializeSimpleGlyph(
    polys: ClipPaths,
): { bytes: Uint8Array; pointCount: number; contourCount: number } | null {
    const clamp = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v / SCALE)));
    const contours: { x: number; y: number }[][] = [];
    for (const poly of polys) {
        const contour: { x: number; y: number }[] = [];
        for (const pt of poly) {
            const x = clamp(pt.X);
            const y = clamp(pt.Y);
            const last = contour[contour.length - 1];
            if (!last || last.x !== x || last.y !== y) contour.push({ x, y });
        }
        while (
            contour.length > 1 &&
            contour[0].x === contour[contour.length - 1].x &&
            contour[0].y === contour[contour.length - 1].y
        ) {
            contour.pop();
        }
        if (contour.length >= 3) contours.push(contour);
    }
    if (contours.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let pointCount = 0;
    for (const contour of contours) {
        for (const pt of contour) {
            if (pt.x < minX) minX = pt.x;
            if (pt.x > maxX) maxX = pt.x;
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }
        pointCount += contour.length;
    }

    const w = new ByteWriter();
    w.int16(contours.length);
    w.int16(minX);
    w.int16(minY);
    w.int16(maxX);
    w.int16(maxY);
    let end = -1;
    for (const contour of contours) {
        end += contour.length;
        w.uint16(end);
    }
    w.uint16(0); // no hinting instructions

    // Flags + deltas with short-vector compression (all points on-curve).
    const flags: number[] = [];
    const xData = new ByteWriter();
    const yData = new ByteWriter();
    let px = 0;
    let py = 0;
    for (const contour of contours) {
        for (const pt of contour) {
            const dx = pt.x - px;
            const dy = pt.y - py;
            px = pt.x;
            py = pt.y;
            let flag = 0x01; // ON_CURVE_POINT
            if (dx === 0) {
                flag |= 0x10; // X_IS_SAME
            } else if (dx >= -255 && dx <= 255) {
                flag |= 0x02; // X_SHORT_VECTOR
                if (dx > 0) flag |= 0x10;
                xData.uint8(Math.abs(dx));
            } else {
                xData.int16(dx);
            }
            if (dy === 0) {
                flag |= 0x20; // Y_IS_SAME
            } else if (dy >= -255 && dy <= 255) {
                flag |= 0x04; // Y_SHORT_VECTOR
                if (dy > 0) flag |= 0x20;
                yData.uint8(Math.abs(dy));
            } else {
                yData.int16(dy);
            }
            flags.push(flag);
        }
    }
    for (const flag of flags) w.uint8(flag);
    w.bytes(xData.toUint8Array());
    w.bytes(yData.toUint8Array());
    if (w.length % 2 === 1) w.uint8(0); // keep loca offsets even

    return { bytes: w.toUint8Array(), pointCount, contourCount: contours.length };
}

/** Rebuild the sfnt container with some tables replaced. */
function assembleSfnt(
    sfntVersion: number,
    tables: TableRecord[],
    original: Uint8Array,
    replacements: Map<string, Uint8Array>,
): ArrayBuffer {
    const entries = tables.map((t) => ({
        tag: t.tag,
        data: replacements.get(t.tag) ?? original.slice(t.offset, t.offset + t.length),
    }));

    const numTables = entries.length;
    let size = 12 + numTables * 16;
    for (const entry of entries) size += pad4(entry.data.length);

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, sfntVersion);
    view.setUint16(4, numTables);
    const pow2 = 1 << Math.floor(Math.log2(numTables));
    view.setUint16(6, pow2 * 16);
    view.setUint16(8, Math.floor(Math.log2(numTables)));
    view.setUint16(10, numTables * 16 - pow2 * 16);

    // Directory entries must be sorted by tag; body order follows suit.
    const sorted = [...entries].sort((lhs, rhs) => (lhs.tag < rhs.tag ? -1 : 1));
    let offset = 12 + numTables * 16;
    let headOffset = -1;
    sorted.forEach((entry, i) => {
        out.set(entry.data, offset);
        const p = 12 + i * 16;
        for (let k = 0; k < 4; k++) out[p + k] = entry.tag.charCodeAt(k);
        view.setUint32(p + 4, tableChecksum(out, offset, entry.data.length));
        view.setUint32(p + 8, offset);
        view.setUint32(p + 12, entry.data.length);
        if (entry.tag === "head") headOffset = offset;
        offset += pad4(entry.data.length);
    });

    // File checksum → head.checkSumAdjustment (its own field is already 0).
    if (headOffset >= 0) {
        const total = tableChecksum(out, 0, out.length);
        view.setUint32(headOffset + 8, (0xb1b0afba - total) >>> 0);
    }
    return out.buffer;
}

class ByteWriter {
    private chunks: number[] = [];

    get length(): number {
        return this.chunks.length;
    }
    uint8(v: number): void {
        this.chunks.push(v & 0xff);
    }
    uint16(v: number): void {
        this.chunks.push((v >> 8) & 0xff, v & 0xff);
    }
    int16(v: number): void {
        this.uint16(v < 0 ? v + 0x10000 : v);
    }
    bytes(data: Uint8Array): void {
        for (const b of data) this.chunks.push(b);
    }
    toUint8Array(): Uint8Array {
        return new Uint8Array(this.chunks);
    }
}

function tableChecksum(data: Uint8Array, offset: number, length: number): number {
    let sum = 0;
    const end = offset + pad4(length);
    for (let p = offset; p < end; p += 4) {
        sum =
            (sum +
                (((data[p] ?? 0) << 24) |
                    ((data[p + 1] ?? 0) << 16) |
                    ((data[p + 2] ?? 0) << 8) |
                    (data[p + 3] ?? 0))) >>>
            0;
    }
    return sum;
}

function pad4(n: number): number {
    return (n + 3) & ~3;
}

function f2dot14(v: number): number {
    return v / 16384;
}

/** Glyph ids referenced by a composite glyph (empty for simple glyphs). */
function compositeComponents(
    view: DataView,
    glyfBase: number,
    offsets: number[],
    gid: number,
): number[] {
    const start = glyfBase + offsets[gid];
    const end = glyfBase + offsets[gid + 1];
    if (end <= start || view.getInt16(start) >= 0) return [];
    const out: number[] = [];
    let p = start + 10;
    for (;;) {
        const flags = view.getUint16(p);
        out.push(view.getUint16(p + 2));
        p += 4 + (flags & 0x0001 ? 4 : 2); // args
        if (flags & 0x0008) p += 2; // WE_HAVE_A_SCALE
        else if (flags & 0x0040) p += 4; // X_AND_Y_SCALE
        else if (flags & 0x0080) p += 8; // TWO_BY_TWO
        if (!(flags & 0x0020)) break; // MORE_COMPONENTS
    }
    return out;
}

/**
 * Resolve Unicode code points to glyph ids through the font's own cmap
 * (Windows/Unicode or pure-Unicode subtables, formats 4 and 12). Returns
 * null when the font has no subtable we can read — callers should then
 * behave as if every glyph were reachable.
 */
export function mapUnicodesToGlyphs(
    data: Uint8Array,
    unicodes: Iterable<number>,
): Set<number> | null {
    const cmap = findSfntTable(data, "cmap");
    if (!cmap) return null;
    const v = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
    const numSubtables = v.getUint16(2);
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < numSubtables; i++) {
        const platform = v.getUint16(4 + i * 8);
        const encoding = v.getUint16(6 + i * 8);
        const offset = v.getUint32(8 + i * 8);
        const score =
            platform === 3 && encoding === 10
                ? 4
                : platform === 3 && encoding === 1
                  ? 3
                  : platform === 0
                    ? 2
                    : 0;
        if (score > bestScore) {
            bestScore = score;
            best = offset;
        }
    }
    if (best < 0) return null;

    const format = v.getUint16(best);
    const out = new Set<number>();
    if (format === 4) {
        const segCount = v.getUint16(best + 6) / 2;
        const endBase = best + 14;
        const startBase = endBase + segCount * 2 + 2;
        const deltaBase = startBase + segCount * 2;
        const rangeBase = deltaBase + segCount * 2;
        for (const u of unicodes) {
            if (u > 0xffff) continue;
            for (let s = 0; s < segCount; s++) {
                if (u > v.getUint16(endBase + s * 2)) continue;
                const segStart = v.getUint16(startBase + s * 2);
                if (u < segStart) break;
                const rangeOffset = v.getUint16(rangeBase + s * 2);
                let gid: number;
                if (rangeOffset === 0) {
                    gid = (u + v.getInt16(deltaBase + s * 2)) & 0xffff;
                } else {
                    gid = v.getUint16(rangeBase + s * 2 + rangeOffset + (u - segStart) * 2);
                    if (gid !== 0) gid = (gid + v.getInt16(deltaBase + s * 2)) & 0xffff;
                }
                if (gid !== 0) out.add(gid);
                break;
            }
        }
    } else if (format === 12) {
        const nGroups = v.getUint32(best + 12);
        for (const u of unicodes) {
            for (let g = 0; g < nGroups; g++) {
                const p = best + 16 + g * 12;
                const groupStart = v.getUint32(p);
                if (u < groupStart) break;
                if (u <= v.getUint32(p + 4)) {
                    out.add(v.getUint32(p + 8) + (u - groupStart));
                    break;
                }
            }
        }
    } else {
        return null;
    }
    return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
