// /api/_llm.js
// A thin OpenAI-compatible chat client, pointed at a LiteLLM gateway.
//
//   LLM_BASE_URL   e.g. https://litellm.internal/v1   (the /v1 root, no path)
//   LLM_API_KEY    the gateway's virtual key
//   LLM_MODEL      whatever name the gateway routes on, e.g. claude-haiku-4-5
//
// None of those set -> isConfigured() is false, /api/ask returns 503 and the
// dashboard hides the chat bubble. The rest of the app is unaffected either way.
//
// Why plain JSON in the prompt rather than tool calling: a gateway can route to
// any model, and support for forced tool choice and json_object response format
// varies by provider behind it. Asking for JSON and parsing defensively works
// on every one of them, and the planner's output is validated against the spec
// allowlist afterwards regardless -- so a malformed reply costs a retry, never
// a bad query.

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 20_000;

function config() {
  return {
    baseUrl: String(process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: String(process.env.LLM_API_KEY || ''),
    model: String(process.env.LLM_MODEL || '')
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.baseUrl && c.apiKey && c.model);
}

// A gateway URL may or may not already carry the /v1 suffix. Accept both rather
// than making the person who sets the env var guess which we want.
function completionsUrl(baseUrl) {
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

async function chat({ messages, maxTokens = 500, temperature = 0, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { baseUrl, apiKey, model } = config();
  if (!baseUrl || !apiKey || !model) {
    throw new Error('The assistant is not configured. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(completionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`The assistant timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw new Error(`Could not reach the LLM gateway: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // The gateway's body can echo the request; keep only a short prefix so a key
    // or a prompt never lands in a log line in full.
    throw new Error(`LLM gateway returned ${res.status}. ${detail.slice(0, 200)}`);
  }

  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('LLM gateway returned no message content.');
  return { text, usage: body?.usage || null };
}

// Models wrap JSON in prose or a fenced block often enough that a bare
// JSON.parse is not worth relying on. Take the outermost {...} and parse that.
function parseJsonObject(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The assistant did not return JSON.');
  return JSON.parse(trimmed.slice(start, end + 1));
}

module.exports = { chat, isConfigured, config, parseJsonObject, completionsUrl };
