import { type NextRequest } from "next/server";

/**
 * Validates the origin of a browser request to prevent Cross-Site Request Forgery (CSRF).
 * 
 * Mimir's API routes are consumed by both browsers and autonomous agents.
 * Browser requests must be protected from CSRF by ensuring the Origin or Referer
 * exactly matches the host they are targeting.
 * 
 * @returns true if the origin is safe, false if it is a suspected CSRF.
 */
export function verifyBrowserOrigin(req: NextRequest): boolean {
  // Public reads don't mutate state, so CSRF is less of a concern,
  // but if this is called, it assumes the route wants to mutate.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return true;
  }

  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) {
    // Browsers always send Origin on cross-origin POST requests.
    // If it's completely missing, it might be an agent or a very strict privacy extension.
    // But for browser-origin policy on mutating API routes, we require it unless it's a signed action.
    // We handle the "signed action" exemption at the policy layer.
    return false;
  }

  try {
    const originUrl = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    
    if (!host) return false;
    
    // Exact match on the hostname
    return originUrl.host === host;
  } catch {
    return false; // Malformed origin
  }
}
