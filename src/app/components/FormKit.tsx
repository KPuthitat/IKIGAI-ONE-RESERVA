// Mobile-form building blocks (owner 2026-08 — "เนี้ยบแบบ PGH", coffee palette).
//
//   <FormSection title="ข้อมูลลูกค้า"> … </FormSection>
//     A dot-marked heading + hairline divider grouping related fields.
//
//   <Field label="ชื่อลูกค้า" hint="ถ้ามี"><input … /></Field>
//     A rounded box with the field name inside at the top and the control
//     flush beneath. Pass a BARE control (no `.input` class) — the `.field`
//     CSS in globals.css styles the input/select/textarea inside it.
//
// Both are presentational (no hooks) so they work in server or client trees.

import type { ReactNode } from "react";

export function FormSection({
  title, action, children, className
}: {
  title: string;
  /** Optional right-aligned control in the header row (e.g. a small link). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-center gap-2.5 pb-2.5 mb-3.5 border-b border-[#F0E8DA]">
        <span className="w-2.5 h-2.5 rounded-full bg-brand shrink-0" aria-hidden />
        <h3 className="flex-1 text-[15px] font-bold text-slate-800 leading-tight">{title}</h3>
        {action}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function Field({
  label, hint, htmlFor, children, className
}: {
  label: string;
  hint?: ReactNode;
  /** When set, the whole box is a <label for=…> (use for a single control). */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const cls = `field ${className ?? ""}`.trim();
  const inner = (
    <>
      <span className="field-label">
        {label}
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      {children}
    </>
  );
  // A <label> wrapping the control gives a big tap target; when no htmlFor is
  // given the implicit association still works for a single nested control.
  return htmlFor
    ? <label htmlFor={htmlFor} className={cls}>{inner}</label>
    : <label className={cls}>{inner}</label>;
}
