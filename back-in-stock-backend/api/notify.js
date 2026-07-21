/**
 * one8 back-in-stock notify endpoint (Vercel serverless function).
 *
 * POST /api/notify
 * Body (JSON):
 *   { customerId: "24789358182560", phone?: "+91 98...", productHandle: "seam-xviii-signature-mens" }
 *   or
 *   { email: "someone@example.com", productHandle: "seam-xviii-signature-mens" }
 *
 * What it does:
 *   1. Validates the product handle and confirms the product exists.
 *   2. Resolves the customer: by Shopify customer ID (KwikPass logged-in flow)
 *      or by email (guest flow; the customer is created if not found).
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

const DEFAULT_ORIGINS = ["https://one8.com", "https://www.one8.com"];

// Very light per-instance throttle. Serverless instances are ephemeral, so
// this is a speed bump, not a guarantee. Add Vercel WAF rules for real limits.
const hits = new Map();
function throttled(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const list = (hits.get(ip) || []).filter((t) => t > windowStart);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  const parsed = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ORIGINS;
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (allowedOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function adminGraphql(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN");
  }

  const response = await fetch(
    `https://${domain}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(
      `Admin API error: ${JSON.stringify(json.errors || json)}`.slice(0, 500),
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

const CUSTOMER_BY_EMAIL_QUERY = `
  query customerByEmail($q: String!) {
    customers(first: 1, query: $q) {
      edges { node { id email } }
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

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (throttled(ip)) {
    res.status(429).json({ ok: false, error: "Too many requests" });
    return;
  }

  try {
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const productHandle = String(body.productHandle || "")
      .trim()
      .toLowerCase();
    const customerId = String(body.customerId || "").trim();
    const email = String(body.email || "").trim().toLowerCase();

    if (!HANDLE_RE.test(productHandle)) {
      res.status(400).json({ ok: false, error: "Invalid product handle" });
      return;
    }
    if (!customerId && !email) {
      res
        .status(400)
        .json({ ok: false, error: "customerId or email is required" });
      return;
    }
    if (customerId && !/^\d{5,20}$/.test(customerId)) {
      res.status(400).json({ ok: false, error: "Invalid customerId" });
      return;
    }
    if (!customerId && !EMAIL_RE.test(email)) {
      res.status(400).json({ ok: false, error: "Invalid email" });
      return;
    }

    // 1. Confirm the product exists so junk handles never become tags.
    const productData = await adminGraphql(PRODUCT_QUERY, {
      q: `handle:${productHandle}`,
    });
    const productNode = productData.products.edges[0]?.node;
    if (!productNode || productNode.handle !== productHandle) {
      res.status(404).json({ ok: false, error: "Unknown product" });
      return;
    }

    const tag = `${TAG_PREFIX}${productHandle}`;

    // 2. Resolve the customer GID.
    let customerGid = null;

    if (customerId) {
      customerGid = `gid://shopify/Customer/${customerId}`;
    } else {
      const found = await adminGraphql(CUSTOMER_BY_EMAIL_QUERY, {
        q: `email:${email}`,
      });
      const existing = found.customers.edges[0]?.node;

      if (existing) {
        customerGid = existing.id;
      } else {
        const created = await adminGraphql(CUSTOMER_CREATE_MUTATION, {
          input: { email, tags: [tag] },
        });
        const errors = created.customerCreate.userErrors;
        if (errors && errors.length) {
          throw new Error(`customerCreate: ${JSON.stringify(errors)}`);
        }
        // Tag was applied at creation; done.
        res.status(200).json({ ok: true, tag, created: true });
        return;
      }
    }

    // 3. Add the tag (idempotent: re-adding an existing tag is a no-op).
    const tagged = await adminGraphql(TAGS_ADD_MUTATION, {
      id: customerGid,
      tags: [tag],
    });
    const tagErrors = tagged.tagsAdd.userErrors;
    if (tagErrors && tagErrors.length) {
      // Most common cause: the customer ID does not exist on this store.
      res.status(422).json({ ok: false, error: "Could not tag customer" });
      return;
    }

    res.status(200).json({ ok: true, tag });
  } catch (error) {
    console.error("[bis-notify]", error);
    res.status(500).json({ ok: false, error: "Server error" });
  }
}
