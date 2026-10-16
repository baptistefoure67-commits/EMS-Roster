// ═══════════════════════════════════════════════════════════════════
// session-token.js — signe et vérifie un jeton de session côté serveur
// UNIQUEMENT. Le secret utilisé ici (SESSION_SECRET, variable
// d'environnement Netlify) n'a AUCUN rapport avec Discord — c'est un
// secret propre à Pillbox/Roster, à générer une fois (une longue chaîne
// aléatoire) et à ne jamais mettre dans le code ni le partager.
//
// Le jeton contient juste ce qu'il faut pour vérifier une permission :
// {discordId, name, grade, exp} — jamais un mot de passe, jamais le
// secret lui-même. Signé en HMAC-SHA256 : impossible à fabriquer ou
// modifier sans connaître SESSION_SECRET, qui ne quitte jamais le
// serveur (07/09 — étape 2 : protection réelle des actions).
// ═══════════════════════════════════════════════════════════════════

const crypto = require("crypto");

const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2h — au-delà, il faut se reconnecter

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString("utf8");
}

function sign(payloadObj, secret) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = base64url(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

// Renvoie le payload {discordId, name, grade, exp} si le jeton est
// valide (signature ET expiration), sinon null. JAMAIS de confiance
// aveugle : recalcule la signature soi-même et compare en temps
// constant, plutôt que de juste "faire confiance" au contenu envoyé.
function verifyDetailed(token, secret) {
  if (!token || typeof token !== "string") return { payload: null, reason: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { payload: null, reason: "malformed_token" };
  if (!secret || typeof secret !== "string") return { payload: null, reason: "missing_server_secret" };

  const [payload, sig] = parts;
  const expectedSig = base64url(crypto.createHmac("sha256", secret).update(payload).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { payload: null, reason: "invalid_signature" };
  }

  let data;
  try {
    data = JSON.parse(base64urlDecode(payload));
  } catch (e) {
    return { payload: null, reason: "invalid_payload" };
  }
  if (!data || !Number.isFinite(data.exp)) return { payload: null, reason: "missing_expiration" };
  if (Date.now() > data.exp) return { payload: null, reason: "expired_token" };
  if (!data.discordId || !data.level) return { payload: null, reason: "incomplete_session" };
  return { payload: data, reason: null };
}

function verify(token, secret) {
  return verifyDetailed(token, secret).payload;
}

module.exports = { sign, verify, verifyDetailed, TOKEN_LIFETIME_MS };
