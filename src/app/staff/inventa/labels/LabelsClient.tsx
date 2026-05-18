"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PICK_FREQ_META, type PickFreq } from "@/lib/inventa";

export type LabelItem = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
};

// QR generator loaded from CDN (same no-dependency pattern as the
// camera scanner) so deploy stays a plain build.
const CDN = "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js";
type QRCodeLib = {
  toDataURL: (text: string, opts?: Record<string, unknown>) => Promise<string>;
};
function getQR(): QRCodeLib | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { QRCode?: QRCodeLib }).QRCode;
}

export default function LabelsClient({ items }: { items: LabelItem[] }) {
  const printable = useMemo(
    () => items.filter((i) => (i.item_code || i.barcode)),
    [items]
  );
  const skipped = items.length - printable.length;

  const [urls, setUrls] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (typeof document !== "undefined" && !document.querySelector("script[data-qr]")) {
      const s = document.createElement("script");
      s.src = CDN; s.async = true; s.setAttribute("data-qr", "1");
      document.head.appendChild(s);
    }
    let cancelled = false;
    let tries = 0;
    const poll = setInterval(async () => {
      if (cancelled) return;
      tries += 1;
      const QR = getQR();
      if (!QR) {
        if (tries > 40) { clearInterval(poll); setStatus("error"); }
        return;
      }
      clearInterval(poll);
      try {
        const map: Record<number, string> = {};
        for (const it of printable) {
          const code = (it.item_code || it.barcode) as string;
          map[it.id] = await QR.toDataURL(code, { margin: 1, width: 200 });
          if (cancelled) return;
        }
        if (!cancelled) { setUrls(map); setStatus("ready"); }
      } catch {
        if (!cancelled) setStatus("error");
      }
    }, 250);
    return () => { cancelled = true; clearInterval(poll); };
  }, [printable]);

  return (
    <>
      <div className="card no-print flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-600">
          พร้อมพิมพ์ <b>{printable.length}</b> ดวง
          {skipped > 0 && (
            <span className="text-amber-700">
              {" "}· ข้าม {skipped} (ไม่มีรหัสสินค้า/บาร์โค้ด)
            </span>
          )}
          {status === "loading" && <span className="text-slate-400"> · กำลังสร้างคิวอาร์...</span>}
          {status === "error" && <span className="text-rose-600"> · สร้างคิวอาร์ไม่สำเร็จ ลองรีเฟรช</span>}
        </div>
        <button type="button"
          onClick={() => window.print()}
          disabled={status !== "ready"}
          className="text-sm px-5 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
          พิมพ์ / บันทึก PDF
        </button>
      </div>

      <div className="printable">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {printable.map((i) => {
            const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
            return (
              <div key={i.id}
                className="border border-slate-300 rounded-lg p-2 flex flex-col items-center text-center break-inside-avoid">
                {urls[i.id]
                  ? <img src={urls[i.id]} alt={i.item_code ?? ""}
                      className="w-28 h-28" />
                  : <div className="w-28 h-28 bg-slate-100 rounded" />}
                <div className="mt-1 text-[11px] font-mono text-slate-700 break-all">
                  {i.item_code || i.barcode}
                </div>
                <div className="text-xs font-medium text-slate-800 leading-tight line-clamp-2">
                  {i.name}
                </div>
                {fm && (
                  <span title={fm.label}
                    className={`mt-1 w-3 h-3 rounded-full ${fm.dot}`} />
                )}
              </div>
            );
          })}
        </div>
        {printable.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-10 no-print space-y-2">
            <p className="font-medium text-slate-600">ยังไม่มีคิวอาร์โค้ดให้พิมพ์</p>
            <p className="text-xs leading-relaxed max-w-md mx-auto">
              หน้านี้จะสร้างคิวอาร์โค้ดให้อัตโนมัติ <b>เฉพาะรายการที่กรอก
              “รหัสสินค้า” หรือ “บาร์โค้ด” ไว้แล้ว</b> — ไปที่เมนู “คลังสินค้า”
              เพิ่ม/แก้รายการแล้วใส่รหัสสินค้า จากนั้นกลับมาหน้านี้เพื่อสั่งพิมพ์
              สติกเกอร์ติดชั้นวาง/บรรจุภัณฑ์
            </p>
            <Link href="/staff/inventa"
              className="inline-block mt-1 text-brand font-bold hover:underline">
              ไปที่คลังสินค้า →
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
