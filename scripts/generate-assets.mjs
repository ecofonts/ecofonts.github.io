/**
 * Generates the PNG brand assets (PWA icons, apple-touch-icon, Open Graph
 * social image) from the SVG logo in public/favicon.svg — no image tooling
 * required: SVG paths are flattened and scanline-rasterized here, and PNGs
 * are encoded with node:zlib.
 *
 * Run from the repo root:  node scripts/generate-assets.mjs
 *
 * The OG image renders text with Arial from C:\Windows\Fonts (dev-machine
 * dependency only; the generated PNGs are committed).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import opentype from "opentype.js";

const GREEN = [0x01, 0xbf, 0x63];
const GREEN_BRIGHT = [0x00, 0xd9, 0x7a];
const DARK_BG = [0x0a, 0x10, 0x0d];
const WHITE = [0xe9, 0xf4, 0xee];
const MUTED = [0x8f, 0xa3, 0x98];

// ---------------------------------------------------------------- PNG output

function pngChunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
            raw,
            y * (stride + 1) + 1,
        );
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

// ------------------------------------------------------------------ geometry

/** Parse an SVG path `d` (absolute M/L/C/Z) into flattened contours. */
function parseSvgPath(d) {
    const tokens = d.match(/[MLCZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
    const contours = [];
    let contour = [];
    let cmd = "";
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    const close = () => {
        if (contour.length >= 3) contours.push(contour);
        contour = [];
    };
    while (i < tokens.length) {
        const tok = tokens[i];
        if (/^[MLCZ]$/i.test(tok)) {
            cmd = tok.toUpperCase();
            i++;
            if (cmd === "Z") {
                close();
                x = startX;
                y = startY;
            }
            if (cmd === "M") {
                close();
                x = startX = num();
                y = startY = num();
                contour.push([x, y]);
                cmd = "L"; // subsequent implicit pairs are line-tos
            }
            continue;
        }
        if (cmd === "L") {
            x = num();
            y = num();
            contour.push([x, y]);
        } else if (cmd === "C") {
            const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
            for (let s = 1; s <= 16; s++) {
                const t = s / 16;
                const mt = 1 - t;
                contour.push([
                    mt * mt * mt * x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
                    mt * mt * mt * y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
                ]);
            }
            x = x3;
            y = y3;
        } else {
            i++; // stray number — skip defensively
        }
    }
    close();
    return contours;
}

/** Flatten an opentype.js path (M/L/Q/C/Z) into contours. */
function flattenFontPath(path) {
    const contours = [];
    let contour = [];
    let x = 0;
    let y = 0;
    const close = () => {
        if (contour.length >= 3) contours.push(contour);
        contour = [];
    };
    for (const c of path.commands) {
        if (c.type === "M") {
            close();
            x = c.x;
            y = c.y;
            contour.push([x, y]);
        } else if (c.type === "L") {
            x = c.x;
            y = c.y;
            contour.push([x, y]);
        } else if (c.type === "Q" || c.type === "C") {
            for (let s = 1; s <= 12; s++) {
                const t = s / 12;
                const mt = 1 - t;
                if (c.type === "Q") {
                    contour.push([
                        mt * mt * x + 2 * mt * t * c.x1 + t * t * c.x,
                        mt * mt * y + 2 * mt * t * c.y1 + t * t * c.y,
                    ]);
                } else {
                    contour.push([
                        mt ** 3 * x + 3 * mt * mt * t * c.x1 + 3 * mt * t * t * c.x2 + t ** 3 * c.x,
                        mt ** 3 * y + 3 * mt * mt * t * c.y1 + 3 * mt * t * t * c.y2 + t ** 3 * c.y,
                    ]);
                }
            }
            x = c.x;
            y = c.y;
        } else if (c.type === "Z") {
            close();
        }
    }
    close();
    return contours;
}

function bboxOf(contours) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const contour of contours)
        for (const [x, y] of contour) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function transform(contours, fn) {
    return contours.map((contour) => contour.map(fn));
}

// -------------------------------------------------------------- rasterization

/** Scanline-rasterize contours; accumulates per-pixel coverage (0..1). */
function coverageOf(width, height, contours, fillRule) {
    const SUB = 4; // subsample rows per pixel
    const coverage = new Float32Array(width * height);
    const edges = [];
    for (const contour of contours) {
        for (let i = 0; i < contour.length; i++) {
            const [x0, y0] = contour[i];
            const [x1, y1] = contour[(i + 1) % contour.length];
            if (y0 !== y1) edges.push([x0, y0, x1, y1]);
        }
    }
    const crossings = [];
    for (let sy = 0; sy < height * SUB; sy++) {
        const y = (sy + 0.5) / SUB;
        crossings.length = 0;
        for (const [x0, y0, x1, y1] of edges) {
            if (y0 <= y === y1 <= y) continue;
            const t = (y - y0) / (y1 - y0);
            crossings.push([x0 + t * (x1 - x0), y1 > y0 ? 1 : -1]);
        }
        if (crossings.length === 0) continue;
        crossings.sort((a, b) => a[0] - b[0]);
        const row = Math.floor(sy / SUB) * width;
        const spans = [];
        if (fillRule === "evenodd") {
            for (let k = 0; k + 1 < crossings.length; k += 2)
                spans.push([crossings[k][0], crossings[k + 1][0]]);
        } else {
            let winding = 0;
            let openX = 0;
            for (const [cx, dir] of crossings) {
                if (winding === 0) openX = cx;
                winding += dir;
                if (winding === 0) spans.push([openX, cx]);
            }
        }
        for (const [sx0, sx1] of spans) {
            const px0 = Math.max(0, Math.floor(sx0));
            const px1 = Math.min(width - 1, Math.ceil(sx1) - 1);
            for (let px = px0; px <= px1; px++) {
                const overlap = Math.min(sx1, px + 1) - Math.max(sx0, px);
                if (overlap > 0) coverage[row + px] += overlap / SUB;
            }
        }
    }
    return coverage;
}

class Image {
    constructor(width, height, background = null) {
        this.width = width;
        this.height = height;
        this.data = new Uint8Array(width * height * 4);
        if (background) {
            for (let i = 0; i < width * height; i++) {
                this.data[i * 4] = background[0];
                this.data[i * 4 + 1] = background[1];
                this.data[i * 4 + 2] = background[2];
                this.data[i * 4 + 3] = 255;
            }
        }
    }

    /** Alpha-composite a filled shape onto the image. */
    fill(contours, color, fillRule = "nonzero") {
        const coverage = coverageOf(this.width, this.height, contours, fillRule);
        for (let i = 0; i < coverage.length; i++) {
            const a = Math.min(1, coverage[i]);
            if (a <= 0) continue;
            const p = i * 4;
            const dstA = this.data[p + 3] / 255;
            const outA = a + dstA * (1 - a);
            for (let ch = 0; ch < 3; ch++) {
                this.data[p + ch] = Math.round(
                    (color[ch] * a + this.data[p + ch] * dstA * (1 - a)) / (outA || 1),
                );
            }
            this.data[p + 3] = Math.round(outA * 255);
        }
    }

    save(path) {
        writeFileSync(path, encodePng(this.width, this.height, this.data));
        console.log(`wrote ${path}`);
    }
}

// ----------------------------------------------------------------- the assets

const svg = readFileSync("public/favicon.svg", "utf8");
const pathData = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const logoGreen = parseSvgPath(pathData[0]);
const logoBbox = bboxOf(logoGreen);

/** Place the logo (green path, even-odd fill) centered in a box. */
function drawLogo(img, cx, cy, size, color = GREEN) {
    const scale = size / Math.max(logoBbox.width, logoBbox.height);
    const placed = transform(logoGreen, ([x, y]) => [
        cx + (x - logoBbox.minX - logoBbox.width / 2) * scale,
        cy + (y - logoBbox.minY - logoBbox.height / 2) * scale,
    ]);
    img.fill(placed, color, "evenodd");
}

function drawText(img, font, text, x, baseline, size, color) {
    const path = font.getPath(text, x, baseline, size);
    img.fill(flattenFontPath(path), color, "nonzero");
}

mkdirSync("public/icons", { recursive: true });

// PWA icons (transparent background).
for (const size of [192, 512]) {
    const img = new Image(size, size);
    drawLogo(img, size / 2, size / 2, size * 0.9);
    img.save(`public/icons/icon-${size}.png`);
}

// Maskable icon: full-bleed background, logo inside the 80% safe zone.
{
    const img = new Image(512, 512, DARK_BG);
    drawLogo(img, 256, 256, 300);
    img.save("public/icons/icon-maskable-512.png");
}

// Apple touch icon (opaque, slightly padded).
{
    const img = new Image(180, 180, DARK_BG);
    drawLogo(img, 90, 90, 120);
    img.save("public/apple-touch-icon.png");
}

// Open Graph social image.
{
    let heading = null;
    let body = null;
    try {
        heading = opentype.parse(toAb(readFileSync("C:/Windows/Fonts/arialbd.ttf")));
        body = opentype.parse(toAb(readFileSync("C:/Windows/Fonts/arial.ttf")));
    } catch {
        console.warn("Arial not found — og.png will be logo-only");
    }
    const img = new Image(1200, 630, DARK_BG);
    drawLogo(img, 250, 315, 380);
    if (heading && body) {
        drawText(img, heading, "Ecofonts", 470, 300, 108, WHITE);
        drawText(img, body, "Save Ink, Save the planet.", 474, 388, 46, GREEN_BRIGHT);
        drawText(img, body, "Optimize PDFs and fonts to print with less ink —", 474, 470, 30, MUTED);
        drawText(img, body, "100% in your browser.", 474, 514, 30, MUTED);
    }
    img.save("public/og.png");
}

function toAb(buf) {
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
