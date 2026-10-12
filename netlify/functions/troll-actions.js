// ═══════════════════════════════════════════════════════════════════
// troll-actions.js (12/10) — « 🎭 Mode troll », réservé au Concepteur.
//
// Sécurité :
//  - Gestion (créer, modifier, armer, annuler, supprimer, envoyer des
//    médias) : uniquement isTrollAdmin(session) — l'ID Discord du
//    Concepteur. Volontairement HORS du système de permissions : ni un
//    grade, ni une exception individuelle, ni « Tout sélectionner » ne
//    peuvent l'accorder (même un DG, qui hérite de tout le reste).
//  - Stockage (trollJokes / trollMedia) : illisible et inmodifiable
//    directement depuis un navigateur, même connecté. Seul ce serveur y
//    accède, avec un jeton spécial (trollService) que les clients n'ont
//    jamais. Les médias ne sont donc jamais publics.
//  - Livraison : une blague n'est remise QU'À son destinataire (identité
//    Discord vérifiée par la session signée), jamais à quelqu'un d'autre.
//  - Une seule fois par outil : la livraison est « réservée » par une
//    écriture conditionnelle AVANT l'affichage — une actualisation, un
//    deuxième onglet ou un double clic ne la relancent jamais.
//  - Expiration : 7 jours après l'armement. Annulation manuelle possible.
//
// Volontairement AUCUNE trace dans les logs du Roster : ils sont visibles
// par beaucoup de monde, la blague serait éventée.
//
// Médias : Netlify refuse plus de 6 Mo par requête et l'encodage grossit
// les fichiers d'un tiers → découpage en morceaux de 3 Mo à l'envoi comme
// à la lecture. Limites : image 5 Mo (PNG/JPG/WEBP), MP3 7 Mo.
// ═══════════════════════════════════════════════════════════════════

const { verify } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { isTrollAdmin, canFor, OWNER_DISCORD_ID } = require("./permissions");

const BASE = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app";
const CHUNK_BYTES = 3 * 1024 * 1024;
const LIMITS = {
  image: { maxBytes: 5 * 1024 * 1024, mimes: ["image/png", "image/jpeg", "image/webp"] },
  audio: { maxBytes: 7 * 1024 * 1024, mimes: ["audio/mpeg", "audio/mp3"] },
};
const EXPIRY_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 500, MAX_NAME = 80;
const APPS = ["roster", "pillbox"];

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(statusCode, obj){ return { statusCode, headers: { "Content-Type": "application/json", ...corsHeaders }, body: JSON.stringify(obj) }; }

async function trollToken(){
  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY } = process.env;
  const customToken = createFirebaseCustomToken({ clientEmail: FIREBASE_CLIENT_EMAIL, privateKey: FIREBASE_PRIVATE_KEY, uid: "troll-service", claims: { trollService: true } });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_WEB_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error("authentification du stockage impossible");
  return data.idToken;
}
const url = (path, tok) => `${BASE}/${path}.json?auth=${tok}`;
async function get(path, tok){ const r = await fetch(url(path, tok)); if (!r.ok) throw new Error(`lecture ${r.status}`); return r.json(); }
async function put(path, tok, value){ const r = await fetch(url(path, tok), { method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(value) }); if (!r.ok) throw new Error(`écriture ${r.status}`); }
async function del(path, tok){ await fetch(url(path, tok), { method:"DELETE" }).catch(()=>{}); }

