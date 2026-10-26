// Bundles one Node service into a single ESM file so container images need no node_modules.
import { build } from "esbuild";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: node scripts/bundle.mjs <entry> <outfile>");
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // pg optionally requires pg-native; we never use it.
  external: ["pg-native"],
  // Some CommonJS dependencies call require(); give the ESM bundle a real one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
