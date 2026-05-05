import { getDb } from "./db";

export type ExportRow = {
  branch: string;
  booking_date: string;
  booking_time: string;
  customer_name: string;
  customer_phone: string;
  party_size: number;
  source: string | null;
  customer_origin: string | null;
  is_member: number | null;
  status: string;
  table_label: string | null;
  notes: string | null;
  created_at: string;
};

function escapeCsvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatSource(s: string | null): string {
  if (!s) return "";
  // อาจเก็บเป็น JSON array ["A","B"] หรือ legacy single string
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as string[];
      return arr.join("; ");
    } catch {
      return s;
    }
  }
  return s;
}

export function exportBookingsCsv(opts: {
  branchId?: number;
  fromDate?: string;
  toDate?: string;
}): string {
  const db = getDb();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.branchId) { where.push("b.branch_id = ?"); params.push(opts.branchId); }
  if (opts.fromDate) { where.push("b.booking_date >= ?"); params.push(opts.fromDate); }
  if (opts.toDate)   { where.push("b.booking_date <= ?"); params.push(opts.toDate); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT
      br.name AS branch,
      b.booking_date,
      b.booking_time,
      b.customer_name,
      b.customer_phone,
      b.party_size,
      b.source,
      b.customer_origin,
      b.is_member,
      b.status,
      t.label AS table_label,
      b.notes,
      b.created_at
    FROM bookings b
    JOIN branches br ON b.branch_id = br.id
    LEFT JOIN tables t ON b.table_id = t.id
    ${whereSql}
    ORDER BY b.booking_date DESC, b.booking_time DESC
  `).all(...params) as ExportRow[];

  const headers = [
    "branch","booking_date","booking_time","customer_name","customer_phone",
    "party_size","source","customer_origin","is_member",
    "status","table_label","notes","created_at"
  ];
  const csv = [
    "﻿" + headers.join(","),    // BOM for Excel UTF-8
    ...rows.map((r) => headers.map((h) => {
      let v: unknown = r[h as keyof ExportRow];
      if (h === "source") v = formatSource(v as string | null);
      if (h === "is_member") v = v === 1 ? "yes" : v === 0 ? "no" : "";
      return escapeCsvField(v);
    }).join(","))
  ].join("\n");
  return csv;
}
