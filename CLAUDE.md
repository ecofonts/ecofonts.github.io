# Ecofonts

A 100% client-side font optimizer. Users upload a font file (`.ttf`, `.otf`,
`.woff`, `.woff2`), a `.zip` of fonts, or a `.pdf` document; Ecofonts
subtracts a grid of small vector holes ("eco holes") from the interior of
every glyph so printing uses less ink, then returns the modified file for
download. For PDFs, every embedded font in the document is optimized in
place; fonts the document references without embedding (typical of Word
exports) are optimized from the user's installed copy via the Local Font
Access API where available. No data ever leaves the browser.

## Architecture

- **Framework:** Astro (static output) + `@astrojs/react`.
- **Layout & theming:** both pages use [src/layouts/Base.astro](src/layouts/Base.astro), which owns the
  design tokens (CSS custom properties with light/dark variants keyed off
  `html[data-theme]`), the sticky nav (theme toggle at the right), and the
  footer (GitHub link: https://github.com/ecofonts/ecofonts.github.io). Theme
  is resolved **before first paint** by an inline script — localStorage key
  `ecofonts-theme`, falling back to `prefers-color-scheme` — and persisted on
  toggle. Component/page styles must use the shared tokens (`--green`,
  `--surface`, `--border`, `--tint`, `--error-*`, `--warn-*`, …) so they
  adapt to both themes; brand green is `#01bf63`, logo is
  [public/favicon.svg](public/favicon.svg).
- **Copy priority:** PDFs lead the messaging everywhere (hero, drop zones,
  FAQ, accept-attribute order); fonts are secondary. Keep it that way.
- **SEO & PWA:** `site` is `https://ecofonts.github.io` (astro.config), with
  @astrojs/sitemap + [public/robots.txt](public/robots.txt). Base.astro emits canonical/OG/
  Twitter tags (social image [public/og.png](public/og.png)) and registers the service
  worker [public/sw.js](public/sw.js) (production only; runtime caching — network-first
  HTML, cache-first hashed assets). The landing page carries WebApplication
  and FAQPage JSON-LD — **the FAQPage entries must mirror the visible FAQ**;
  update both together. PNG assets (icons, og.png) are generated from the
  SVG logo by [scripts/generate-assets.mjs](scripts/generate-assets.mjs) (`node scripts/generate-assets.mjs`;
  needs Arial from C:\Windows\Fonts for the og.png text). Bump the CACHE
  version in sw.js when changing precached shell files.
- **Routes:**
  - `/` — [src/pages/index.astro](src/pages/index.astro): landing page (hero + drop zone, how-it-works,
    features, Google Fonts import guide, FAQ). Static, with one inline
    script for the drop zone; page-specific scoped styles live in the page.
  - `/font` — [src/pages/font.astro](src/pages/font.astro): mounts the optimizer React component with `client:load`.
- **Landing → optimizer file handoff:** dropping files on `/` stashes them
  in IndexedDB ([src/lib/handoff.ts](src/lib/handoff.ts)) and navigates to `/font`, which takes
  them on mount and **preselects them without auto-processing** — the user
  picks an Eco Intensity and clicks Optimize. IndexedDB (not sessionStorage)
  because `File` objects survive structured cloning there and fonts can
  exceed string-storage quotas.
- **Strictly client-side processing.** There are no API routes, server
  endpoints, or serverless functions — all parsing, geometry, and packaging
  runs in the browser. Keep it that way.

### Source layout

- [src/components/FontOptimizer.tsx](src/components/FontOptimizer.tsx) — UI: drag-and-drop upload zone
  accepting **multiple files** (`.pdf`/`.zip`/`.ttf`/`.otf`/`.woff`/`.woff2`), "Eco Intensity"
  slider (1–20%), batch + per-glyph progress, per-file download buttons plus
  "Download all", per-file failure reporting, and a before/after preview:
  the result's raw font bytes (`previewOriginalData`/`previewProcessedData`
  on `EcoResult`) are loaded as **real web fonts via the FontFace API** and
  rendered as plain HTML text — native quality, wrapping and multiline for
  free; do not reintroduce canvas rendering (blurry, and opentype.js text
  layout throws on GSUB lookups it doesn't support). PDFs never show a font
  preview (the pipeline returns null preview data for them); instead each
  PDF result row gets a **Print** button that prints the optimized document
  without downloading it — the blob is loaded into an invisible iframe and
  `contentWindow.print()` opens the dialog (the frame must stay rendered,
  not `display:none`, and outlive the dialog).
  Files are processed sequentially; one failure never aborts the batch.
  Styled by [src/components/FontOptimizer.css](src/components/FontOptimizer.css) using the shared design
  tokens. Loads the worker client with a dynamic `import()` on first use —
  this keeps the heavy libraries out of the initial bundle **and out of
  Astro's prerender pass** (see gotchas). A Web Lock is held for the whole
  batch so Chrome doesn't freeze the tab while it's hidden mid-job (frozen
  pages pause their workers too).
- [src/lib/workerClient.ts](src/lib/workerClient.ts) + [src/lib/pipeline.worker.ts](src/lib/pipeline.worker.ts) — processing runs in a
  **dedicated Web Worker** so it continues at full speed in background tabs
  (browsers clamp hidden-tab main-thread timers to ≥1s, which would stall
  the pipeline's cooperative `setTimeout(0)` yields; workers are exempt) and
  heavy glyphs never jank the UI. The client lazily spawns the worker,
  multiplexes jobs by id (progress stream + final done/error message), and
  falls back to running the pipeline inline on the main thread when module
  workers are unavailable. When a PDF needs installed fonts, the worker
  sends a `need-local-fonts` message and suspends the job until the client
  answers with the bytes (the Local Font Access API is main-thread only) —
  the client **always** replies, even with an empty result, or the job would
  hang. The worker transfers result buffers back
  **deduped** — the `.ttf` path aliases the output and preview buffers to
  the same ArrayBuffer, and a duplicate in a transfer list throws.
  `vite.worker.format` is `'es'` (astro.config) so the worker keeps pdf-lib
  behind its dynamic import instead of inlining it into the worker chunk.
- [src/lib/limits.ts](src/lib/limits.ts) — single source of truth for selection validation,
  used by both the landing drop zone and the optimizer (they once drifted;
  don't duplicate the rules again). Per-selection maximums: 20 PDFs, 100
  fonts (`.ttf`/`.otf`/`.woff`/`.woff2` combined), 5 `.zip`. **The maximums
  must not appear in regular UI copy** — only in the rejection message when
  a selection exceeds them.
- [src/lib/pipeline.ts](src/lib/pipeline.ts) — file-level routing: single font vs `.zip`
  traversal with JSZip vs `.pdf`. Rewrites zip entries in place so the
  archive keeps its exact folder structure (e.g. Google Fonts `static/`
  folders); non-font files pass through untouched; per-file failures become
  warnings and the original file is kept. Font containers are detected by
  byte signature (never extension) and preserved on output: `.woff2` is
  unwrapped/re-wrapped via [src/lib/webfont.ts](src/lib/webfont.ts), `.woff` is parsed directly
  by opentype.js and re-wrapped on the way out.
- [src/lib/webfont.ts](src/lib/webfont.ts) — container helpers: signature sniffing, a WOFF
  (1.0) writer built on the platform's native `CompressionStream`, WOFF2
  (de)compression via `woff2-encoder` (self-contained ESM + embedded wasm,
  dynamically imported so its ~1 MB chunk loads only when a `.woff2`
  arrives), and `extractTtcFace` (pulls one face out of a TrueType
  Collection by PostScript name — the Local Font Access API returns whole
  `.ttc` files for collection-hosted system fonts). **Do not swap it for `wawoff2`** — that binding only assigns
  `module.exports` in its Node branch, so bundled for the browser it exports
  nothing and its ready-promise hangs forever.
- [src/lib/ecofont.ts](src/lib/ecofont.ts) — geometry engine: opentype.js parse → flatten
  glyph outlines to polygons → boolean ops with clipper-lib → new paths →
  `font.toArrayBuffer()`. Browser-agnostic (ArrayBuffer in/out, no DOM), so
  it can be exercised from Node for testing. Exports `subtractEcoHoles` +
  `SCALE` for reuse by the glyf surgeon.
- [src/lib/glyf.ts](src/lib/glyf.ts) — TrueType "glyf surgeon" used for PDF-embedded fonts:
  parses glyf/loca directly from the binary (works on subset fonts that have
  no cmap/name tables, where opentype.js fails), resolves composites, punches
  holes, and reassembles the sfnt rewriting **only** glyf/loca (+ minimal
  head/maxp patches). Untouched glyphs keep their original bytes including
  hinting; glyph IDs and widths are preserved exactly, which the PDF's
  CID-to-GID mapping depends on. **A rewritten glyph keeps its original
  header `xMin`** — never recompute it. hmtx is copied through untouched and
  rasterizers seat a glyph by translating it `(lsb − xMin)` (FreeType does,
  so most PDF viewers do), so a recomputed `xMin` slides that glyph sideways
  and only that one: round-sided letters drift while stems stay put, which
  looks like broken letter spacing. Takes an optional `keepGlyphs` set (used
  when embedding installed fonts): glyphs outside it are written empty —
  ids and hmtx metrics survive, outlines vanish — after expanding the set
  over composite components. Also exports `mapUnicodesToGlyphs` (cmap
  formats 4/12) for building such sets.
- [src/lib/cff.ts](src/lib/cff.ts) — CFF "charstring surgeon" for PDF-embedded CFF fonts
  (`FontFile3`, subtypes Type1C/CIDFontType0C/OpenType): interprets Type 2
  charstrings (subrs, hintmask, flex) into contours, punches holes, re-emits
  charstrings, and rebuilds the CFF container while copying
  charset/encoding/FDSelect/subrs byte-for-byte, so glyph IDs, CID mappings
  and text encoding survive. Glyphs using unsupported features (seac,
  arithmetic ops) keep their original bytes. `ecoProcessSfnt` handles full
  OpenType wrappers by swapping the CFF table (or delegating to the glyf
  surgeon for glyf-flavored ones).
- [src/lib/type1.ts](src/lib/type1.ts) — Type 1 "charstring surgeon" for legacy PostScript
  fonts (`FontFile`): splits clear/eexec/trailer segments, decrypts,
  interprets Type 1 charstrings (subrs, OtherSubrs flex + hint replacement),
  punches holes, splices only the charstring bytes back into the PostScript
  source, and re-encrypts. hsbw/sbw sidebearings are preserved verbatim;
  glyphs using seac or unknown OtherSubrs keep their original bytes.
- [src/lib/pdf.ts](src/lib/pdf.ts) — PDF plumbing via pdf-lib (dynamically imported): finds
  every unique `FontFile2`/`FontFile3`/`FontFile` stream referenced by a
  font descriptor, decodes it (`decodePDFRawStream`), runs the matching
  surgeon (sniffing bytes, not trusting the declared subtype), re-embeds via
  `context.flateStream` (+ `Length1` for TrueType, `Length1/2/3` for Type 1,
  preserved `Subtype` for FontFile3), and saves. Nothing else in the
  document is modified. Descriptors with **no** font program (Word exports
  leave system fonts out) are filled from the user's installed fonts when a
  `LocalFontResolver` is supplied: only for descriptors whose referencing
  font dicts are all simple `TrueType` (CID fonts depend on the original
  file's glyph order), matched by PostScript name, TTC faces extracted,
  optimized by the matching surgeon and attached as `FontFile2` (or
  `FontFile3`/`OpenType` for OTTO faces). When every referencing dict uses
  plain `WinAnsiEncoding` and the face is non-symbolic, the embedded copy
  is subset via `keepGlyphs` (all cp1252-reachable glyphs, ~220 of
  thousands); any other encoding embeds the full face — never guess a
  char→glyph mapping we can't reproduce. Unmatched or unsupported
  non-embedded fonts become warnings, not errors.
- [src/lib/localFonts.ts](src/lib/localFonts.ts) — main-thread wrapper for the Local Font
  Access API (Chromium-only). `requestLocalFonts()` **must be called from
  the Optimize click handler** — the permission prompt needs the click's
  transient user activation — and returns a `LocalFontResolver` (or null:
  unsupported browser / permission denied, both non-fatal). The resolver is
  handed through the worker protocol and called only when a PDF actually
  references non-embedded fonts.
- [src/lib/clipper-lib.d.ts](src/lib/clipper-lib.d.ts) — hand-written types for the parts of
  `clipper-lib` we use (the package ships none).

### Processing pipeline (per glyph)

1. Snapshot **all** glyph paths before mutating any — composite glyphs
   (accents) resolve component outlines lazily.
2. Flatten M/L/Q/C/Z commands to polygons (Clipper needs integers; font units
   are scaled by 100).
3. Union with the nonzero fill rule to normalize winding.
4. Inset the shape by a minimum "wall" thickness (ClipperOffset, negative
   delta) so holes never notch the glyph silhouette.
5. Intersect a globally-aligned staggered grid of octagonal holes with the
   inset interior, then subtract the result from the full glyph.
6. If no holes fit (thin glyph, empty inset), keep the original curved path.

Hole radius is solved from the slider value so the *measured* ink-area
reduction tracks the chosen percentage (a calibration factor compensates for
area the wall protection preserves). Tuning constants live at the top of
[src/lib/ecofont.ts](src/lib/ecofont.ts).

## Known limitations / gotchas

- **opentype.js writes CFF-flavored OpenType** (`OTTO` sfnt), not glyf-based
  TrueType. The output installs and renders everywhere; original filenames
  and extensions are preserved (`.woff`/`.woff2` inputs get the rewritten
  sfnt re-wrapped into their original container).
- **GSUB and variation tables (fvar/avar/cvar/gvar/stat) are dropped**
  before writing. opentype.js throws on GSUB lookup types it can't serialize
  (e.g. type 7 in Arial) and on fvar axis values that overflow its 16.16
  encoder (e.g. Sitka, Segoe UI Variable); the variation tables would be
  invalid anyway since the rewritten outlines are the default instance only.
  Ligatures and variation axes are lost; outlines and metrics are unaffected.
  Variable inputs produce a `warnings` entry in the pipeline result.
- The `.ttf`/`.zip` paths still go through opentype.js, which parses sfnt
  and WOFF natively but **not WOFF2** — those bytes must be decompressed
  first (webfont.ts does this in the pipeline).
- **Never statically import opentype.js from component code.** Astro's
  prerender pass loads modules in plain Node, where opentype.js resolves as
  CJS and its named ESM imports crash the build (`vite.ssr.noExternal` does
  not help the prerender chunks). Reach it through the dynamically imported
  pipeline instead.
- Variable fonts lose their variation tables (opentype.js rewrites only the
  default instance); the static instances usually shipped alongside them
  process fine.
- Output files grow (curves become line segments); that is inherent to the
  approach.
- **PDFs:** all embedded font formats are rewritten — `FontFile2`
  (TrueType), `FontFile3` (CFF/OpenType), and `FontFile` (legacy Type 1).
  Text drawn with non-embedded viewer fonts is optimized by embedding the
  user's installed copy (Chrome/Edge only — Local Font Access API, with a
  one-time permission prompt on Optimize when the batch has PDFs); in other
  browsers, when permission is denied, when no installed font matches the
  PostScript name, or for non-embedded CID/Type 1 fonts, that text stays
  unoptimized and a warning explains why. Per-glyph
  and per-font failures degrade gracefully (original bytes kept, warning
  shown). Encrypted PDFs are rejected by pdf-lib at load time. The
  `.ttf`/`.zip` paths still go through opentype.js (CFF output); the PDF
  path uses the binary surgeons.

## Testing

There is no test runner wired up yet. The lib layer is deliberately
DOM-free: bundle a scratch script with the repo's own esbuild
(`node_modules\.bin\esbuild.cmd entry.mjs --bundle --platform=node
--format=esm`) and run it in Node against a system font (e.g.
`C:\Windows\Fonts\arial.ttf`) to exercise parse → holes → re-compile →
re-parse round trips.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
