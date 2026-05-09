// Helper สำหรับ fetch — ตอนนี้ host ที่ root / ไม่มี basePath แล้ว
// เก็บ helper ไว้เผื่ออนาคตต้องรองรับ basePath ใหม่

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}
