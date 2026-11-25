// Small helpers for tidy Thai line breaks. A no-break space (U+00A0) tells the browser "do not break here".
const NB = " ";

/** "15 มิถุนายน 2533" must never split between the day, the month and the year. */
export const glueDate = (s: string): string => s.replace(/(\d{1,2}) ([ก-๙]+\.?) (\d{4})/g, `$1${NB}$2${NB}$3`).replace(/(\d{1,2}):(\d{2})/g, "$1:$2");

/** "บริษัท ทรานซิสเตอร์ ริช จำกัด": keep "บริษัท" with the first name word and the legal suffix with the last, so "จำกัด" is never alone on a line. */
export function glueCompany(name: string): string {
  return name.replace(/^(บริษัท|ห้างหุ้นส่วนจำกัด|หจก\.|บจก\.|บมจ\.) /, `$1${NB}`).replace(/ (จำกัด \(มหาชน\)|\(มหาชน\)|จำกัด)$/, `${NB}$1`);
}

/** "11.4 g/dL", "118 mmHg": the number and its unit stay on one line. */
export const glueUnit = (value: string | number, unit?: string | null): string => (unit ? `${value}${NB}${unit}` : String(value));

/** "ไขมันชนิดดี (HDL)": the bracket stays with the word before it. */
export const glueParen = (s: string): string => s.replace(/ \(/g, `${NB}(`);
