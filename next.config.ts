import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The report engine's SQL parser (libpg-query) loads its WebAssembly from its
  // own folder at run time, so it is required from node_modules, not bundled,
  // and its files ship with the report routes.
  serverExternalPackages: ["libpg-query"],
  outputFileTracingIncludes: {
    "/api/reports/**": ["./node_modules/libpg-query/wasm/**/*"],
    // The PDF's typeface, read from disk while rendering.
    "/api/reports/runs/[runId]/pdf": [
      "./node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf",
      "./node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf",
    ],
  },
};

export default nextConfig;
