/* Auth endpoint: exchange a Google ID token for a server session cookie. */
import {
  verifyGoogleCredential,
  createSessionToken,
  authEnabled,
  buildSessionCookie,
  SESSION_MAX_AGE,
} from "@/lib/auth";

export const runtime = "edge";

function json(obj: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(obj), { status, headers });
}

/** POST { credential } — verify Google token, set HttpOnly session cookie. */
export async function POST(req: Request): Promise<Response> {
  // When enforcement is off there is no secret to sign with; report success so
  // the existing client flow is unaffected.
  if (!authEnabled()) {
    return json({ ok: true, enforced: false });
  }
  try {
    const { credential } = (await req.json()) as { credential?: string };
    if (!credential || typeof credential !== "string") {
      return json({ error: "缺少 Google 登入憑證" }, 400);
    }
    const claims = await verifyGoogleCredential(credential);
    const token = await createSessionToken(claims);
    return json(
      { ok: true, enforced: true, email: claims.email },
      200,
      buildSessionCookie(token, SESSION_MAX_AGE)
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: `登入驗證失敗：${msg}` }, 401);
  }
}

/** DELETE — clear the session cookie (sign out). */
export async function DELETE(): Promise<Response> {
  return json({ ok: true }, 200, buildSessionCookie("", 0));
}
