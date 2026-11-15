// Annual check-up — the two short-lived, unforgeable tokens the clinical screens use (phase 4):
//   • the licence UNLOCK: a doctor types their licence number once; the cookie then proves "unlocked in the last 30 minutes".
//     (The older Mounjaro unlock cookie holds a bare user id, which anyone can type into their browser; this one is signed.)
//   • the FILE LINK: a result file is opened through a link good for 5 minutes, made for one result and one person.
// Pure functions (no cookies / database) so they can be tested; the routes do the cookie and permission work around them.
import { signValue, verifySignedValue } from "./secret-vault";

export const UNLOCK_COOKIE = "ac_unlock";
export const UNLOCK_MINUTES = 30;
export const FILE_LINK_MINUTES = 5;

const minutes = (n: number) => n * 60_000;

export function makeUnlockToken(userId: number, now = Date.now()): string {
  return signValue(`${userId}|${now + minutes(UNLOCK_MINUTES)}`, "ac-unlock");
}
/** Expiry (ms) when the token is valid for this user right now, else null. */
export function readUnlockToken(token: string | null | undefined, userId: number, now = Date.now()): number | null {
  const v = verifySignedValue(token, "ac-unlock");
  if (!v) return null;
  const [uid, exp] = v.split("|").map(Number);
  return uid === userId && Number.isFinite(exp) && exp > now ? exp : null;
}

export function makeFileToken(resultId: number, userId: number, now = Date.now()): string {
  return signValue(`${resultId}|${userId}|${now + minutes(FILE_LINK_MINUTES)}`, "ac-file");
}
export function readFileToken(token: string | null | undefined, resultId: number, userId: number, now = Date.now()): boolean {
  const v = verifySignedValue(token, "ac-file");
  if (!v) return false;
  const [rid, uid, exp] = v.split("|").map(Number);
  return rid === resultId && uid === userId && Number.isFinite(exp) && exp > now;
}
/** The link a page shows for a result file. */
export const fileLink = (resultId: number, userId: number) => `/api/annual-checkup/file/${resultId}?t=${encodeURIComponent(makeFileToken(resultId, userId))}`;
