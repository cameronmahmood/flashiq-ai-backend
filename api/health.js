export const runtime = "nodejs";
export default function handler(req, res) {
  res.json({
    ok: true,
    hasKey: !!process.env.OPENAI_API_KEY,
    node: process.version
  });
}
