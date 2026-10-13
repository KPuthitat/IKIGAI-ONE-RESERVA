// Nong Plara's greeting on the home pages: the pose and line follow the Bangkok hour.
// Wording is deliberately neutral (no gendered particles).
import type { MascotPose } from "@/app/components/Mascot";

export type Greeting = { pose: MascotPose; text: string };

export function greetingForHour(hour: number): Greeting {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return { pose: "thumbs", text: "สวัสดีตอนเช้า วันนี้สู้ไปด้วยกันนะ" };
  if (h >= 11 && h < 14) return { pose: "drumstick", text: "ได้เวลาพักทานข้าวแล้ว อย่าลืมกินนะ" };
  if (h >= 14 && h < 18) return { pose: "proud", text: "ช่วงบ่ายแล้ว ลุยต่ออีกนิด!" };
  if (h >= 18 && h < 22) return { pose: "cheer", text: "ใกล้เลิกงานแล้ว วันนี้เก่งมาก" };
  return { pose: "notes", text: "ดึกแล้ว อย่าลืมพักผ่อนนะ" };
}

/** Current hour in Bangkok (UTC+7), independent of the server's time zone. */
export function bangkokHour(now: number = Date.now()): number {
  return new Date(now + 7 * 3600_000).getUTCHours();
}
