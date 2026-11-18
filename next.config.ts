import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The per-request Content-Security-Policy and the other security headers are
  // set by the Proxy (lib/supabase/proxy-session.ts), which runs on every page
  // and API request and holds the CSP nonce. HSTS is set here instead so it
  // also covers the static assets the Proxy's matcher skips. Sent only in
  // production: browsers ignore it over plain-HTTP localhost anyway.
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
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
