// Helper สำหรับเติม basePath ให้ URL ที่เรียกผ่าน fetch / <a href> ฝั่ง client
// next/link และ next/router จัดการ basePath ให้อัตโนมัติ — ไม่ต้องใช้ helper นี้
// แต่ fetch('/api/...') ต้องเติม basePath เอง เพราะ Next ไม่ rewrite URL ใน fetch

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/** prepend basePath ให้ URL absolute path (e.g. apiUrl('/api/foo') -> '/reserva/api/foo') */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  return `${BASE_PATH}${path}`;
}
