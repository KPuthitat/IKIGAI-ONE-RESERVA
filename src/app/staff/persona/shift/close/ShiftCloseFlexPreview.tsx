"use client";

// HTML approximation of the LINE Flex card that will be POSTed to
// the staff group when this shift_close report submits. Sits inside
// the form so the staff (or admin testing) can see exactly what'll
// land in the chat before they hit "ส่งรายงาน".
//
// The component does NOT call line.ts — it independently mirrors
// the layout shiftCloseFlex() builds server-side. They MUST stay
// visually in sync; if the real card changes, update both. This
// trade-off is deliberate: server-rendering Flex JSON → live HTML
// preview is a big abstraction that fragments easily, while two
// small files with parallel layouts are easy to inspect side by
// side.
//
// Rendered scope: the headline block (red box) + branch/date/sender
// + the body checklist. Skips the footer, which is just the IKIGAI
// OS brand strip and never changes.

type DefaultField = {
  key: "closing_drawer" | "service_charge" | "daily_revenue";
  amount: number | null;
  label: string;
  display_order: number;
  in_red_box: boolean;
};

type ChecklistRow = {
  label: string;
  checked: boolean;
  note: string | null;
  kind?: "checkbox" | "text" | "choice" | "amount" | "section";
};

export default function ShiftCloseFlexPreview({
  branchName,
  closerName,
  reportDate,
  defaultFields,
  checklist
}: {
  branchName: string;
  closerName: string;
  reportDate: string; // YYYY-MM-DD
  defaultFields: DefaultField[];
  checklist: ChecklistRow[];
}) {
  // Format the same way line.ts does — locale='th-TH' with up to 2
  // decimals, no fixed minimum so "23000" reads "23,000" not
  // "23,000.00".
  function fmt(n: number): string {
    return n.toLocaleString("th-TH", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  }
  function formatThaiDate(iso: string): string {
    try {
      const [y, m, d] = iso.split("-").map(Number);
      const months = [
        "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
        "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"
      ];
      return `${d} ${months[m - 1]} ${y + 543}`;
    } catch { return iso; }
  }

  // Order-sorted headlines = fields with amount != null AND in_red_box.
  const headlines = [...defaultFields]
    .filter((f) => f.amount != null && f.in_red_box)
    .sort((a, b) => a.display_order - b.display_order);

  // Non-headline defaults appear in the checklist body as bold rows.
  const inBodyDefaults = [...defaultFields]
    .filter((f) => f.amount != null && !f.in_red_box)
    .sort((a, b) => a.display_order - b.display_order);

  // Visible checklist rows = exclude section dividers from this
  // mini-preview to keep it tight. Server-side card includes them.
  const visibleChecklist = checklist.filter((c) => c.kind !== "section");

  const anyData =
    defaultFields.some((f) => f.amount != null) ||
    visibleChecklist.some((c) => c.checked || (c.note && c.note.trim()));

  if (!anyData) {
    return (
      <div className="card bg-slate-50 border-dashed border-slate-300 text-center text-xs text-slate-500 py-6">
        🦉 พิมพ์ยอดและทำเครื่องหมายเช็คลิสต์เพื่อดูตัวอย่างการ์ดที่จะส่งเข้ากลุ่ม
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wider font-bold text-slate-500">
          🦉 ตัวอย่างการ์ดที่จะส่งเข้ากลุ่ม LINE
        </h3>
        <span className="text-[10px] text-slate-400">ปรับ live ตามที่พิมพ์</span>
      </div>

      {/* Mocked LINE chat strip — gives the preview a familiar
          "this is what staff will see" context. */}
      <div className="bg-slate-100 rounded-lg p-3">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-full bg-rose-200 flex items-center justify-center text-[10px] font-bold text-rose-700">
            IO
          </div>
          <span className="text-[10px] font-bold text-slate-600">IKIGAI OS</span>
        </div>

        <div className="bg-white rounded-2xl rounded-tl-md shadow-sm overflow-hidden max-w-[360px]">
          {/* Header — same dark navy as the real Flex bubble */}
          <div className="bg-[#1a1a2e] text-white px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-rose-300 tracking-wide">IKIGAI OS</span>
              <span className="text-[10px] text-slate-300">PERSONA • STAFF</span>
            </div>
            <div className="text-base font-bold mt-1">Check list หลังเลิกงาน</div>
          </div>

          {/* Body */}
          <div className="p-4 space-y-3">
            <div>
              <div className="text-sm font-bold text-slate-800">{branchName}</div>
              <div className="text-[10px] text-slate-500">{formatThaiDate(reportDate)}</div>
            </div>

            <div className="border-t border-slate-200" />

            <div className="text-xs">
              <div className="flex justify-between text-slate-500">
                <span>ผู้ส่งรายการ</span>
                <span className="font-bold text-slate-700">{closerName}</span>
              </div>
            </div>

            {/* Red headline box — same coral background as the real
                card. First entry renders biggest. */}
            {headlines.length > 0 && (
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 space-y-2">
                {headlines.map((h, i) => (
                  <div key={h.key}>
                    <div className="text-[10px] text-rose-700">{h.label}</div>
                    <div
                      className={`text-rose-600 font-bold leading-tight ${
                        i === 0 ? "text-xl" : "text-base"
                      }`}
                    >
                      {fmt(h.amount!)} <span className="text-[10px] font-medium">บาท</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* In-body bold defaults (the ones with in_red_box=false). */}
            {inBodyDefaults.length > 0 && (
              <div className="space-y-1.5 text-xs">
                {inBodyDefaults.map((d) => (
                  <div key={d.key} className="flex items-center justify-between">
                    <span className="text-slate-600">{d.label}</span>
                    <span className="font-bold text-slate-800">
                      {fmt(d.amount!)} <span className="text-[10px] font-normal">บาท</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Custom checklist body — render the same checked/unchecked
                rows the server-side card shows. Capped at 8 visible
                with a "+N more" footer to keep the preview compact. */}
            {visibleChecklist.length > 0 && (
              <div className="border-t border-slate-200 pt-2 space-y-1">
                {visibleChecklist.slice(0, 8).map((c, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="mt-0.5 text-[10px]">
                      {c.checked ? "✅" : "⬜"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span
                        className={`${c.checked ? "text-slate-700" : "text-slate-400"}`}
                      >
                        {c.label}
                      </span>
                      {c.note && c.note.trim() && (
                        <div className="text-[10px] text-slate-500 italic mt-0.5">
                          {c.note}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {visibleChecklist.length > 8 && (
                  <div className="text-[10px] text-slate-400 font-bold">
                    + อีก {visibleChecklist.length - 8} ข้อ
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer brand strip — purely cosmetic, matches the real
              card's "IKIGAI OS" attribution. */}
          <div className="bg-slate-50 text-center py-2 border-t border-slate-200">
            <span className="text-[9px] font-bold text-slate-400 tracking-widest">
              IKIGAI OS
            </span>
          </div>
        </div>
      </div>

      <p className="text-[10px] text-slate-400 leading-snug">
        * ตัวอย่างนี้เป็นภาพประมาณการในระบบเว็บ — การ์ดจริงใน LINE
        อาจคลาดเคลื่อนเล็กน้อยตามขนาดหน้าจอผู้รับ
      </p>
    </div>
  );
}
