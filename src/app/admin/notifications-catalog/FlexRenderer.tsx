"use client";

// Generic LINE Flex "bubble" → HTML renderer. Interprets the subset of Flex
// our card builders use (box / text / separator / button / image) so the
// notification catalog can preview EVERY card design from one component
// (owner 2026-06-24). Not pixel-perfect to LINE, but close enough to review
// wording + layout before anything is sent.

type Node = Record<string, unknown>;

const SIZE_PX: Record<string, number> = {
  xxs: 9, xs: 11, sm: 13, md: 15, lg: 18, xl: 21, xxl: 25, "3xl": 30, "4xl": 36, "5xl": 42
};
const SPACE_PX: Record<string, number> = { none: 0, xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 20 };
const px = (v: unknown, map: Record<string, number>, dflt = 0): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (v.endsWith("px")) return parseFloat(v) || dflt;
    if (v in map) return map[v];
  }
  return dflt;
};
const alignToText = (a: unknown): "left" | "center" | "right" =>
  a === "center" ? "center" : a === "end" ? "right" : "left";

function FlexText({ node }: { node: Node }) {
  const size = SIZE_PX[(node.size as string) ?? "md"] ?? 15;
  const style: React.CSSProperties = {
    fontSize: size,
    fontWeight: node.weight === "bold" ? 700 : 400,
    color: (node.color as string) ?? "#111111",
    textAlign: alignToText(node.align),
    flexGrow: typeof node.flex === "number" ? (node.flex as number) : undefined,
    flexBasis: typeof node.flex === "number" && (node.flex as number) > 0 ? 0 : undefined,
    whiteSpace: node.wrap ? "normal" : "nowrap",
    overflow: "hidden",
    lineHeight: 1.3
  };
  return <div style={style}>{String(node.text ?? "")}</div>;
}

function FlexButton({ node }: { node: Node }) {
  const action = (node.action as Node) ?? {};
  const color = (node.color as string) ?? "#1a2b50";
  const primary = node.style === "primary";
  return (
    <div style={{
      marginTop: px(node.margin, SPACE_PX, 4),
      background: primary ? color : "transparent",
      border: primary ? "none" : `1px solid ${color}`,
      color: primary ? "#ffffff" : color,
      borderRadius: 8, padding: "7px 10px", textAlign: "center",
      fontSize: 13, fontWeight: 700
    }}>{String(action.label ?? "ปุ่ม")}</div>
  );
}

function FlexBox({ node }: { node: Node }) {
  const layout = (node.layout as string) ?? "vertical";
  const horizontal = layout === "horizontal" || layout === "baseline";
  const contents = (node.contents as Node[]) ?? [];
  const pad = px(node.paddingAll, SPACE_PX, 0);
  const gap = px(node.spacing, SPACE_PX, 0);
  const style: React.CSSProperties = {
    display: "flex",
    flexDirection: horizontal ? "row" : "column",
    alignItems: layout === "baseline" ? "baseline" : horizontal ? "center" : "stretch",
    gap,
    padding: pad || undefined,
    paddingTop: node.paddingTop ? px(node.paddingTop, SPACE_PX) : undefined,
    paddingBottom: node.paddingBottom ? px(node.paddingBottom, SPACE_PX) : undefined,
    background: (node.backgroundColor as string) ?? undefined,
    borderRadius: node.cornerRadius ? px(node.cornerRadius, SPACE_PX, 8) : undefined,
    marginTop: px(node.margin, SPACE_PX, 0),
    flexGrow: typeof node.flex === "number" ? (node.flex as number) : undefined
  };
  return <div style={style}>{contents.map((c, i) => <FlexNode key={i} node={c} />)}</div>;
}

function FlexNode({ node }: { node: Node }) {
  switch (node.type) {
    case "box": return <FlexBox node={node} />;
    case "text": return <FlexText node={node} />;
    case "button": return <FlexButton node={node} />;
    case "separator":
      return <div style={{ borderTop: `1px solid ${(node.color as string) ?? "#eeeeee"}`, marginTop: px(node.margin, SPACE_PX, 4), marginBottom: 2 }} />;
    case "image":
      return <div style={{ marginTop: px(node.margin, SPACE_PX, 4), height: 64, background: "#f1f5f9", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#94a3b8" }}>[รูป/QR]</div>;
    default: return null;
  }
}

/** Render a Flex bubble (the `.contents` of a flex message). */
export default function FlexRenderer({ bubble }: { bubble: Node }) {
  const sizeW: Record<string, number> = { nano: 180, micro: 220, kilo: 260, mega: 300, giga: 340 };
  const width = sizeW[(bubble.size as string) ?? "mega"] ?? 300;
  const parts: Array<["header" | "hero" | "body" | "footer", Node]> = [];
  for (const k of ["header", "hero", "body", "footer"] as const) {
    if (bubble[k]) parts.push([k, bubble[k] as Node]);
  }
  return (
    <div style={{ width, background: "#ffffff", borderRadius: 14, overflow: "hidden", boxShadow: "0 6px 20px rgba(0,0,0,0.12)", border: "1px solid rgba(0,0,0,0.06)" }}>
      {parts.map(([k, box]) => <FlexBox key={k} node={box} />)}
    </div>
  );
}
