// Server-side language helpers — อ่าน cookie แล้วคืน Lang
// ใช้ใน server components เท่านั้น
import { cookies } from "next/headers";
import { type Lang, SUPPORTED_LANGS, DEFAULT_LANG } from "./i18n";

export function getLang(): Lang {
  const c = cookies().get("lang")?.value;
  if (c && SUPPORTED_LANGS.includes(c as Lang)) return c as Lang;
  return DEFAULT_LANG;
}
