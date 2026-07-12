/**
 * Type 1 "charstring surgeon" for the legacy PostScript font format that
 * PDFs embed as FontFile. A Type 1 program is a cleartext PostScript header,
 * an eexec-encrypted section holding the Private dict with /Subrs and
 * /CharStrings (each charstring individually encrypted), and a cleartext
 * trailer of zeros.
 *
 * The surgeon decrypts the eexec section, interprets each Type 1 charstring
 * (including the OtherSubrs flex and hint-replacement protocols) into
 * contours, punches the eco holes, re-emits the charstring as straight
 * lines with the original sidebearing/width, splices only the charstring
 * bytes back into the PostScript source, and re-encrypts. Glyph names,
 * encoding, subroutines and everything else stay byte-identical, so the
 * PDF's text mapping is untouched.
 *
 * Glyphs using seac accent composition or unknown OtherSubrs keep their
 * original bytes.
 */
import type { Path as ClipPath, Paths as ClipPaths } from "clipper-lib";
import { SCALE, subtractEcoHoles } from "./ecofont";

const YIELD_EVERY = 24;
const MAX_SUBR_DEPTH = 10;
const MAX_OPS = 500_000;
const EEXEC_R = 55665;
const CHARSTRING_R = 4330;
const C1 = 52845;
const C2 = 22719;

export interface EcoType1Result {
    buffer: ArrayBuffer;
    glyphCount: number;
    glyphsChanged: number;
    /** Values for the PDF stream dict (FontFile requires all three). */
    length1: number;
    length2: number;
    length3: number;
}

// ------------------------------------------------------------- en/decryption

function decrypt(bytes: Uint8Array, r: number, skip: number): Uint8Array {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        out[i] = c ^ (r >> 8);
        r = ((c + r) * C1 + C2) & 0xffff;
    }
    return out.subarray(skip);
}

function encrypt(bytes: Uint8Array, r: number, lead: number): Uint8Array {
    const out = new Uint8Array(bytes.length + lead);
    for (let i = 0; i < out.length; i++) {
        const p = i < lead ? 0x55 : bytes[i - lead];
        const c = (p ^ (r >> 8)) & 0xff;
        out[i] = c;
        r = ((c + r) * C1 + C2) & 0xffff;
    }
    return out;
}

// ------------------------------------------------------ Type 1 interpreter

interface Type1Env {
    subrs: Uint8Array[];
    segLen: number;
}

export interface ParsedType1Glyph {
    contours: ClipPaths;
    /** hsbw/sbw operator and its operands, preserved verbatim on re-emit. */
    sb: { op: "hsbw" | "sbw"; args: number[] } | null;
}

