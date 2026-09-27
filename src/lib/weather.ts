// Best-effort weather forecast for the ANALYTICA forward plan (owner 2026-09-27).
// Uses Open-Meteo (free, no API key) keyed by the branch's lat/lon. Network is
// egress-gated in prod, so this NEVER throws: on any failure it returns {} and
// the forward plan simply shows no weather. (The Open-Meteo host must be on the
// environment's egress allow-list for this to return data in production.)

import type { ForecastWeather } from "./forecast";

function summarize(tempMax: number | null, rain: number | null): string {
  const parts: string[] = [];
  if (rain != null && rain >= 60) parts.push("ฝนน่าจะตก");
  else if (rain != null && rain >= 30) parts.push("อาจมีฝน");
  if (tempMax != null && tempMax >= 35) parts.push("ร้อนจัด");
  else if (tempMax != null && tempMax >= 33) parts.push("ค่อนข้างร้อน");
  return parts.length ? parts.join(" · ") : "อากาศปกติ";
}

export async function fetchBranchWeather(lat: number, lon: number, days: number): Promise<Record<string, ForecastWeather>> {
  const n = Math.min(16, Math.max(1, days));
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FBangkok&forecast_days=${n}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return {};
    const j = await res.json() as { daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] } };
    const d = j.daily;
    if (!d?.time?.length) return {};
    const out: Record<string, ForecastWeather> = {};
    for (let i = 0; i < d.time.length; i++) {
      const tempMax = d.temperature_2m_max?.[i] ?? null;
      const tempMin = d.temperature_2m_min?.[i] ?? null;
      const rainChance = d.precipitation_probability_max?.[i] ?? null;
      out[d.time[i]] = { tempMax, tempMin, rainChance, summary: summarize(tempMax, rainChance) };
    }
    return out;
  } catch {
    return {};   // blocked host / timeout / bad JSON → no weather, plan still works
  } finally {
    clearTimeout(timer);
  }
}
