"use client";

import { useRouter } from "next/navigation";
import PinPromptModal from "@/app/components/PinPromptModal";
import { apiUrl } from "@/lib/url";

// The PIN gate shown before entering the admin console (owner 2026-09-21).
// On a correct PIN, /api/auth/unlock-admin sets the httpOnly unlock cookie and
// os_view=admin, then we forward to `next`. Cancelling drops to staff view.
export default function AdminUnlockClient({ next }: { next: string }) {
  const router = useRouter();

  async function submit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await fetch(apiUrl("/api/auth/unlock-admin"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { ok: false, message: j.error ?? "wrong_pin" };
    router.replace(next);
    router.refresh();
    return { ok: true };
  }

  return (
    <div className="min-h-screen bg-[#F6F0E5]">
      <PinPromptModal
        title="เข้าสู่มุมมองผู้ดูแลระบบ"
        description={<>ใส่ PIN 4 หลักของคุณเพื่อเข้าโหมดผู้ดูแลระบบ · กด &quot;ยกเลิก&quot; เพื่ออยู่ในมุมมองพนักงาน</>}
        submitLabel="เข้าสู่ผู้ดูแลระบบ"
        onSubmit={submit}
        onClose={() => { router.replace("/staff"); router.refresh(); }}
      />
    </div>
  );
}
