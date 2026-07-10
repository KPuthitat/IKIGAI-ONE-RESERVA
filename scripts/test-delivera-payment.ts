// Unit tests for the DELIVERA PromptPay QR payload + CRC16. Pure functions only
// (no DB). Run via: npm run test:delivera
import { crc16, buildPromptPayPayload } from "../src/lib/delivera/payment";

let failed = 0;
function ok(name: string, cond: boolean): void {
  if (!cond) { console.error(`✗ ${name}`); failed++; } else console.log(`✓ ${name}`);
}

// 1) CRC16-CCITT-FALSE standard vector: "123456789" → 0x29B1
ok("1.crc16 standard vector", crc16("123456789") === "29B1");

// 2) payload well-formed: format + dynamic POI + PromptPay AID + THB + country
{
  const p = buildPromptPayPayload("0812345678", 150);
  ok("2.starts with format 000201", p.startsWith("000201"));
  ok("2.dynamic POI 010212", p.includes("010212"));
  ok("2.promptpay AID", p.includes("A000000677010111"));
  ok("2.currency THB 5303764", p.includes("5303764"));
  ok("2.country 5802TH", p.includes("5802TH"));
}

// 3) phone proxy → 0066 + number (leading 0 dropped), padded to 13
ok("3.phone proxy 0066…", buildPromptPayPayload("0812345678", 100).includes("0066812345678"));

// 4) 13-digit national id → tag 02
ok("4.national id tag 02", buildPromptPayPayload("1234567890123", 100).includes("02131234567890123"));

// 5) amount tag 54 formatted to 2 dp
ok("5.amount 150.00", buildPromptPayPayload("0812345678", 150).includes("5406150.00"));
ok("5.amount 1234.5 → 1234.50", buildPromptPayPayload("0812345678", 1234.5).includes("54071234.50"));

// 6) trailing CRC is self-consistent (last 4 chars = crc16 of the rest)
{
  const p = buildPromptPayPayload("0899999999", 89);
  ok("6.crc self-consistent", p.slice(-4) === crc16(p.slice(0, -4)));
  ok("6.crc tag present", p.slice(-8, -4) === "6304");
}

console.log(failed === 0 ? "\nALL PASS (payment)" : `\n${failed} FAILED (payment)`);
process.exit(failed === 0 ? 0 : 1);
