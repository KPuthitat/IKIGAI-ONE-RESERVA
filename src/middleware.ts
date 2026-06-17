import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Expose the current path+query to server components via a request header,
// so the auth guard can build a /login?next=… redirect that returns the user
// to the page they tapped (owner 2026-06-17: LINE approval cards must land on
// the right menu after login, not the default home). Header only — no auth or
// DB here, so it stays edge-safe.
export function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/admin/:path*", "/staff/:path*"]
};
