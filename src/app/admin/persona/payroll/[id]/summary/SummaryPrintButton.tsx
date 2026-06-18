"use client";

// Print/save-as-PDF trigger for the whole-period compensation summary
// (owner 2026-06-18 — one PDF of every employee in the pay run, for the
// accounting office). Same window.print() mechanism as the single payslip.
export default function SummaryPrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="btn-secondary text-sm">
      บันทึก PDF / พิมพ์
    </button>
  );
}
