// Nong Plara's hourly greeting. Run: node --import tsx scripts/test-mascot-greeting.ts
import { bangkokHour, greetingForHour } from "../src/lib/mascot-greeting";
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
const pose = (h: number) => greetingForHour(h).pose;
ok("morning 05–10 → thumbs", pose(5) === "thumbs" && pose(10) === "thumbs");
ok("lunch 11–13 → drumstick", pose(11) === "drumstick" && pose(13) === "drumstick");
ok("afternoon 14–17 → proud", pose(14) === "proud" && pose(17) === "proud");
ok("evening 18–21 → cheer", pose(18) === "cheer" && pose(21) === "cheer");
ok("night 22–04 → notes", pose(22) === "notes" && pose(23) === "notes" && pose(0) === "notes" && pose(4) === "notes");
ok("every hour has a pose and a non-empty line", Array.from({ length: 24 }, (_, h) => greetingForHour(h)).every((g) => !!g.pose && g.text.length > 5));
ok("out-of-range hours wrap instead of throwing", pose(24) === pose(0) && pose(-1) === pose(23) && pose(29) === pose(5));
ok("Bangkok hour is UTC+7 regardless of the server zone", bangkokHour(Date.UTC(2026, 9, 13, 2, 0)) === 9 && bangkokHour(Date.UTC(2026, 9, 13, 18, 0)) === 1);
process.exit(failed ? 1 : 0);
