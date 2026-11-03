// Vérifie que "Modifier" reste utilisable après une sauvegarde — avant
// le 01/11, renderAll() (appelé après chaque sauvegarde individuelle)
// refermait systématiquement TOUTES les fiches ouvertes, y compris
// celle qu'on venait juste de sauvegarder, obligeant à recliquer sur
// "Modifier" pour continuer. Correspond aux tests 1, 2, 3 du cahier
// des charges "correction ciblée du Roster EMS" (01/11).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROSTER_DIR = path.join(__dirname, '..');
const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  const server = http.createServer((req,res)=>{
    const filePath = path.join(ROSTER_DIR, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(filePath, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(data); });
  });
  await new Promise(r=>server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/.netlify/functions/protected-write', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok:true, savedAt: Date.now() }) });
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    document.getElementById("accessGate").style.display = "none";
    document.getElementById("appContent").style.display = "";
    currentUserLevel = "D"; currentSessionToken = "fake-session-token";
    employees = [
      {id:'e1', name:'Moussa', discordId:'20', idUnique:'1', grade:'ADD', licencie:false, role:''},
      {id:'e2', name:'Baptiste', discordId:'21', idUnique:'2', grade:'ADD', licencie:false, role:''},
    ];
    rosterCloudConfirmed = true; userCaps = null;
    renderAll();
  });

  await page.click('[data-edit="e1"]');
  await page.click('[data-save="e1"]');
  await page.waitForTimeout(400);
  t('Test 1 — Mode Modifier (fiche Moussa) toujours actif après sauvegarde', await page.evaluate(() => document.querySelector('[data-edit-slot="e1"]')?.innerHTML.length > 0));
  t('Test 3 — Remodifier Moussa directement, sans recliquer sur Modifier', await page.evaluate(() => !!document.querySelector('[data-edit-name="e1"]')));

  await page.click('[data-edit="e2"]');
  await page.waitForTimeout(200);
  t('Test 2 — Ouvrir Baptiste fonctionne normalement (bouton Modifier intact)', await page.evaluate(() => !!document.querySelector('[data-edit-name="e2"]')));
  t('Moussa reste ouvert même après avoir ouvert Baptiste (pas de fermeture croisée)', await page.evaluate(() => document.querySelector('[data-edit-slot="e1"]')?.innerHTML.length > 0));

  await page.click('[data-cancel="e1"]');
  await page.waitForTimeout(100);
  t('Sortie explicite ("Annuler") ferme bien la fiche — seule façon prévue de quitter', await page.evaluate(() => document.querySelector('[data-edit-slot="e1"]')?.innerHTML.length === 0));

  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${realErrors.length}`);
  await browser.close(); server.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
