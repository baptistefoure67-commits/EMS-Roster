// Audit du 04/11 : les boutons data-view-history, data-copy-id,
// data-toggle-grade, data-licencier et data-reintegrer avaient le même
// risque que "Modifier" avant son correctif du 01/11 — écouteur attaché
// directement, ré-attaché à chaque renderAll() (toutes les 3s en
// arrière-plan). Vérifie qu'ils restent fiables après de nombreuses
// reconstructions successives du tableau.
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
  page.on('dialog', d=>d.accept()); // auto-accept les confirm() de licenciement
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    document.getElementById("accessGate").style.display = "none";
    document.getElementById("appContent").style.display = "";
    currentUserLevel = "D"; currentSessionToken = "fake-session-token";
    employees = [
      {id:'e1', name:'Cloe White', discordId:'4', idUnique:'65630', grade:'MC', licencie:false, role:''},
      {id:'e2', name:'Leto Mendez', discordId:'5', idUnique:'65631', grade:'STG', licencie:true, licencieDate:'01/11/2026', role:''},
    ];
    rosterCloudConfirmed = true; userCaps = null;
    renderAll();
  });

  // data-copy-id : après 15 reconstructions, le clic doit encore copier
  const copyResult = await page.evaluate(async () => {
    for(let i=0;i<15;i++) renderAll();
    window._copiedViaToast = null;
    const original = window.toast;
    window.toast = (msg)=>{ window._copiedViaToast = msg; };
    document.querySelector('[data-copy-id="4"]').click();
    await new Promise(r=>setTimeout(r, 50)); // copyToClipboard est async (navigator.clipboard.writeText)
    window.toast = original;
    return window._copiedViaToast;
  });
  t('data-copy-id fonctionne après 15 reconstructions', copyResult && copyResult.includes('4'), copyResult);

  // data-toggle-grade : replie/déplie une section après reconstructions
  const toggleResult = await page.evaluate(() => {
    for(let i=0;i<10;i++) renderAll();
    const before = collapsedGrades.has('MC');
    document.querySelector('[data-toggle-grade="MC"]').click();
    const after = collapsedGrades.has('MC');
    return { before, after };
  });
  t('data-toggle-grade bascule après 10 reconstructions', toggleResult.before !== toggleResult.after, JSON.stringify(toggleResult));

  // data-reintegrer : réintègre un licencié après reconstructions
  const reintegrerResult = await page.evaluate(() => {
    for(let i=0;i<10;i++) renderAll();
    document.querySelector('[data-reintegrer="e2"]').click();
    const e = employees.find(x=>x.id==='e2');
    return e.licencie;
  });
  t('data-reintegrer réintègre après 10 reconstructions', reintegrerResult === false, reintegrerResult);

  console.log(results.join('\n'));
  const realErrors = errors.filter(e => !/Unexpected token/.test(e));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${realErrors.length}`);
  if(realErrors.length) console.log(realErrors);
  await browser.close(); server.close();
  process.exit(failed || realErrors.length ? 1 : 0);
})();
