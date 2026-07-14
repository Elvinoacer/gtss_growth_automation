/**
 * fetchJson.js — fetchJSON helper
 *
 * Promise-based wrapper around fetch() that auto-sets Content-Type for JSON
 * bodies, parses the response as JSON, and throws an Error with .status /
 * .body / .hint fields for non-2xx responses so callers can inspect
 * structured error fields (e.g. `active_execution_id`).
 */

async function fetchJSON(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  // Auto-set Content-Type for JSON bodies so callers don't have to
  if (
    options.body &&
    typeof options.body === "string" &&
    !headers["Content-Type"]
  ) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      // Non-JSON response — keep data null and fall through to the
      // error path with the raw text as the message.
    }
  }

  if (!response.ok) {
    const message =
      data && data.error ? data.error : `Request failed: ${response.status}`;
    const err = new Error(message);
    // Attach the full response body and status so callers can inspect
    // structured error fields like `hint`, `active_execution_id`, etc.
    err.status = response.status;
    err.body = data || {};
    err.hint = (data && data.hint) || null;
    throw err;
  }

  return data;
}
