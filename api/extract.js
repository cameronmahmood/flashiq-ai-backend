// api/extract.js
export const runtime = "nodejs";
export const config = { api: { bodyParser: false } };

import Busboy from "busboy";
import pdfParse from "pdf-parse";
import AdmZip from "adm-zip";

// ---- CORS ----
const CORS_ALLOW = [
  "https://cameronmahmood.github.io",
  "https://cameronmahmood.github.io/flashiq",
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

// ---- multipart to memory ----
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const files = [];
    const fields = {};
    bb.on("file", (name, file, info) => {
      const chunks = [];
      const { filename, mimeType } = info || {};
      file.on("data", d => chunks.push(d));
      file.on("end", () => files.push({
        fieldname: name,
        filename: filename || "unnamed",
        mimeType: mimeType || "application/octet-stream",
        buffer: Buffer.concat(chunks),
      }));
    });
    bb.on("field", (n, v) => fields[n] = v);
    bb.on("error", reject);
    bb.on("close", () => resolve({ files, fields }));
    req.pipe(bb);
  });
}

// ---- helpers: file type ----
const isImage = mt => /^image\//i.test(mt);
const isPdf   = (mt, name) => mt === "application/pdf" || /\.pdf$/i.test(name);
const isPptx  = (mt, name) =>
  mt === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || /\.pptx$/i.test(name);
const isTxt   = (mt, name) => (mt || "").startsWith("text/") || /\.txt$/i.test(name);

// ---- OCR with OpenAI Vision ----
async function ocrWithOpenAI(buf, mime = "image/jpeg") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const b64 = buf.toString("base64");
  const url = `data:${mime};base64,${b64}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Extract legible text from this image. If handwritten, transcribe it." },
          { type: "image_url", image_url: { url } }
        ]
      }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "OpenAI OCR error");
  return (j.choices?.[0]?.message?.content || "").trim();
}

// ---- PPTX: read text from slide XMLs + OCR images in ppt/media ----
async function extractFromPptx(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // 1) Text from slides XML
  const slides = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)\.xml/)?.[1] || "0", 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/)?.[1] || "0", 10);
      return na - nb;
    });

  const pieces = [];
  for (const e of slides) {
    const xml = e.getData().toString("utf8");
    const matches = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)];
    const text = matches.map(m => m[1]).join(" ").trim();
    if (text) pieces.push(text);
  }

  // 2) OCR images if present
  const mediaImages = entries.filter(e => /^ppt\/media\/.+\.(png|jpe?g|webp)$/i.test(e.entryName));
  for (const img of mediaImages) {
    const buf = img.getData();
    try {
      const t = await ocrWithOpenAI(buf, guessMimeFromName(img.entryName));
      if (t) pieces.push(t);
    } catch (_) { /* ignore single image errors */ }
  }

  return pieces.join("\n\n");
}

function guessMimeFromName(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "image/jpeg";
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { files } = await parseMultipart(req);
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });

    const results = [];
    for (const f of files) {
      try {
        let text = "";

        if (isPdf(f.mimeType, f.filename)) {
          const parsed = await pdfParse(f.buffer);
          text = (parsed.text || "").trim();

        } else if (isPptx(f.mimeType, f.filename)) {
          text = (await extractFromPptx(f.buffer)).trim();

        } else if (isTxt(f.mimeType, f.filename)) {
          text = f.buffer.toString("utf8");

        } else if (isImage(f.mimeType)) {
          text = await ocrWithOpenAI(f.buffer, f.mimeType);
        }

        // Ultimate fallback: OCR anything that yielded nothing
        if (!text.trim()) {
          text = await ocrWithOpenAI(f.buffer, "image/jpeg");
        }

        if (text.trim()) results.push({ file: f.filename, ok: true, text });
        else results.push({ file: f.filename, ok: false, error: "No extractable text found" });

      } catch (err) {
        results.push({ file: f.filename, ok: false, error: String(err.message || err) });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
