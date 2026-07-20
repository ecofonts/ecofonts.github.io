/**
 * PDF pipeline: extracts every embedded font program — TrueType (FontFile2),
 * CFF/OpenType (FontFile3) and legacy Type 1 (FontFile) — runs it through
 * the matching surgeon, and re-embeds it in place. Nothing else in the
 * document is touched: text, layout, images, metadata and page content
 * streams stay byte-identical in meaning.
 */
import {
    PDFDict,
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFRawStream,
    PDFRef,
    decodePDFRawStream,
} from "pdf-lib";
import { ecoProcessCff, ecoProcessSfnt } from "./cff";
import { ecoProcessTrueType, mapUnicodesToGlyphs } from "./glyf";
import { ecoProcessType1 } from "./type1";
import { extractTtcFace } from "./webfont";
import type { LocalFontResolver, ProgressCallback } from "./pipeline";

export interface PdfEcoOutput {
    data: ArrayBuffer;
    processedFonts: string[];
    warnings: string[];
}

type FontKind = "truetype" | "fontfile3" | "type1";

export async function processPdf(
    data: ArrayBuffer,
    intensity: number,
    onProgress?: ProgressCallback,
    resolveLocalFonts?: LocalFontResolver,
): Promise<PdfEcoOutput> {
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not read the PDF: ${message}`);
    }

    // Collect the unique font streams referenced by font descriptors (the
    // same stream may be shared by several descriptors), plus descriptors
    // with no font program at all and the Subtype of every font dict that
    // references a descriptor (needed to decide whether a missing font can
    // be safely embedded from the user's installed copy).
    const targets: { ref: PDFRef; name: string; kind: FontKind }[] = [];
    const seenRefs = new Set<string>();
    const bareDescriptors: { tag: string; dict: PDFDict; name: string }[] = [];
    const descriptorParents = new Map<string, { subtype: string; winAnsi: boolean }[]>();
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        const type = obj.get(PDFName.of("Type"));
        if (type instanceof PDFName && type.decodeText() === "Font") {
            const subtype = obj.get(PDFName.of("Subtype"));
            const descRef = obj.get(PDFName.of("FontDescriptor"));
            if (subtype instanceof PDFName && descRef instanceof PDFRef) {
                const encoding = obj.get(PDFName.of("Encoding"));
                const encodingObj =
                    encoding instanceof PDFRef ? doc.context.lookup(encoding) : encoding;
                const parents = descriptorParents.get(descRef.tag) ?? [];
                parents.push({
                    subtype: subtype.decodeText(),
                    // Plain WinAnsiEncoding (no Differences dict) is the only
                    // char→glyph mapping we reproduce when subsetting an
                    // installed font; anything else embeds the full face.
                    winAnsi:
                        encodingObj instanceof PDFName &&
                        encodingObj.decodeText() === "WinAnsiEncoding",
                });
                descriptorParents.set(descRef.tag, parents);
            }
            continue;
        }
        const candidates: [string, FontKind][] = [
            ["FontFile2", "truetype"],
            ["FontFile3", "fontfile3"],
            ["FontFile", "type1"],
        ];
        let found = false;
        for (const [key, kind] of candidates) {
            const fileRef = obj.get(PDFName.of(key));
            if (fileRef instanceof PDFRef) {
                found = true;
                if (!seenRefs.has(fileRef.tag)) {
                    seenRefs.add(fileRef.tag);
                    targets.push({ ref: fileRef, name: descriptorFontName(obj), kind });
                }
                break;
            }
        }
        if (!found && type instanceof PDFName && type.decodeText() === "FontDescriptor") {
            bareDescriptors.push({ tag: ref.tag, dict: obj, name: descriptorFontName(obj) });
        }
    }

    // A descriptor without a font program means the viewer draws that text
    // with its own copy of the font — there is nothing in the file to
    // optimize. When the Local Font Access API granted us the user's
    // installed fonts, optimize the installed copy and embed it instead.
    // Only for simple TrueType fonts: their char→glyph mapping goes through
    // the font's own cmap, so any complete copy of the face renders the
    // same text (CID fonts depend on the glyph order of the original file).
    const embeddable = new Map<string, { dicts: PDFDict[]; subset: boolean }>();
    const unembeddable = new Set<string>();
    for (const { tag, dict, name } of bareDescriptors) {
        const parents = descriptorParents.get(tag) ?? [];
        if (parents.length > 0 && parents.every((parent) => parent.subtype === "TrueType")) {
            // Subsetting the installed font (emptying glyphs no character
            // code can reach) is only safe when we can reproduce the
            // char→glyph mapping: plain WinAnsiEncoding on every referencing
            // font dict and a non-symbolic face.
            const flags = dict.get(PDFName.of("Flags"));
            const symbolic = !(flags instanceof PDFNumber) || (flags.asNumber() & 4) !== 0;
            const subset = !symbolic && parents.every((parent) => parent.winAnsi);
            const entry = embeddable.get(name) ?? { dicts: [], subset: true };
            entry.dicts.push(dict);
            entry.subset = entry.subset && subset;
            embeddable.set(name, entry);
        } else {
            unembeddable.add(name);
        }
    }

    let localFonts: Record<string, ArrayBuffer> = {};
    if (resolveLocalFonts && embeddable.size > 0) {
        try {
            localFonts = await resolveLocalFonts([...embeddable.keys()]);
        } catch {
            localFonts = {};
        }
    }
    const resolvedNames = [...embeddable.keys()].filter((name) => localFonts[name]);

    if (targets.length === 0 && resolvedNames.length === 0) {
        throw new Error(
            bareDescriptors.length > 0
                ? "The fonts in this PDF are referenced by name but not embedded, and no matching installed font was available — there are no outlines in the file to optimize."
                : "No embedded fonts found in this PDF — the text may use standard viewer fonts, which cannot be optimized.",
        );
    }

    const processedFonts: string[] = [];
    const warnings: string[] = [];
    const fileCount = targets.length + resolvedNames.length;

    for (let i = 0; i < targets.length; i++) {
        const { ref, name, kind } = targets[i];
        try {
            const stream = doc.context.lookup(ref);
            if (!(stream instanceof PDFRawStream)) {
                throw new Error("font stream has an unexpected object type");
            }
            const subtype = stream.dict.get(PDFName.of("Subtype"));
            const fontBytes = decodePDFRawStream(stream).decode();
            const report = (done: number, total: number) =>
                onProgress?.({
                    fileName: name,
                    fileIndex: i + 1,
                    fileCount,
                    glyphsDone: done,
                    glyphsTotal: total,
                });

            let buffer: ArrayBuffer;
            let type1Lengths: { length1: number; length2: number; length3: number } | null = null;
            if (kind === "truetype") {
                buffer = (await ecoProcessTrueType(fontBytes, intensity, report)).buffer;
            } else if (kind === "type1") {
                const result = await ecoProcessType1(fontBytes, intensity, report);
                buffer = result.buffer;
                type1Lengths = result;
            } else {
                // FontFile3: bare CFF (Type1C/CIDFontType0C) or a full
                // OpenType wrapper — sniff the actual bytes rather than
                // trusting the declared subtype.
                const version = new DataView(
                    fontBytes.buffer,
                    fontBytes.byteOffset,
                    fontBytes.byteLength,
                ).getUint32(0);
                if (version === 0x4f54544f || version === 0x00010000 || version === 0x74727565) {
                    buffer = await ecoProcessSfnt(fontBytes, intensity, report);
                } else {
                    buffer = (await ecoProcessCff(fontBytes, intensity, report)).buffer;
                }
            }

            const newBytes = new Uint8Array(buffer);
            const newStream = doc.context.flateStream(newBytes);
            if (kind === "truetype") {
                // FontFile2 requires Length1 = uncompressed font program size.
                newStream.dict.set(PDFName.of("Length1"), PDFNumber.of(newBytes.length));
            } else if (kind === "type1" && type1Lengths) {
                // FontFile requires the three segment lengths.
                newStream.dict.set(PDFName.of("Length1"), PDFNumber.of(type1Lengths.length1));
                newStream.dict.set(PDFName.of("Length2"), PDFNumber.of(type1Lengths.length2));
                newStream.dict.set(PDFName.of("Length3"), PDFNumber.of(type1Lengths.length3));
            } else if (subtype instanceof PDFName) {
                newStream.dict.set(PDFName.of("Subtype"), subtype);
            }
            doc.context.assign(ref, newStream);
            processedFonts.push(name);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push(`${name}: ${message} — kept as-is`);
        }
    }

    // Embed optimized copies of the installed fonts the document relies on.
    for (let i = 0; i < resolvedNames.length; i++) {
        const name = resolvedNames[i];
        try {
            const entry = embeddable.get(name)!;
            const fontBytes = prepareLocalFont(localFonts[name], name);
            const report = (done: number, total: number) =>
                onProgress?.({
                    fileName: name,
                    fileIndex: targets.length + i + 1,
                    fileCount,
                    glyphsDone: done,
                    glyphsTotal: total,
                });

            const version = new DataView(
                fontBytes.buffer,
                fontBytes.byteOffset,
                fontBytes.byteLength,
            ).getUint32(0);
            let newBytes: Uint8Array;
            let fileKey: string;
            if (version === 0x00010000 || version === 0x74727565) {
                // Keep only the glyphs WinAnsi character codes can reach
                // (mapUnicodesToGlyphs returning null means the cmap is
                // unreadable — embed the full face instead).
                const keep = entry.subset
                    ? (mapUnicodesToGlyphs(fontBytes, WIN_ANSI_UNICODES) ?? undefined)
                    : undefined;
                newBytes = new Uint8Array(
                    (await ecoProcessTrueType(fontBytes, intensity, report, keep)).buffer,
                );
                fileKey = "FontFile2";
            } else if (version === 0x4f54544f) {
                newBytes = new Uint8Array(await ecoProcessSfnt(fontBytes, intensity, report));
                fileKey = "FontFile3";
            } else {
                throw new Error("the installed font has an unsupported format");
            }

            const newStream = doc.context.flateStream(newBytes);
            if (fileKey === "FontFile2") {
                newStream.dict.set(PDFName.of("Length1"), PDFNumber.of(newBytes.length));
            } else {
                newStream.dict.set(PDFName.of("Subtype"), PDFName.of("OpenType"));
            }
            const streamRef = doc.context.register(newStream);
            for (const descriptor of entry.dicts) {
                descriptor.set(PDFName.of(fileKey), streamRef);
            }
            processedFonts.push(name);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            warnings.push(`${name}: ${message} — its text keeps the viewer's font`);
        }
    }

    // Non-embedded fonts we could not replace still render with the
    // viewer's copy; tell the user why that text is not optimized.
    const missingHint = resolveLocalFonts
        ? "no matching installed font was found"
        : "optimizing it needs access to your installed fonts (Chrome or Edge)";
    for (const name of embeddable.keys()) {
        if (!localFonts[name]) {
            warnings.push(
                `${name}: not embedded in this PDF and ${missingHint} — its text keeps the viewer's font`,
            );
        }
    }
    for (const name of unembeddable) {
        warnings.push(
            `${name}: not embedded in this PDF — its text is drawn with the viewer's copy of the font and cannot be optimized`,
        );
    }

    if (processedFonts.length === 0) {
        throw new Error(`Could not process any font in the PDF. ${warnings.join(" / ")}`);
    }

    const saved = await doc.save({ useObjectStreams: false });
    // Copy into a fresh buffer: saved.buffer is typed ArrayBufferLike and may
    // be a view into a larger allocation.
    const out = new Uint8Array(saved.byteLength);
    out.set(saved);
    return {
        data: out.buffer,
        processedFonts,
        warnings,
    };
}

