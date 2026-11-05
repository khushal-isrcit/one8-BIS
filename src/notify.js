/**
 * one8 back-in-stock notify endpoint (Cloudflare Worker route).
 *
 * POST /api/notify
 * Body (JSON):
 *   { customerId: "24789358182560", phone?: "+919812345678", productHandle: "seam-xviii-signature-mens" }
 *   or
 *   { email: "someone@example.com", phone?: "+919812345678", productHandle: "seam-xviii-signature-mens" }
 *
 * GET /api/notify?productHandle=<handle>&phone=%2B919812345678
 *   Answers { ok, tag, subscribed } — whether that shopper already holds the
 *   tag, so the storefront can render the button in its subscribed state on
 *   load. Read-only: it never creates a customer, and it skips the product
 *   check, since an unknown handle correctly answers subscribed: false.
 *
 * What POST does:
 *   1. Validates the product handle and confirms the product exists.
 *   2. Resolves the customer: by Shopify customer ID (KwikPass logged-in flow),
 *      by email, or by phone (guest flow; the customer is created if not found).
 *   3. Adds the tag `bis-<product-handle>` to that customer via the Admin API.
 *
 * The backend/email team keys their automations off that tag. When a product
 * is restocked they segment customers with tag `bis-<handle>`, send the email,
 * then remove the tag so customers are not notified twice.
 *
 * Per-store settings, set on each Worker in the Cloudflare dashboard
 * (Settings > Variables and Secrets), so one codebase serves several stores:
 *   SHOPIFY_STORE_DOMAIN  text, e.g. 6qx7kf-as.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN   secret: Admin API access token of a custom app with
 *                         read_customers + write_customers (and read_products)
 *   ALLOWED_ORIGINS       text, comma-separated storefront origins. While it is
 *                         empty, browser requests are refused.
 * Rate limit bindings (wrangler.jsonc):
 *   NOTIFY_WRITE_LIMITER  optional; without them the in-memory throttle
 *   NOTIFY_READ_LIMITER   below takes over.
 *
 * NOTE: reading customers also requires the app to be approved for protected
 * customer data. Without it, every customer query fails with ACCESS_DENIED —
 * see the hint logged by describeAdminError().
 */

import { json } from "./http.js";

const API_VERSION = "2025-07";
const TAG_PREFIX = "bis-";
const HANDLE_RE = /^[a-z0-9][a-z0-9-_]{0,120}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

// One Admin API call may not exceed this...
const REQUEST_TIMEOUT_MS = 4000;
// ...and all calls for one invocation may not exceed this. Workers do not cut
// off HTTP requests on wall-clock time, but a shopper waiting on the button
// will, so every retry and backoff is still bounded by this budget.
const FUNCTION_BUDGET_MS = 8500;
const MAX_BODY_CHARS = 100_000;
const MAX_ATTEMPTS = 3;
// Requests per IP per window. The read-only GET gets a higher allowance: it
// fires on every sold-out variant view, and shoppers on Indian mobile carriers
// share NAT addresses, so a handful of them behind one IP would otherwise
// exhaust the write budget.
const RATE_LIMIT_WRITE = 10;
const RATE_LIMIT_READ = 30;
const RATE_WINDOW_MS = 60_000;
const SHOPIFY_TAG_MAX = 255;

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

// Fallback per-isolate throttle, used only when the Cloudflare rate limit
// bindings are missing (e.g. removed from wrangler.jsonc). Isolates are
// ephemeral, so this is a speed bump, not a guarantee.
const hits = new Map();

function throttledInMemory(ip, limit) {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Prune stale IPs so a long-lived warm instance does not grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.length || times[times.length - 1] <= windowStart) hits.delete(key);
    }
  }

  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  list.push(now);
  hits.set(ip, list);
  return list.length > limit;
}

/**
 * Cloudflare's rate limit binding counts per Cloudflare location rather than
 * per isolate, so it holds across warm and cold instances. If the binding
 * errors, fall back to the in-memory throttle rather than failing the request.
 */
async function throttled(env, ip, isRead) {
  const binding = isRead ? env.NOTIFY_READ_LIMITER : env.NOTIFY_WRITE_LIMITER;
  if (binding) {
    try {
      const { success } = await binding.limit({ key: ip });
      return !success;
    } catch (error) {
      console.error("[bis-notify] rate limit binding failed", error);
    }
  }
  return throttledInMemory(ip, isRead ? RATE_LIMIT_READ : RATE_LIMIT_WRITE);
}

