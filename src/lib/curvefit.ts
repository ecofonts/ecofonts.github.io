/**
 * Curve refitting.
 *
 * The eco pipeline flattens every Bézier curve to a dense chain of line
 * segments before clipping (Clipper needs polygons). Emitting those polylines
 * verbatim is what makes the output balloon 4-5x. This module fits compact
 * Bézier curves back onto the clipped polygons *before* serialization, so the
 * stored outline is the same shape within a sub-unit tolerance while costing a
 * fraction of the points.
 *
 * Corner-aware: sharp turns — glyph cusps and, crucially, the straight edges
 * of the octagonal eco holes — are detected by turn angle and kept as hard
 * breakpoints. Holes stay crisp octagons and corners stay sharp; only smoothly
 * curving runs are fitted to cubics (Schneider, "An Algorithm for
 * Automatically Fitting Digitized Curves", Graphics Gems, 1990).
 *
 * Works in plain font-unit coordinates (no Clipper SCALE, no DOM), so both the
 * CFF path (opentype.js, cubic) and the glyf surgeon (TrueType, quadratic) can
 * share it and it can be exercised from Node.
 */

export interface Pt {
    x: number;
    y: number;
}
/** A fitted contour: a start point followed by line/cubic segments back to it. */
export type Seg =
    | { type: "line"; end: Pt }
    | { type: "cubic"; c1: Pt; c2: Pt; end: Pt };
export interface FittedContour {
    start: Pt;
    segs: Seg[];
}

/** Turn sharper than this (as cos of the angle between edge directions) is a
 * corner. cos(40°)=0.766, so an octagon's 45° corners (cos 0.707) are kept. */
const CORNER_COS = 0.766;

/** Vector helpers (small structs; kept local for speed and clarity). */
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const norm = (a: Pt): Pt => {
    const l = Math.hypot(a.x, a.y) || 1;
    return { x: a.x / l, y: a.y / l };
};

/**
 * Fit a single closed contour (font-unit points, no repeated closing point) to
 * a Bézier outline. `tolerance` is the max allowed deviation in font units.
 */
export function fitContour(points: Pt[], tolerance: number): FittedContour {
    const pts = dedupe(points);
    const n = pts.length;
    if (n < 4) {
        // Too small to fit meaningfully — keep as straight edges.
        return { start: pts[0] ?? { x: 0, y: 0 }, segs: pts.slice(1).map((end) => ({ type: "line", end })) };
    }

    const corners = findCorners(pts);
    const segs: Seg[] = [];

    if (corners.length === 0) {
        // Fully smooth loop (e.g. an 'O'): break at index 0 and fit as one open
        // curve, using a smoothed tangent through the seam so it stays closed.
        const open = pts.map((p) => p);
        open.push(pts[0]);
        const seam = norm(sub(pts[1], pts[n - 1]));
        fitCubic(open, 0, open.length - 1, seam, mul(seam, -1), tolerance, segs);
    } else {
        // Split the loop into open runs between consecutive corners. The run
        // always advances at least one step, so a single-corner contour
        // becomes one run spanning the whole loop (a === b).
        for (let ci = 0; ci < corners.length; ci++) {
            const a = corners[ci];
            const b = corners[(ci + 1) % corners.length];
            const run: Pt[] = [pts[a]];
            let k = a;
            do {
                k = (k + 1) % n;
                run.push(pts[k]);
            } while (k !== b);
            if (run.length === 2) {
                segs.push({ type: "line", end: run[1] });
            } else {
                const tHat1 = norm(sub(run[1], run[0]));
                const tHat2 = norm(sub(run[run.length - 2], run[run.length - 1]));
                fitCubic(run, 0, run.length - 1, tHat1, tHat2, tolerance, segs);
            }
        }
    }
    return { start: pts[0], segs };
}

/** Drop consecutive duplicate points (and a closing point equal to the start). */
function dedupe(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
    }
    while (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) {
        out.pop();
    }
    return out;
}

/** Indices whose turn angle marks a hard corner (octagon vertices, cusps). */
function findCorners(pts: Pt[]): number[] {
    const n = pts.length;
    const corners: number[] = [];
    for (let i = 0; i < n; i++) {
        const inDir = norm(sub(pts[i], pts[(i - 1 + n) % n]));
        const outDir = norm(sub(pts[(i + 1) % n], pts[i]));
        if (dot(inDir, outDir) < CORNER_COS) corners.push(i);
    }
    return corners;
}

