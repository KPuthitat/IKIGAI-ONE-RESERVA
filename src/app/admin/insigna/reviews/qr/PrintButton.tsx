"use client";

export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-bold text-white print:hidden"
    >
      พิมพ์ทั้งหมด
    </button>
  );
}
