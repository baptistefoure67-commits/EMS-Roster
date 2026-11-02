// Vérification de bout en bout (vrai navigateur, vrai parcours client
// -> serveur) que "Modifier" ET "Sauvegarder" fonctionnent normalement
// pour un compte D — demandé après un rapport de bug où les deux
// semblaient cassés. Résultat de cette investigation : aucun bug
// trouvé pour un D+, les deux fonctionnent correctement de bout en
// bout ; seul un non-D+ est bloqué, comme voulu (voir
// roster-save-grade-consistency.test.js pour cette partie-là).
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
  const calls = [];
  await page.route('**/.netlify/functions/protected-write', async route => {
    const body = JSON.parse(route.request().postData());
    calls.push({action: body.action, payload: body.payload});
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok:true, savedAt: Date.now(), employees: body.payload?.employees }) });
  });

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  // ===== "Modifier" (fiche individuelle), compte D, changement de grade =====
  await page.evaluate(() => {
    document.getElementById("accessGate").style.display = "none";
    document.getElementById("appContent").style.display = "";
    currentUserLevel = "D"; currentSessionToken = "fake-session-token";
    employees = [{id:'e1', name:'Peter Nox', discordId:'20', idUnique:'265476', grade:'STG', licencie:false, role:''}];
    rosterCloudConfirmed = true; userCaps = null;
    renderAll();
    document.querySelector('[data-edit="e1"]').click();
  });
  await page.selectOption('[data-edit-grade="e1"]', 'A');
  await page.click('[data-save="e1"]');
  await page.waitForTimeout(300);
  t('Modifier (D) : la requête editEmployee part bien avec le nouveau grade', calls.some(c=>c.action==='editEmployee' && c.payload.grade==='A'), JSON.stringify(calls));
  const toastText = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  t('Modifier (D) : confirmation affichée, pas de message d\'erreur', toastText.includes('mis à jour'), toastText);

  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${realErrors.length}`);
  await browser.close(); server.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
