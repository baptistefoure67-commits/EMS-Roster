// Suite autonome (test global avant clôture) : vérifie le vrai cycle
// d'une question de licenciement Stagiaire (2 quotas ratés = proposé,
// "Non" = reste actif, "Oui" = licencié pour de vrai).
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
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.route('**/pillbox-proxy**', async route=>{
    let body={}; try{ body=JSON.parse(route.request().postData()||'{}'); }catch(e){}
    if(body.action==='getWeekHistoryEntry') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,state:'absent',entry:null})});
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  // STG avec Q1 deja enregistre, qui rate ENCORE son quota cette semaine (peu de réa) -> newQ=2 = seuil de proposition
  const sample = '📂:d1\t[STG] Stagiaire Risque\t100001\tSTG\tQ1\t\tf0\t01/01\t0\t01/01\tf4';
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  await page.evaluate((sample) => {
    pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
    document.getElementById('weekStartInput').value='2026-10-17';
    document.getElementById('tableauText').value = sample;
    document.getElementById('tableauText').dispatchEvent(new Event('input'));
    document.getElementById('reaText').value = '1. Stagiaire Risque - Réa : 5';
    document.getElementById('reaText').dispatchEvent(new Event('input'));
  }, sample);
  await page.evaluate(() => document.getElementById('analyzeBtn').click());
  await page.waitForTimeout(1000);

  const key = await page.evaluate(() => { document.getElementById('launchQuestionsModal').style.display='none'; return state.parsed.rows.find(r=>r.name==='Stagiaire Risque').key; });

  const before = await page.evaluate(() => {
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Stagiaire Risque');
    return { pendingStgLicence: e.pendingStgLicence, licencie: e.licencie, inPendingList: ctx.pendingStgLicenceList.some(x=>x.name==='Stagiaire Risque') };
  });
  t('Q2 atteint : licenciement PROPOSÉ (question), pas encore appliqué', before.pendingStgLicence === true && before.licencie === false && before.inPendingList, JSON.stringify(before));

  // Répond "Non" explicitement : reste PAS licencié
  const afterNon = await page.evaluate((key) => {
    state.overrides[key] = { stgLicenceDecision: false };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Stagiaire Risque');
    return { licencie: e.licencie, stillActive: !!e };
  }, key);
  t('Répondre "Non" : la personne reste active, pas licenciée", pas plus loin', afterNon.licencie === false && afterNon.stillActive, JSON.stringify(afterNon));

  // Répond "Oui" : licenciement appliqué pour de vrai
  const afterOui = await page.evaluate((key) => {
    state.overrides[key] = { stgLicenceDecision: true };
    const ctx = buildContext();
    const stillActif = ctx.actifs.some(x=>x.name==='Stagiaire Risque');
    const nowLicencie = ctx.licencies.find(x=>x.name==='Stagiaire Risque');
    return { stillActif, licencie: !!nowLicencie, reason: nowLicencie?.licenceReason };
  }, key);
  t('Répondre "Oui" : passe bien dans les licenciés, plus dans les actifs', !afterOui.stillActif && afterOui.licencie, JSON.stringify(afterOui));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
