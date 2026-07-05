const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The 1 GB prod droplet OOM-kills `next build` during its type-check/lint
  // phase (2026-07-05: "…checking validity of types ..Killed"). Skip both ON
  // THE SERVER — they're redundant there:
  //   • CI runs `npm run check:types` (tsc --noEmit) on every push, green before
  //     deploy (owner standard).
  //   • Route-export validity is caught by a full local `npm run build` before
  //     pushing route changes.
  // Keeps the server build light enough to fit in RAM. Gated on LIGHT_BUILD so
  // ONLY the deploy (scripts/deploy.sh sets LIGHT_BUILD=1) skips them — a local
  // `npm run build` still runs the full type-check + route-export validation.
  typescript: { ignoreBuildErrors: process.env.LIGHT_BUILD === '1' },
  eslint: { ignoreDuringBuilds: process.env.LIGHT_BUILD === '1' },
  // basePath ไม่ใช้แล้ว — host ที่ root /
  experimental: {
    // pdfkit is server-only (INVENTA PO PDF). Marking it external keeps
    // Next from bundling it — pdfkit ships AFM font-metric data files it
    // loads via require at runtime, which webpack can't trace.
    serverComponentsExternalPackages: ['better-sqlite3', 'pdfkit']
  },
  // เก็บเวลา build ไว้ใน env เพื่อแสดงใน footer (last update)
  // NEXT_PUBLIC_BUILD_TIME = ค่า env ที่ส่งมาจาก deploy script ถ้ามี, ไม่งั้นใช้เวลาตอน build
  env: {
    NEXT_PUBLIC_BUILD_TIME: process.env.BUILD_TIME || new Date().toISOString(),
    NEXT_PUBLIC_APP_VERSION: process.env.APP_VERSION || '1.0.0'
  },
  webpack: (config) => {
    config.resolve.alias['@'] = path.join(__dirname, 'src');
    return config;
  }
};
module.exports = nextConfig;
