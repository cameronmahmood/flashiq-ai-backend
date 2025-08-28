// api/extract.js
import Busboy from 'busboy';
import pdfParse from 'pdf-parse';
import { readPptx } from 'pptx-parser';
import OpenAI from 'openai';

export const config = { api: { bodyParser: false } };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const files = [];
    bb.on('file', (name, file, info) => {
      const chunks = [];
      file.on('data', d => chunks.push(d));
      file.on('end', () => {
        files.push({
          filename: info.filename,
          mime: info.mimeType || info.mime,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve({ files }));
    req.pipe(bb);
  });
}

async function ocrImageToText(buffer, mime) {
  // Use OpenAI Vision (gpt-4o-mini) to extract clean text
  const b64 = buffer.toString('base64');
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Extract readable study notes text from this image. Only return text.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
      ]
    }],
    temperature: 0.2
  });
  return res.choices?.[0]?.message?.content || '';
}

export default async function handler(req, res) {
  // CORS (same allowlist you used in generate.js)
  const origin = req.headers.origin || '';
  const allow = ["https://cameronmahmood.github.io", "http://localhost:8000"];
  if (allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { files } = await parseForm(req);
    if (!files?.length) return res.status(400).json({ error: 'No files' });

    let combined = '';
    for (const f of files) {
      const ext = (f.filename.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') {
        const data = await pdfParse(f.buffer);
        combined += `\n\n${data.text || ''}`;
      } else if (ext === 'ppt' || ext === 'pptx') {
        const deck = await readPptx(f.buffer);
        const slideText = deck.slides.map(s => (s.text || '').trim()).join('\n');
        combined += `\n\n${slideText}`;
      } else if (ext === 'docx') {
        // Optional: add 'mammoth' to parse docx if you want
        combined += `\n\n[.docx parsing not implemented yet]`;
      } else if ((f.mime || '').startsWith('image/')) {
        const txt = await ocrImageToText(f.buffer, f.mime || 'image/png');
        combined += `\n\n${txt}`;
      } else {
        // fallback: try to treat as text
        combined += `\n\n${f.buffer.toString('utf8')}`;
      }
    }

    // Trim and limit (avoid huge prompts)
    const text = combined.replace(/\s+\n/g, '\n').trim().slice(0, 12000); // keep it sane
    return res.json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'extract-failed' });
  }
}
