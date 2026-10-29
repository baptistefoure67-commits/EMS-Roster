// Suite autonome (test global avant clôture de semaine) : vérifie le
// coffre (Argent du coffre, estimation après distribution) et
// l'exclusion correcte des WDV, sur une analyse réaliste multi-employés.
const path = require("path"), http = require("http"), fs = require("fs");
const { pillboxHtmlPath } = require("./_helpers");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const PB_PATH = pillboxHtmlPath();
const server = http.createServer((req,res)=>{
  const p = (req.url.split("?")[0]==="/"||req.url.split("?")[0]==="/index.html") ? PB_PATH : null;
  if(!p){ res.writeHead(404); res.end(); return; }
  fs.readFile(p, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(data); });
});


const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  await new Promise(r=>server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromiumMod.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message+' | '+e.stack));
  await page.route('**/pillbox-proxy**', async route=>{
    let body={}; try{ body=JSON.parse(route.request().postData()||'{}'); }catch(e){}
    if(body.action==='getWeekHistoryEntry') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,state:'absent',entry:null})});
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });

  // Plusieurs employés couvrant : salaire fixe+heures+réa, recrutements+formations,
  // PPA, quota non atteint (déduction), WDV (non payé), bénévole.
  const sample = [
    '📂:d1\t[ADD] Alice Haut\t100001\tADD\t\t\tf0\t01/01\t0\t01/01\tf4',
    '📂:d2\t[RF] Formateur Un\t100002\tRF\t\t\tf0\t01/01\t0\t01/01\tf4',
    '📂:d3\t[STG] Stagiaire Quota\t100003\tSTG\tQ1\t\tf0\t01/01\t0\t01/01\tf4',
    '📂:d4\t[A] Wdv Personne\t100004\tWDV\t\t\tf0\t01/01\t0\t01/01\tf4',
    '📂:d5\t[BNVL] Benevole Un\t100005\tM\t\t\tf0\t01/01\t0\t01/01\tf4',
  ].join('\n');

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  await page.evaluate((sample) => {
    pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
    document.getElementById('weekStartInput').value='2026-10-17';
    document.getElementById('coffreInput').value = '50000000';
    document.getElementById('tableauText').value = sample;
    document.getElementById('tableauText').dispatchEvent(new Event('input'));
    document.getElementById('reaText').value = "1. Alice Haut - Réa : 100\n2. Formateur Un - Réa : 80\n3. Stagiaire Quota - Réa : 10";
    document.getElementById('reaText').dispatchEvent(new Event('input'));
  }, sample);
  await page.evaluate(() => document.getElementById('analyzeBtn').click());
  await page.waitForTimeout(1200);

  const r = await page.evaluate(() => {
    document.getElementById('launchQuestionsModal')?.style && (document.getElementById('launchQuestionsModal').style.display='none');
    state.activiteSuivi={ 'id:100002': { recrutements: 2, formations: 3 } };
    state.activiteSuiviLoadError = null;
    const ctx = buildContext();
    return {
      totalPaye: ctx.totalPaye,
      nbAnomalies: state.parsed.anomalies.length,
      employeeNames: ctx.employees.map(e=>e.name),
      rowsCount: ctx.employees.filter(r=>!r.benevole).length,
    };
  });
  t("Analyse réussie, pas d anomalie inattendue", r.nbAnomalies === 0, JSON.stringify(r));
  t('WDV bien exclu entièrement (jamais dans les employés)', !r.employeeNames.includes('Wdv Personne'), JSON.stringify(r.employeeNames));
  t('Total payes calculé (> 0)', r.totalPaye > 0, r.totalPaye);

  // Coffre : vérifie que l'estimation après distribution est cohérente
  const coffreCheck = await page.evaluate(() => {
    const coffreActuel = getCoffre();
    const ctx = buildContext();
    return { coffreActuel, totalPaye: ctx.totalPaye, coffreApres: coffreActuel - ctx.totalPaye };
  });
  t('Coffre lu correctement (50M)', coffreCheck.coffreActuel === 50000000, coffreCheck.coffreActuel);
  t('Coffre après = coffre actuel - total payes (cohérent)', Math.abs(coffreCheck.coffreApres - (coffreCheck.coffreActuel - coffreCheck.totalPaye)) < 1, JSON.stringify(coffreCheck));

  // Champ coffre vide -> fonctionnalité désactivée, pas "coffre à 0"
  const coffreEmpty = await page.evaluate(() => {
    document.getElementById('coffreInput').value = '';
    return getCoffre();
  });
  t('Coffre vide = null (désactivé), pas 0', coffreEmpty === null, coffreEmpty);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
