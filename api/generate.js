// api/generate.js
export default async function handler(req, res) {
  // --- CORS: allow your site to call this API ---
  const origin = req.headers.origin || "";
  const allow = ["https://cameronmahmood.github.io", "http://localhost:8000"];
  if (allow.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Parse body safely
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
  const { text } = body || {};
  if (!text || text.length < 10) return res.status(400).json({ error: "No text" });

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content:
            "Turn study notes into concise flashcards. Reply ONLY with a JSON array: [{\"front\":\"...\",\"back\":\"...\"}]. No prose, no code fences." },
          { role: "user", content:
            `Create 6–15 college-level flashcards. Keep each front/back short and precise.\nNotes:\n${text}` }
        ]
      })
    });

    const data = await resp.json();
    let content = data?.choices?.[0]?.message?.content || "[]";
    content = content.replace(/```json|```/g, "").trim(); // strip code fences if present
    let cards = [];
    try { cards = JSON.parse(content); } catch {}
    cards = (cards || []).filter(c => c?.front && c?.back).slice(0, 20);

    return res.status(200).json({ cards });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "AI error" });
  }
}