function clientIp(request) {
  const cfIp = (request.headers.get("cf-connecting-ip") || "").trim();
  const forwarded = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return cfIp || forwarded || "unknown";
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * No fallback list: this code serves more than one store, so a Worker missing
 * ALLOWED_ORIGINS must not silently accept another store's storefront.
 */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** @returns {{ allowed: boolean, headers: Headers }} */
function corsFor(request, env) {
  const origin = (request.headers.get("origin") || "").replace(/\/$/, "");
  const headers = new Headers({
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });

  // Server-to-server calls (curl, Shopify Flow, health checks) send no Origin.
  if (!origin) return { allowed: true, headers };

  if (allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    return { allowed: true, headers };
  }
  return { allowed: false, headers };
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Read the body as text and parse it ourselves: storefront `fetch` calls (and
 * `sendBeacon`) often send text/plain rather than application/json.
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_CHARS) throw new BadRequest("Payload too large");

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new BadRequest("Payload too large");
  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new BadRequest("Body must be valid JSON");
  }
}

/**
 * Query params as a plain object, so parseInput can take a GET the same way it
 * takes a JSON body.
 */
function queryOf(request) {
  const params = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    // First occurrence wins, so ?phone=a&phone=b reads as "a".
    if (!(key in params)) params[key] = value;
  }
  return params;
}

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Shopify Admin API
// ---------------------------------------------------------------------------

/** Escape a value for embedding in a Shopify search query string. */
function searchLiteral(value) {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(errors) {
  return (errors || []).some(
    (e) => e?.extensions?.code === "THROTTLED" || /throttl/i.test(e?.message || ""),
  );
}

/**
 * Turn Shopify's errors[] into something actionable in the logs. The two
 * failure modes that look identical from the outside — a missing scope and
 * missing protected-customer-data approval — need completely different fixes,
 * so name them explicitly.
 */
function describeAdminError(errors) {
  const list = Array.isArray(errors) ? errors : [];
  const text = list.map((e) => e?.message || "").join(" | ");

  if (/protected customer data|not approved to access/i.test(text)) {
    return (
      "SHOPIFY PROTECTED CUSTOMER DATA NOT APPROVED — the app can read products " +
      "but not customers. Fix in Shopify admin > Settings > Apps and sales channels > " +
      "Develop apps > (your app) > API access > Protected customer data access > " +
      "Request access. Approval is separate from the read_customers scope."
    );
  }
  if (list.some((e) => e?.extensions?.code === "ACCESS_DENIED") || /access denied/i.test(text)) {
    return (
      "ACCESS_DENIED — the token lacks a required scope (read_products, " +
      "read_customers, write_customers). Note that adding a scope invalidates " +
      "the existing token: reinstall the app and update SHOPIFY_ADMIN_TOKEN."
    );
  }
  return "";
}

/**
 * @param {object} ctx - { env, deadline } shared across every call in one
 *   request, so retries cannot outlive the time budget.
 */
async function adminGraphql(query, variables, ctx, attempt = 1) {
  const domain = ctx.env.SHOPIFY_STORE_DOMAIN;
  const token = ctx.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN");
  }
  if (/^https?:\/\//i.test(domain)) {
    // A full URL here builds an unreachable address and reads as a network
    // failure, which is a confusing way to learn about a typo.
    throw new Error("SHOPIFY_STORE_DOMAIN must be a bare host, e.g. shop.myshopify.com");
  }

  const remaining = ctx.deadline - Date.now();
  if (remaining <= 0) throw new Error("Admin API time budget exhausted");

  let response;
  try {
    response = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
  } catch (error) {
    // Network failure or timeout — worth one more shot, budget permitting.
    if (attempt < MAX_ATTEMPTS && ctx.deadline - Date.now() > 1000) {
      await sleep(300 * attempt);
      return adminGraphql(query, variables, ctx, attempt + 1);
    }
    throw new Error(`Admin API unreachable: ${error.message}`);
  }

  // 429/5xx: back off and retry, honouring Retry-After when present.
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const backoff =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * attempt;

    // Only sleep if there is time left afterwards to actually make the call.
    if (ctx.deadline - Date.now() > backoff + 1000) {
      await sleep(backoff);
      return adminGraphql(query, variables, ctx, attempt + 1);
    }
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Admin API returned non-JSON (HTTP ${response.status})`);
  }

  // Shopify signals cost-limit throttling with HTTP 200 + errors[].
  if (
    json.errors &&
    isThrottled(json.errors) &&
    attempt < MAX_ATTEMPTS &&
    ctx.deadline - Date.now() > 1500
  ) {
    await sleep(500 * attempt);
    return adminGraphql(query, variables, ctx, attempt + 1);
  }

  if (!response.ok || json.errors) {
    const hint = describeAdminError(json.errors);
    if (hint) console.error("[bis-notify]", hint);
    throw new Error(
      `Admin API error (HTTP ${response.status}): ${JSON.stringify(json.errors || json)}`.slice(0, 500),
    );
  }
  return json.data;
}

const PRODUCT_QUERY = `
  query productByHandle($q: String!) {
    products(first: 1, query: $q) {
      edges { node { id handle } }
    }
  }
`;

const CUSTOMER_BY_ID_QUERY = `
  query customerById($id: ID!) {
    customer(id: $id) { id tags }
  }
`;

const CUSTOMER_SEARCH_QUERY = `
  query customerSearch($q: String!) {
    customers(first: 1, query: $q) {
      edges { node { id tags } }
    }
  }
`;

const CUSTOMER_CREATE_MUTATION = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// Domain steps
// ---------------------------------------------------------------------------

async function assertProductExists(handle, ctx) {
  const data = await adminGraphql(PRODUCT_QUERY, { q: `handle:${searchLiteral(handle)}` }, ctx);
  const node = data.products?.edges?.[0]?.node;
  // Shopify search is fuzzy; require an exact handle match.
  if (!node || node.handle !== handle) {
    throw new BadRequest("Unknown product", 404);
  }
}

/**
 * Find an existing customer without creating one. Identity is resolved in
 * order of trust: Shopify customer ID, then email, then phone — matching how
 * the storefront widget resolves a Kwikpass shopper.
 * @returns {Promise<{ gid: string, tags: string[] } | null>}
 */
async function findCustomer({ customerId, email, phone }, ctx) {
  if (customerId) {
    // Look up rather than assume: tagging an unknown ID surfaces as a
    // top-level GraphQL error, which would otherwise read as a 500.
    const data = await adminGraphql(
      CUSTOMER_BY_ID_QUERY,
      { id: `gid://shopify/Customer/${customerId}` },
      ctx,
    );
    if (!data.customer) return null;
    return { gid: data.customer.id, tags: data.customer.tags || [] };
  }

  const q = email ? `email:${searchLiteral(email)}` : `phone:${searchLiteral(phone)}`;
  const found = await adminGraphql(CUSTOMER_SEARCH_QUERY, { q }, ctx);
  const node = found.customers?.edges?.[0]?.node;
  return node ? { gid: node.id, tags: node.tags || [] } : null;
}

