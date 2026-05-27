"use client";

// HTML approximation of LINE Flex card layout. NOT pixel-perfect —
// LINE's actual renderer applies device-specific font metrics and
// the bubble has a max-width that varies — but close enough that
// admin can spot wrapping issues + see the rough shape before
// hitting save. Mirrors the giga bubble + dark navy header + body
// box pattern used by every PERSONA card.

type BodyEntry =
  | { divider: true }
  | {
      text: string;
      color?: "dark" | "muted";
      size?: "xs" | "sm" | "md";
      weight?: "bold" | "normal";
    };

export type FlexPreviewProps = {
  header: {
    leftLabel: string;
    rightLabel: string;
    /** Big bold title on the second row of the header. */
    title: string;
  };
  body: BodyEntry[];
  /** Optional CTA button at the bottom. */
  buttonLabel?: string;
};

const COLOR_TEXT_DARK = "#1e293b";
const COLOR_TEXT_MUTED = "#64748b";
const COLOR_BRAND_LIGHT = "#fda4af";
const COLOR_INK_700 = "#1a1a2e";
const COLOR_DIVIDER = "#e2e8f0";

const SIZE_PX: Record<NonNullable<Extract<BodyEntry, { text: string }>["size"]>, number> = {
  xs: 12, sm: 14, md: 16
};

export default function FlexPreview({ header, body, buttonLabel }: FlexPreviewProps) {
  return (
    <div className="rounded-xl overflow-hidden border-[1.5px] border-slate-200 shadow-sm bg-white"
      style={{ maxWidth: 360 }}>
      {/* Header */}
      <div style={{ backgroundColor: COLOR_INK_700, padding: "20px" }}>
        <div className="flex items-center justify-between text-[11px] font-bold">
          <span style={{ color: COLOR_BRAND_LIGHT }}>{header.leftLabel}</span>
          <span style={{ color: "#cbd5e1", fontWeight: 400 }}>{header.rightLabel}</span>
        </div>
        <div className="text-white font-bold mt-3"
          style={{ fontSize: 18, lineHeight: 1.3 }}>
          {header.title}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "24px" }} className="space-y-3">
        {body.map((entry, i) => {
          if ("divider" in entry) {
            return <div key={i} style={{ borderTop: `1px solid ${COLOR_DIVIDER}`, marginTop: 12, marginBottom: 4 }} />;
          }
          const color = entry.color === "muted" ? COLOR_TEXT_MUTED : COLOR_TEXT_DARK;
          const fontSize = SIZE_PX[entry.size ?? "sm"];
          const fontWeight = entry.weight === "bold" ? 700 : 400;
          return (
            <div key={i} style={{ color, fontSize, fontWeight, lineHeight: 1.5, whiteSpace: "pre-line" }}>
              {entry.text}
            </div>
          );
        })}
      </div>

      {/* Footer button */}
      {buttonLabel && (
        <div style={{ padding: "12px" }}>
          <button type="button" disabled
            className="w-full font-bold text-white py-2.5 rounded-lg cursor-default opacity-90"
            style={{ backgroundColor: COLOR_INK_700, fontSize: 14 }}>
            {buttonLabel}
          </button>
        </div>
      )}
    </div>
  );
}

export type { BodyEntry };
