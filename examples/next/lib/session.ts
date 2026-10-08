// DEMO ONLY: a random cookie stands in for a real session (Better Auth, Auth.js, Clerk…).
// Never ship this: anyone can pick any cookie value.
export const COOKIE = "hatid-demo-user";
export function demoUserId(req: Request): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f-]{36})`).exec(req.headers.get("cookie") ?? "");
  return m?.[1] ?? null;
}
