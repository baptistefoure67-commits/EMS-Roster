// ═══════════════════════════════════════════════════════════════════
// firebase-token.js — fabrique un vrai jeton d'authentification Firebase
// (un "custom token"), signé avec la clé privée du compte de service
// Firebase. C'est CE jeton qui permet à Firebase lui-même de savoir
// qui écrit et avec quel grade — pas juste une apparence de connexion
// côté site, une vraie vérification côté Firebase.
//
// Volontairement écrit avec juste le module natif "crypto" de Node,
// SANS le paquet complet firebase-admin (bien plus lourd) — un jeton
// personnalisé Firebase n'est qu'un JWT signé en RS256 avec la clé
// privée du compte de service, ce que crypto.createSign fait très bien
// tout seul.
//
// Variables d'environnement Netlify nécessaires (à créer une fois le
// compte de service généré depuis la console Firebase — voir le guide
// donné à part) :
//   FIREBASE_CLIENT_EMAIL  → le "client_email" du fichier JSON du compte de service
//   FIREBASE_PRIVATE_KEY   → le "private_key" du même fichier (garder les \n tels quels)
//   FIREBASE_PROJECT_ID    → le "project_id" du même fichier
// ═══════════════════════════════════════════════════════════════════

const crypto = require("crypto");

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// uid : identifiant unique de l'utilisateur pour Firebase Auth (on utilise
// l'ID Discord, préfixé pour ne jamais entrer en collision avec autre chose).
// claims : les infos personnalisées qu'on veut retrouver côté règles
// Firebase (ex: {grade:"MC"}) — accessibles ensuite via auth.token.grade
// dans les règles de sécurité.
function createFirebaseCustomToken({ clientEmail, privateKey, uid, claims }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now,
    exp: now + 3600, // 1h — cohérent avec la durée du jeton de session déjà en place
    uid: `discord:${uid}`,
    claims: claims || {},
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  // La clé privée du compte de service Firebase stocke ses retours à la
  // ligne comme "\n" littéral dans une variable d'environnement — il
  // faut les reconvertir en vrais retours à la ligne avant de signer.
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  const signature = base64url(signer.sign(normalizedKey));

  return `${signingInput}.${signature}`;
}

module.exports = { createFirebaseCustomToken };
