import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { isSafeImageName, imageDiskPath } from "@/lib/delivera/images";

// Public: serve a DELIVERA image (menu photo / store PromptPay QR) to the
// customer LIFF. No session — these are meant to be shown to customers. The
// filename is validated to a bare token so it can't escape the images dir.
export const dynamic = "force-dynamic";

const CT: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  const name = params.name;
  if (!isSafeImageName(name)) return NextResponse.json({ error: "bad_name" }, { status: 400 });
  try {
    const buf = await fs.readFile(imageDiskPath(name));
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    return new NextResponse(new Uint8Array(buf), {
      headers: { "Content-Type": CT[ext] ?? "application/octet-stream", "Cache-Control": "public, max-age=86400" }
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
