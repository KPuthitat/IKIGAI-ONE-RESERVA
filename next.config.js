const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // basePath ไม่ใช้แล้ว — host ที่ root /
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3']
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
