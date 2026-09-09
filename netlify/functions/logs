// ═══════════════════════════════════════════════════════════════════
// logs.js — écrit les journaux d'action, UNIQUEMENT depuis le serveur.
// Jamais un log écrit directement par le navigateur (voir demande
// explicite : "ne pas faire confiance à author envoyé par le
// navigateur") — chaque appel à logAction() doit venir d'une fonction
// serveur qui a déjà vérifié l'identité elle-même.
//
// Chemin Firebase dédié : rosterLogs — accessible en lecture seulement
// par ceux qui ont la permission view_logs (vérifié côté serveur avant
// de renvoyer quoi que ce soit, jamais juste caché à l'écran), jamais
// modifiable ni supprimable depuis l'interface normale (règles Firebase
// : write autorisé uniquement via jeton Firebase + niveau autorisé,
// aucune fonction de suppression exposée côté client).
// ═══════════════════════════════════════════════════════════════════

const LOGS_URL = "https://paie-terminal-pillbox-default-rtdb.europe-west1.firebasedatabase.app/rosterLogs.json";

async function logAction({ action, authorDiscordId, authorName, authorLevel, targetDiscordId, targetName, oldValue, newValue, details, idToken }) {
  const entry = {
    action,
    authorDiscordId: authorDiscordId || null,
    authorName: authorName || null,
    authorLevel: authorLevel || null,
    targetDiscordId: targetDiscordId || null,
    targetName: targetName || null,
    oldValue: oldValue !== undefined ? String(oldValue) : null,
    newValue: newValue !== undefined ? String(newValue) : null,
    details: details || null,
    createdAt: Date.now(), // TOUJOURS l'horloge serveur, jamais une date envoyée par le client
  };
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const url = idToken ? `${LOGS_URL.replace(".json", `/${key}.json`)}?auth=${idToken}` : LOGS_URL.replace(".json", `/${key}.json`);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Échec de l'écriture du log (${res.status}) : ${t.slice(0, 200)}`);
  }
  return entry;
}

module.exports = { logAction, LOGS_URL };
