import { NextResponse, type NextRequest } from "next/server";
import { COOKIE } from "./lib/session";

export function proxy(req: NextRequest) {
  const res = NextResponse.next();
  if (!req.cookies.get(COOKIE)) res.cookies.set(COOKIE, crypto.randomUUID(), { httpOnly: true, sameSite: "lax", path: "/" });
  return res;
}
