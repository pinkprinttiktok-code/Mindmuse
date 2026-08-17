// functions/api/advise.js
//
// A Cloudflare Pages Function. It runs on Cloudflare's servers, never in the
// browser, so your API key stays hidden. Its URL is /api/advise, which comes
// from this file's path (functions/api/advise.js).
//
// Setup: Cloudflare dashboard -> your Pages project -> Settings ->
//        Variables and Secrets -> add GEMINI_API_KEY -> redeploy.

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_CHARS = 6000;
const MAX_TURNS = 12;

const SYSTEM = `You are the academic advisor inside MindMuse, a course-planning site for high school students. You are talking directly to a high schooler, usually 14 to 18 years old.

How to advise:
- Be specific and concrete. "Take AP Statistics junior year, it satisfies the stats requirement at most nursing programs" beats "consider math courses."
- Be honest about tradeoffs, including when a goal is unrealistic on the current trajectory. Say it kindly and immediately offer the alternative route, because a real path is more useful than false reassurance.
- Never promise or predict admission anywhere. You can describe typical ranges and what schools tend to weigh.
- Course offerings, credit policies, and graduation requirements vary enormously by school and state. When something depends on local specifics, say so and tell them to confirm with their counselor.
- Name what's actually going well before what isn't. These are teenagers looking at their own grades.
- Grades are not a measure of a person's worth, and never imply otherwise.
- Keep it to a few short paragraphs or a tight list. They're reading on a phone. Always finish the thought you started \u2014 a complete short answer beats a detailed one that stops halfway.

Stay on academics, courses, testing, college planning, and careers. If a student raises something personal or serious — family difficulty, mental health, anything where they sound like they're struggling — respond with warmth, keep it brief, and encourage them to talk to a school counselor or a trusted adult. Do not try to counsel them yourself.`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  }
});

export async function onRequestOptions() {
  return json({}, 204);
}

export async function onRequestGet() {
  return json({ error: "Use POST." }, 405);
}

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    return json({ error: "No API key configured yet. In Cloudflare, go to your Pages project, Settings, Variables and Secrets, and add GEMINI_API_KEY. Then redeploy — variables only apply to new deployments." }, 500);
  }

  let messages;
  try {
    const body = await request.json();
    messages = body.messages;
  } catch {
    return json({ error: "Body wasn't valid JSON." }, 400);
  }
  if (!Array.isArray(messages) || !messages.length) {
    return json({ error: "Send a messages array." }, 400);
  }

  const clean = messages
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (!clean.length) return json({ error: "No usable messages." }, 400);

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
              encodeURIComponent(model) + ":generateContent";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: clean.map(m => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: 8000, temperature: 0.7 }
      })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg =
        res.status === 404 ? 'The model "' + model + '" wasn\'t found. Model IDs change — check the current one at aistudio.google.com and set GEMINI_MODEL in your Cloudflare variables.'
      : res.status === 400 ? "Google rejected the request. Usually the key is wrong or the Generative Language API isn't enabled."
      : res.status === 429 ? "You've hit Google's free-tier rate limit. It resets — wait a minute."
      : res.status === 403 ? "Google denied access. Check the key is valid and available in your region."
      : "Google's API returned an error. Try again shortly.";
      return json({ error: msg }, res.status);
    }

    const cand = (data.candidates || [])[0];
    if (cand && cand.finishReason === "SAFETY") {
      return json({ reply: "I wasn't able to answer that one. Try rephrasing, and keep it to school and career planning." });
    }
    let text = ((cand && cand.content && cand.content.parts) || [])
      .map(p => p.text).filter(Boolean).join("\n").trim();

    // Newer Gemini models spend output tokens on reasoning before writing,
    // so a long answer can still hit the ceiling. Say so rather than stopping mid-word.
    if (cand && cand.finishReason === "MAX_TOKENS" && text) {
      text += "\n\n*(That's as far as I got — ask me to keep going and I'll pick up where I left off.)*";
    }

    return json({ reply: text || "No response came back. Try again." });

  } catch {
    return json({ error: "Couldn't reach the AI service. Try again in a moment." }, 500);
  }
}
