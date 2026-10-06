// Which accounts a pay round / doctor-fee round covers, by account status.

/** Payroll eligibility by account status (owner 2026-10-06: ฐิติวรดา ลาออกต้นเดือน
 *  หายจากรอบ). A disabled account is never paid. A resigned/terminated account is
 *  still owed pay for the days worked in a round that starts on or before their
 *  last working day (the FT resignation month is prorated by that day) — it only
 *  drops out of rounds that START AFTER it, which is what stops a resigned person
 *  appearing in later rounds (owner 2026-07-18). No known last day → excluded.
 *  `alias` prefixes the users columns; `startParam` is the SQL token for the
 *  period start ("@pstart" or "?"). */
export function payrollStatusEligibleSql(alias: string, startParam: string): string {
  const a = alias ? `${alias}.` : "";
  return `${a}status != 'disabled'
      AND (${a}status NOT IN ('resigned', 'terminated')
           OR COALESCE((SELECT MIN(d) FROM (
                SELECT MAX(proposed_last_day) AS d FROM resignation_requests
                 WHERE user_id = ${a}id AND status = 'approved'
                UNION ALL
                SELECT MAX(effective_date) AS d FROM termination_records
                 WHERE user_id = ${a}id AND status IN ('scheduled', 'executed')
              )), '') >= ${startParam})`;
}
