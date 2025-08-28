// POST multipart form: field name "file" → { results: [{file, ok, text}] }
export const runtime = "nodejs";
export const config = { api: { bodyParser: false } };

import Busboy from "busboy";
import pdfParse from "pdf-parse";
import AdmZip from "adm-zip";

const ALLOW = ["https://cameronmahmood.github.io", "http://localhost:8080", "http://localhost:5173"];
function cors(req, res) {
  const o = req.headers.origin || "";
  if (ALLOW.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const files = [];
    bb.on("file", (_name, file, info) => {
      const chunks = [];
      const { filename, mimeType } = info;
      file.on("data", d => chunks.push(d));
      file.on("end", () => files.push({ filename, mimeType, buffer: Buffer.concat(chunks) }));
    });
    bb.on("error", reject);
    bb.on("close", () => resolve(files));
    req.pipe(bb);
  });
}

function isPdf(mt, name) { return mt === "application/pdf" || /\.pdf$/i.test(name); }
function isPptx(mt, name) {
  return mt === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || /\.pptx$/i.test(name);
}
function isImage(mt) { return /^image\//i.test(mt); }
function isTxt(mt, name) { return mt?.startsWith("text/") || /\.txt$/i.test(name); }

function extractPptx(buffer) {
  const zip = new AdmZip(buffer);
  const slides = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = +(a.entryName.match(/slide(\d+)\.xml/)?.[1] || 0);
      const nb = +(b.entryName.match(/slide(\d+)\.xml/)?.[1] || 0);
      return na - nb;
    });
  const out = [];
  for (const s of slides) {
    const xml = s.getData().toString("utf8");
    const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(m => m[1]).join(" ");
    if (text.trim()) out.push(text);
  }
  return out.join("\n\n");
}

async function ocrWithOpenAI(buffer, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Transcribe the legible text from this image. If handwriting, do your best." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }]
    })
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "OpenAI OCR error");
  return json.choices?.[0]?.message?.content?.trim() || "";
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const files = await parseMultipart(req);
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });

    const results = [];
    for (const f of files) {
      try {
        let text = "";
        if (isTxt(f.mimeType, f.filename)) text = f.buffer.toString("utf8");
        else if (isPdf(f.mimeType, f.filename)) text = (await pdfParse(f.buffer)).text || "";
        else if (isPptx(f.mimeType, f.filename)) text = extractPptx(f.buffer);
        if (!text.trim() && isImage(f.mimeType)) text = await ocrWithOpenAI(f.buffer, f.mimeType);

        if (!text.trim()) results.push({ file: f.filename, ok: false, error: "No extractable text found" });
        else results.push({ file: f.filename, ok: true, text: text.trim() });
      } catch (e) {
        console.error("EXTRACT_FILE_ERROR", f.filename, e);
        results.push({ file: f.filename, ok: false, error: String(e.message || e) });
      }
    }
    res.json({ results });
  } catch (e) {
    console.error("EXTRACT_ERROR", e);
    res.status(500).json({ error: String(e.message || e) });
  }
}
