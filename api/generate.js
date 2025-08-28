// api/generate.js
// POST { text: string } -> { cards: [{front, back}, ...] }
// Uses OpenAI to turn notes into flashcards.

export const runtime = "nodejs";

const CORS_ALLOW = [
  "https://cameronmahmood.github.io",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
];

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (CORS_ALLOW.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Safely parse body
    let body = req.body;
    if (typeof body === "string") try { body = JSON.parse(body); } catch {}
    const text = (body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "No text" });

    const prompt = `
Turn the following notes into concise flashcards.
Return JSON with the shape:
{ "cards": [ { "front": "Q or term", "back": "answer" }, ... ] }
Keep cards short and specific. 8–15 cards max.

NOTES:
${text}
`.trim();

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: json?.error?.message || "OpenAI error", raw: json });
    }

    // Parse assistant JSON
    let data;
    try {
      data = JSON.parse(json.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      return res.status(502).json({ error: "Bad JSON from model", raw: json });
    }

    const cards = Array.isArray(data?.cards) ? data.cards.filter(c => c?.front && c?.back) : [];
    return res.json({ cards });
  } catch (e) {
    console.error("GENERATE_ERR:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
