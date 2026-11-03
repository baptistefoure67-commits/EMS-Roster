// Corrige un vrai bug de timing confirmé par un rapport de bug réel
// (401 systématique sur rosterEmsSpecialSelection.json, 38ms après le
// chargement) : startRosterLiveUpdates() démarre AVANT la fin de
// l'échange du jeton Firebase dans les deux chemins de connexion
// (restoreSessionFromStorage et checkDiscordAuthReturn), donc son tout
// premier appel à refreshSpecialSelectionFromCloud() partait sans
// aucun ?auth=, puisque seul currentSessionToken (déjà prêt) était
// vérifié, jamais currentFirebaseIdToken (le seul dont withFirebaseAuth
// a réellement besoin pour cette lecture directe).
const { chromium } = require('playwright');
const path = require('path');
const ROSTER_HTML = path.join(__dirname, '..', 'index.html');
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(`file://${ROSTER_HTML}`);
  await page.waitForTimeout(300);

  let fetchedUrls = [];
  await page.exposeFunction('recordFetch', (url) => fetchedUrls.push(url));
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    window.fetch = (...args) => { window.recordFetch(String(args[0])); return originalFetch(...args); };
  });

  await page.evaluate(async () => {
    currentSessionToken = 'fake-session-token';
    currentFirebaseIdToken = null; // exactement l'état au moment buggé
    await refreshSpecialSelectionFromCloud();
  });
  t('Aucun appel non authentifié tant que currentFirebaseIdToken n\'est pas prêt', !fetchedUrls.some(u => u.includes('rosterEmsSpecialSelection')), JSON.stringify(fetchedUrls));

  fetchedUrls = [];
  await page.evaluate(async () => {
    currentFirebaseIdToken = 'fake-firebase-token';
    try{ await refreshSpecialSelectionFromCloud(); }catch(e){}
  });
  t('Une fois le jeton prêt, l\'appel repart normalement avec le bon auth=', fetchedUrls.some(u => u.includes('rosterEmsSpecialSelection') && u.includes('auth=fake-firebase-token')), JSON.stringify(fetchedUrls));

  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${realErrors.length}`);
  await browser.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