function statusOf(j, now){
  if (!j) return "inconnue";
  if (j.cancelledAt) return "annulée";
  const targets = APPS.filter(a => j.apps && j.apps[a]);
  const delivered = targets.filter(a => j.delivered && j.delivered[a]);
  if (targets.length && delivered.length === targets.length) return "terminée";
  if (!j.active) return "désactivée";
  if (j.expiresAt && now > j.expiresAt) return "expirée";
  if (delivered.length) return "déclenchée (partiellement)";
  return "en attente";
}
// Vérifie que le contenu réel correspond au type annoncé (pas juste l'extension).
function magicOk(kind, mime, firstBytes){
  const b = firstBytes, hex = [...b.slice(0,4)].map(x=>x.toString(16).padStart(2,"0")).join("");
  if (kind === "image") {
    if (mime === "image/png") return hex === "89504e47";
    if (mime === "image/jpeg") return hex.startsWith("ffd8ff");
    if (mime === "image/webp") return b.slice(0,4).toString() === "RIFF" && b.slice(8,12).toString() === "WEBP";
    return false;
  }
  return b.slice(0,3).toString() === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0); // en-tête ID3 ou trame MPEG
}
function publicJoke(id, j, now){
  return { id, name: j.name, targetDiscordId: j.targetDiscordId, targetName: j.targetName, apps: j.apps || {}, text: j.text || null,
    image: j.image ? { name: j.image.name, mime: j.image.mime, size: j.image.size, chunks: j.image.chunks } : null,
    audio: j.audio ? { name: j.audio.name, mime: j.audio.mime, size: j.audio.size, chunks: j.audio.chunks } : null,
    active: !!j.active, armedAt: j.armedAt || null, expiresAt: j.expiresAt || null, delivered: j.delivered || {}, cancelledAt: j.cancelledAt || null,
    createdAt: j.createdAt || null, updatedAt: j.updatedAt || null, status: statusOf(j, now) };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Méthode non autorisée." });
  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) return json(500, { error: "Configuration manquante côté serveur." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Requête invalide." }); }
  const session = verify(body.token, SESSION_SECRET);
  if (!session) return json(401, { error: "Session invalide ou expirée." });
  // (12/10) Accès = permission « manage_troll » (décochée partout par défaut,
  // cochable par grade ou individuellement ; le Concepteur l'a toujours).
  // owner = le Concepteur lui-même : voit et gère TOUTES les blagues ; les
  // autres ne voient et ne gèrent que les leurs, et ne peuvent pas le viser.
  const owner = isTrollAdmin(session);
  const action = body.action;
  const now = Date.now();
  const ADMIN_ACTIONS = ["list","save","uploadChunk","finalizeMedia","deleteMedia","arm","disarm","cancel","delete"];
  const admin = ADMIN_ACTIONS.includes(action) || action === "mediaChunk" ? await canFor(session, "manage_troll") : false;
  if (ADMIN_ACTIONS.includes(action) && !admin) return json(403, { error: "Il faut la permission « Mode troll »." });
  const ownsJoke = (j) => owner || (!!j && !!j.createdByDiscordId && String(j.createdByDiscordId) === String(session.discordId));

  try {
    const tok = await trollToken();
    const id = body.id ? String(body.id) : null;
    if (id && !/^[A-Za-z0-9_-]{6,40}$/.test(id)) return json(400, { error: "Identifiant invalide." });

    // ───────────── Destinataire : blagues en attente pour MOI ─────────────
    if (action === "pending") {
      if (!APPS.includes(body.app)) return json(400, { error: "Outil invalide." });
      const all = (await get("trollJokes", tok)) || {};
      const mine = Object.entries(all)
        .filter(([, j]) => j && String(j.targetDiscordId) === String(session.discordId) && j.active && !j.cancelledAt
          && j.apps && j.apps[body.app] && !(j.delivered && j.delivered[body.app]) && (!j.expiresAt || now <= j.expiresAt))
        .sort((a, b) => (a[1].armedAt||0) - (b[1].armedAt||0))
        // Le destinataire reçoit ici la description de SA blague (pas les
        // médias eux-mêmes) pour pouvoir télécharger AVANT de la réserver.
        .map(([jid, j]) => { const pj = publicJoke(jid, j, now); return { id: jid, text: pj.text, image: pj.image, audio: pj.audio }; });
      return json(200, { pending: mine });
    }

    // Réservation atomique de la livraison (AVANT affichage) — jamais deux fois.
    if (action === "claim") {
      if (!id || !APPS.includes(body.app)) return json(400, { error: "Paramètres manquants." });
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(url(`trollJokes/${id}`, tok), { headers: { "X-Firebase-ETag": "true" } });
        if (!r.ok) throw new Error(`lecture ${r.status}`);
        const etag = r.headers.get("etag"); const j = await r.json();
        if (!j || String(j.targetDiscordId) !== String(session.discordId)) return json(404, { error: "Introuvable." });
        if (!j.active || j.cancelledAt || !(j.apps && j.apps[body.app]) || (j.expiresAt && now > j.expiresAt)) return json(409, { error: "Plus disponible.", unavailable: true });
        if (j.delivered && j.delivered[body.app]) return json(409, { error: "Déjà déclenchée.", already: true });
        const next = { ...j, delivered: { ...(j.delivered||{}), [body.app]: now } };
        const w = await fetch(url(`trollJokes/${id}`, tok), { method:"PUT", headers:{ "Content-Type":"application/json", "if-match": etag }, body: JSON.stringify(next) });
        if (w.ok) { const pj = publicJoke(id, next, now); return json(200, { ok: true, joke: { id, text: pj.text, image: pj.image, audio: pj.audio } }); }
        if (w.status !== 412) throw new Error(`écriture ${w.status}`);
      }
      return json(409, { error: "Conflit, réessaie.", already: true });
    }

    // Lecture d'un morceau de média : Concepteur, ou destinataire de CETTE blague.
    if (action === "mediaChunk") {
      const kind = body.kind; const index = Number(body.index);
      if (!id || !LIMITS[kind] || !Number.isInteger(index) || index < 0 || index > 10) return json(400, { error: "Paramètres invalides." });
      const j = await get(`trollJokes/${id}`, tok);
      if (!j || !j[kind]) return json(404, { error: "Média introuvable." });
      const isTarget = String(j.targetDiscordId) === String(session.discordId) && !j.cancelledAt;
      if (!isTarget && !(admin && ownsJoke(j))) return json(403, { error: "Accès refusé." });
      if (index >= j[kind].chunks) return json(400, { error: "Morceau inexistant." });
      const data = await get(`trollMedia/${id}/${kind}_${j[kind].uploadId}/${index}`, tok);
      if (typeof data !== "string") return json(404, { error: "Morceau manquant." });
      return json(200, { data, mime: j[kind].mime });
    }

    // ───────────── Concepteur uniquement ─────────────
    if (action === "list") {
      const all = (await get("trollJokes", tok)) || {};
      const jokes = Object.entries(all).filter(([, j]) => ownsJoke(j)).map(([jid, j]) => ({ ...publicJoke(jid, j, now), createdByName: j.createdByName || null })).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
      return json(200, { jokes });
    }

    if (action === "save") {
      const j = body.joke || {};
      const name = String(j.name || "").trim();
      const text = j.text == null ? "" : String(j.text);
      const apps = { roster: !!(j.apps && j.apps.roster), pillbox: !!(j.apps && j.apps.pillbox) };
      if (!name || name.length > MAX_NAME) return json(400, { error: `Nom obligatoire (${MAX_NAME} caractères max).` });
      if (text.length > MAX_TEXT) return json(400, { error: `Phrase trop longue (${MAX_TEXT} caractères max).` });
      if (!j.targetDiscordId || !/^\d{5,25}$/.test(String(j.targetDiscordId))) return json(400, { error: "Destinataire invalide." });
      if (!apps.roster && !apps.pillbox) return json(400, { error: "Choisis au moins un outil (Roster et/ou Pillbox)." });
      if (!owner && String(j.targetDiscordId) === OWNER_DISCORD_ID) return json(403, { error: "Le Concepteur est intouchable." });
      const jid = id || `j${now.toString(36)}${Math.random().toString(36).slice(2,8)}`;
      const existing = id ? await get(`trollJokes/${jid}`, tok) : null;
      if (id && !existing) return json(404, { error: "Blague introuvable." });
      if (existing && !ownsJoke(existing)) return json(403, { error: "Ce n'est pas ta blague." });
      const merged = { ...(existing || { active:false, delivered:{}, createdAt: now, image:null, audio:null, createdByDiscordId: String(session.discordId), createdByName: String(session.name||"").slice(0,100) }),
        name, text: text.trim() ? text : null, apps, targetDiscordId: String(j.targetDiscordId),
        targetName: String(j.targetName || "").slice(0, 100), updatedAt: now };
      // Changement de destinataire ou d'outils : la blague repart de zéro (jamais livrée par erreur à l'ancien).
      if (existing && (existing.targetDiscordId !== merged.targetDiscordId || JSON.stringify(existing.apps) !== JSON.stringify(apps))) {
        merged.delivered = {}; merged.active = false;
      }
      await put(`trollJokes/${jid}`, tok, merged);
      return json(200, { ok: true, joke: publicJoke(jid, merged, now) });
    }

    if (action === "uploadChunk") {
      const { kind, uploadId, mime } = body; const index = Number(body.index), total = Number(body.total), size = Number(body.size);
      const lim = LIMITS[kind];
      if (!id || !lim || !/^[a-z0-9]{6,20}$/.test(String(uploadId||""))) return json(400, { error: "Paramètres invalides." });
      if (!lim.mimes.includes(mime)) return json(400, { error: kind === "image" ? "Format refusé : PNG, JPG, JPEG ou WEBP uniquement." : "Format refusé : MP3 uniquement." });
      if (!(size > 0) || size > lim.maxBytes) return json(400, { error: `Fichier trop volumineux (max ${lim.maxBytes/1024/1024} Mo).` });
      const expectedTotal = Math.ceil(size / CHUNK_BYTES);
      if (total !== expectedTotal || !(index >= 0 && index < total)) return json(400, { error: "Découpage incohérent." });
      const data = String(body.data || "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > Math.ceil(CHUNK_BYTES/3)*4 + 4) return json(400, { error: "Morceau invalide." });
      if (index === 0 && !magicOk(kind, mime, Buffer.from(data.slice(0, 24), "base64"))) {
        return json(400, { error: kind === "image" ? "Ce fichier n'est pas une vraie image PNG/JPG/WEBP." : "Ce fichier n'est pas un vrai MP3." });
      }
      const j = await get(`trollJokes/${id}`, tok);
      if (!j) return json(404, { error: "Blague introuvable — enregistre-la d'abord." });
      if (!ownsJoke(j)) return json(403, { error: "Ce n'est pas ta blague." });
      await put(`trollMedia/${id}/${kind}_${uploadId}/${index}`, tok, data);
      return json(200, { ok: true });
    }

    if (action === "finalizeMedia") {
      const { kind, uploadId, name, mime } = body; const size = Number(body.size); const lim = LIMITS[kind];
      if (!id || !lim || !/^[a-z0-9]{6,20}$/.test(String(uploadId||"")) || !lim.mimes.includes(mime) || !(size > 0) || size > lim.maxBytes) return json(400, { error: "Paramètres invalides." });
      const total = Math.ceil(size / CHUNK_BYTES);
      // Ne déclare le média enregistré QUE si tous les morceaux sont réellement en base.
      for (let i = 0; i < total; i++) {
        const c = await get(`trollMedia/${id}/${kind}_${uploadId}/${i}`, tok);
        if (typeof c !== "string" || !c.length) return json(409, { error: `Envoi incomplet (morceau ${i+1}/${total} manquant) — rien n'a été enregistré.` });
      }
      const j = await get(`trollJokes/${id}`, tok);
      if (!j) return json(404, { error: "Blague introuvable." });
      if (!ownsJoke(j)) return json(403, { error: "Ce n'est pas ta blague." });
      const previous = j[kind];
      const next = { ...j, [kind]: { name: String(name||"").slice(0,120), mime, size, chunks: total, uploadId }, updatedAt: now };
      await put(`trollJokes/${id}`, tok, next);
      if (previous && previous.uploadId && previous.uploadId !== uploadId) await del(`trollMedia/${id}/${kind}_${previous.uploadId}`, tok);
      return json(200, { ok: true, joke: publicJoke(id, next, now) });
    }

    if (action === "deleteMedia") {
      const kind = body.kind;
      if (!id || !LIMITS[kind]) return json(400, { error: "Paramètres invalides." });
      const j = await get(`trollJokes/${id}`, tok);
      if (!j) return json(404, { error: "Blague introuvable." });
      if (!ownsJoke(j)) return json(403, { error: "Ce n'est pas ta blague." });
      const previous = j[kind];
      const next = { ...j, [kind]: null, updatedAt: now };
      await put(`trollJokes/${id}`, tok, next);
      if (previous && previous.uploadId) await del(`trollMedia/${id}/${kind}_${previous.uploadId}`, tok);
      return json(200, { ok: true, joke: publicJoke(id, next, now) });
    }

    if (["arm","disarm","cancel"].includes(action)) {
      if (!id) return json(400, { error: "Paramètres manquants." });
      const j = await get(`trollJokes/${id}`, tok);
      if (!j) return json(404, { error: "Blague introuvable." });
      if (!ownsJoke(j)) return json(403, { error: "Ce n'est pas ta blague." });
      let next;
      if (action === "arm") {
        if (!j.text && !j.image && !j.audio) return json(400, { error: "Rien à envoyer : ajoute une phrase, une image ou un son." });
        next = { ...j, active: true, armedAt: now, expiresAt: now + EXPIRY_MS, delivered: {}, cancelledAt: null, updatedAt: now };
      } else if (action === "disarm") {
        next = { ...j, active: false, updatedAt: now };
      } else {
        next = { ...j, active: false, cancelledAt: now, updatedAt: now };
      }
      await put(`trollJokes/${id}`, tok, next);
      return json(200, { ok: true, joke: publicJoke(id, next, now) });
    }

    if (action === "delete") {
      if (!id) return json(400, { error: "Paramètres manquants." });
      const j = await get(`trollJokes/${id}`, tok);
      if (j && !ownsJoke(j)) return json(403, { error: "Ce n'est pas ta blague." });
      await del(`trollJokes/${id}`, tok);
      await del(`trollMedia/${id}`, tok);
      return json(200, { ok: true });
    }

    return json(400, { error: `Action inconnue : "${action}".` });
  } catch (err) {
    return json(500, { error: `Erreur : ${err.message}` });
  }
};

module.exports.statusOf = statusOf;
module.exports.CHUNK_BYTES = CHUNK_BYTES;
