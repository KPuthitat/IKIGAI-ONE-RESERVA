"use client";

export default function PrintButton({ label = "สั่งพิมพ์ A4" }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()}
      className="rounded-xl px-5 py-3 text-base font-bold text-white shadow-md"
      style={{ background: "linear-gradient(100deg,#1CC4B1,#0FA596)" }}>
      🖨️ {label}
    </button>
  );
}
