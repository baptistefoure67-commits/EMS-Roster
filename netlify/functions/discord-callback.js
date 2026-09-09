// ═══════════════════════════════════════════════════════════════════
// discord-callback.js — Fonction Netlify (serveur), JAMAIS envoyée au
// navigateur. C'est le SEUL endroit qui connaît le Client Secret Discord
// (lu depuis une variable d'environnement Netlify, jamais écrit en dur
// ici) — exactement le point que le cahier des charges impose.
//
// ÉTAPE 1 (celle-ci) : juste se connecter, retrouver le grade dans le
// Roster, et l'afficher. AUCUNE protection d'action n'est encore en
// place à ce stade — ça viendra à l'étape 2 (vérification des
// permissions côté serveur pour une vraie action).
// ═══════════════════════════════════════════════════════════════════

const ROSTER_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterEmsData.json";
const { sign, TOKEN_LIFETIME_MS } = require("./session-token");
const { createFirebaseCustomToken } = require("./firebase-token");
const { resolveUserLevel, LEVEL_LABEL } = require("./permissions");
const { logAction } = require("./logs");

exports.handler = async function (event) {
  const {
    DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, SITE_URL, SESSION_SECRET,
    FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_WEB_API_KEY,
  } = process.env;

  // Garde-fou : si les variables d'environnement ne sont pas encore
  // configurées côté Netlify, on le dit clairement plutôt que de planter
  // sans explication.
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SITE_URL || !SESSION_SECRET || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY || !FIREBASE_WEB_API_KEY) {
    return {
      statusCode: 500,
      body: "Configuration manquante côté serveur (variables d'environnement non définies sur Netlify).",
    };
  }

  const code = event.queryStringParameters && event.queryStringParameters.code;
  if (!code) {
    return { statusCode: 400, body: "Code Discord manquant dans la requête." };
  }

  try {
    // 1) Échange le code temporaire contre un vrai jeton d'accès — c'est
    // CETTE étape précise qui nécessite le Client Secret, donc qui doit
    // obligatoirement se faire ici (serveur), jamais dans le navigateur.
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return redirectWithError(SITE_URL, `Échec de l'échange avec Discord (${tokenRes.status}) : ${errText.slice(0, 200)}`);
    }
    const tokenData = await tokenRes.json();

    // 2) Récupère l'identité Discord de la personne connectée.
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) {
      return redirectWithError(SITE_URL, "Impossible de récupérer l'identité Discord.");
    }
    const discordUser = await userRes.json();
    const discordId = discordUser.id;
    const discordUsername = discordUser.username;

    // 3) Cherche cet ID Discord dans le Roster — jamais l'inverse (le
    // frontend ne doit jamais pouvoir affirmer lui-même son grade/niveau).
    const rosterRes = await fetch(ROSTER_URL);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    const employees = (rosterData && rosterData.employees) || [];
    const rosterMatch = employees.find((e) => e.discordId === discordId && !e.licencie) || null;

    // 4) Détermine le VRAI niveau — OWNER d'abord (indépendant du
    // Roster, voir permissions.js), sinon grade Roster (MC/ADD/CD/D).
    // Le frontend n'a jamais son mot à dire là-dessus.
    const level = resolveUserLevel(discordId, rosterMatch ? rosterMatch.grade : null);
    const displayName = rosterMatch ? rosterMatch.name : discordUsername;

    if (!level) {
      const reason = !rosterMatch
        ? `Ton compte Discord (${discordUsername}) n'est pas dans le Roster EMS.`
        : `${rosterMatch.name} (${rosterMatch.grade}) n'a pas un grade reconnu par le système de permissions.`;
      return redirectWithError(SITE_URL, `${reason} Accès refusé.`);
    }

    // 5) Génère un jeton signé — c'est LUI qui prouvera l'accès pour les
    // actions sensibles, jamais le nom/niveau en clair seuls (ceux-là
    // restent affichables mais ne suffisent plus à agir). Le niveau
    // (pas le grade brut) est ce qui compte désormais pour can().
    const token = sign(
      { discordId, name: displayName, level, exp: Date.now() + TOKEN_LIFETIME_MS },
      SESSION_SECRET
    );

    // 6) Jeton Firebase authentique — le niveau y est aussi comme
    // "custom claim", pour que les règles Firebase elles-mêmes puissent
    // vérifier auth.token.level directement.
    const firebaseToken = createFirebaseCustomToken({
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY,
      uid: discordId,
      claims: { level },
    });

    // Échange immédiatement contre un vrai jeton d'identité, pour
    // pouvoir journaliser cette connexion de façon authentifiée
    // (rosterLogs exige désormais une vraie connexion pour écrire).
    let idTokenForLog = null;
    try {
      const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${process.env.FIREBASE_WEB_API_KEY}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: firebaseToken, returnSecureToken: true }),
      });
      const exchData = await exch.json();
      if (exch.ok) idTokenForLog = exchData.idToken;
    } catch (e) { /* échec silencieux — ne bloque jamais la connexion */ }

    // Journalise chaque connexion réussie — utile pour repérer une
    // activité inhabituelle plus tard (voir logs.js).
    await logAction({
      action: "connexion",
      authorDiscordId: discordId,
      authorName: displayName,
      authorLevel: level,
      idToken: idTokenForLog,
    }).catch(()=>{}); // ne bloque jamais la connexion si le log échoue

    const params = new URLSearchParams({
      discord_ok: "1",
      discord_id: discordId,
      discord_name: displayName,
      discord_level: level,
      discord_level_label: LEVEL_LABEL[level],
      discord_token: token,
      firebase_token: firebaseToken,
    });
    return {
      statusCode: 302,
      headers: { Location: `${SITE_URL}?${params.toString()}` },
    };
  } catch (err) {
    return redirectWithError(SITE_URL, `Erreur inattendue : ${err.message}`);
  }
};

function redirectWithError(siteUrl, message) {
  const params = new URLSearchParams({ discord_ok: "0", discord_error: message });
  return { statusCode: 302, headers: { Location: `${siteUrl}?${params.toString()}` } };
}
