"use client";

import { useState, useTransition } from "react";
import { t, type Lang } from "@/lib/i18n";

export type TableOpt = { id: number; label: string };

export type RecentVisit = {
  id: number;
  guest_name: string | null;
  phone: string | null;
  party_size: number;
  visited_at: string;
  verification_code: string | null;
  redemption_status: string | null;
  first_time: number;
  table_label: string | null;
  recorded_by_name: string | null;
};

type SubmitResult = {
  id: number;
  verification_code: string | null;
  redemption_status: "eligible" | "not_eligible" | string;
  first_time: boolean;
};

export default function WalkInClient({
  lang, tables, recent
}: {
  lang: Lang;
  tables: TableOpt[];
  recent: RecentVisit[];
}) {
  const [guestName, setGuestName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [tableId, setTableId] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [claimed, setClaimed] = useState(false);
  const [pending, startTransition] = useTransition();

  function reset() {
    setGuestName("");
    setPhone("");
    setPartySize(2);
    setTableId("");
    setNotes("");
    setError(null);
    setResult(null);
    setClaimed(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/staff/walk-in", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            guest_name: guestName.trim() || null,
            phone: phone.trim() || null,
            party_size: partySize,
            table_id: tableId === "" ? null : tableId,
            notes: notes.trim() || null
          })
        });
        const json = await res.json();
        if (!res.ok) {
          setError(json.error || "submit_failed");
          return;
        }
        setResult({
          id: json.id,
          verification_code: json.verification_code,
          redemption_status: json.redemption_status,
          first_time: !!json.first_time
        });
      } catch (err) {
        console.error(err);
        setError("network_error");
      }
    });
  }

  function claimIceCream() {
    if (!result) return;
    startTransition(async () => {
      try {
        const res = await fetch("/api/staff/redemption/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "walk_in", id: result.id })
        });
        const json = await res.json();
        if (!res.ok && !json.already_claimed) {
          setError(json.error || "claim_failed");
          return;
        }
        setClaimed(true);
      } catch (err) {
        console.error(err);
        setError("network_error");
      }
    });
  }

  // ── Result panel — shown after submit ──
  if (result) {
    return (
      <div className="space-y-4">
        <div className="card">
          <h2 className="text-lg font-bold text-slate-800 mb-2">
            {t(lang, "staff.walkIn.recorded")}
          </h2>
          <p className="text-sm text-slate-600">
            {guestName || phone || t(lang, "staff.walkIn.guestPlaceholder")}{" "}
            · {partySize} {t(lang, "staff.walkIn.guestsUnit")}
          </p>
        </div>

        {result.first_time && result.verification_code && !claimed && (
          <div className="card bg-amber-50 border border-amber-200">
            <p className="text-sm font-bold text-amber-800 mb-1">
              {t(lang, "staff.walkIn.firstTimeBanner")}
            </p>
            <p className="text-xs text-amber-700 mb-3">
              {t(lang, "staff.walkIn.firstTimeHint")}
            </p>
            <div className="bg-white border border-amber-300 rounded-lg p-4 text-center">
              <div className="text-xs text-slate-500 mb-1">
                {t(lang, "staff.walkIn.codeLabel")}
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-widest">
                {result.verification_code}
              </div>
            </div>
            <button
              type="button"
              onClick={claimIceCream}
              disabled={pending}
              className="btn-primary mt-3 w-full"
            >
              {pending ? "…" : t(lang, "staff.walkIn.claimBtn")}
            </button>
          </div>
        )}

        {claimed && (
          <div className="card bg-emerald-50 border border-emerald-200 text-center">
            <p className="text-emerald-700 font-bold">
              {t(lang, "staff.walkIn.claimedOk")}
            </p>
          </div>
        )}

        {!result.first_time && (
          <div className="card bg-slate-50 border border-slate-200 text-center text-sm text-slate-600">
            {t(lang, "staff.walkIn.returningCustomer")}
          </div>
        )}

        {error && (
          <div className="card bg-rose-50 border border-rose-200 text-sm text-rose-700">
            {error}
          </div>
        )}

        <button type="button" onClick={reset} className="btn-secondary w-full">
          {t(lang, "staff.walkIn.recordAnother")}
        </button>
      </div>
    );
  }

  // ── Form ──
  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="card space-y-4">
        <div>
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "staff.walkIn.guestName")}
          </label>
          <input
            type="text"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder={t(lang, "staff.walkIn.guestPlaceholder")}
            className="input w-full"
            maxLength={80}
          />
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "staff.walkIn.phone")}
            <span className="text-amber-700 ml-2 font-medium">
              {t(lang, "staff.walkIn.phoneHint")}
            </span>
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="081-234-5678"
            className="input w-full"
            inputMode="tel"
            maxLength={30}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">
              {t(lang, "staff.walkIn.partySize")}
            </label>
            <input
              type="number"
              value={partySize}
              onChange={(e) => setPartySize(Math.max(1, Number(e.target.value) || 1))}
              min={1}
              max={50}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">
              {t(lang, "staff.walkIn.table")}
            </label>
            <select
              value={tableId}
              onChange={(e) => setTableId(e.target.value === "" ? "" : Number(e.target.value))}
              className="input w-full"
            >
              <option value="">{t(lang, "staff.walkIn.tableAny")}</option>
              {tables.map((tb) => (
                <option key={tb.id} value={tb.id}>{tb.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "staff.walkIn.notes")}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={500}
            className="input w-full"
          />
        </div>

        {error && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={pending || (!guestName.trim() && !phone.trim())}
          className="btn-primary w-full"
        >
          {pending ? "…" : t(lang, "staff.walkIn.submit")}
        </button>
      </form>

      {/* Today's walk-ins */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "staff.walkIn.todayList")}
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">
            {t(lang, "staff.walkIn.noneYet")}
          </p>
        ) : (
          <div className="space-y-2 text-sm">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center gap-3 border-b border-slate-100 pb-2 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">
                    {r.guest_name || r.phone || "—"}
                  </div>
                  <div className="text-xs text-slate-500">
                    {hhmmFromIso(r.visited_at)} · {r.party_size} {t(lang, "staff.walkIn.guestsUnit")}
                    {r.table_label && ` · ${r.table_label}`}
                  </div>
                </div>
                {r.first_time === 1 && (
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    r.redemption_status === "claimed"
                      ? "bg-emerald-100 text-emerald-700"
                      : r.redemption_status === "expired"
                        ? "bg-slate-200 text-slate-500"
                        : "bg-amber-100 text-amber-700"
                  }`}>
                    {r.redemption_status === "claimed"
                      ? t(lang, "staff.walkIn.pillClaimed")
                      : r.redemption_status === "expired"
                        ? t(lang, "staff.walkIn.pillExpired")
                        : t(lang, "staff.walkIn.pillEligible")}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function hhmmFromIso(iso: string): string {
  const bkk = new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(11, 16);
}
