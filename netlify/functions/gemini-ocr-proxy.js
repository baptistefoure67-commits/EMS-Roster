// Relais OCR Gemini strict pour Pillbox.
// Le client ne choisit ni le modèle, ni le prompt, ni le schéma Gemini :
// il transmet uniquement une image + une liste optionnelle de noms EMS.

const { verifyDetailed } = require("./session-token");
const { canFor } = require("./permissions");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Pillbox-Session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_OCR_MODEL = process.env.GEMINI_OCR_MODEL || "gemini-3.6-flash";
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ROSTER_NAMES = 500;
const MAX_NAME_LENGTH = 120;

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });

  const { GEMINI_API_KEY, SESSION_SECRET } = process.env;
  if (!GEMINI_API_KEY || !SESSION_SECRET) {
    return json(500, { error: "Configuration manquante côté serveur (GEMINI_API_KEY ou SESSION_SECRET absente sur Netlify)." });
  }

  const sessionToken = (event.headers && (event.headers["x-pillbox-session"] || event.headers["X-Pillbox-Session"])) || "";
  const verification = verifyDetailed(sessionToken, SESSION_SECRET);
  if (!verification.payload) return json(401, { error: "Session Discord invalide ou expirée.", code: verification.reason });
  if (!(await canFor(verification.payload, "use_pillbox_terminal"))) return json(403, { error: "Accès au Terminal Paie refusé." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Requête invalide (JSON attendu)." }); }

  const allowedKeys = new Set(["imageBase64", "mimeType", "rosterNames"]);
  const extraKeys = Object.keys(body).filter(k => !allowedKeys.has(k));
  if (extraKeys.length) return json(400, { error: `Champs OCR non autorisés : ${extraKeys.join(", ")}.` });

  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.trim() : "";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType.trim().toLowerCase() : "";
  const rosterNames = body.rosterNames === undefined ? [] : body.rosterNames;
  if (!imageBase64 || !ALLOWED_MIME.has(mimeType)) return json(400, { error: "Format OCR invalide (imageBase64 + mimeType image/png|jpeg|webp attendus)." });
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return json(400, { error: "Image Base64 invalide." });
  const imageBytes = Math.floor(imageBase64.length * 3 / 4) - (imageBase64.endsWith("==") ? 2 : imageBase64.endsWith("=") ? 1 : 0);
  if (imageBytes <= 0 || imageBytes > MAX_IMAGE_BYTES) return json(413, { error: `Image trop volumineuse (max ${MAX_IMAGE_BYTES / 1024 / 1024} Mo).` });
  if (!Array.isArray(rosterNames) || rosterNames.length > MAX_ROSTER_NAMES || rosterNames.some(n => typeof n !== "string" || n.length > MAX_NAME_LENGTH)) {
    return json(400, { error: "Liste rosterNames invalide ou trop volumineuse." });
  }

  const cleanNames = [...new Set(rosterNames.map(n => n.trim()).filter(Boolean))].slice(0, MAX_ROSTER_NAMES);
  const rosterHint = cleanNames.length
    ? `\n\nLISTE DES EMPLOYÉS CONNUS (utilise exactement l'orthographe d'un nom de cette liste quand il correspond à ce que tu vois) :\n${cleanNames.join("\n")}`
    : "";

  const prompt = `Tu es un OCR spécialisé dans la lecture de tableaux de jeux vidéo. Analyse visuellement la capture d'écran fournie.

Le tableau contient notamment ces colonnes :
- RANG : numéro tout à gauche
- EMPLOYÉ : nom de la personne
- CONTRIBUTION : pourcentage (À IGNORER)
- RÉANIMATIONS : nombre de réanimations
- FACTURES ENCAISSÉES : À IGNORER
- MONTANT FACTURES : À IGNORER

MISSION : extraire CHAQUE ligne visible du tableau et UNIQUEMENT ces 3 champs :
1. rank = numéro exact affiché dans la colonne RANG
2. name = nom exact affiché dans la colonne EMPLOYÉ
3. rea = nombre exact affiché dans la colonne RÉANIMATIONS

RÈGLES TRÈS IMPORTANTES :
- Lis ligne par ligne, de haut en bas.
- Le numéro de RANG est indépendant du nombre de lignes détectées : ne le renumérote jamais.
- Le nombre RÉANIMATIONS est la colonne située après CONTRIBUTION. Ne prends JAMAIS le pourcentage comme réanimation.
- Ne prends JAMAIS un nombre provenant de FACTURES ou MONTANT FACTURES.
- Un 0 visible dans RÉANIMATIONS doit être retourné comme 0.
- Ne fusionne jamais deux lignes.
- N'invente aucune ligne et n'en oublie aucune.
- Si le nom ressemble à un nom connu de la liste ci-dessous, utilise exactement ce nom.
- Retourne uniquement le JSON demandé, sans commentaire.${rosterHint}`;

  const payload = {
    contents: [{ parts: [
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: imageBase64 } },
    ]}],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            rank: { type: "INTEGER" },
            name: { type: "STRING" },
            rea: { type: "INTEGER" },
          },
          required: ["rank", "name", "rea"],
        },
      },
      temperature: 0,
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_OCR_MODEL)}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
    );
    const text = await res.text();
    return { statusCode: res.status, headers: { "Content-Type": "application/json", ...corsHeaders }, body: text };
  } catch (err) {
    return json(502, { error: `Impossible de joindre Gemini : ${err.message}` });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) };
}
