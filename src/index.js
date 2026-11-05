/**
 * one8 back-in-stock API, Cloudflare Worker entry point.
 *
 * Static files in public/ are served by Workers Static Assets before this
 * script runs, so "/" never reaches here. Everything that does not match a
 * file lands in fetch() below.
 */

import { handleHealth } from "./health.js";
import { json } from "./http.js";
import { handleNotify } from "./notify.js";

const ROUTES = {
  "/api/notify": handleNotify,
  "/api/health": handleHealth,
};

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
    const route = ROUTES[pathname];

    if (!route) return json({ ok: false, error: "Not found" }, 404);

    try {
      return await route(request, env);
    } catch (error) {
      // Routes handle their own errors; this only catches a bug in one.
      console.error("[bis-notify] unhandled", error);
      return json({ ok: false, error: "Server error" }, 500);
    }
  },
};