/** Schneider recursive cubic fit over pts[first..last]; appends to `out`. */
function fitCubic(
    pts: Pt[],
    first: number,
    last: number,
    tHat1: Pt,
    tHat2: Pt,
    tolerance: number,
    out: Seg[],
): void {
    const nPts = last - first + 1;
    if (nPts === 2) {
        out.push({ type: "line", end: pts[last] });
        return;
    }

    let u = chordLengthParameterize(pts, first, last);
    let bez = generateBezier(pts, first, last, u, tHat1, tHat2);
    let [maxErr, split] = computeMaxError(pts, first, last, bez, u);

    if (maxErr < tolerance * tolerance) {
        emit(bez, tolerance, out);
        return;
    }

    // Try reparameterizing a few times before giving up and splitting.
    if (maxErr < (tolerance * 4) * (tolerance * 4)) {
        for (let i = 0; i < 4; i++) {
            const uPrime = reparameterize(pts, first, last, u, bez);
            bez = generateBezier(pts, first, last, uPrime, tHat1, tHat2);
            [maxErr, split] = computeMaxError(pts, first, last, bez, uPrime);
            if (maxErr < tolerance * tolerance) {
                emit(bez, tolerance, out);
                return;
            }
            u = uPrime;
        }
    }

    // Still too coarse: split at the worst point and recurse.
    const center = computeCenterTangent(pts, split);
    fitCubic(pts, first, split, tHat1, center, tolerance, out);
    fitCubic(pts, split, last, mul(center, -1), tHat2, tolerance, out);
}

/** Emit a fitted cubic, downgrading to a line when it is effectively straight. */
function emit(bez: Pt[], tolerance: number, out: Seg[]): void {
    if (
        distToSegment(bez[1], bez[0], bez[3]) <= tolerance &&
        distToSegment(bez[2], bez[0], bez[3]) <= tolerance
    ) {
        out.push({ type: "line", end: bez[3] });
    } else {
        out.push({ type: "cubic", c1: bez[1], c2: bez[2], end: bez[3] });
    }
}

