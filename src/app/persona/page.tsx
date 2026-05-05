import { redirect } from "next/navigation";

// /persona — ทางลัดไปยัง /staff/persona (ลงเวลา)
export default function PersonaShortcut() {
  redirect("/staff/persona");
}