/**
 * Resolve the customer to tag, creating one for guests.
 * @returns {Promise<{ gid: string, tags: string[], created: boolean }>}
 */
async function resolveCustomer({ customerId, email, phone, tag }, ctx) {
  const existing = await findCustomer({ customerId, email, phone }, ctx);
  if (existing) return { ...existing, created: false };

  // A customer ID that resolves to nothing is a client error, not a cue to
  // create an account we have no contact details for.
  if (customerId) throw new BadRequest("Unknown customer", 404);

  const input = { tags: [tag] };
  if (email) input.email = email;
  if (phone) input.phone = phone;

  const created = await adminGraphql(CUSTOMER_CREATE_MUTATION, { input }, ctx);
  const errors = created.customerCreate?.userErrors || [];
  if (errors.length) {
    // A phone/email that another customer already owns loses the race with a
    // concurrent signup; treat it as a client error rather than a crash.
    if (errors.some((e) => /taken|already/i.test(e.message || ""))) {
      throw new BadRequest("Customer already exists with different details", 409);
    }
    console.error("[bis-notify] customerCreate userErrors", JSON.stringify(errors));
    throw new BadRequest("Could not create customer", 422);
  }

  const node = created.customerCreate?.customer;
  if (!node) throw new Error("customerCreate returned no customer");
  // The tag was applied at creation time.
  return { gid: node.id, tags: [tag], created: true };
}