function chordLengthParameterize(pts: Pt[], first: number, last: number): number[] {
    const u: number[] = [0];
    for (let i = first + 1; i <= last; i++) {
        u.push(u[i - first - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const total = u[u.length - 1] || 1;
    for (let i = 0; i < u.length; i++) u[i] /= total;
    return u;
}

const B0 = (t: number): number => (1 - t) ** 3;
const B1 = (t: number): number => 3 * t * (1 - t) ** 2;
const B2 = (t: number): number => 3 * t * t * (1 - t);
const B3 = (t: number): number => t ** 3;

/** Least-squares fit of the two inner control points given fixed tangents. */
function generateBezier(pts: Pt[], first: number, last: number, u: number[], tHat1: Pt, tHat2: Pt): Pt[] {
    const nPts = last - first + 1;
    const A: [Pt, Pt][] = [];
    for (let i = 0; i < nPts; i++) {
        A.push([mul(tHat1, B1(u[i])), mul(tHat2, B2(u[i]))]);
    }
    let c00 = 0,
        c01 = 0,
        c11 = 0,
        x0 = 0,
        x1 = 0;
    const p0 = pts[first];
    const p3 = pts[last];
    for (let i = 0; i < nPts; i++) {
        c00 += dot(A[i][0], A[i][0]);
        c01 += dot(A[i][0], A[i][1]);
        c11 += dot(A[i][1], A[i][1]);
        const tmp = sub(
            pts[first + i],
            add(add(mul(p0, B0(u[i])), mul(p0, B1(u[i]))), add(mul(p3, B2(u[i])), mul(p3, B3(u[i])))),
        );
        x0 += dot(A[i][0], tmp);
        x1 += dot(A[i][1], tmp);
    }
    const detC = c00 * c11 - c01 * c01;
    const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    let alphaL = detC === 0 ? 0 : (x0 * c11 - x1 * c01) / detC;
    let alphaR = detC === 0 ? 0 : (c00 * x1 - c01 * x0) / detC;
    const epsilon = 1e-6 * chord;
    if (alphaL < epsilon || alphaR < epsilon) {
        // Degenerate solution — fall back to the Wu/Barsky third-of-chord rule.
        alphaL = alphaR = chord / 3;
    }
    return [p0, add(p0, mul(tHat1, alphaL)), add(p3, mul(tHat2, alphaR)), p3];
}

function bezierAt(bez: Pt[], t: number): Pt {
    const v = bez.slice();
    for (let i = 1; i <= 3; i++) {
        for (let j = 0; j <= 3 - i; j++) {
            v[j] = { x: (1 - t) * v[j].x + t * v[j + 1].x, y: (1 - t) * v[j].y + t * v[j + 1].y };
        }
    }
    return v[0];
}

/** Worst squared deviation of the samples from the fitted curve, + its index. */
function computeMaxError(pts: Pt[], first: number, last: number, bez: Pt[], u: number[]): [number, number] {
    let maxDist = 0;
    let split = first + Math.floor((last - first) / 2);
    for (let i = first + 1; i < last; i++) {
        const p = bezierAt(bez, u[i - first]);
        const d = (p.x - pts[i].x) ** 2 + (p.y - pts[i].y) ** 2;
        if (d >= maxDist) {
            maxDist = d;
            split = i;
        }
    }
    return [maxDist, split];
}

/** Newton-Raphson: nudge each parameter toward the curve's nearest point. */
function reparameterize(pts: Pt[], first: number, last: number, u: number[], bez: Pt[]): number[] {
    const q1 = [0, 1, 2].map((i) => mul(sub(bez[i + 1], bez[i]), 3));
    const q2 = [0, 1].map((i) => mul(sub(q1[i + 1], q1[i]), 2));
    const evalDeg = (c: Pt[], deg: number, t: number): Pt => {
        const v = c.slice();
        for (let i = 1; i <= deg; i++) {
            for (let j = 0; j <= deg - i; j++) {
                v[j] = { x: (1 - t) * v[j].x + t * v[j + 1].x, y: (1 - t) * v[j].y + t * v[j + 1].y };
            }
        }
        return v[0];
    };
    return u.map((ui, i) => {
        const idx = first + i;
        const d = sub(bezierAt(bez, ui), pts[idx]);
        const d1 = evalDeg(q1, 2, ui);
        const d2 = evalDeg(q2, 1, ui);
        const num = d.x * d1.x + d.y * d1.y;
        const den = d1.x * d1.x + d1.y * d1.y + d.x * d2.x + d.y * d2.y;
        return den === 0 ? ui : ui - num / den;
    });
}

function computeCenterTangent(pts: Pt[], center: number): Pt {
    const v1 = sub(pts[center - 1], pts[center]);
    const v2 = sub(pts[center], pts[center + 1]);
    return norm({ x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 });
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
    const ab = sub(b, a);
    const lenSq = ab.x * ab.x + ab.y * ab.y;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * ab.x), p.y - (a.y + t * ab.y));
}

/**
 * Convert one cubic (start `p0`) to 1-2 quadratic segments for TrueType glyf
 * output, staying within `tolerance`. Returns each quadratic's off-curve
 * control and on-curve end point.
 */
export function cubicToQuadratics(
    p0: Pt,
    c1: Pt,
    c2: Pt,
    p3: Pt,
    tolerance: number,
): { control: Pt; end: Pt }[] {
    const single = quadFromCubic(p0, c1, c2, p3);
    // Error at the midpoint (where a quad and cubic diverge most).
    const cubMid = {
        x: (p0.x + 3 * c1.x + 3 * c2.x + p3.x) / 8,
        y: (p0.y + 3 * c1.y + 3 * c2.y + p3.y) / 8,
    };
    const quadMid = { x: (p0.x + 2 * single.x + p3.x) / 4, y: (p0.y + 2 * single.y + p3.y) / 4 };
    if (Math.hypot(cubMid.x - quadMid.x, cubMid.y - quadMid.y) <= tolerance) {
        return [{ control: single, end: p3 }];
    }
    // Split the cubic in half and approximate each half with one quadratic.
    const m1 = mid(p0, c1);
    const m2 = mid(c1, c2);
    const m3 = mid(c2, p3);
    const n1 = mid(m1, m2);
    const n2 = mid(m2, m3);
    const mid0 = mid(n1, n2); // split point on the curve
    return [
        { control: quadFromCubic(p0, m1, n1, mid0), end: mid0 },
        { control: quadFromCubic(mid0, n2, m3, p3), end: p3 },
    ];
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The quadratic control point that best matches a cubic (degree reduction). */
function quadFromCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt): Pt {
    return {
        x: (3 * c1.x - p0.x + 3 * c2.x - p3.x) / 4,
        y: (3 * c1.y - p0.y + 3 * c2.y - p3.y) / 4,
    };
}
