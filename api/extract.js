// api/extract.js
// Upload one or more files and get back extracted text.
// Supports: PDF, PPTX (best-effort), images (OCR with OpenAI Vision), TXT.
// Friendly fallback if PPTX parsing fails. Uses CORS allowlist.
//
// Env: OPENAI_API_KEY (Vercel Project Settings → Environment Variables)

import Busboy from "busboy";
import pdfParse from "pdf-parse";
import { readPptx } from "pptx-parser";

// ====== CONFIG ======
const CORS_ALLOW = [
  "https://cameronmahmood.github.io",
  "http://localhost:8000",
  "http://localhost:5173",
  "http://127.0.0.1:8000",
];

// Disable Vercel / Next default JSON body parsing so we can stream multipart
export const config = { api: { bodyParser: false } };

// ====== Helpers ======
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (CORS_ALLOW.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const files = [];

    bb.on("file", (fieldname, file, info) => {
      const { filename, mimeType } = info || {};
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        files.push({
          fieldname,
          filename: filename || "upload.bin",
          mime: mimeType || "application/octet-stream",
          buffer: Buffer.concat(chunks),
        });
      });
    });

    bb.on("error", reject);
    bb.on("finish", () => resolve({ files }));
    req.pipe(bb);
  });
}

// OpenAI Vision OCR (for images/handwriting)
async function ocrWithOpenAIVision(buffer, mime) {
  const b64 = buffer.toString("base64");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Extract clean, readable study notes text from the image. Return only the text—no commentary.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime};base64,${b64}` },
            },
          ],
        },
      ],
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("OpenAI Vision error:", data);
    throw new Error("vision-failed");
  }
  return data?.choices?.[0]?.message?.content || "";
}

// ====== Main handler ======
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    // 1) Parse multipart form (supports multiple files)
    const { files } = await parseMultipart(req);
    if (!files?.length) return res.status(400).json({ error: "No files" });

    let combinedText = "";

    // 2) Process each file
    for (const f of files) {
      const name = f.filename || "upload.bin";
      const ext = (name.split(".").pop() || "").toLowerCase();
      const mime = f.mime || "application/octet-stream";

      // --- PDF ---
      if (ext === "pdf" || mime === "application/pdf") {
        try {
          const data = await pdfParse(f.buffer);
          combinedText += `\n\n${(data.text || "").trim()}`;
        } catch (err) {
          console.error("PDF parse failed:", err);
          combinedText += `\n\n[Could not parse PDF: ${name}]`;
        }
        continue;
      }

      // --- PPT / PPTX ---
      if (ext === "ppt" || ext === "pptx") {
        try {
          const deck = await readPptx(f.buffer);
          const slides = Array.isArray(deck?.slides) ? deck.slides : [];
          const slideText = slides.map((s) => (s.text || "").trim()).join("\n");
          if (slideText) {
            combinedText += `\n\n${slideText}`;
          } else {
            combinedText += `\n\n[No visible text found in ${name}]`;
          }
        } catch (err) {
          console.error("PPTX parse failed, fallback hint:", err);
          // Fallback: tell user to export slides to PDF (most reliable)
          combinedText +=
            `\n\n[Could not parse ${name} directly. ` +
            `Tip: Export slides as PDF and re-upload for best results.]`;
        }
        continue;
      }

      // --- Images (JPEG/PNG/etc) → OCR ---
      if ((mime || "").startsWith("image/")) {
        try {
          const text = await ocrWithOpenAIVision(f.buffer, mime);
          combinedText += `\n\n${text.trim()}`;
        } catch (err) {
          console.error("OCR failed:", err);
          combinedText += `\n\n[Could not OCR image: ${name}]`;
        }
        continue;
      }

      // --- Plain text files ---
      if (ext === "txt" || mime === "text/plain") {
        combinedText += `\n\n${f.buffer.toString("utf8").trim()}`;
        continue;
      }

      // --- DOCX (optional) ---
      // If you want DOCX, add "mammoth" to deps and implement here.
      if (ext === "docx") {
        combinedText += `\n\n[.docx parsing not implemented. Convert to PDF or TXT.]`;
        continue;
      }

      // --- Fallback: try UTF-8 ---
      try {
        combinedText += `\n\n${f.buffer.toString("utf8").trim()}`;
      } catch {
        combinedText += `\n\n[Unsupported file: ${name}]`;
      }
    }

    // 3) Clean & limit size to keep prompts sane
    const cleaned =
      combinedText.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const limited = cleaned.slice(0, 12000); // ~12k chars max

    return res.status(200).json({ text: limited });
  } catch (err) {
    console.error("extract.js fatal:", err);
    return res.status(500).json({ error: "extract-failed" });
  }
}
