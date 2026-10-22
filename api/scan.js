// Serverless function: keeps your Gemini key on the server, never in the browser.
// If Google says the model is busy, it retries and falls back to other Gemini Flash models.
const FIX = ["tube_to_led","bulb_to_led","fan_to_bldc","ac_to_inverter","ac_tune_up","standby_cut","geyser_timer","lights_off"];
const PROMPT = `You are an energy auditor for Indian homes. Look at the photo and list energy-using items or energy waste (old tube lights, incandescent bulbs, old AC, fans left on, standby devices, geyser...). Return ONLY a JSON list. Each item: {"item": str, "issue": str, "fix_type": one of ${JSON.stringify(FIX)}, "quantity": int, "watts_each": number (typical for that item), "hours_per_day": number, "box_2d": [ymin, xmin, ymax, xmax] scaled 0-1000}. Max 8 items. If nothing is visible, return [].`;
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const BUSY = (r, j) => [429, 500, 502, 503, 504].includes(r.status) || /high demand|overload|unavailable|try again later|quota/i.test(JSON.stringify(j));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(model, key, image, extra, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: "application/json", ...extra },
      }),
      signal: c.signal,
    });
  } finally { clearTimeout(t); }
}

// Find other Flash models this key can use (only runs when the main model is busy).
async function discover(key, primary) {
  const out = [primary];
  try {
    const r = await fetch(`${API}?pageSize=200`, { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    const ok = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/i.test(m.name) && !/image|tts|live|audio|embed|robotics|computer|thinking|exp/i.test(m.name))
      .map(m => m.name.replace(/^models\//, ""));
    ok.sort((a, b) => (/lite/i.test(a) - /lite/i.test(b)) || b.localeCompare(a));
    for (const n of ok) if (!out.includes(n)) out.push(n);
  } catch (e) {}
  return out.slice(0, 4);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel settings" });
  const image = req.body && req.body.image;
  if (!image || image.length > 4000000) return res.status(400).json({ error: "Missing or too-large image" });
  const primary = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const t0 = Date.now();
  let models = [primary];
  try {
    for (let i = 0; i < 6 && Date.now() - t0 < 30000; i++) {
      const model = models[i % models.length];
      let r, j;
      try {
        r = await call(model, key, image, { thinkingConfig: { thinkingLevel: "low" } }, 22000);
        j = await r.json();
        if (!r.ok && /think/i.test(JSON.stringify(j))) { r = await call(model, key, image, {}, 22000); j = await r.json(); }
      } catch (e) {
        if (e.name !== "AbortError") throw e;
        r = { ok: false, status: 504 }; j = { error: { message: "timeout" } };
      }
      if (r.ok) {
        const txt = (j.candidates?.[0]?.content?.parts?.[0]?.text || "[]").replace(/```json|```/g, "").trim();
        return res.status(200).json({ findings: JSON.parse(txt), tokens: j.usageMetadata?.totalTokenCount || 1500, model });
      }
      if (!BUSY(r, j)) return res.status(502).json({ error: (j.error && j.error.message) || "Gemini error" });
      if (models.length === 1) models = await discover(key, primary);
      await sleep(1200);
    }
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
  return res.status(503).json({ error: "Google's AI is busy right now. Please wait a few seconds and tap Run Green Audit again." });
};
