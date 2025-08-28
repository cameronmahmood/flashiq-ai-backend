// POST { text } → { cards: [{front,back}, ...] }
export const runtime = "nodejs";
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const origin = req.headers.origin || "";
  const allow = ["https://cameronmahmood.github.io", "http://localhost:8080", "http://localhost:5173"];
  if (allow.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const text = (body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "No text" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [{
          role: "user",
          content: `Make 5 concise flashcards from this:\n\n${text}\n\nReturn JSON: {"cards":[{"front":"...","back":"..."}]}`
        }]
      })
    });

    const json = await resp.json();
    if (!resp.ok) {
      console.error("OPENAI_ERROR", json);
      return res.status(502).json({ error: json?.error?.message || "OpenAI error" });
    }

    // Try to parse model output into JSON
    let payload = null;
    try {
      payload = JSON.parse(json.choices?.[0]?.message?.content || "{}");
    } catch {
      // weak fallback: attempt to extract a JSON block
      const raw = json.choices?.[0]?.message?.content || "";
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) payload = JSON.parse(m[0]);
    }
    const cards = (payload?.cards || []).filter(c => c.front && c.back).slice(0, 20);
    res.json({ cards });
  } catch (e) {
    console.error("GEN_ERROR", e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
