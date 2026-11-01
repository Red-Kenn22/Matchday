// Matchday screenshot reader (Cloudflare Worker)
// ------------------------------------------------
// Receives a results/fixtures screenshot from the Matchday app, asks Claude to
// read it, and returns the matches as JSON. The Anthropic API key lives here as
// a Cloudflare secret and never reaches the web page.
//
// Setup (Cloudflare dashboard → this Worker → Settings):
//   Secret   ANTHROPIC_API_KEY   your Anthropic API key           (required)
//   KV       LIMITS              a KV namespace for daily limits  (optional but recommended)
//   Variable ALLOWED_ORIGINS     comma-separated sites allowed    (optional)
//   Variable DAILY_LIMIT         reads per team per day           (optional, default 20)
//   Variable MODEL               Claude model id                  (optional)
//
// Open the Worker's URL in a browser to check it: it shows whether the key and
// the limits store are connected.

const DEFAULT_ORIGINS = "https://red-kenn22.github.io";
const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_DAILY_LIMIT = 20;
const MAX_IMAGE_CHARS = 4_000_000; // ~3 MB image once decoded
const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"];

const TOOL = {
  name: "record_matches",
  description: "Record every football match visible in the screenshot.",
  input_schema: {
    type: "object",
    properties: {
      team_names_seen: {
        type: "array",
        items: { type: "string" },
        description: "Every distinct team name visible, spelled exactly as shown.",
      },
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            date: { type: ["string", "null"], description: "YYYY-MM-DD" },
            time: { type: ["string", "null"], description: "HH:MM, 24-hour" },
            competition: { type: ["string", "null"], description: "Competition or league name as shown" },
            type: { type: ["string", "null"], enum: ["league", "cup", "friendly", null] },
            home: { type: "string" },
            away: { type: "string" },
            home_score: { type: ["integer", "null"] },
            away_score: { type: ["integer", "null"] },
            ht_home: { type: ["integer", "null"] },
            ht_away: { type: ["integer", "null"] },
            status: {
              type: "string",
              enum: ["played", "upcoming", "postponed", "abandoned", "walkover", "unknown"],
            },
            venue: { type: ["string", "null"] },
            goals: {
              type: "array",
              description: "Goal events if the screenshot lists them (e.g. a match detail page).",
              items: {
                type: "object",
                properties: {
                  minute: { type: ["integer", "null"] },
                  team: { type: ["string", "null"] },
                  player: { type: ["string", "null"] },
                },
              },
            },
            unsure: {
              type: "array",
              items: { type: "string" },
              description: "Names of any fields above you could not read with confidence.",
            },
          },
          required: ["home", "away", "status"],
        },
      },
      unreadable: {
        type: "array",
        items: { type: "string" },
        description: "Anything that looks like a match but could not be read, described briefly.",
      },
    },
    required: ["team_names_seen", "matches", "unreadable"],
  },
};

function prompt(today) {
  return [
    "This is a screenshot from a grassroots football website or app, usually FA Full-Time (England).",
    "Read every match row and record it with the record_matches tool.",
    "",
    "Rules:",
    `- Today is ${today}. Dates are UK format (DD/MM/YY). Convert to YYYY-MM-DD.`,
    "- Copy team names exactly as shown. A name may appear twice (logo text and label): record it once.",
    "- 'HT 1-2' or '(HT 1-2)' is the half-time score, home first.",
    "- 'L' usually means league, 'Cup' means cup. Put the competition text (e.g. 'U16 A') in competition.",
    "- A row with 'VS' and no score is upcoming. 'P-P' is postponed, 'A-A' abandoned, 'H-W'/'A-W' walkover.",
    "- Never guess. If a value is unclear, set it to null and add the field name to unsure.",
    "- Ignore adverts, menus and news.",
  ].join("\n");
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim());
  const ok = origin && allowed.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Team-Code, X-Media-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors.headers });

    if (request.method === "GET") {
      return json(
        { ok: true, service: "matchday-reader", key: !!env.ANTHROPIC_API_KEY, limits: !!env.LIMITS },
        200,
        cors.headers
      );
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, cors.headers);
    if (!cors.ok) return json({ error: "This site is not allowed to use the reader." }, 403, cors.headers);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Reader is not set up yet (no API key)." }, 503, cors.headers);

    const team = (request.headers.get("X-Team-Code") || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{2,40}$/.test(team)) return json({ error: "Missing team code." }, 400, cors.headers);

    const mediaType = request.headers.get("X-Media-Type") || "image/jpeg";
    if (!MEDIA_TYPES.includes(mediaType)) return json({ error: "Unsupported image type." }, 415, cors.headers);

    // Body is the raw base64 image. It is spliced into the API request as text
    // rather than parsed, which keeps CPU time low on the free plan.
    const image = (await request.text()).trim();
    if (!image) return json({ error: "No image received." }, 400, cors.headers);
    if (image.length > MAX_IMAGE_CHARS) return json({ error: "Image too large." }, 413, cors.headers);
    if (image.includes('"') || image.includes("\\") || image.includes(",")) {
      return json({ error: "Image must be plain base64." }, 400, cors.headers);
    }

    // Daily limit per team (skipped if no KV namespace is bound).
    const limit = parseInt(env.DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT;
    const today = new Date().toISOString().slice(0, 10);
    const limitKey = `${team}:${today}`;
    let used = 0;
    if (env.LIMITS) {
      used = parseInt(await env.LIMITS.get(limitKey), 10) || 0;
      if (used >= limit) {
        return json({ error: `Daily limit reached (${limit} reads). Try again tomorrow.` }, 429, cors.headers);
      }
    }

    const head = JSON.stringify({
      model: env.MODEL || DEFAULT_MODEL,
      max_tokens: 4000,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: "@@IMAGE@@" } },
            { type: "text", text: prompt(today) },
          ],
        },
      ],
    });
    const [before, after] = head.split("@@IMAGE@@");

    let apiRes;
    try {
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: before + image + after,
      });
    } catch (e) {
      return json({ error: "Could not reach the AI service. Try again." }, 502, cors.headers);
    }

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.log("Anthropic error", apiRes.status, detail.slice(0, 500));
      const msg =
        apiRes.status === 400 && /credit|billing/i.test(detail)
          ? "The reader is out of credit."
          : "The AI service could not read this image.";
      return json({ error: msg }, 502, cors.headers);
    }

    const data = await apiRes.json();
    const tool = (data.content || []).find((c) => c.type === "tool_use");
    if (!tool) return json({ error: "No matches found in the image." }, 422, cors.headers);

    if (env.LIMITS) await env.LIMITS.put(limitKey, String(used + 1), { expirationTtl: 60 * 60 * 48 });

    return json(
      { ...tool.input, remaining: env.LIMITS ? Math.max(0, limit - used - 1) : null },
      200,
      cors.headers
    );
  },
};
