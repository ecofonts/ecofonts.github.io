/**
 * Ecofonts geometry engine.
 *
 * Takes a TTF binary, punches a uniform grid of small "eco holes" out of the
 * interior of every glyph (boolean difference via Clipper), and re-compiles
 * the font with opentype.js. Pure ArrayBuffer-in / ArrayBuffer-out — no DOM
 * access — so it runs in the browser and in Node (for tests) alike.
 *
 * Coordinate notes:
 * - Clipper works on integers, so font-unit coordinates are scaled by SCALE
 *   before clipping and divided back afterwards.
 * - Clipper emits outer contours and holes with opposite windings, which is
 *   exactly what the nonzero fill rule used by font rasterizers requires.
 * - opentype.js writes CFF-flavored OpenType (sfnt version "OTTO"). The
 *   output installs and renders everywhere a .ttf does, and the original
 *   file name/extension is preserved by the pipeline.
 */
import ClipperLib from "clipper-lib";
import type { Path as ClipPath, Paths as ClipPaths } from "clipper-lib";
import { parse, Path } from "opentype.js";
import type { Font, Glyph } from "opentype.js";

/** Integer scale factor between font units and Clipper coordinates. */
const SCALE = 100;
/** Hole grid spacing, as a fraction of the em size. Smaller spacing means
 * more, smaller holes for the same target ink removal. */
const HOLE_SPACING_EM = 0.055;
/** Minimum wall kept between a hole and the glyph outline (fraction of em). */
const MIN_WALL_EM = 0.015;
/** Smallest useful hole radius (fraction of em); tinier holes vanish. */
const MIN_RADIUS_EM = 0.004;
/** Vertices per hole polygon (octagons approximate circles well enough). */
const CIRCLE_SEGMENTS = 8;
/** Glyphs processed between yields back to the event loop. */
const YIELD_EVERY = 24;
/** Safety cap on holes generated for a single glyph (icon fonts etc.). */
const MAX_HOLES_PER_GLYPH = 20_000;

export type GlyphProgressCallback = (glyphsDone: number, glyphsTotal: number) => void;

export function parseFont(data: ArrayBuffer): Font {
    return parse(data);
}

/**
 * Parse a TTF, subtract eco holes from every glyph and re-compile it.
 *
 * @param data      original font binary
 * @param intensity target fraction of interior ink to remove (0.01–0.20)
 * @returns the new binary plus the mutated Font object (usable for previews)
 */
export interface ProcessedTtf {
    buffer: ArrayBuffer;
    font: Font;
    /** True when the input was a variable font (axes cannot survive the rewrite). */
    droppedVariations: boolean;
}

export async function processTtf(
    data: ArrayBuffer,
    intensity: number,
    onGlyph?: GlyphProgressCallback,
): Promise<ProcessedTtf> {
    const font = parse(data);
    const upem = font.unitsPerEm || 1000;
    const total = font.glyphs.length;

    // Snapshot every glyph path before mutating any of them: composite glyphs
    // (accented letters etc.) resolve their component outlines lazily, so all
    // paths must be read while the components are still untouched.
    const glyphs: Glyph[] = [];
    const originals: Path[] = [];
    for (let i = 0; i < total; i++) {
        const glyph = font.glyphs.get(i);
        glyphs.push(glyph);
        originals.push(glyph.path);
    }

    const segLen = upem / 50; // curve flattening: max segment length in font units
    for (let i = 0; i < total; i++) {
        const original = originals[i];
        if (original && original.commands.length > 0) {
            const contours = flattenPath(original, segLen);
            if (contours.length > 0) {
                const holed = subtractEcoHoles(contours, upem, intensity);
                // null means "no holes fit" — keep the original curved outline.
                if (holed) glyphs[i].path = polysToPath(holed);
            }
        }
        if ((i + 1) % YIELD_EVERY === 0) {
            onGlyph?.(i + 1, total);
            await yieldToEventLoop();
        }
    }
    onGlyph?.(total, total);

    // opentype.js re-serializes optional tables it parsed, but our rewrite
    // invalidates some of them or trips writer bugs:
    // - gsub: the writer throws on lookup types it doesn't support (e.g.
    //   type 7 extension lookups, as in Arial); only optional substitutions
    //   such as ligatures are lost.
    // - fvar/avar/cvar/gvar/stat: variation tables. The rewritten outlines
    //   are the default instance only, so they'd be lies — and fvar axis
    //   values can overflow the writer's 16.16 encoder ("Value 32768 is
    //   outside the range..." on e.g. Sitka or Segoe UI Variable).
    const tables = font.tables as Record<string, unknown>;
    const droppedVariations = Boolean(tables.fvar);
    for (const name of ["gsub", "fvar", "avar", "cvar", "gvar", "stat"]) {
        delete tables[name];
    }

    return { buffer: font.toArrayBuffer(), font, droppedVariations };
}

