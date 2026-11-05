/**
 * Deploy verification endpoint.
 *
 * GET /api/health          -> reports which env vars are configured (no secrets)
 * GET /api/health?probe=1  -> additionally makes one read-only Admin API call
 *                             to confirm the token and scopes actually work
 *
 * Vars live in wrangler.jsonc; SHOPIFY_ADMIN_TOKEN is a Worker secret set in
 * the Cloudflare dashboard (Settings > Variables and Secrets).
 */

import { empty, json } from "./http.js";

const API_VERSION = "2025-07";

const SHOP_QUERY = `{ shop { name myshopifyDomain } }`;

async function probeAdminApi(env) {
  const domain = env.SHOPIFY_STORE_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) return { ok: false, error: "Missing store domain or admin token" };

  try {
    const response = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: SHOP_QUERY }),
      signal: AbortSignal.timeout(6000),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "Admin token rejected (check the token and its scopes)" };
    }

    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.errors) {
      return {
        ok: false,
        error: `Admin API error (HTTP ${response.status})`,
        detail: JSON.stringify(body?.errors || null)?.slice(0, 300),
      };
    }

    return { ok: true, shop: body.data?.shop?.name || null };
  } catch (error) {
    return { ok: false, error: `Admin API unreachable: ${error.message}` };
  }
}

export async function handleHealth(request, env) {
  const headers = { "Cache-Control": "no-store" };

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed" }, 405, {
      ...headers,
      Allow: "GET, HEAD",
    });
  }

  const storeDomain = env.SHOPIFY_STORE_DOMAIN || null;
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const body = {
    ok: true,
    service: "one8-back-in-stock",
    platform: "cloudflare-workers",
    apiVersion: API_VERSION,
    storeDomain,
    // Never echo the token itself — just whether it is present and plausible.
    adminTokenConfigured: Boolean(env.SHOPIFY_ADMIN_TOKEN),
    adminTokenLooksValid: /^shp(at|ca)_[a-f0-9]{32}$/i.test(env.SHOPIFY_ADMIN_TOKEN || ""),
    allowedOrigins: allowedOrigins.length
      ? allowedOrigins
      : ["https://one8.com", "https://www.one8.com (default)"],
    rateLimiter: env.NOTIFY_WRITE_LIMITER ? "cloudflare-binding" : "in-memory",
  };

  if (!storeDomain || !body.adminTokenConfigured) {
    body.ok = false;
    body.error = "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN in this environment";
  }

  if (new URL(request.url).searchParams.get("probe") === "1") {
    body.adminApi = await probeAdminApi(env);
    if (!body.adminApi.ok) body.ok = false;
  }

  const status = body.ok ? 200 : 503;
  if (request.method === "HEAD") return empty(status, headers);
  return json(body, status, headers);
}
