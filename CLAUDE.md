# Ecofonts

A 100% client-side font optimizer. Users upload a `.ttf` file, a `.zip` of
fonts, or a `.pdf` document; Ecofonts subtracts a grid of small vector holes
("eco holes") from the interior of every glyph so printing uses less ink,
then returns the modified file for download. For PDFs, every embedded
TrueType font in the document is optimized in place. No data ever leaves the
browser.

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
- **Landing → optimizer file handoff:** dropping a font on `/` stashes the
  `File` in IndexedDB ([src/lib/handoff.ts](src/lib/handoff.ts)) and navigates to `/font`, which
  takes it on mount and starts processing automatically. IndexedDB (not
  sessionStorage) because `File` objects survive structured cloning there
  and fonts can exceed string-storage quotas.
- **Strictly client-side processing.** There are no API routes, server
  endpoints, or serverless functions — all parsing, geometry, and packaging
  runs in the browser. Keep it that way.

### Source layout

- [src/components/FontOptimizer.tsx](src/components/FontOptimizer.tsx) — UI: drag-and-drop upload zone
  accepting **multiple files** (`.pdf`/`.zip`/`.ttf`), "Eco Intensity"
  slider (1–20%), batch + per-glyph progress, per-file download buttons plus
  "Download all", before/after canvas preview, per-file failure reporting.
  Files are processed sequentially; one failure never aborts the batch.
  Styled by [src/components/FontOptimizer.css](src/components/FontOptimizer.css) using the shared design
  tokens. Loads the pipeline with a dynamic `import()` on first use — this
  keeps the heavy libraries out of the initial bundle **and out of Astro's
  prerender pass** (see gotchas).
- [src/lib/limits.ts](src/lib/limits.ts) — single source of truth for selection validation,
  used by both the landing drop zone and the optimizer (they once drifted;
  don't duplicate the rules again). Per-selection maximums: 20 PDFs, 100
  `.ttf`, 5 `.zip`. **The maximums must not appear in regular UI copy** —
  only in the rejection message when a selection exceeds them.
- [src/lib/pipeline.ts](src/lib/pipeline.ts) — file-level routing: single `.ttf` vs `.zip`
  traversal with JSZip vs `.pdf`. Rewrites zip entries in place so the
  archive keeps its exact folder structure (e.g. Google Fonts `static/`
  folders); non-font files pass through untouched; per-file failures become
  warnings and the original file is kept.
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
  CID-to-GID mapping depends on.
- [src/lib/pdf.ts](src/lib/pdf.ts) — PDF plumbing via pdf-lib (dynamically imported): finds
  every unique `FontFile2` stream referenced by a font descriptor, decodes it
  (`decodePDFRawStream`), runs the glyf surgeon, re-embeds via
  `context.flateStream` + `Length1`, and saves. Nothing else in the document
  is modified.
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
  and extensions are preserved.
- **GSUB and variation tables (fvar/avar/cvar/gvar/stat) are dropped**
  before writing. opentype.js throws on GSUB lookup types it can't serialize
  (e.g. type 7 in Arial) and on fvar axis values that overflow its 16.16
  encoder (e.g. Sitka, Segoe UI Variable); the variation tables would be
  invalid anyway since the rewritten outlines are the default instance only.
  Ligatures and variation axes are lost; outlines and metrics are unaffected.
  Variable inputs produce a `warnings` entry in the pipeline result.
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
- **PDFs:** only `FontFile2` (TrueType) embedded fonts are rewritten —
  `FontFile` (Type 1) and `FontFile3` (CFF) fonts are kept as-is with a
  warning. Text drawn with non-embedded viewer fonts cannot be optimized.
  Encrypted PDFs are rejected by pdf-lib at load time. The `.ttf`/`.zip`
  paths still go through opentype.js (CFF output); only the PDF path uses
  the glyf surgeon, which outputs true TrueType.

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
