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

exports.handler = async function (event) {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, SITE_URL } = process.env;

  // Garde-fou : si les variables d'environnement ne sont pas encore
  // configurées côté Netlify, on le dit clairement plutôt que de planter
  // sans explication.
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI || !SITE_URL) {
    return {
      statusCode: 500,
      body: "Configuration manquante côté serveur (variables d'environnement Discord non définies sur Netlify).",
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
    const rosterRes = await fetch(ROSTER_URL);
    const rosterData = rosterRes.ok ? await rosterRes.json() : null;
    const employees = (rosterData && rosterData.employees) || [];
    const match = employees.find((e) => e.discordId === discordId && !e.licencie);

    if (!match) {
      // ID Discord non trouvé dans le Roster → accès refusé, message clair.
      return redirectWithError(SITE_URL, `Ton compte Discord (${discordUsername}) n'est pas dans le Roster EMS — accès refusé.`);
    }

    // 4) Pour l'étape 1 uniquement : on renvoie le nom/grade trouvés dans
    // l'adresse de retour, pour affichage seulement. Ce n'est PAS encore
    // une session sécurisée (n'importe qui pourrait modifier l'adresse à
    // la main pour l'instant) — ça sera corrigé à l'étape 2, avant
    // d'accrocher la moindre action sensible à cette information.
    const params = new URLSearchParams({
      discord_ok: "1",
      discord_id: discordId,
      discord_name: match.name,
      discord_grade: match.grade,
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
