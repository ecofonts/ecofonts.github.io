/**
 * Web-font container helpers: signature sniffing, WOFF wrapping and WOFF2
 * (de)compression. The pipeline unwraps compressed containers to a plain
 * sfnt before the geometry engine runs and re-wraps the result afterwards,
 * so every upload keeps the container — and the file extension — it arrived
 * in. Browser-agnostic: CompressionStream exists in windows, workers, and
 * Node ≥18 alike, and the woff2-encoder wasm module (self-contained ESM,
 * embedded wasm) is dynamically imported so its ~1 MB chunk is neither in
 * the initial bundle nor in the worker chunk until a .woff2 file actually
 * shows up. (Don't swap it for wawoff2: that binding only assigns
 * module.exports in its Node branch, so bundled for the browser it exports
 * nothing and its ready-promise never resolves.)
 */

export type FontContainer = "sfnt" | "woff" | "woff2";

/** Identify a font binary by its 4-byte signature — never by extension. */
export function sniffContainer(data: ArrayBuffer): FontContainer | null {
    if (data.byteLength < 4) return null;
    switch (new DataView(data).getUint32(0)) {
        case 0x774f4646: // 'wOFF'
            return "woff";
        case 0x774f4632: // 'wOF2'
            return "woff2";
        case 0x00010000: // TrueType
        case 0x4f54544f: // 'OTTO' (CFF-flavored OpenType)
        case 0x74727565: // 'true' (legacy Apple)
        case 0x74797031: // 'typ1'
            return "sfnt";
        default:
            return null;
    }
}

/** wOF2 → sfnt, via a wasm build of Google's reference WOFF2 codec. */
export async function decompressWoff2(data: ArrayBuffer): Promise<ArrayBuffer> {
    const { decompress } = await import("woff2-encoder");
    return toArrayBuffer(await decompress(data));
}

/** sfnt → wOF2. Same module as the decompressor — a .woff2 job always runs
 * both directions, so splitting them would just load the wasm twice. */
export async function compressWoff2(data: ArrayBuffer): Promise<ArrayBuffer> {
    const { compress } = await import("woff2-encoder");
    return toArrayBuffer(await compress(data));
}

/** Never hand out (or transfer!) a view over someone else's buffer — copy
 * unless the bytes already own their entire ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
}

/**
 * Wrap an sfnt binary in a WOFF (1.0) container: same tables, individually
 * zlib-compressed. Table order, checksums, and every byte of table data are
 * preserved, so the wrap is lossless.
 */
export async function wrapWoff(sfnt: ArrayBuffer): Promise<ArrayBuffer> {
    const src = new DataView(sfnt);
    const numTables = src.getUint16(4);

    interface WoffTable {
        tag: number;
        checksum: number;
        origLength: number;
        stored: Uint8Array;
    }
    const tables: WoffTable[] = [];
    // sfnt directory: 12-byte header, then 16 bytes per table (kept in
    // input order — sfnt directories are already sorted by tag, which is
    // exactly what the WOFF spec requires).
    for (let i = 0; i < numTables; i++) {
        const p = 12 + i * 16;
        const origLength = src.getUint32(p + 12);
        const raw = new Uint8Array(sfnt, src.getUint32(p + 8), origLength);
        const compressed = await deflate(raw);
        tables.push({
            tag: src.getUint32(p),
            checksum: src.getUint32(p + 4),
            origLength,
            // The spec forbids storing a "compressed" table that didn't
            // actually shrink; equal compLength/origLength means raw.
            stored: compressed.length < origLength ? compressed : raw,
        });
    }

    const pad4 = (n: number) => (n + 3) & ~3;
    const dirOffset = 44; // WOFF header size
    let dataOffset = dirOffset + numTables * 20;
    let totalSfntSize = 12 + numTables * 16;
    const offsets: number[] = [];
    for (const table of tables) {
        offsets.push(dataOffset);
        dataOffset = pad4(dataOffset + table.stored.length);
        totalSfntSize += pad4(table.origLength);
    }

    const out = new Uint8Array(dataOffset);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x774f4646); // 'wOFF'
    view.setUint32(4, src.getUint32(0)); // flavor = original sfnt version
    view.setUint32(8, out.length);
    view.setUint16(12, numTables);
    view.setUint32(16, totalSfntSize);
    view.setUint16(20, 1); // majorVersion (meta/private fields stay zero)
    for (let i = 0; i < numTables; i++) {
        const p = dirOffset + i * 20;
        view.setUint32(p, tables[i].tag);
        view.setUint32(p + 4, offsets[i]);
        view.setUint32(p + 8, tables[i].stored.length);
        view.setUint32(p + 12, tables[i].origLength);
        view.setUint32(p + 16, tables[i].checksum);
        out.set(tables[i].stored, offsets[i]);
    }
    return out.buffer as ArrayBuffer;
}

/** zlib-format deflate via the platform's native CompressionStream. */
async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
