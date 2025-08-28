// api/extract.js
export const runtime = "nodejs";
export const config = { api: { bodyParser: false } };

// ---- Imports ----
import Busboy from "busboy";
import pdfParse from "pdf-parse";
import { readPptx } from "pptx-parser";

// ---- CORS allowlist ----
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

export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    const { fileBuffer, filename, mimetype } = await readSingleFile(req);
    if (!fileBuffer) {
      return res.status(400).json({ error: "No file uploaded (field name must be 'file')" });
    }

    const lower = (filename || "").toLowerCase();
    const type = (mimetype || "").toLowerCase();

    let text = "";

    // --- PDF ---
    if (type.includes("pdf") || lower.endsWith(".pdf")) {
      const out = await pdfParse(fileBuffer).catch((e) => {
        throw new Error("PDF parse failed: " + e.message);
      });
      text = (out.text || "").trim();
    }
    // --- PPTX ---
    else if (lower.endsWith(".pptx")) {
      const slides = await readPptx(fileBuffer).catch(() => null);
      if (slides && Array.isArray(slides.slides)) {
        text = slides.slides
          .map((s, i) => `Slide ${i + 1}:\n${(s.text || "").trim()}`)
          .join("\n\n");
      }
      if (!text) {
        // friendly fallback
        text = "[Could not extract PPTX text. Try exporting slides to PDF and upload the PDF.]";
      }
    }
    // --- Plain images or other files (future OCR hook) ---
    else {
      // If you later add OCR, call it here and set 'text' accordingly.
      // For now we return a gentle message.
      text = "[Unsupported file type for text extraction. Use PDF or PPTX.]";
    }

    // trim + guard extremely long responses (Vercel response size limits)
    if (text.length > 200_000) text = text.slice(0, 200_000) + "\n[truncated]";

    return res.status(200).json({ text, filename, bytes: fileBuffer.length });
  } catch (err) {
    console.error("extract error:", err);
    // Show a readable error to the frontend for debugging
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}

// -------- Busboy: read single file named "file" --------
function readSingleFile(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 4.5 * 1024 * 1024 } }); // ~4.5MB
    let fileBuffer = Buffer.alloc(0);
    let filename = "";
    let mimetype = "";
    let gotFile = false;

    bb.on("file", (name, stream, info) => {
      if (name !== "file") {
        // ignore other fields
        stream.resume();
        return;
      }
      gotFile = true;
      filename = info.filename || "";
      mimetype = info.mimeType || info.mimetype || "";
      stream.on("data", (chunk) => (fileBuffer = Buffer.concat([fileBuffer, chunk])));
      stream.on("limit", () => reject(new Error("File too large (limit ~4.5MB)")));
      stream.on("error", reject);
    });

    bb.on("error", reject);
    bb.on("finish", () => resolve({ fileBuffer: gotFile ? fileBuffer : null, filename, mimetype }));

    req.pipe(bb);
  });
}