/**
 * Subtract a grid of holes from one glyph's contours.
 * Returns the new contours, or null when the glyph should stay untouched.
 */
function subtractEcoHoles(
    contours: ClipPaths,
    upem: number,
    intensity: number,
): ClipPaths | null {
    // Union the raw contours with the nonzero rule: resolves overlaps and
    // normalizes winding so the inset offset shrinks (not grows) the shape.
    const normalized = boolOp(ClipperLib.ClipType.ctUnion, contours, null);
    if (normalized.length === 0) return null;

    // On a square grid with spacing s, circles of radius r remove pi*r^2/s^2
    // of the area — solve for r so the removed fraction matches `intensity`.
    // The wall protection below claws back ~40% of that in practice (measured
    // on real text faces), so compensate; the cap keeps holes from touching.
    const effective = Math.min(intensity * 1.6, 0.32);
    const spacing = upem * HOLE_SPACING_EM;
    const radius = Math.max(spacing * Math.sqrt(effective / Math.PI), upem * MIN_RADIUS_EM);
    // Wall = minimum ink thickness preserved around every hole so the glyph
    // silhouette is never notched and thin strokes keep their edges.
    const wall = Math.max(upem * MIN_WALL_EM, radius * 0.3);

    const inset = insetPaths(normalized, wall);
    if (inset.length === 0) return null; // glyph too thin for any hole

    const holes = holeGrid(pathsBounds(inset), spacing * SCALE, radius * SCALE);
    if (holes.length === 0) return null;

    // Clip holes to the inset interior first (protects the walls), then
    // subtract them from the full glyph.
    const interiorHoles = boolOp(ClipperLib.ClipType.ctIntersection, holes, inset);
    if (interiorHoles.length === 0) return null;

    const holed = boolOp(ClipperLib.ClipType.ctDifference, normalized, interiorHoles);
    return holed.length > 0 ? cleanPaths(holed) : null;
}

/** Flatten an opentype path (M/L/Q/C/Z) into closed integer polygons. */
function flattenPath(path: Path, segLen: number): ClipPaths {
    const contours: ClipPaths = [];
    let current: ClipPath = [];
    let startX = 0;
    let startY = 0;
    let x = 0;
    let y = 0;

    const push = (px: number, py: number): void => {
        const X = Math.round(px * SCALE);
        const Y = Math.round(py * SCALE);
        const last = current[current.length - 1];
        if (!last || last.X !== X || last.Y !== Y) current.push({ X, Y });
    };
    const closeContour = (): void => {
        // Drop an explicit closing point identical to the start; Clipper
        // treats polygons as implicitly closed.
        const first = current[0];
        const last = current[current.length - 1];
        if (first && last && first !== last && first.X === last.X && first.Y === last.Y) {
            current.pop();
        }
        if (current.length >= 3) contours.push(current);
        current = [];
    };

    for (const cmd of path.commands) {
        switch (cmd.type) {
            case "M":
                closeContour();
                x = startX = cmd.x;
                y = startY = cmd.y;
                push(x, y);
                break;
            case "L":
                x = cmd.x;
                y = cmd.y;
                push(x, y);
                break;
            case "Q": {
                const steps = stepsFor(
                    dist(x, y, cmd.x1, cmd.y1) + dist(cmd.x1, cmd.y1, cmd.x, cmd.y),
                    segLen,
                );
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    const mt = 1 - t;
                    push(
                        mt * mt * x + 2 * mt * t * cmd.x1 + t * t * cmd.x,
                        mt * mt * y + 2 * mt * t * cmd.y1 + t * t * cmd.y,
                    );
                }
                x = cmd.x;
                y = cmd.y;
                break;
            }
            case "C": {
                const steps = stepsFor(
                    dist(x, y, cmd.x1, cmd.y1) +
                        dist(cmd.x1, cmd.y1, cmd.x2, cmd.y2) +
                        dist(cmd.x2, cmd.y2, cmd.x, cmd.y),
                    segLen,
                );
                for (let s = 1; s <= steps; s++) {
                    const t = s / steps;
                    const mt = 1 - t;
                    push(
                        mt * mt * mt * x +
                            3 * mt * mt * t * cmd.x1 +
                            3 * mt * t * t * cmd.x2 +
                            t * t * t * cmd.x,
                        mt * mt * mt * y +
                            3 * mt * mt * t * cmd.y1 +
                            3 * mt * t * t * cmd.y2 +
                            t * t * t * cmd.y,
                    );
                }
                x = cmd.x;
                y = cmd.y;
                break;
            }
            case "Z":
                x = startX;
                y = startY;
                closeContour();
                break;
        }
    }
    closeContour();
    return contours;
}

