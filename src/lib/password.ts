// แยกฟังก์ชัน hash/verify ออกจาก auth.ts เพื่อให้ scripts standalone (init-db, cron)
// import ใช้ได้โดยไม่ดึง next/headers
import bcrypt from "bcryptjs";

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}
