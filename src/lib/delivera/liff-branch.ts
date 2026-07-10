// Resolve the ?branch=<id> param for a DELIVERA LIFF (client-only).
//
// When a LIFF is opened via https://liff.line.me/<id>?branch=1, LINE moves the
// original query string into a `liff.state` param, so the server-side searchParams
// see no `branch`. After liff.init() the SDK restores window.location, but to be
// robust we read both the plain query AND any liff.state fallback here.
export function branchFromLiffUrl(fallback: number): number {
  if (fallback) return fallback;
  if (typeof window === "undefined") return 0;
  const sp = new URLSearchParams(window.location.search);
  let b = Number(sp.get("branch")) || 0;
  if (!b) {
    const st = sp.get("liff.state");
    if (st) {
      const dec = decodeURIComponent(st);
      const inner = new URLSearchParams(dec.startsWith("?") ? dec.slice(1) : dec);
      b = Number(inner.get("branch")) || 0;
    }
  }
  return b;
}
