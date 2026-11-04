// Corrige le bug rapporté "Modifier ne marche pas pour tout le monde,
// par moments" : le clic sur "Modifier" était attaché DIRECTEMENT à
// chaque bouton, ré-attaché à chaque renderAll() — qui tourne
// automatiquement toutes les 3 secondes en arrière-plan (sondage live).
// Si ce rafraîchissement tombe juste avant qu'un clic ne soit traité,
// le bouton visé est déjà remplacé par un autre élément du DOM, et le
// clic ne déclenche plus rien, sans erreur visible. Corrigé avec un
// écouteur délégué unique sur `document`, qui retrouve toujours le
// VRAI bouton affiché au moment du clic.
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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    document.getElementById("accessGate").style.display = "none";
    document.getElementById("appContent").style.display = "";
    currentUserLevel = "D"; currentSessionToken = "fake-session-token";
    employees = [{id:'e1', name:'Cloe White', discordId:'4', idUnique:'65630', grade:'MC', licencie:false, role:''}];
    rosterCloudConfirmed = true; userCaps = null;
    renderAll();
  });

  const result = await page.evaluate(() => {
    // Simule le sondage en arrière-plan (renderAll toutes les 3s dans
    // la vraie appli) en le déclenchant 20 fois de suite — avec
    // l'ancien code (écouteur par bouton), ça ne changeait rien en
    // soi, mais prouve ici qu'un bouton reconstruit N fois reste
    // cliquable normalement avec la délégation.
    for(let i=0;i<20;i++) renderAll();
    document.querySelector('[data-edit="e1"]').click();
    return document.querySelector('[data-edit-slot="e1"]').innerHTML.length > 0;
  });
  t('Modifier fonctionne après 20 reconstructions successives du tableau', result);

  const toggle = await page.evaluate(() => {
    const before = document.querySelector('[data-edit-slot="e1"]').innerHTML.length > 0;
    document.querySelector('[data-edit="e1"]').click();
    const after = document.querySelector('[data-edit-slot="e1"]').innerHTML.length > 0;
    return { before, after };
  });
  t('Un clic bascule toujours proprement (ouvert -> fermé)', toggle.before === true && toggle.after === false, JSON.stringify(toggle));

  const single = await page.evaluate(() => {
    let calls = 0;
    const original = window.toast;
    window.toast = (...a)=>{ calls++; return original(...a); };
    document.querySelector('[data-edit="e1"]').click();
    window.toast = original;
    return calls;
  });
  t('Un seul clic ne déclenche la logique qu\'une seule fois (pas d\'écouteurs accumulés)', single === 0, single);

  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${realErrors.length}`);
  await browser.close(); server.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
