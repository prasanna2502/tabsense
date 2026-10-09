import { defineConfig } from 'wxt';
import { BRANDING } from './src/config/branding';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    // Product name comes from the branding module — the single place the
    // name lives in code (src/config/branding.ts).
    name: BRANDING.productName,
    description: BRANDING.tagline,
    // Minimal permissions, each justified in docs/permission-justifications.md.
    // Nothing else may be added without updating that document.
    // M2 adds `tabGroups`: applying an accepted grouping suggestion
    // names the Chrome tab group it creates — impossible without it.
    // (Reading group membership rides on `tabs`.) Nothing else added.
    permissions: ['tabs', 'sidePanel', 'storage', 'tabGroups'],
    // MV3 blocks WebAssembly instantiation by default; 'wasm-unsafe-eval'
    // is the one token MV3 accepts to allow it, and it covers only the
    // Wasm bundled in this package (no remote code). Required for the
    // Rust core (proposal §5).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: {
      default_title: BRANDING.productName,
    },
  },
});
