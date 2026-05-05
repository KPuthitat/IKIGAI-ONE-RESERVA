/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const nextConfig = {
  reactStrictMode: true,
  basePath,
  // ป้องกัน asset prefix ผิดเวลา host ภายใต้ subpath
  assetPrefix: basePath || undefined,
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3']
  }
};
module.exports = nextConfig;
