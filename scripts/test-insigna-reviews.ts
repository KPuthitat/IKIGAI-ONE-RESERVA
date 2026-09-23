// INSIGNA review funnel (owner 2026-09-23) — submit → tier/routing,
// no-gating (Google link for ALL scores), reward-for-completion, claim,
// summary. Run:  node --import tsx scripts/test-insigna-reviews.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-insigna-reviews.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;
process.env.INSIGNA_SALT = "test-salt-test-salt-test-salt-1234"; // ≥32 chars

(async () => {
  const { getDb } = await import("../src/lib/db");
  const {
    getReviewConfig, saveReviewConfig, setBranchGoogleUrl, getBranchReviewInfo,
    submitReview, trackGoogleClick, claimReward, reviewSummary, listReviews
  } = await import("../src/lib/insigna");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPOPLARAEMIA')").run().lastInsertRowid);

  // ── config ──
  ok("config default: disabled, no reward, threshold 4", (() => {
    const c = getReviewConfig();
    return c.enabled === false && c.reward_text === null && c.high_threshold === 4;
  })());

  saveReviewConfig({ enabled: true, reward_text: "เครื่องดื่มฟรี 1 แก้ว", high_threshold: 4 });
  ok("saveReviewConfig persists", (() => {
    const c = getReviewConfig();
    return c.enabled && c.reward_text === "เครื่องดื่มฟรี 1 แก้ว" && c.high_threshold === 4;
  })());
  ok("threshold clamps to 2-5", (() => {
    saveReviewConfig({ high_threshold: 9 });
    const hi = getReviewConfig().high_threshold;
    saveReviewConfig({ high_threshold: 1 });
    const lo = getReviewConfig().high_threshold;
    saveReviewConfig({ high_threshold: 4 });
    return hi === 5 && lo === 2;
  })());

  // ── branch google url ──
  setBranchGoogleUrl(A, "https://search.google.com/local/writereview?placeid=NAMA");
  ok("getBranchReviewInfo returns branch + url", (() => {
    const info = getBranchReviewInfo("nama");
    return info?.branch_id === A && info?.google_review_url === "https://search.google.com/local/writereview?placeid=NAMA";
  })());
  ok("unknown slug → null", getBranchReviewInfo("nope") === null);

  // ── submit: HIGH tier (5★ ≥ 4) ──
  const hi = submitReview({ branch_id: A, rating: 5, food_rating: 5, service_rating: 4, comment: "อร่อยมาก" });
  ok("high tier at rating >= threshold", hi.tier === "high");
  ok("high tier gets the branch google url", hi.google_review_url === "https://search.google.com/local/writereview?placeid=NAMA");
  ok("reward code minted (reward configured) with IK- prefix", !!hi.reward_code && hi.reward_code.startsWith("IK-"));
  ok("row persisted with routed_google=1", (() => {
    const row = db.prepare("SELECT * FROM insigna_review_requests WHERE token = ?").get(hi.token) as { rating: number; tier: string; routed_google: number; comment: string };
    return row.rating === 5 && row.tier === "high" && row.routed_google === 1 && row.comment === "อร่อยมาก";
  })());

  // ── submit: LOW tier (2★ < 4) — MUST still get the Google link (no gating) ──
  const lo = submitReview({ branch_id: A, rating: 2, comment: "รอนาน" });
  ok("low tier at rating < threshold", lo.tier === "low");
  ok("NO GATING: low tier STILL receives the Google url", lo.google_review_url === "https://search.google.com/local/writereview?placeid=NAMA");
  ok("low tier still earns the reward (completion, not score)", !!lo.reward_code);

  // ── branch without google url → null url, routed_google=0, reward still minted ──
  const noUrl = submitReview({ branch_id: B, rating: 5 });
  ok("branch w/o url → google_review_url null", noUrl.google_review_url === null);
  ok("branch w/o url → routed_google=0 in row", (db.prepare("SELECT routed_google FROM insigna_review_requests WHERE token = ?").get(noUrl.token) as { routed_google: number }).routed_google === 0);

  // ── reward NOT minted when reward text is empty ──
  saveReviewConfig({ reward_text: null });
  const noReward = submitReview({ branch_id: A, rating: 5 });
  ok("no reward text → reward_code null", noReward.reward_code === null);
  saveReviewConfig({ reward_text: "เครื่องดื่มฟรี 1 แก้ว" });

  // ── google click tracking ──
  trackGoogleClick(hi.token);
  ok("trackGoogleClick sets clicked_google=1", (db.prepare("SELECT clicked_google FROM insigna_review_requests WHERE token = ?").get(hi.token) as { clicked_google: number }).clicked_google === 1);
  trackGoogleClick("bogus-token"); // must not throw
  ok("trackGoogleClick unknown token is a no-op", true);

  // ── reward claim lifecycle ──
  ok("claim unknown code → 'unknown'", claimReward("IK-ZZZZZZ") === "unknown");
  ok("claim valid code → 'claimed'", claimReward(hi.reward_code!) === "claimed");
  ok("claim again → 'already'", claimReward(hi.reward_code!) === "already");
  ok("claim is case-insensitive", claimReward(lo.reward_code!.toLowerCase()) === "claimed");

  // ── invalid rating rejected ──
  ok("rating out of range throws", (() => {
    try { submitReview({ branch_id: A, rating: 6 }); return false; } catch { return true; }
  })());

  // ── summary + list ──
  // Rows inserted: hi(A,5), lo(A,2), noUrl(B,5), noReward(A,5). The
  // rating:6 submit threw, so it never persisted → 4 rows total.
  const sum = reviewSummary({ days: null });
  ok("summary total = 4 persisted submits", sum.total === 4);
  ok("summary avg = 4.25 ((5+2+5+5)/4)", sum.avg === 4.25);
  ok("summary lowCount = 1 (only the 2★)", sum.lowCount === 1);
  ok("summary googleShown = 3 (branch A's rows; B has no url)", sum.googleShown === 3);
  ok("summary googleClicked = 1", sum.googleClicked === 1);
  ok("summary rewardsIssued = 3 (noReward row had no reward text)", sum.rewardsIssued === 3);
  ok("summary rewardsClaimed = 2", sum.rewardsClaimed === 2);

  const branchA = reviewSummary({ branch_id: A, days: null });
  ok("branch-filtered summary: A has 3 rows", branchA.total === 3);
  ok("branch B has exactly 1 row", (db.prepare("SELECT COUNT(*) n FROM insigna_review_requests WHERE branch_id = ?").get(B) as { n: number }).n === 1);

  const lows = listReviews({ tier: "low" });
  ok("listReviews tier filter returns only low", lows.length === 1 && lows[0].tier === "low");
  ok("listReviews newest first, 4 rows", (() => {
    const all = listReviews({ limit: 100 });
    return all.length === 4 && all[0].created_at >= all[all.length - 1].created_at;
  })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
