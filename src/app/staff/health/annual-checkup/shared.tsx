"use client";

import { apiUrl } from "@/lib/url";

export const INTERP: Array<{ v: "normal" | "abnormal" | "follow_up"; th: string }> = [
  { v: "normal", th: "ปกติ" }, { v: "abnormal", th: "ผิดปกติ" }, { v: "follow_up", th: "ต้องติดตาม" }
];
export const INTERP_TH: Record<string, string> = { normal: "ปกติ", abnormal: "ผิดปกติ", follow_up: "ต้องติดตาม" };
export const STATUS_TH: Record<string, string> = { draft: "ร่าง", verified: "ตรวจสอบแล้ว", released: "เปิดผลแล้ว" };
export const STATUS_CLS: Record<string, string> = { draft: "bg-slate-100 text-slate-600", verified: "bg-sky-100 text-sky-700", released: "bg-emerald-100 text-emerald-700" };

export type ApiResult = { ok: boolean; message?: string; error?: string; [k: string]: unknown };

/** POST JSON to an annual-checkup route; never throws, always returns {ok, message?}. */
export async function post(path: string, body: unknown): Promise<ApiResult> {
  try {
    const r = await fetch(apiUrl(`/api/annual-checkup/${path}`), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}
export async function upload(orderId: number, file: File): Promise<ApiResult> {
  const f = new FormData(); f.set("orderId", String(orderId)); f.set("file", file);
  try { return await (await fetch(apiUrl("/api/annual-checkup/file/upload"), { method: "POST", body: f })).json(); }
  catch { return { ok: false, message: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }; }
}

export function Banner({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <div className={`rounded-lg px-4 py-2 text-sm border ${msg.ok ? "bg-emerald-50 text-emerald-800 border-emerald-200" : "bg-rose-50 text-rose-800 border-rose-200"}`}>{msg.text}</div>;
}
