// (19/10) Relais pour l'OCR Gemini utilisé par Pillbox (lecture des
// captures d'écran de réanimations). La clé GEMINI_API_KEY ne doit
// JAMAIS vivre dans le code envoyé au navigateur — n'importe qui peut
// l'extraire en 2 clics via "Afficher le code source" et l'utiliser à
// la place de Pillbox, sur son propre quota. Ici, la clé reste
// uniquement côté serveur (variable d'environnement Netlify), et ce
// relais se contente de transmettre tel quel le corps de la requête
// que Pillbox construit déjà (prompt + image) vers l'API Google.
//
// Protégé par la vraie session Discord signée de Pillbox. Aucun secret fixe
// n'est présent dans le navigateur : le jeton de session est vérifié côté
// serveur avec SESSION_SECRET avant tout appel à Gemini.


const { verifyDetailed } = require("./session-token");
const { canFor } = require("./permissions");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  const { GEMINI_API_KEY, SESSION_SECRET } = process.env;
  if (!GEMINI_API_KEY || !SESSION_SECRET) {
    return json(500, { error: "Configuration manquante côté serveur (GEMINI_API_KEY ou SESSION_SECRET absente sur Netlify)." });
  }

  const sessionToken = (event.headers && (event.headers["x-pillbox-session"] || event.headers["X-Pillbox-Session"])) || "";
  const verification = verifyDetailed(sessionToken, SESSION_SECRET);
  if (!verification.payload) {
    return json(401, { error: "Session Discord invalide ou expirée.", code: verification.reason });
  }
  if (!(await canFor(verification.payload, "use_pillbox_terminal"))) {
    return json(403, { error: "Accès au Terminal Paie refusé." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Requête invalide (JSON attendu)." });
  }

  // model : transmis par Pillbox (GEMINI_MODEL), jamais codé en dur ici,
  // pour ne jamais avoir à toucher cette fonction si Google change à
  // nouveau les modèles disponibles (déjà arrivé une fois, voir le
  // commentaire sur GEMINI_MODEL côté Pillbox).
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gemini-3.6-flash";
  const payload = body.payload;
  if (!payload) return json(400, { error: "Paramètre 'payload' manquant." });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const text = await res.text();
    // Transmis tel quel (statut Google inclus, ex. 429 quota) — Pillbox
    // sait déjà interpréter un 429 pour basculer sur Tesseract, jamais
    // besoin de réinventer cette logique ici.
    return { statusCode: res.status, headers: { "Content-Type": "application/json", ...corsHeaders }, body: text };
  } catch (err) {
    return json(502, { error: `Impossible de joindre Gemini : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) };
}
