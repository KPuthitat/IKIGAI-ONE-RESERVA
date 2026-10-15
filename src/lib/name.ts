// Display an employee's name with their Thai title prefix
// (คำนำหน้า: นาย / นาง / นางสาว / ฯลฯ) prepended. Used everywhere a
// staff name is shown so the prefix is consistent across the app.
// Empty / null prefix → just the name (no leading space).
export function nameWithPrefix(
  prefix: string | null | undefined,
  name: string
): string {
  const p = (prefix ?? "").trim();
  return p ? `${p} ${name}` : name;
}

/** SQL for the same thing as nameWithPrefix(), for a users alias: TRIM(prefix || ' ' || display_name). */
export function sqlNameWithPrefix(alias: string): string {
  return `TRIM(COALESCE(${alias}.title_prefix, '') || ' ' || ${alias}.display_name)`;
}
