// ── Smart น้องฮูก — model catalogue + cost estimate (client + server safe) ──
//
// No db import here so the settings UI can render the model picker. Prices are
// LIST-PRICE ESTIMATES (USD per million tokens); the baht figures are
// ประมาณการ for the on-screen counter, not a billing source of truth.

export type OwlAiModel = {
  id: string;
  label: string;
  inUsdPerMtok: number;
  outUsdPerMtok: number;
};

export const OWL_AI_MODELS: OwlAiModel[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5 — ประหยัดสุด (คำถามง่ายๆ)",
    inUsdPerMtok: 1,
    outUsdPerMtok: 5
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6 — สมดุล",
    inUsdPerMtok: 3,
    outUsdPerMtok: 15
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8 — ฉลาดสุด (แนะนำสำหรับวิเคราะห์)",
    inUsdPerMtok: 5,
    outUsdPerMtok: 25
  }
];

// Default to the most capable model — it orchestrates the data tools most
// reliably. The owner can switch to Haiku/Sonnet from settings to save cost.
export const DEFAULT_OWL_AI_MODEL = "claude-opus-4-8";

const THB_PER_USD = 36;

export function owlAiModel(id: string | null | undefined): OwlAiModel {
  return OWL_AI_MODELS.find((m) => m.id === id)
    ?? OWL_AI_MODELS.find((m) => m.id === DEFAULT_OWL_AI_MODEL)
    ?? OWL_AI_MODELS[OWL_AI_MODELS.length - 1];
}

/** Estimated baht cost of one question given token counts. */
export function owlAiCostBaht(modelId: string | null | undefined, inTok: number, outTok: number): number {
  const m = owlAiModel(modelId);
  const usd = (inTok / 1e6) * m.inUsdPerMtok + (outTok / 1e6) * m.outUsdPerMtok;
  return Math.round(usd * THB_PER_USD * 100) / 100;
}
