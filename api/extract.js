// api/extract.js
// Upload one or more files and get back extracted text.
// Supports: PDF, PPTX (unzip + read slide XML), images (OCR with OpenAI Vision), TXT.
// Env: OPENAI_API_KEY (Vercel Project Settings → Environment Variables)

export const runtime = "nodejs";
export const config = { api: { bodyParser: false } };

// ---- Imports ----
import Busboy from "busboy";
import pdfParse from "pdf-parse";
import AdmZip from "adm-zip";

// ====== CONFIG ======
const CORS_ALLOW = [
  "https://cameronmahmood.github.io",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://127.0.0.1:8080",
];

// helper: set CORS headers
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (CORS_ALLOW.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---- Parse multipart using Busboy into memory ----
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const files = [];
    const fields = {};
    bb.on("file", (name, file, info) => {
      const chunks = [];
      const { filename, mimeType } = info;
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files.push({
          fieldname: name,
          filename: filename || "unnamed",
          mimeType: mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks),
        });
      });
    });
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("error", reject);
    bb.on("close", () => resolve({ files, fields }));
    req.pipe(bb);
  });
}

// ---- Simple PPTX text extractor (reads slide XMLs) ----
function unescapeXML(str = "") {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTextFromPptx(buffer) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // collect slide XML files: ppt/slides/slide1.xml, slide2.xml, ...
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/slide(\d+)\.xml/)?.[1] || "0", 10);
      const nb = parseInt(b.entryName.match(/slide(\d+)\.xml/)?.[1] || "0", 10);
      return na - nb;
    });

  const all = [];
  for (const e of slideEntries) {
    const xml = e.getData().toString("utf8");

    // grab text in <a:t>…</a:t>
    const textRuns = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      unescapeXML(m[1]).replace(/\s+/g, " ").trim()
    );

    // convert explicit line breaks <a:br/> to newlines (approx by splitting shapes)
    const slideText = textRuns.join(" ").trim();
    if (slideText) all.push(slideText);
  }
  return all.join("\n\n");
}

// ---- OCR using OpenAI Vision for images / fallback ----
async function ocrWithOpenAI(buffer, mimeType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const b64 = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${b64}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Extract legible text from this image. If handwritten, transcribe it as best as possible.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.2,
    }),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.error?.message || "OpenAI OCR error");
  }
  return json.choices?.[0]?.message?.content?.trim() || "";
}

function isImageType(mt) {
  return /^image\//i.test(mt);
}
function isPdf(mt, name) {
  return mt === "application/pdf" || /\.pdf$/i.test(name);
}
function isPptx(mt, name) {
  return (
    mt ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    /\.pptx$/i.test(name)
  );
}
function isText(mt, name) {
  return mt?.startsWith?.("text/") || /\.txt$/i.test(name);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const { files } = await parseMultipart(req);
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });

    const results = [];
    for (const f of files) {
      let text = "";
      try {
        if (isPdf(f.mimeType, f.filename)) {
          const parsed = await pdfParse(f.buffer);
          text = (parsed.text || "").trim();
        } else if (isPptx(f.mimeType, f.filename)) {
          text = extractTextFromPptx(f.buffer);
          // If we somehow got nothing, keep text="" and let OCR try as fallback
        } else if (isText(f.mimeType, f.filename)) {
          text = f.buffer.toString("utf8");
        }

        if (!text.trim() && isImageType(f.mimeType)) {
          // OCR images with OpenAI Vision
          text = await ocrWithOpenAI(f.buffer, f.mimeType);
        }

        // As a super-safe fallback, try OCR for anything that yielded no text
        if (!text.trim() && !isImageType(f.mimeType)) {
          // Use a common mime that Vision accepts if we don't have an image
          text = await ocrWithOpenAI(f.buffer, "image/jpeg");
        }
      } catch (err) {
        results.push({ file: f.filename, ok: false, error: String(err.message || err) });
        continue;
      }

      if (!text.trim()) {
        results.push({ file: f.filename, ok: false, error: "No extractable text found" });
      } else {
        results.push({ file: f.filename, ok: true, text });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