function descriptorFontName(descriptor: PDFDict): string {
    const name = descriptor.get(PDFName.of("FontName"));
    if (name instanceof PDFName) return name.decodeText();
    return "embedded font";
}

/**
 * Every Unicode code point WinAnsiEncoding (= Windows code page 1252) can
 * address: 0x20–0x7E and 0xA0–0xFF map to themselves, 0x80–0x9F to the
 * cp1252 specials below. Used to decide which glyphs of an installed font a
 * simple WinAnsi-encoded PDF font can possibly draw.
 */
const WIN_ANSI_UNICODES: number[] = (() => {
    const specials = [
        0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
        0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
        0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
    ];
    const out: number[] = [...specials];
    for (let u = 0x20; u <= 0x7e; u++) out.push(u);
    for (let u = 0xa0; u <= 0xff; u++) out.push(u);
    return out;
})();

/**
 * Turn a Local Font Access blob into a single embeddable sfnt: the API
 * returns the underlying font file, which may be a TrueType Collection —
 * extract the face matching the PostScript name in that case.
 */
function prepareLocalFont(data: ArrayBuffer, postscriptName: string): Uint8Array {
    const view = new DataView(data);
    if (data.byteLength >= 12 && view.getUint32(0) === 0x74746366 /* 'ttcf' */) {
        const face = extractTtcFace(data, postscriptName);
        if (!face) {
            throw new Error("could not find this face inside the installed font collection");
        }
        return new Uint8Array(face);
    }
    return new Uint8Array(data);
}
