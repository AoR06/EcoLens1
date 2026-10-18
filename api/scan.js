// Serverless function: keeps your Gemini key on the server, never in the browser.
const FIX = ["tube_to_led","bulb_to_led","fan_to_bldc","ac_to_inverter","ac_tune_up","standby_cut","geyser_timer","lights_off"];
const PROMPT = `You are an energy auditor for Indian homes. Look at the photo and list energy-using items or energy waste (old tube lights, incandescent bulbs, old AC, fans left on, standby devices, geyser...). Return ONLY a JSON list. Each item: {"item": str, "issue": str, "fix_type": one of ${JSON.stringify(FIX)}, "quantity": int, "watts_each": number (typical for that item), "hours_per_day": number, "box_2d": [ymin, xmin, ymax, xmax] scaled 0-1000}. Max 8 items. If nothing is visible, return [].`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel settings" });
  const image = req.body && req.body.image;
  if (!image || image.length > 4000000) return res.status(400).json({ error: "Missing or too-large image" });
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "Gemini error" });
    let txt = (j.candidates?.[0]?.content?.parts?.[0]?.text || "[]").replace(/```json|```/g, "").trim();
    res.status(200).json({ findings: JSON.parse(txt), tokens: j.usageMetadata?.totalTokenCount || 1500 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
