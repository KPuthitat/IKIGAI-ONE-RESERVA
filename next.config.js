const path = require('path');

/** @type {import('next').NextConfig} */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
const nextConfig = {
  reactStrictMode: true,
  basePath,
  // ป้องกัน asset prefix ผิดเวลา host ภายใต้ subpath
  assetPrefix: basePath || undefined,
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3']
  },
  webpack: (config) => {
    // explicit alias เผื่อ tsconfig paths บาง env ไม่ถูก pick up
    config.resolve.alias['@'] = path.join(__dirname, 'src');
    return config;
  }
};
module.exports = nextConfig;
