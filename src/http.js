/**
 * Small response helpers shared by the routes. Workers hand each route a
 * Fetch API Request and expect a Response back, so these replace Vercel's
 * res.status().json() helpers.
 */

export function json(body, status = 200, headers = {}) {
  const merged = new Headers(headers);
  merged.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: merged });
}

/** Same as json(), minus the body, for HEAD requests. */
export function empty(status = 204, headers = {}) {
  return new Response(null, { status, headers: new Headers(headers) });
}