/** Convert Clipper polygons back to an opentype path in font units. */
function polysToPath(polys: ClipPaths): Path {
    const path = new Path();
    const r = (v: number): number => Math.round(v / SCALE);
    for (const poly of polys) {
        if (poly.length < 3) continue;
        path.moveTo(r(poly[0].X), r(poly[0].Y));
        for (let i = 1; i < poly.length; i++) {
            path.lineTo(r(poly[i].X), r(poly[i].Y));
        }
        path.closePath();
    }
    return path;
}

/**
 * Build the hole grid covering `bounds` (Clipper coordinates). The grid is
 * anchored at the font-space origin — not the glyph — so the hole texture
 * lines up consistently across all glyphs; odd rows shift by half a step for
 * a staggered, more uniform pattern.
 */
function holeGrid(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    spacing: number,
    radius: number,
): ClipPaths {
    const rowStart = Math.floor((bounds.minY - radius) / spacing);
    const rowEnd = Math.ceil((bounds.maxY + radius) / spacing);
    const colSpan = Math.ceil((bounds.maxX - bounds.minX + 2 * radius) / spacing) + 2;
    if ((rowEnd - rowStart + 1) * colSpan > MAX_HOLES_PER_GLYPH) return [];

    const holes: ClipPaths = [];
    for (let row = rowStart; row <= rowEnd; row++) {
        const cy = row * spacing;
        const shift = (row & 1) !== 0 ? spacing / 2 : 0;
        const colStart = Math.floor((bounds.minX - radius - shift) / spacing);
        const colEnd = Math.ceil((bounds.maxX + radius - shift) / spacing);
        for (let col = colStart; col <= colEnd; col++) {
            holes.push(circlePath(col * spacing + shift, cy, radius));
        }
    }
    return holes;
}

function circlePath(cx: number, cy: number, r: number): ClipPath {
    const pts: ClipPath = [];
    for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
        const a = (2 * Math.PI * k) / CIRCLE_SEGMENTS;
        pts.push({
            X: Math.round(cx + r * Math.cos(a)),
            Y: Math.round(cy + r * Math.sin(a)),
        });
    }
    return pts;
}

function boolOp(clipType: number, subject: ClipPaths, clip: ClipPaths | null): ClipPaths {
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    if (clip && clip.length > 0) {
        clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    }
    const solution: ClipPaths = [];
    clipper.Execute(
        clipType,
        solution,
        ClipperLib.PolyFillType.pftNonZero,
        ClipperLib.PolyFillType.pftNonZero,
    );
    return solution;
}

/** Shrink polygons inward by `wall` font units. */
function insetPaths(paths: ClipPaths, wall: number): ClipPaths {
    const offset = new ClipperLib.ClipperOffset(2, 0.25);
    offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const solution: ClipPaths = [];
    offset.Execute(solution, -wall * SCALE);
    return solution;
}

/** Simplify near-collinear points and drop degenerate speck contours. */
function cleanPaths(paths: ClipPaths): ClipPaths {
    const cleaned = ClipperLib.Clipper.CleanPolygons(paths, SCALE * 0.35);
    const minArea = (3 * SCALE) * (3 * SCALE); // < ~3x3 font units: invisible
    return cleaned.filter(
        (p) => p.length >= 3 && Math.abs(ClipperLib.Clipper.Area(p)) > minArea,
    );
}

function pathsBounds(paths: ClipPaths): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
} {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
        for (const pt of path) {
            if (pt.X < minX) minX = pt.X;
            if (pt.X > maxX) maxX = pt.X;
            if (pt.Y < minY) minY = pt.Y;
            if (pt.Y > maxY) maxY = pt.Y;
        }
    }
    return { minX, minY, maxX, maxY };
}

function dist(x0: number, y0: number, x1: number, y1: number): number {
    return Math.hypot(x1 - x0, y1 - y0);
}

function stepsFor(estimatedLength: number, segLen: number): number {
    return Math.min(16, Math.max(2, Math.ceil(estimatedLength / segLen)));
}

/** Let the browser paint between glyph batches so the UI stays responsive. */
function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
