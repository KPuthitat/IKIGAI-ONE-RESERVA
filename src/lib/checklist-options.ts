// Pure helper for parsing the JSON-encoded options column on
// shift_checklist_items. Lives in its own file (rather than db.ts)
// so client components — specifically /admin/persona/checklist/
// ChecklistEditor.tsx — can import it without webpack dragging
// better-sqlite3 (and its node:fs / node:path deps) into the
// browser bundle, which was the source of the 502 from the
// 2026-05-21 build:
//
//   UnhandledSchemeError: Reading from "node:fs" is not handled
//   by plugins (Unhandled scheme).
//
// No imports here on purpose — pure JS, safe on both server and
// client.

/** Decode the options_json column on a shift_checklist_items row
 *  into a string[]. Returns [] when the row isn't a choice kind or
 *  the JSON is malformed; never throws. */
export function parseChecklistOptions(row: { options_json: string | null }): string[] {
  if (!row.options_json) return [];
  try {
    const parsed = JSON.parse(row.options_json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}
