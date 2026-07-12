/**
 * CFF "charstring surgeon": subtracts eco holes from every glyph of a bare
 * CFF font program (the format PDFs embed as FontFile3 with subtype Type1C
 * or CIDFontType0C) by interpreting each Type 2 charstring into contours,
 * punching the holes, and re-emitting the charstring as straight-line
 * segments. The CFF container is then rebuilt with the new CharStrings
 * INDEX while the charset, encoding, FDSelect, string and subroutine data
 * are copied byte-for-byte — so glyph IDs, CID mappings and text encoding
 * stay exactly as the PDF expects them.
 *
 * Glyphs whose charstrings use features we do not rewrite (seac accents,
 * arithmetic operators) keep their original bytes.
 *
 * Also handles full OpenType fonts (FontFile3 subtype OpenType): the CFF
 * table is processed and swapped inside the sfnt wrapper, or the TrueType
 * surgeon takes over for glyf-flavored ones.
 */
import type { Path as ClipPath, Paths as ClipPaths } from "clipper-lib";
import { SCALE, subtractEcoHoles } from "./ecofont";
import { ecoProcessTrueType, findSfntTable, replaceSfntTable } from "./glyf";

const YIELD_EVERY = 24;
const MAX_SUBR_DEPTH = 10;
const MAX_OPS = 500_000;

export interface EcoCffResult {
    buffer: ArrayBuffer;
    glyphCount: number;
    glyphsChanged: number;
}

/** Process an sfnt font program (TrueType or CFF-flavored OpenType). */
export async function ecoProcessSfnt(
    bytes: Uint8Array,
    intensity: number,
    onGlyph?: (done: number, total: number) => void,
): Promise<ArrayBuffer> {
    const version = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (version === 0x4f54544f) {
        const cff = findSfntTable(bytes, "CFF ");
        if (!cff) throw new Error("OpenType font has no CFF table");
        const result = await ecoProcessCff(cff, intensity, onGlyph);
        return replaceSfntTable(bytes, "CFF ", new Uint8Array(result.buffer));
    }
    return (await ecoProcessTrueType(bytes, intensity, onGlyph)).buffer;
}

// ============================================================ CFF structure

interface DictEntry {
    op: number; // two-byte ops are 1200 + second byte
    operands: number[];
    /** Raw operand bytes, for verbatim re-emission of untouched entries. */
    raw: Uint8Array;
}

interface CffIndex {
    items: [number, number][]; // absolute [start, end) per item
    end: number; // absolute end of the whole INDEX
}

function parseIndex(bytes: Uint8Array, view: DataView, pos: number): CffIndex {
    const count = view.getUint16(pos);
    if (count === 0) return { items: [], end: pos + 2 };
    const offSize = bytes[pos + 2];
    const readOffset = (i: number): number => {
        let v = 0;
        const p = pos + 3 + i * offSize;
        for (let k = 0; k < offSize; k++) v = (v << 8) | bytes[p + k];
        return v;
    };
    const dataStart = pos + 3 + (count + 1) * offSize - 1;
    const items: [number, number][] = [];
    for (let i = 0; i < count; i++) {
        items.push([dataStart + readOffset(i), dataStart + readOffset(i + 1)]);
    }
    return { items, end: dataStart + readOffset(count) };
}

function parseDict(bytes: Uint8Array, start: number, end: number): DictEntry[] {
    const entries: DictEntry[] = [];
    let operands: number[] = [];
    let operandStart = start;
    let p = start;
    while (p < end) {
        const b = bytes[p];
        if (b <= 21) {
            const op = b === 12 ? 1200 + bytes[p + 1] : b;
            const raw = bytes.slice(operandStart, p);
            p += b === 12 ? 2 : 1;
            entries.push({ op, operands, raw });
            operands = [];
            operandStart = p;
        } else if (b === 28) {
            operands.push((((bytes[p + 1] << 8) | bytes[p + 2]) << 16) >> 16);
            p += 3;
        } else if (b === 29) {
            operands.push(
                (bytes[p + 1] << 24) | (bytes[p + 2] << 16) | (bytes[p + 3] << 8) | bytes[p + 4],
            );
            p += 5;
        } else if (b === 30) {
            // real number (BCD nibbles)
            let s = "";
            p++;
            let done = false;
            while (!done && p < end) {
                for (const nib of [bytes[p] >> 4, bytes[p] & 0x0f]) {
                    if (nib <= 9) s += String(nib);
                    else if (nib === 0x0a) s += ".";
                    else if (nib === 0x0b) s += "E";
                    else if (nib === 0x0c) s += "E-";
                    else if (nib === 0x0e) s += "-";
                    else if (nib === 0x0f) {
                        done = true;
                        break;
                    }
                }
                p++;
            }
            operands.push(parseFloat(s) || 0);
        } else if (b >= 32 && b <= 246) {
            operands.push(b - 139);
            p += 1;
        } else if (b >= 247 && b <= 250) {
            operands.push((b - 247) * 256 + bytes[p + 1] + 108);
            p += 2;
        } else if (b >= 251 && b <= 254) {
            operands.push(-(b - 251) * 256 - bytes[p + 1] - 108);
            p += 2;
        } else {
            throw new Error(`invalid CFF dict byte ${b}`);
        }
    }
    return entries;
}

