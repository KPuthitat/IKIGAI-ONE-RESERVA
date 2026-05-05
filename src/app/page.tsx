import { redirect } from "next/navigation";

// Root: ส่งไป login (พนักงาน/แอดมิน เข้าที่นี่ — ลูกค้าจองที่ /reserva)
export default function RootPage() {
  redirect("/login");
}
