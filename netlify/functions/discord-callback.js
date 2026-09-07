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

exports.handler = async function (event) {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, SITE_URL, SESSION_SECRET } = process.env;

  // Garde-fou : si les variables d'environnement ne sont pas encore
  // configurées côté Netlify, on le dit clairement plutôt que de planter
  // sans explication.
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SITE_URL || !SESSION_SECRET) {
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
    // frontend ne doit jamais pouvoir affirmer lui-même son grade).
    // Accès réservé à MC et au-dessus (DG, D, CD, ADD, MC) — un Stagiaire
    // ou n'importe quel autre grade dans le Roster est refusé ici (07/09).
    const ALLOWED_GRADES = ["DG", "D", "CD", "ADD", "MC"];
    const rosterRes = await fetch(ROSTER_URL);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    const employees = (rosterData && rosterData.employees) || [];
    const anyMatch = employees.find((e) => e.discordId === discordId && !e.licencie);
    const match = anyMatch && ALLOWED_GRADES.includes(anyMatch.grade) ? anyMatch : null;

    if (!match) {
      // Message précis selon le cas : absent du Roster, ou présent mais
      // grade insuffisant — plus clair que "accès refusé" tout court.
      const reason = !anyMatch
        ? `Ton compte Discord (${discordUsername}) n'est pas dans le Roster EMS.`
        : `${anyMatch.name} (${anyMatch.grade}) n'a pas le grade minimum requis (MC et au-dessus).`;
      return redirectWithError(SITE_URL, `${reason} Accès refusé.`);
    }

    // 4) Génère un jeton signé — c'est LUI qui prouvera l'accès pour les
    // actions sensibles (étape 2), jamais le nom/grade en clair seuls
    // (ceux-là restent affichables mais ne suffisent plus à agir).
    const token = sign(
      { discordId, name: match.name, grade: match.grade, exp: Date.now() + TOKEN_LIFETIME_MS },
      SESSION_SECRET
    );
    const params = new URLSearchParams({
      discord_ok: "1",
      discord_id: discordId,
      discord_name: match.name,
      discord_grade: match.grade,
      discord_token: token,
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
