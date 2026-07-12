// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://ecofonts.github.io',
  integrations: [react(), sitemap()],
  vite: {
    optimizeDeps: {
      // Pre-bundle the font-processing libraries at dev-server startup.
      // They are only reached through a dynamic import(), so without this
      // Vite discovers them on first use, re-optimizes, and reloads the
      // page — aborting that first import with "Failed to fetch
      // dynamically imported module".
      include: ['opentype.js', 'jszip', 'clipper-lib', 'pdf-lib'],
    },
    worker: {
      // The pipeline worker keeps pdf-lib behind a dynamic import(); the
      // default iife format would inline it into the worker chunk and make
      // every user download it, PDFs or not.
      format: 'es',
    },
  },
});