async function addTag(gid, tag, ctx) {
  const result = await adminGraphql(TAGS_ADD_MUTATION, { id: gid, tags: [tag] }, ctx);
  const errors = result.tagsAdd?.userErrors || [];
  if (errors.length) {
    console.error("[bis-notify] tagsAdd userErrors", JSON.stringify(errors));
    throw new BadRequest("Could not tag customer", 422);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Read one field from a JSON body or a parsed query string. A JSON body may
 * send an array ({ "phone": ["a", "b"] }); take the first rather than
 * stringifying it into "a,b" and failing validation for the wrong reason.
 */
function field(source, key) {
  const value = Array.isArray(source[key]) ? source[key][0] : source[key];
  return value == null ? "" : String(value);
}

function parseInput(body) {
  const productHandle = field(body, "productHandle").trim().toLowerCase();
  const customerId = field(body, "customerId").trim();
  const email = field(body, "email").trim().toLowerCase();

  // A "+" in a query string decodes to a space, so an un-encoded
  // ?phone=+919812345678 arrives as " 919812345678". Repair that exact
  // signature — a leading space before digits — before stripping separators,
  // otherwise the number silently loses its country-code marker and 400s.
  let rawPhone = field(body, "phone");
  if (/^\s+\d/.test(rawPhone)) rawPhone = `+${rawPhone.trim()}`;
  // Strip spaces, dashes and brackets so "+91 98123-45678" normalises cleanly.
  const phone = rawPhone.trim().replace(/[\s()\-.]/g, "");

  if (!HANDLE_RE.test(productHandle)) throw new BadRequest("Invalid product handle");
  if (!customerId && !email && !phone) {
    throw new BadRequest("customerId, email or phone is required");
  }
  if (customerId && !/^\d{5,20}$/.test(customerId)) throw new BadRequest("Invalid customerId");
  if (email && !EMAIL_RE.test(email)) throw new BadRequest("Invalid email");
  if (phone && !E164_RE.test(phone)) {
    throw new BadRequest("Invalid phone, expected E.164 format e.g. +919812345678");
  }

  const tag = `${TAG_PREFIX}${productHandle}`;
  if (tag.length > SHOPIFY_TAG_MAX) throw new BadRequest("Product handle too long");

  return { productHandle, customerId, email, phone, tag };
}

export async function handleNotify(request, env) {
  const { allowed: originAllowed, headers } = corsFor(request, env);
  const reply = (status, body) => json(body, status, headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: originAllowed ? 204 : 403, headers });
  }
  const isRead = request.method === "GET";
  if (request.method !== "POST" && !isRead) {
    headers.set("Allow", "GET, POST, OPTIONS");
    return reply(405, { ok: false, error: "Method not allowed" });
  }
  if (!originAllowed) {
    return reply(403, { ok: false, error: "Origin not allowed" });
  }
  if (await throttled(env, clientIp(request), isRead)) {
    headers.set("Retry-After", "60");
    return reply(429, { ok: false, error: "Too many requests" });
  }

  // Shared by every Admin call in this invocation.
  const ctx = { env, deadline: Date.now() + FUNCTION_BUDGET_MS };

  try {
    // ---- GET: has this customer already subscribed? ----------------------
    if (isRead) {
      const { tag, customerId, email, phone } = parseInput(queryOf(request));

      // A failed lookup must not 500 the product page. The button stays
      // clickable and the POST is idempotent, so answering "not subscribed"
      // is the safe degradation.
      let subscribed = false;
      let degraded = false;
      try {
        const customer = await findCustomer({ customerId, email, phone }, ctx);
        subscribed = Boolean(customer?.tags.includes(tag));
      } catch (error) {
        if (error instanceof BadRequest) throw error;
        console.error("[bis-notify] status lookup failed", error);
        degraded = true;
      }

      // Never cache: the answer is per-customer and changes on subscribe.
      headers.set("Cache-Control", "no-store");
      return reply(200, { ok: true, tag, subscribed, degraded });
    }

    // ---- POST: subscribe -------------------------------------------------
    const body = await readJsonBody(request);
    const { productHandle, customerId, email, phone, tag } = parseInput(body);

    // 1. Confirm the product exists so junk handles never become tags.
    await assertProductExists(productHandle, ctx);

    // 2. Resolve (or create) the customer.
    const customer = await resolveCustomer({ customerId, email, phone, tag }, ctx);

    // 3. Add the tag, unless creation already applied it.
    const alreadyTagged = customer.tags.includes(tag);
    if (!alreadyTagged) await addTag(customer.gid, tag, ctx);

    return reply(200, {
      ok: true,
      tag,
      created: customer.created,
      alreadySubscribed: alreadyTagged && !customer.created,
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      return reply(error.status, { ok: false, error: error.message });
    }
    console.error("[bis-notify]", error);
    return reply(500, { ok: false, error: "Server error" });
  }
}
