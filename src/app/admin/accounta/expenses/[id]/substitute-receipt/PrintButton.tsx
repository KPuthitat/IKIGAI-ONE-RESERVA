"use client";

// Print / save-as-PDF trigger for the substitute receipt. Same window.print()
// mechanism as the payslip; the global @media print rule shows only .printable.
export default function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="btn-secondary text-sm">
      บันทึก PDF / พิมพ์
    </button>
  );
}
