"use client";
export default function PrintButton() {
  return <button type="button" className="btn-primary text-sm" onClick={() => window.print()}>พิมพ์ / บันทึกเป็น PDF</button>;
}
