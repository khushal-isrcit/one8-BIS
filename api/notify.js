/**
 * one8 back-in-stock notify endpoint (Vercel serverless function).
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
 * Env vars (Vercel project settings):
 *   SHOPIFY_STORE_DOMAIN  e.g. 6qx7kf-as.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN   Admin API access token of a custom app with
 *                         read_customers + write_customers (and read_products)
 *   ALLOWED_ORIGINS       optional, comma-separated. Defaults to one8.com.
 */

const API_VERSION = "2025-07";
const TAG_PREFIX = "bis-";
const HANDLE_RE = /^[a-z0-9][a-z0-9-_]{0,120}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;

const DEFAULT_ORIGINS = ["https://one8.com", "https://www.one8.com"];

const REQUEST_TIMEOUT_MS = 6000;
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

// Very light per-instance throttle. Serverless instances are ephemeral, so
// this is a speed bump, not a guarantee. Add Vercel WAF rules for real limits.
const hits = new Map();

function throttled(ip, limit) {
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

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.headers["x-real-ip"] || "").trim() || "unknown";
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function allowedOrigins() {
  const parsed = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ORIGINS;
}

/** @returns {boolean} whether the request origin is permitted. */
function applyCors(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Server-to-server calls (curl, Shopify Flow, health checks) send no Origin.
  if (!origin) return true;

  if (allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Vercel only pre-parses the body when Content-Type is exactly application/json.
 * Storefront `fetch` calls (and `sendBeacon`) often send text/plain, so fall
 * back to reading and parsing the raw stream ourselves.
 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  let raw = req.body;
  if (raw == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100_000) throw new BadRequest("Payload too large");
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
  }

  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
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
 * takes a JSON body. Vercel populates req.query; the URL fallback keeps this
 * testable and portable to a plain Node server.
 */
function queryOf(req) {
  if (req.query && typeof req.query === "object") return req.query;

  const params = {};
  for (const [key, value] of new URL(req.url || "/", "http://localhost").searchParams) {
    // First occurrence wins, matching how field() unwraps Vercel's arrays.
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

async function adminGraphql(query, variables, attempt = 1) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN");
  }

  let response;
  try {
    response = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Network failure or timeout — worth one more shot.
    if (attempt < MAX_ATTEMPTS) {
      await sleep(300 * attempt);
      return adminGraphql(query, variables, attempt + 1);
    }
    throw new Error(`Admin API unreachable: ${error.message}`);
  }

  // 429/5xx: back off and retry, honouring Retry-After when present.
  if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * attempt);
    return adminGraphql(query, variables, attempt + 1);
  }

  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error(`Admin API returned non-JSON (HTTP ${response.status})`);
  }

  // Shopify signals cost-limit throttling with HTTP 200 + errors[].
  if (json.errors && isThrottled(json.errors) && attempt < MAX_ATTEMPTS) {
    await sleep(500 * attempt);
    return adminGraphql(query, variables, attempt + 1);
  }

  if (!response.ok || json.errors) {
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

async function assertProductExists(handle) {
  const data = await adminGraphql(PRODUCT_QUERY, { q: `handle:${searchLiteral(handle)}` });
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
async function findCustomer({ customerId, email, phone }) {
  if (customerId) {
    // Look up rather than assume: tagging an unknown ID surfaces as a
    // top-level GraphQL error, which would otherwise read as a 500.
    const data = await adminGraphql(CUSTOMER_BY_ID_QUERY, {
      id: `gid://shopify/Customer/${customerId}`,
    });
    if (!data.customer) return null;
    return { gid: data.customer.id, tags: data.customer.tags || [] };
  }

  const q = email ? `email:${searchLiteral(email)}` : `phone:${searchLiteral(phone)}`;
  const found = await adminGraphql(CUSTOMER_SEARCH_QUERY, { q });
  const node = found.customers?.edges?.[0]?.node;
  return node ? { gid: node.id, tags: node.tags || [] } : null;
}

/**
 * Resolve the customer to tag, creating one for guests.
 * @returns {Promise<{ gid: string, tags: string[], created: boolean }>}
 */
async function resolveCustomer({ customerId, email, phone, tag }) {
  const existing = await findCustomer({ customerId, email, phone });
  if (existing) return { ...existing, created: false };

  // A customer ID that resolves to nothing is a client error, not a cue to
  // create an account we have no contact details for.
  if (customerId) throw new BadRequest("Unknown customer", 404);

  const input = { tags: [tag] };
  if (email) input.email = email;
  if (phone) input.phone = phone;

  const created = await adminGraphql(CUSTOMER_CREATE_MUTATION, { input });
  const errors = created.customerCreate?.userErrors || [];
  if (errors.length) {
    // A phone/email that another customer already owns loses the race with a
    // concurrent signup; treat it as a client error rather than a crash.
    if (errors.some((e) => /taken|already/i.test(e.message || ""))) {
      throw new BadRequest("Customer already exists with different details", 409);
    }
    throw new Error(`customerCreate: ${JSON.stringify(errors)}`);
  }

  const node = created.customerCreate?.customer;
  if (!node) throw new Error("customerCreate returned no customer");
  // The tag was applied at creation time.
  return { gid: node.id, tags: [tag], created: true };
}

async function addTag(gid, tag) {
  const result = await adminGraphql(TAGS_ADD_MUTATION, { id: gid, tags: [tag] });
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
 * Read one field from a JSON body or a parsed query string. A repeated query
 * param (?phone=a&phone=b) arrives as an array; take the first rather than
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

export default async function handler(req, res) {
  const originAllowed = applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(originAllowed ? 204 : 403).end();
    return;
  }
  const isRead = req.method === "GET";
  if (req.method !== "POST" && !isRead) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  if (!originAllowed) {
    res.status(403).json({ ok: false, error: "Origin not allowed" });
    return;
  }
  if (throttled(clientIp(req), isRead ? RATE_LIMIT_READ : RATE_LIMIT_WRITE)) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ ok: false, error: "Too many requests" });
    return;
  }

  try {
    // ---- GET: has this customer already subscribed? ----------------------
    if (isRead) {
      const { tag, customerId, email, phone } = parseInput(queryOf(req));
      const customer = await findCustomer({ customerId, email, phone });

      // Never cache: the answer is per-customer and changes on subscribe.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ok: true,
        tag,
        subscribed: Boolean(customer?.tags.includes(tag)),
      });
      return;
    }

    // ---- POST: subscribe -------------------------------------------------
    const body = await readJsonBody(req);
    const { productHandle, customerId, email, phone, tag } = parseInput(body);

    // 1. Confirm the product exists so junk handles never become tags.
    await assertProductExists(productHandle);

    // 2. Resolve (or create) the customer.
    const customer = await resolveCustomer({ customerId, email, phone, tag });

    // 3. Add the tag, unless creation already applied it.
    const alreadyTagged = customer.tags.includes(tag);
    if (!alreadyTagged) await addTag(customer.gid, tag);

    res.status(200).json({
      ok: true,
      tag,
      created: customer.created,
      alreadySubscribed: alreadyTagged && !customer.created,
    });
  } catch (error) {
    if (error instanceof BadRequest) {
      res.status(error.status).json({ ok: false, error: error.message });
      return;
    }
    console.error("[bis-notify]", error);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}