/** Interpret a decrypted Type 1 charstring into flattened contours. */
export function interpretType1Charstring(code: Uint8Array, env: Type1Env): ParsedType1Glyph {
    const stack: number[] = [];
    const psStack: number[] = []; // OtherSubrs results, retrieved by `pop`
    const contours: ClipPaths = [];
    let current: ClipPath = [];
    let x = 0;
    let y = 0;
    let sb: ParsedType1Glyph["sb"] = null;
    let flexing = false;
    let flexPts: [number, number][] = [];
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
            Math.hypot(c1x - x, c1y - y) +
            Math.hypot(c2x - c1x, c2y - c1y) +
            Math.hypot(nx - c2x, ny - c2y);
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
    /** Take `n` operands from the bottom of the stack, then clear it. */
    const takeAll = (n: number): number[] => {
        const args = stack.slice(0, n);
        stack.length = 0;
        return args;
    };
    const flexMove = (dx: number, dy: number): void => {
        x += dx;
        y += dy;
        if (flexing) flexPts.push([x, y]);
        else moveTo(x, y);
    };

    function exec(code: Uint8Array, depth: number): void {
        if (depth > MAX_SUBR_DEPTH) throw new Error("subroutine depth exceeded");
        let i = 0;
        while (i < code.length && !ended) {
            if (++opCount > MAX_OPS) throw new Error("charstring too complex");
            const b = code[i];
            if (b >= 32) {
                if (b <= 246) {
                    stack.push(b - 139);
                    i += 1;
                } else if (b <= 250) {
                    stack.push((b - 247) * 256 + code[i + 1] + 108);
                    i += 2;
                } else if (b <= 254) {
                    stack.push(-(b - 251) * 256 - code[i + 1] - 108);
                    i += 2;
                } else {
                    // 255: 32-bit signed integer (not 16.16 as in Type 2)
                    stack.push(
                        (code[i + 1] << 24) | (code[i + 2] << 16) | (code[i + 3] << 8) | code[i + 4],
                    );
                    i += 5;
                }
                continue;
            }
            switch (b) {
                case 13: {
                    // hsbw: sbx wx
                    const [sbx, wx] = takeAll(2);
                    sb = { op: "hsbw", args: [sbx, wx] };
                    x = sbx;
                    y = 0;
                    i += 1;
                    break;
                }
                case 9: // closepath (does not move the current point)
                    closeContour();
                    stack.length = 0;
                    i += 1;
                    break;
                case 21: {
                    const [dx, dy] = takeAll(2);
                    flexMove(dx, dy);
                    i += 1;
                    break;
                }
                case 22: {
                    const [dx] = takeAll(1);
                    flexMove(dx, 0);
                    i += 1;
                    break;
                }
                case 4: {
                    const [dy] = takeAll(1);
                    flexMove(0, dy);
                    i += 1;
                    break;
                }
                case 5: {
                    const [dx, dy] = takeAll(2);
                    lineTo(x + dx, y + dy);
                    i += 1;
                    break;
                }
                case 6: {
                    // hlineto: exactly one operand in Type 1
                    const [dx] = takeAll(1);
                    lineTo(x + dx, y);
                    i += 1;
                    break;
                }
                case 7: {
                    const [dy] = takeAll(1);
                    lineTo(x, y + dy);
                    i += 1;
                    break;
                }
                case 8: {
                    const a = takeAll(6);
                    curveTo(
                        x + a[0],
                        y + a[1],
                        x + a[0] + a[2],
                        y + a[1] + a[3],
                        x + a[0] + a[2] + a[4],
                        y + a[1] + a[3] + a[5],
                    );
                    i += 1;
                    break;
                }
                case 30: {
                    // vhcurveto: dy1 dx2 dy2 dx3
                    const a = takeAll(4);
                    const c1x = x;
                    const c1y = y + a[0];
                    curveTo(c1x, c1y, c1x + a[1], c1y + a[2], c1x + a[1] + a[3], c1y + a[2]);
                    i += 1;
                    break;
                }
                case 31: {
                    // hvcurveto: dx1 dx2 dy2 dy3
                    const a = takeAll(4);
                    const c1x = x + a[0];
                    const c1y = y;
                    curveTo(c1x, c1y, c1x + a[1], c1y + a[2], c1x + a[1], c1y + a[2] + a[3]);
                    i += 1;
                    break;
                }
                case 1: // hstem
                case 3: // vstem
                    stack.length = 0;
                    i += 1;
                    break;
                case 10: {
                    // callsubr — no bias in Type 1
                    const idx = stack.pop();
                    const subr = idx !== undefined ? env.subrs[idx] : undefined;
                    if (!subr) throw new Error("invalid subroutine index");
                    i += 1;
                    exec(subr, depth + 1);
                    break;
                }
                case 11: // return
                    return;
                case 14: // endchar
                    closeContour();
                    ended = true;
                    return;
                case 12: {
                    const b2 = code[i + 1];
                    if (b2 === 12) {
                        // div
                        const divisor = stack.pop() ?? 1;
                        const dividend = stack.pop() ?? 0;
                        stack.push(dividend / divisor);
                        i += 2;
                    } else if (b2 === 16) {
                        // callothersubr: args… n othersubr#
                        const which = stack.pop() ?? -1;
                        const n = stack.pop() ?? 0;
                        const args = stack.splice(stack.length - n, n);
                        if (which === 0) {
                            // flex end: args = [flexheight, endx, endy]
                            if (flexing && flexPts.length >= 7) {
                                const [, c1, c2, mid, c3, c4, end] = flexPts;
                                curveTo(c1[0], c1[1], c2[0], c2[1], mid[0], mid[1]);
                                curveTo(c3[0], c3[1], c4[0], c4[1], end[0], end[1]);
                            }
                            flexing = false;
                            flexPts = [];
                            // `pop pop setcurrentpoint` retrieves x then y
                            psStack.push(args[2] ?? y, args[1] ?? x);
                        } else if (which === 1) {
                            flexing = true;
                            flexPts = [];
                        } else if (which === 2) {
                            // one flex point was just recorded by rmoveto
                        } else if (which === 3) {
                            // hint replacement: subr# retrieved by `pop`
                            psStack.push(args[0] ?? 3);
                        } else {
                            throw new Error(`OtherSubrs[${which}] not supported`);
                        }
                        i += 2;
                    } else if (b2 === 17) {
                        // pop: retrieve an OtherSubrs result
                        const v = psStack.pop();
                        if (v === undefined) throw new Error("pop without OtherSubrs result");
                        stack.push(v);
                        i += 2;
                    } else if (b2 === 33) {
                        // setcurrentpoint (absolute)
                        const [nx, ny] = takeAll(2);
                        x = nx;
                        y = ny;
                        i += 2;
                    } else if (b2 === 7) {
                        // sbw: sbx sby wx wy
                        const args = takeAll(4);
                        sb = { op: "sbw", args };
                        x = args[0];
                        y = args[1];
                        i += 2;
                    } else if (b2 === 0 || b2 === 1 || b2 === 2) {
                        // dotsection / vstem3 / hstem3
                        stack.length = 0;
                        i += 2;
                    } else if (b2 === 6) {
                        throw new Error("seac accent composition not supported");
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
    closeContour();
    return { contours, sb };
}

// --------------------------------------------------------------- re-emission

function encodeT1Number(out: number[], v: number): void {
    v = Math.round(v);
    if (v >= -107 && v <= 107) out.push(v + 139);
    else if (v >= 108 && v <= 1131) out.push(247 + ((v - 108) >> 8), (v - 108) & 255);
    else if (v <= -108 && v >= -1131) out.push(251 + ((-v - 108) >> 8), (-v - 108) & 255);
    else out.push(255, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

function buildType1Charstring(
    polys: ClipPaths,
    sb: NonNullable<ParsedType1Glyph["sb"]>,
): Uint8Array {
    const out: number[] = [];
    for (const arg of sb.args) encodeT1Number(out, arg);
    if (sb.op === "hsbw") out.push(13);
    else out.push(12, 7);
    let cx = sb.args[0];
    let cy = sb.op === "sbw" ? sb.args[1] : 0;
    for (const poly of polys) {
        const pts = poly.map((pt) => ({
            x: Math.round(pt.X / SCALE),
            y: Math.round(pt.Y / SCALE),
        }));
        if (pts.length < 3) continue;
        encodeT1Number(out, pts[0].x - cx);
        encodeT1Number(out, pts[0].y - cy);
        out.push(21); // rmoveto
        cx = pts[0].x;
        cy = pts[0].y;
        for (let i = 1; i < pts.length; i++) {
            encodeT1Number(out, pts[i].x - cx);
            encodeT1Number(out, pts[i].y - cy);
            out.push(5); // rlineto — exactly one pair per operator in Type 1
            cx = pts[i].x;
            cy = pts[i].y;
        }
        out.push(9); // closepath
    }
    out.push(14); // endchar
    return new Uint8Array(out);
}

// -------------------------------------------------- PostScript-level parsing

interface Token {
    text: string;
    start: number;
    end: number;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function nextToken(bytes: Uint8Array, pos: number): Token | null {
    while (pos < bytes.length && WHITESPACE.has(bytes[pos])) pos++;
    if (pos >= bytes.length) return null;
    const start = pos;
    while (pos < bytes.length && !WHITESPACE.has(bytes[pos])) pos++;
    let text = "";
    for (let i = start; i < pos; i++) text += String.fromCharCode(bytes[i]);
    return { text, start, end: pos };
}

function findAscii(bytes: Uint8Array, needle: string, from: number): number {
    outer: for (let i = from; i <= bytes.length - needle.length; i++) {
        for (let k = 0; k < needle.length; k++) {
            if (bytes[i + k] !== needle.charCodeAt(k)) continue outer;
        }
        return i;
    }
    return -1;
}

interface CharstringEntry {
    name: string;
    /** Offsets in the decrypted plaintext for splicing. */
    numStart: number;
    numEnd: number;
    binStart: number;
    binEnd: number;
}

// ------------------------------------------------------------------ the pass

export async function ecoProcessType1(
    data: Uint8Array,
    intensity: number,
    onGlyph?: (done: number, total: number) => void,
): Promise<EcoType1Result> {
    // Split the program: cleartext | eexec-encrypted | trailer of zeros.
    const eexecAt = findAscii(data, "eexec", 0);
    if (eexecAt < 0) throw new Error("not a Type 1 font program (no eexec)");
    let encStart = eexecAt + 5;
    while (encStart < data.length && WHITESPACE.has(data[encStart])) encStart++;

    let trailerStart = data.length;
    const cleartomarkAt = findAscii(data, "cleartomark", encStart);
    if (cleartomarkAt >= 0) {
        let p = cleartomarkAt;
        while (p > encStart && (WHITESPACE.has(data[p - 1]) || data[p - 1] === 0x30)) p--;
        trailerStart = p;
    }

    let encrypted = data.subarray(encStart, trailerStart);
    // The encrypted section may be hex-encoded (PFA style).
    if (looksHex(encrypted)) {
        encrypted = hexDecode(encrypted);
    }
    const plain = decrypt(encrypted, EEXEC_R, 0);

    // Parse /lenIV, /Subrs and /CharStrings from the plaintext (the first
    // four plaintext bytes are random salt; parse past them).
    const lenIvAt = findAscii(plain, "/lenIV", 4);
    let lenIV = 4;
    if (lenIvAt >= 0) {
        const tok = nextToken(plain, lenIvAt + 6);
        if (tok) lenIV = parseInt(tok.text, 10) || 4;
    }

    const subrs: Uint8Array[] = [];
    const subrsAt = findAscii(plain, "/Subrs", 4);
    if (subrsAt >= 0) {
        // Skip the "<count> array" preamble (at most a few tokens) to reach
        // the first "dup" entry.
        let pos = subrsAt + 6;
        for (let skipped = 0; skipped < 4; skipped++) {
            const tok = nextToken(plain, pos);
            if (!tok || tok.text === "dup") break;
            pos = tok.end;
        }
        for (;;) {
            const dup = nextToken(plain, pos);
            if (!dup || dup.text !== "dup") break;
            const idxTok = nextToken(plain, dup.end);
            const lenTok = idxTok && nextToken(plain, idxTok.end);
            const rdTok = lenTok && nextToken(plain, lenTok.end);
            if (!idxTok || !lenTok || !rdTok) break;
            const index = parseInt(idxTok.text, 10);
            const length = parseInt(lenTok.text, 10);
            if (!Number.isFinite(index) || !Number.isFinite(length)) break;
            const binStart = rdTok.end + 1; // single space after the RD token
            subrs[index] = decrypt(plain.subarray(binStart, binStart + length), CHARSTRING_R, lenIV);
            pos = binStart + length;
        }
    }

    const charStringsAt = findAscii(plain, "/CharStrings", 4);
    if (charStringsAt < 0) throw new Error("Type 1 font has no /CharStrings");
    const entries: CharstringEntry[] = [];
    {
        let pos = charStringsAt + 12;
        // Skip the "<n> dict dup begin" preamble, then read entries.
        for (;;) {
            const tok = nextToken(plain, pos);
            if (!tok || tok.text === "end") break;
            if (tok.text.startsWith("/")) {
                const lenTok = nextToken(plain, tok.end);
                const rdTok = lenTok && nextToken(plain, lenTok.end);
                if (!lenTok || !rdTok) break;
                const length = parseInt(lenTok.text, 10);
                if (!Number.isFinite(length)) break;
                const binStart = rdTok.end + 1;
                entries.push({
                    name: tok.text.slice(1),
                    numStart: lenTok.start,
                    numEnd: lenTok.end,
                    binStart,
                    binEnd: binStart + length,
                });
                pos = binStart + length;
            } else {
                pos = tok.end;
            }
        }
    }
    if (entries.length === 0) throw new Error("Type 1 font has no charstrings");

    // Type 1 fonts are effectively always 1000 units/em (FontMatrix 0.001).
    const upem = 1000;
    const segLen = upem / 50;
    const env: Type1Env = { subrs, segLen };

    const replacements = new Map<number, Uint8Array>(); // entry index → new encrypted bytes
    let glyphsChanged = 0;
    for (let gi = 0; gi < entries.length; gi++) {
        const entry = entries[gi];
        try {
            const code = decrypt(plain.subarray(entry.binStart, entry.binEnd), CHARSTRING_R, lenIV);
            const parsed = interpretType1Charstring(code, env);
            if (parsed.contours.length > 0 && parsed.sb) {
                const holed = subtractEcoHoles(parsed.contours, upem, intensity);
                if (holed && holed.length > 0) {
                    const rebuilt = buildType1Charstring(holed, parsed.sb);
                    replacements.set(gi, encrypt(rebuilt, CHARSTRING_R, lenIV));
                    glyphsChanged++;
                }
            }
        } catch {
            // Unsupported charstring feature — keep the original glyph.
        }
        if ((gi + 1) % YIELD_EVERY === 0) {
            onGlyph?.(gi + 1, entries.length);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    onGlyph?.(entries.length, entries.length);

    // Splice the new charstrings into the plaintext (lengths + bytes only).
    const parts: Uint8Array[] = [];
    let cursor = 0;
    for (let gi = 0; gi < entries.length; gi++) {
        const replacement = replacements.get(gi);
        if (!replacement) continue;
        const entry = entries[gi];
        parts.push(plain.subarray(cursor, entry.numStart));
        parts.push(asciiBytes(String(replacement.length)));
        parts.push(plain.subarray(entry.numEnd, entry.binStart));
        parts.push(replacement);
        cursor = entry.binEnd;
    }
    parts.push(plain.subarray(cursor));
    const newPlain = concatBytes(parts);
    const newEncrypted = encrypt(newPlain, EEXEC_R, 0);

    const clearPart = data.subarray(0, encStart);
    const trailer = data.subarray(trailerStart);
    const out = concatBytes([clearPart, newEncrypted, trailer]);
    return {
        buffer: out.buffer as ArrayBuffer,
        glyphCount: entries.length,
        glyphsChanged,
        length1: clearPart.length,
        length2: newEncrypted.length,
        length3: trailer.length,
    };
}

function looksHex(bytes: Uint8Array): boolean {
    let checked = 0;
    for (let i = 0; i < bytes.length && checked < 16; i++) {
        const b = bytes[i];
        if (WHITESPACE.has(b)) continue;
        const isHex =
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
        if (!isHex) return false;
        checked++;
    }
    return checked > 0;
}

function hexDecode(bytes: Uint8Array): Uint8Array {
    const out: number[] = [];
    let hi = -1;
    for (const b of bytes) {
        let v: number;
        if (b >= 0x30 && b <= 0x39) v = b - 0x30;
        else if (b >= 0x41 && b <= 0x46) v = b - 0x37;
        else if (b >= 0x61 && b <= 0x66) v = b - 0x57;
        else continue;
        if (hi < 0) hi = v;
        else {
            out.push((hi << 4) | v);
            hi = -1;
        }
    }
    return new Uint8Array(out);
}

function asciiBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
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