function dictGet(entries: DictEntry[], op: number): number[] | null {
    const entry = entries.find((e) => e.op === op);
    return entry ? entry.operands : null;
}

// ======================================================= Type 2 interpreter

interface GlyphEnv {
    gsubrs: Uint8Array[];
    lsubrs: Uint8Array[];
    segLen: number;
}

interface ParsedGlyph {
    contours: ClipPaths;
    /** The raw width operand if the charstring carried one. */
    widthRaw: number | null;
}

function subrBias(subrs: Uint8Array[]): number {
    return subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768;
}

/** Interpret a Type 2 charstring into flattened contours (Clipper coords). */
export function interpretCharstring(code: Uint8Array, env: GlyphEnv): ParsedGlyph {
    const stack: number[] = [];
    const contours: ClipPaths = [];
    let current: ClipPath = [];
    let x = 0;
    let y = 0;
    let nStems = 0;
    let widthRaw: number | null = null;
    let widthDone = false;
    let ended = false;
    let opCount = 0;

    const push = (px: number, py: number): void => {
        const X = Math.round(px * SCALE);
        const Y = Math.round(py * SCALE);
        const last = current[current.length - 1];
        if (!last || last.X !== X || last.Y !== Y) current.push({ X, Y });
    };
    const closeContour = (): void => {
        const first = current[0];
        const last = current[current.length - 1];
        if (first && last && first !== last && first.X === last.X && first.Y === last.Y) {
            current.pop();
        }
        if (current.length >= 3) contours.push(current);
        current = [];
    };
    const moveTo = (nx: number, ny: number): void => {
        closeContour();
        x = nx;
        y = ny;
        push(x, y);
    };
    const lineTo = (nx: number, ny: number): void => {
        x = nx;
        y = ny;
        push(x, y);
    };
    const curveTo = (
        c1x: number,
        c1y: number,
        c2x: number,
        c2y: number,
        nx: number,
        ny: number,
    ): void => {
        const est =
            Math.hypot(c1x - x, c1y - y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(nx - c2x, ny - c2y);
        const steps = Math.min(16, Math.max(2, Math.ceil(est / env.segLen)));
        const x0 = x;
        const y0 = y;
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            const mt = 1 - t;
            push(
                mt ** 3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * nx,
                mt ** 3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * ny,
            );
        }
        x = nx;
        y = ny;
    };
    const takeStemWidth = (): void => {
        if (!widthDone) {
            widthDone = true;
            if (stack.length % 2 === 1) widthRaw = stack.shift() as number;
        }
    };

    function exec(code: Uint8Array, depth: number): void {
        if (depth > MAX_SUBR_DEPTH) throw new Error("subroutine depth exceeded");
        let i = 0;
        while (i < code.length && !ended) {
            if (++opCount > MAX_OPS) throw new Error("charstring too complex");
            const b = code[i];
            // Operands
            if (b >= 32 || b === 28) {
                if (b === 28) {
                    stack.push((((code[i + 1] << 8) | code[i + 2]) << 16) >> 16);
                    i += 3;
                } else if (b <= 246) {
                    stack.push(b - 139);
                    i += 1;
                } else if (b <= 250) {
                    stack.push((b - 247) * 256 + code[i + 1] + 108);
                    i += 2;
                } else if (b <= 254) {
                    stack.push(-(b - 251) * 256 - code[i + 1] - 108);
                    i += 2;
                } else {
                    // 255: 16.16 fixed
                    stack.push(
                        (((code[i + 1] << 24) |
                            (code[i + 2] << 16) |
                            (code[i + 3] << 8) |
                            code[i + 4]) |
                            0) /
                            65536,
                    );
                    i += 5;
                }
                continue;
            }
            // Operators
            switch (b) {
                case 1: // hstem
                case 3: // vstem
                case 18: // hstemhm
                case 23: // vstemhm
                    takeStemWidth();
                    nStems += stack.length >> 1;
                    stack.length = 0;
                    i += 1;
                    break;
                case 19: // hintmask
                case 20: {
                    // cntrmask — implicit vstem from pending operands
                    takeStemWidth();
                    nStems += stack.length >> 1;
                    stack.length = 0;
                    i += 1 + ((nStems + 7) >> 3);
                    break;
                }
                case 21: // rmoveto
                    if (!widthDone) {
                        widthDone = true;
                        if (stack.length > 2) widthRaw = stack.shift() as number;
                    }
                    moveTo(x + stack[0], y + stack[1]);
                    stack.length = 0;
                    i += 1;
                    break;
                case 22: // hmoveto
                    if (!widthDone) {
                        widthDone = true;
                        if (stack.length > 1) widthRaw = stack.shift() as number;
                    }
                    moveTo(x + stack[0], y);
                    stack.length = 0;
                    i += 1;
                    break;
                case 4: // vmoveto
                    if (!widthDone) {
                        widthDone = true;
                        if (stack.length > 1) widthRaw = stack.shift() as number;
                    }
                    moveTo(x, y + stack[0]);
                    stack.length = 0;
                    i += 1;
                    break;
                case 5: // rlineto
                    for (let k = 0; k + 1 < stack.length; k += 2) {
                        lineTo(x + stack[k], y + stack[k + 1]);
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                case 6: // hlineto (alternating H/V)
                case 7: {
                    // vlineto (alternating V/H)
                    let horizontal = b === 6;
                    for (let k = 0; k < stack.length; k++) {
                        if (horizontal) lineTo(x + stack[k], y);
                        else lineTo(x, y + stack[k]);
                        horizontal = !horizontal;
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 8: // rrcurveto
                    for (let k = 0; k + 5 < stack.length; k += 6) {
                        curveTo(
                            x + stack[k],
                            y + stack[k + 1],
                            x + stack[k] + stack[k + 2],
                            y + stack[k + 1] + stack[k + 3],
                            x + stack[k] + stack[k + 2] + stack[k + 4],
                            y + stack[k + 1] + stack[k + 3] + stack[k + 5],
                        );
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                case 24: {
                    // rcurveline: {curve}+ line
                    let k = 0;
                    for (; k + 5 < stack.length - 2; k += 6) {
                        curveTo(
                            x + stack[k],
                            y + stack[k + 1],
                            x + stack[k] + stack[k + 2],
                            y + stack[k + 1] + stack[k + 3],
                            x + stack[k] + stack[k + 2] + stack[k + 4],
                            y + stack[k + 1] + stack[k + 3] + stack[k + 5],
                        );
                    }
                    lineTo(x + stack[k], y + stack[k + 1]);
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 25: {
                    // rlinecurve: {line}+ curve
                    let k = 0;
                    for (; k + 1 < stack.length - 6; k += 2) {
                        lineTo(x + stack[k], y + stack[k + 1]);
                    }
                    curveTo(
                        x + stack[k],
                        y + stack[k + 1],
                        x + stack[k] + stack[k + 2],
                        y + stack[k + 1] + stack[k + 3],
                        x + stack[k] + stack[k + 2] + stack[k + 4],
                        y + stack[k + 1] + stack[k + 3] + stack[k + 5],
                    );
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 26: {
                    // vvcurveto: dx1? {dya dxb dyb dyc}+
                    let k = 0;
                    let dx1 = 0;
                    if (stack.length % 4 === 1) dx1 = stack[k++];
                    for (; k + 3 < stack.length; k += 4) {
                        const c1x = x + dx1;
                        const c1y = y + stack[k];
                        const c2x = c1x + stack[k + 1];
                        const c2y = c1y + stack[k + 2];
                        curveTo(c1x, c1y, c2x, c2y, c2x, c2y + stack[k + 3]);
                        dx1 = 0;
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 27: {
                    // hhcurveto: dy1? {dxa dxb dyb dxc}+
                    let k = 0;
                    let dy1 = 0;
                    if (stack.length % 4 === 1) dy1 = stack[k++];
                    for (; k + 3 < stack.length; k += 4) {
                        const c1x = x + stack[k];
                        const c1y = y + dy1;
                        const c2x = c1x + stack[k + 1];
                        const c2y = c1y + stack[k + 2];
                        curveTo(c1x, c1y, c2x, c2y, c2x + stack[k + 3], c2y);
                        dy1 = 0;
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 30: // vhcurveto
                case 31: {
                    // hvcurveto — alternating groups of 4, optional 5th on last
                    let horizontal = b === 31;
                    let k = 0;
                    while (stack.length - k >= 4) {
                        const lastGroup = stack.length - k === 5;
                        if (horizontal) {
                            const c1x = x + stack[k];
                            const c1y = y;
                            const c2x = c1x + stack[k + 1];
                            const c2y = c1y + stack[k + 2];
                            curveTo(
                                c1x,
                                c1y,
                                c2x,
                                c2y,
                                c2x + (lastGroup ? stack[k + 4] : 0),
                                c2y + stack[k + 3],
                            );
                        } else {
                            const c1x = x;
                            const c1y = y + stack[k];
                            const c2x = c1x + stack[k + 1];
                            const c2y = c1y + stack[k + 2];
                            curveTo(
                                c1x,
                                c1y,
                                c2x,
                                c2y,
                                c2x + stack[k + 3],
                                c2y + (lastGroup ? stack[k + 4] : 0),
                            );
                        }
                        k += lastGroup ? 5 : 4;
                        horizontal = !horizontal;
                    }
                    stack.length = 0;
                    i += 1;
                    break;
                }
                case 10: {
                    // callsubr
                    const idx = (stack.pop() as number) + subrBias(env.lsubrs);
                    const subr = env.lsubrs[idx];
                    if (!subr) throw new Error("invalid local subroutine index");
                    i += 1;
                    exec(subr, depth + 1);
                    break;
                }
                case 29: {
                    // callgsubr
                    const idx = (stack.pop() as number) + subrBias(env.gsubrs);
                    const subr = env.gsubrs[idx];
                    if (!subr) throw new Error("invalid global subroutine index");
                    i += 1;
                    exec(subr, depth + 1);
                    break;
                }
                case 11: // return
                    return;
                case 14: // endchar
                    if (!widthDone) {
                        widthDone = true;
                        if (stack.length === 1 || stack.length === 5) {
                            widthRaw = stack.shift() as number;
                        }
                    }
                    if (stack.length >= 4) throw new Error("seac accent composition not supported");
                    closeContour();
                    ended = true;
                    return;
                case 12: {
                    const b2 = code[i + 1];
                    if (b2 === 35) {
                        // flex: dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 dx6 dy6 fd
                        const a = stack;
                        const c1x = x + a[0], c1y = y + a[1];
                        const c2x = c1x + a[2], c2y = c1y + a[3];
                        const jx = c2x + a[4], jy = c2y + a[5];
                        curveTo(c1x, c1y, c2x, c2y, jx, jy);
                        const c3x = x + a[6], c3y = y + a[7];
                        const c4x = c3x + a[8], c4y = c3y + a[9];
                        curveTo(c3x, c3y, c4x, c4y, c4x + a[10], c4y + a[11]);
                        stack.length = 0;
                        i += 2;
                    } else if (b2 === 34) {
                        // hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6
                        const a = stack;
                        const y0 = y;
                        const c1x = x + a[0], c1y = y;
                        const c2x = c1x + a[1], c2y = c1y + a[2];
                        const jx = c2x + a[3], jy = c2y;
                        curveTo(c1x, c1y, c2x, c2y, jx, jy);
                        const c3x = x + a[4], c3y = y;
                        const c4x = c3x + a[5], c4y = y0;
                        curveTo(c3x, c3y, c4x, c4y, c4x + a[6], y0);
                        stack.length = 0;
                        i += 2;
                    } else if (b2 === 36) {
                        // hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
                        const a = stack;
                        const y0 = y;
                        const c1x = x + a[0], c1y = y + a[1];
                        const c2x = c1x + a[2], c2y = c1y + a[3];
                        const jx = c2x + a[4], jy = c2y;
                        curveTo(c1x, c1y, c2x, c2y, jx, jy);
                        const c3x = x + a[5], c3y = y;
                        const c4x = c3x + a[6], c4y = c3y + a[7];
                        curveTo(c3x, c3y, c4x, c4y, c4x + a[8], y0);
                        stack.length = 0;
                        i += 2;
                    } else if (b2 === 37) {
                        // flex1: dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 d6
                        const a = stack;
                        const startX = x, startY = y;
                        const dx = a[0] + a[2] + a[4] + a[6] + a[8];
                        const dy = a[1] + a[3] + a[5] + a[7] + a[9];
                        const c1x = x + a[0], c1y = y + a[1];
                        const c2x = c1x + a[2], c2y = c1y + a[3];
                        const jx = c2x + a[4], jy = c2y + a[5];
                        curveTo(c1x, c1y, c2x, c2y, jx, jy);
                        const c3x = x + a[6], c3y = y + a[7];
                        const c4x = c3x + a[8], c4y = c3y + a[9];
                        if (Math.abs(dx) > Math.abs(dy)) {
                            curveTo(c3x, c3y, c4x, c4y, c4x + a[10], startY);
                        } else {
                            curveTo(c3x, c3y, c4x, c4y, startX, c4y + a[10]);
                        }
                        stack.length = 0;
                        i += 2;
                    } else if (b2 === 0) {
                        // dotsection (deprecated no-op)
                        stack.length = 0;
                        i += 2;
                    } else {
                        throw new Error(`charstring operator 12 ${b2} not supported`);
                    }
                    break;
                }
                default:
                    throw new Error(`charstring operator ${b} not supported`);
            }
        }
    }

    exec(code, 0);
    closeContour(); // lenient: tolerate a missing endchar
    return { contours, widthRaw };
}

// ====================================================== charstring emission

function encodeCsNumber(out: number[], v: number): void {
    if (Number.isInteger(v)) {
        if (v >= -107 && v <= 107) {
            out.push(v + 139);
            return;
        }
        if (v >= 108 && v <= 1131) {
            out.push(247 + ((v - 108) >> 8), (v - 108) & 255);
            return;
        }
        if (v <= -108 && v >= -1131) {
            out.push(251 + ((-v - 108) >> 8), (-v - 108) & 255);
            return;
        }
        if (v >= -32768 && v <= 32767) {
            out.push(28, (v >> 8) & 255, v & 255);
            return;
        }
    }
    const fixed = Math.round(v * 65536) | 0;
    out.push(255, (fixed >>> 24) & 255, (fixed >>> 16) & 255, (fixed >>> 8) & 255, fixed & 255);
}

/** Emit a Type 2 charstring drawing the polygons with straight lines. */
function buildCharstring(polys: ClipPaths, widthRaw: number | null): Uint8Array {
    const out: number[] = [];
    if (widthRaw !== null) encodeCsNumber(out, widthRaw);
    let cx = 0;
    let cy = 0;
    for (const poly of polys) {
        const pts = poly.map((pt) => ({
            x: Math.round(pt.X / SCALE),
            y: Math.round(pt.Y / SCALE),
        }));
        if (pts.length < 3) continue;
        encodeCsNumber(out, pts[0].x - cx);
        encodeCsNumber(out, pts[0].y - cy);
        out.push(21); // rmoveto (implicitly closes the previous path)
        cx = pts[0].x;
        cy = pts[0].y;
        // rlineto chains, max 24 coordinate pairs per operator (stack limit 48)
        for (let i = 1; i < pts.length; ) {
            const chunk = Math.min(24, pts.length - i);
            for (let k = 0; k < chunk; k++) {
                encodeCsNumber(out, pts[i + k].x - cx);
                encodeCsNumber(out, pts[i + k].y - cy);
                cx = pts[i + k].x;
                cy = pts[i + k].y;
            }
            out.push(5); // rlineto
            i += chunk;
        }
    }
    out.push(14); // endchar
    return new Uint8Array(out);
}

// ===================================================== container re-assembly

function buildIndex(items: Uint8Array[]): Uint8Array {
    if (items.length === 0) return new Uint8Array([0, 0]);
    let total = 0;
    for (const item of items) total += item.length;
    const offSize = total + 1 <= 0xff ? 1 : total + 1 <= 0xffff ? 2 : total + 1 <= 0xffffff ? 3 : 4;
    const out = new Uint8Array(3 + (items.length + 1) * offSize + total);
    out[0] = items.length >> 8;
    out[1] = items.length & 255;
    out[2] = offSize;
    let p = 3;
    let offset = 1;
    const writeOffset = (v: number): void => {
        for (let k = offSize - 1; k >= 0; k--) out[p++] = (v >> (k * 8)) & 255;
    };
    writeOffset(offset);
    for (const item of items) {
        offset += item.length;
        writeOffset(offset);
    }
    for (const item of items) {
        out.set(item, p);
        p += item.length;
    }
    return out;
}

function encode29(out: number[], v: number): void {
    out.push(29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function pushOp(out: number[], op: number): void {
    if (op >= 1200) out.push(12, op - 1200);
    else out.push(op);
}

/**
 * Re-serialize a DICT: untouched entries keep their raw operand bytes;
 * entries listed in `patches` get fresh 5-byte integer operands (fixed
 * length, so dict sizes are stable across the sizing and fill passes).
 */
function buildDict(entries: DictEntry[], patches: Map<number, number[]>): Uint8Array {
    const out: number[] = [];
    for (const entry of entries) {
        const patch = patches.get(entry.op);
        if (patch) {
            for (const v of patch) encode29(out, v);
        } else {
            for (const byte of entry.raw) out.push(byte);
        }
        pushOp(out, entry.op);
    }
    return new Uint8Array(out);
}

function charsetLength(bytes: Uint8Array, view: DataView, offset: number, nGlyphs: number): number {
    const format = bytes[offset];
    if (format === 0) return 1 + 2 * (nGlyphs - 1);
    if (format === 1 || format === 2) {
        const rangeSize = format === 1 ? 3 : 4;
        let covered = 1;
        let p = offset + 1;
        while (covered < nGlyphs) {
            const nLeft = format === 1 ? bytes[p + 2] : view.getUint16(p + 2);
            covered += nLeft + 1;
            p += rangeSize;
        }
        return p - offset;
    }
    throw new Error(`unsupported charset format ${format}`);
}

function encodingLength(bytes: Uint8Array, offset: number): number {
    const format = bytes[offset];
    let length: number;
    if ((format & 0x7f) === 0) length = 2 + bytes[offset + 1];
    else if ((format & 0x7f) === 1) length = 2 + 2 * bytes[offset + 1];
    else throw new Error(`unsupported encoding format ${format}`);
    if (format & 0x80) length += 1 + 3 * bytes[offset + length];
    return length;
}

function fdSelectLength(bytes: Uint8Array, view: DataView, offset: number, nGlyphs: number): number {
    const format = bytes[offset];
    if (format === 0) return 1 + nGlyphs;
    if (format === 3) return 3 + 2 + view.getUint16(offset + 1) * 3 + 2;
    throw new Error(`unsupported FDSelect format ${format}`);
}

function parseFdSelect(
    bytes: Uint8Array,
    view: DataView,
    offset: number,
    nGlyphs: number,
): Uint8Array {
    const format = bytes[offset];
    const fds = new Uint8Array(nGlyphs);
    if (format === 0) {
        fds.set(bytes.subarray(offset + 1, offset + 1 + nGlyphs));
        return fds;
    }
    if (format === 3) {
        const nRanges = view.getUint16(offset + 1);
        let p = offset + 3;
        for (let r = 0; r < nRanges; r++) {
            const first = view.getUint16(p);
            const fd = bytes[p + 2];
            const next = view.getUint16(p + 3); // next range's first, or sentinel
            for (let gid = first; gid < next && gid < nGlyphs; gid++) fds[gid] = fd;
            p += 3;
        }
        return fds;
    }
    throw new Error(`unsupported FDSelect format ${format}`);
}

interface PrivateBlock {
    entries: DictEntry[];
    subrsBlock: Uint8Array | null;
    lsubrs: Uint8Array[];
}

function parsePrivate(
    bytes: Uint8Array,
    view: DataView,
    size: number,
    offset: number,
): PrivateBlock {
    const entries = parseDict(bytes, offset, offset + size);
    const subrsRel = dictGet(entries, 19)?.[0];
    let subrsBlock: Uint8Array | null = null;
    let lsubrs: Uint8Array[] = [];
    if (subrsRel !== undefined) {
        const index = parseIndex(bytes, view, offset + subrsRel);
        subrsBlock = bytes.slice(offset + subrsRel, index.end);
        lsubrs = index.items.map(([s, e]) => bytes.slice(s, e));
    }
    return { entries, subrsBlock, lsubrs };
}

/** Serialize a private dict + its subrs (placed immediately after the dict). */
function buildPrivateBlock(priv: PrivateBlock): { block: Uint8Array; dictSize: number } {
    if (!priv.subrsBlock) {
        const dict = buildDict(priv.entries, new Map());
        return { block: dict, dictSize: dict.length };
    }
    // Subrs offset is relative to the private dict start; with the 5-byte
    // patch encoding the dict size is independent of the offset value.
    const sized = buildDict(priv.entries, new Map([[19, [0]]]));
    const dict = buildDict(priv.entries, new Map([[19, [sized.length]]]));
    const block = new Uint8Array(dict.length + priv.subrsBlock.length);
    block.set(dict, 0);
    block.set(priv.subrsBlock, dict.length);
    return { block, dictSize: dict.length };
}

// ================================================================= main pass

export async function ecoProcessCff(
    data: Uint8Array,
    intensity: number,
    onGlyph?: (done: number, total: number) => void,
): Promise<EcoCffResult> {
    const bytes = new Uint8Array(data);
    const view = new DataView(bytes.buffer);

    if (bytes[0] !== 1) throw new Error(`unsupported CFF version ${bytes[0]}`);
    const hdrSize = bytes[2];

    const nameIdx = parseIndex(bytes, view, hdrSize);
    const topIdx = parseIndex(bytes, view, nameIdx.end);
    const stringIdx = parseIndex(bytes, view, topIdx.end);
    const gsubrIdx = parseIndex(bytes, view, stringIdx.end);
    if (topIdx.items.length !== 1) throw new Error("multi-font CFF sets are not supported");
    const top = parseDict(bytes, topIdx.items[0][0], topIdx.items[0][1]);
    const gsubrs = gsubrIdx.items.map(([s, e]) => bytes.slice(s, e));

    const charStringsOff = dictGet(top, 17)?.[0];
    if (charStringsOff === undefined) throw new Error("CFF has no CharStrings");
    const csIdx = parseIndex(bytes, view, charStringsOff);
    const nGlyphs = csIdx.items.length;

    const fontMatrix = dictGet(top, 1207);
    const upem = fontMatrix && fontMatrix[0] ? Math.round(1 / fontMatrix[0]) : 1000;
    const segLen = upem / 50;

    const isCID = dictGet(top, 1230) !== null;

    // Private dict(s) and per-glyph local subroutines.
    let singlePrivate: PrivateBlock | null = null;
    let fdPrivates: PrivateBlock[] = [];
    let fdEntries: DictEntry[][] = [];
    let fdSelect: Uint8Array | null = null;
    let fdSelectBlock: Uint8Array | null = null;
    if (isCID) {
        const fdArrayOff = dictGet(top, 1236)?.[0];
        const fdSelectOff = dictGet(top, 1237)?.[0];
        if (fdArrayOff === undefined || fdSelectOff === undefined) {
            throw new Error("CID-keyed CFF is missing FDArray/FDSelect");
        }
        const fdIdx = parseIndex(bytes, view, fdArrayOff);
        fdEntries = fdIdx.items.map(([s, e]) => parseDict(bytes, s, e));
        fdPrivates = fdEntries.map((entries) => {
            const priv = dictGet(entries, 18);
            if (!priv) return { entries: [], subrsBlock: null, lsubrs: [] };
            return parsePrivate(bytes, view, priv[0], priv[1]);
        });
        fdSelect = parseFdSelect(bytes, view, fdSelectOff, nGlyphs);
        fdSelectBlock = bytes.slice(
            fdSelectOff,
            fdSelectOff + fdSelectLength(bytes, view, fdSelectOff, nGlyphs),
        );
    } else {
        const priv = dictGet(top, 18);
        singlePrivate = priv
            ? parsePrivate(bytes, view, priv[0], priv[1])
            : { entries: [], subrsBlock: null, lsubrs: [] };
    }

    // ---- rewrite charstrings
    const newCharstrings: Uint8Array[] = new Array(nGlyphs);
    let glyphsChanged = 0;
    for (let gid = 0; gid < nGlyphs; gid++) {
        const [start, end] = csIdx.items[gid];
        const code = bytes.slice(start, end);
        newCharstrings[gid] = code;
        try {
            const priv = isCID ? fdPrivates[fdSelect ? fdSelect[gid] : 0] : singlePrivate;
            const parsed = interpretCharstring(code, {
                gsubrs,
                lsubrs: priv?.lsubrs ?? [],
                segLen,
            });
            if (parsed.contours.length > 0) {
                const holed = subtractEcoHoles(parsed.contours, upem, intensity);
                if (holed && holed.length > 0) {
                    newCharstrings[gid] = buildCharstring(holed, parsed.widthRaw);
                    glyphsChanged++;
                }
            }
        } catch {
            // Unsupported charstring feature — keep the original glyph.
        }
        if ((gid + 1) % YIELD_EVERY === 0) {
            onGlyph?.(gid + 1, nGlyphs);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    onGlyph?.(nGlyphs, nGlyphs);

    // ---- reassemble the container
    const header = bytes.slice(0, hdrSize);
    const nameBlock = bytes.slice(hdrSize, nameIdx.end);
    const stringBlock = bytes.slice(topIdx.end, stringIdx.end);
    const gsubrBlock = bytes.slice(stringIdx.end, gsubrIdx.end);

    const charsetOff = dictGet(top, 15)?.[0] ?? 0;
    const charsetBlock =
        charsetOff > 2
            ? bytes.slice(charsetOff, charsetOff + charsetLength(bytes, view, charsetOff, nGlyphs))
            : null;
    const encodingOff = isCID ? 0 : (dictGet(top, 16)?.[0] ?? 0);
    const encodingBlock =
        encodingOff > 1
            ? bytes.slice(encodingOff, encodingOff + encodingLength(bytes, encodingOff))
            : null;

    const csIndexBlock = buildIndex(newCharstrings);
    const privateBlocks = (isCID ? fdPrivates : [singlePrivate as PrivateBlock]).map((priv) =>
        priv.entries.length > 0 ? buildPrivateBlock(priv) : null,
    );

    // Sizing pass: dict sizes are stable because patched operands are always
    // 5 bytes; only the offset *values* change in the fill pass.
    const buildTop = (positions: {
        charset: number;
        encoding: number;
        charstrings: number;
        privSize: number;
        privPos: number;
        fdarray: number;
        fdselect: number;
    }): Uint8Array => {
        const patches = new Map<number, number[]>();
        if (charsetBlock) patches.set(15, [positions.charset]);
        if (encodingBlock) patches.set(16, [positions.encoding]);
        patches.set(17, [positions.charstrings]);
        if (!isCID && singlePrivate && singlePrivate.entries.length > 0) {
            patches.set(18, [positions.privSize, positions.privPos]);
        }
        if (isCID) {
            patches.set(1236, [positions.fdarray]);
            patches.set(1237, [positions.fdselect]);
        }
        return buildIndex([buildDict(top, patches)]);
    };
    const buildFdArray = (privPositions: number[]): Uint8Array =>
        buildIndex(
            fdEntries.map((entries, i) => {
                const built = privateBlocks[i];
                const patches = new Map<number, number[]>();
                if (built) patches.set(18, [built.dictSize, privPositions[i]]);
                return buildDict(entries, patches);
            }),
        );

    const zeros = {
        charset: 0,
        encoding: 0,
        charstrings: 0,
        privSize: 0,
        privPos: 0,
        fdarray: 0,
        fdselect: 0,
    };
    const topIdxSize = buildTop(zeros).length;
    const fdArraySize = isCID ? buildFdArray(fdEntries.map(() => 0)).length : 0;

    let p = hdrSize + nameBlock.length + topIdxSize + stringBlock.length + gsubrBlock.length;
    const encodingPos = p;
    if (encodingBlock) p += encodingBlock.length;
    const charsetPos = p;
    if (charsetBlock) p += charsetBlock.length;
    const fdSelectPos = p;
    if (fdSelectBlock) p += fdSelectBlock.length;
    const charstringsPos = p;
    p += csIndexBlock.length;
    const fdArrayPos = p;
    p += fdArraySize;
    const privPositions: number[] = [];
    for (const built of privateBlocks) {
        privPositions.push(p);
        if (built) p += built.block.length;
    }

    const single = privateBlocks[0];
    const topBlock = buildTop({
        charset: charsetPos,
        encoding: encodingPos,
        charstrings: charstringsPos,
        privSize: !isCID && single ? single.dictSize : 0,
        privPos: privPositions[0] ?? 0,
        fdarray: fdArrayPos,
        fdselect: fdSelectPos,
    });
    if (topBlock.length !== topIdxSize) throw new Error("CFF top dict sizing mismatch");

    const out = new Uint8Array(p);
    out.set(header, 0);
    out.set(nameBlock, hdrSize);
    out.set(topBlock, hdrSize + nameBlock.length);
    out.set(stringBlock, hdrSize + nameBlock.length + topIdxSize);
    out.set(gsubrBlock, hdrSize + nameBlock.length + topIdxSize + stringBlock.length);
    if (encodingBlock) out.set(encodingBlock, encodingPos);
    if (charsetBlock) out.set(charsetBlock, charsetPos);
    if (fdSelectBlock) out.set(fdSelectBlock, fdSelectPos);
    out.set(csIndexBlock, charstringsPos);
    if (isCID) {
        const fdArrayBlock = buildFdArray(privPositions);
        if (fdArrayBlock.length !== fdArraySize) throw new Error("CFF FDArray sizing mismatch");
        out.set(fdArrayBlock, fdArrayPos);
    }
    privateBlocks.forEach((built, i) => {
        if (built) out.set(built.block, privPositions[i]);
    });

    return { buffer: out.buffer, glyphCount: nGlyphs, glyphsChanged };
}
