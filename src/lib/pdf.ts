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
import { ecoProcessTrueType } from "./glyf";
import { ecoProcessType1 } from "./type1";
import type { ProgressCallback } from "./pipeline";

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
): Promise<PdfEcoOutput> {
    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(data, { updateMetadata: false });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not read the PDF: ${message}`);
    }

    // Collect the unique font streams referenced by font descriptors (the
    // same stream may be shared by several descriptors).
    const targets: { ref: PDFRef; name: string; kind: FontKind }[] = [];
    const seenRefs = new Set<string>();
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;
        const candidates: [string, FontKind][] = [
            ["FontFile2", "truetype"],
            ["FontFile3", "fontfile3"],
            ["FontFile", "type1"],
        ];
        for (const [key, kind] of candidates) {
            const ref = obj.get(PDFName.of(key));
            if (ref instanceof PDFRef) {
                if (!seenRefs.has(ref.tag)) {
                    seenRefs.add(ref.tag);
                    targets.push({ ref, name: descriptorFontName(obj), kind });
                }
                break;
            }
        }
    }

    if (targets.length === 0) {
        throw new Error(
            "No embedded fonts found in this PDF — the text may use standard viewer fonts, which cannot be optimized.",
        );
    }

    const processedFonts: string[] = [];
    const warnings: string[] = [];

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
                    fileCount: targets.length,
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
