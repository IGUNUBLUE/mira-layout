// Pure: a Responses API server-sent-event stream (read whole) into its text.
// Only `response.completed` counts as success (SIWC "Models and inference").

export const QUOTA_CODES = ["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"];

/**
 * Returns { ok: true, text } or { ok: false, code, message }.
 * code: a server error code, "interrupted" (no terminal event) or "invalid_event".
 */
export function parseResponseStream(body) {
  let delta = "", completed = null;
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { return { ok: false, code: "invalid_event", message: "The response stream could not be read." }; }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") delta += event.delta;
    else if (event.type === "response.completed") completed = event.response;
    else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      const err = event.response?.error ?? event.error ?? event;
      const code = err?.code ?? (event.type === "response.incomplete" ? event.response?.incomplete_details?.reason ?? "incomplete" : "failed");
      return { ok: false, code, message: err?.message ?? describe(code) };
    }
  }
  if (!completed) return { ok: false, code: "interrupted", message: "The response ended before it completed." };
  const text = outputText(completed) || delta;
  return { ok: true, text };
}

function outputText(response) {
  let out = "";
  for (const item of response?.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") out += c.text;
  }
  return out;
}

/** A sentence for the person, by error code. */
export function describe(code, status) {
  if (code === "subscription_sharing_usage_limit_exceeded") return "Your ChatGPT plan's usage limit for apps is reached. Try again later.";
  if (code === "subscription_sharing_usage_unavailable") return "ChatGPT plan usage isn't available for this account or workspace.";
  if (status === 401) return "The ChatGPT session expired or was revoked. Sign in again.";
  if (status === 403) return "This ChatGPT account isn't allowed to use its plan here. Sign in again or check the workspace settings.";
  if (status === 404 || code === "model_not_found") return "The model isn't available for your plan. Pick another model.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500) return `OpenAI answered ${status}. Try again in a moment.`;
  return `The request failed (${code ?? status}).`;
}
