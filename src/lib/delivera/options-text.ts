// Pure (no DB) so client components can show the options of an order line.

/** Human text of a stored options_json snapshot, e.g. "ขนาด: Large · ความหวาน: 25%". Tolerates the legacy "{}" value. */
export function describeOptions(optionsJson: string | null | undefined): string {
  if (!optionsJson) return "";
  try {
    const j = JSON.parse(optionsJson) as { choices?: Array<{ group?: string; name?: string }> };
    if (!Array.isArray(j.choices) || j.choices.length === 0) return "";
    const byGroup = new Map<string, string[]>();
    for (const c of j.choices) { const g = c.group ?? ""; byGroup.set(g, [...(byGroup.get(g) ?? []), c.name ?? ""]); }
    return [...byGroup.entries()].map(([g, names]) => (g ? `${g}: ${names.join(", ")}` : names.join(", "))).join(" · ");
  } catch { return ""; }
}
