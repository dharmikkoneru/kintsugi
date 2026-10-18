import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // PGlite ships WASM and its own data directory, so it must stay a runtime
  // dependency instead of being bundled by Turbopack.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
