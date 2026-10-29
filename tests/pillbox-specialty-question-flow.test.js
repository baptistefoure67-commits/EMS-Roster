// Suite autonome (test global avant clôture) : vérifie le choix de
// spécialité lors d'une promotion Médecin (M → MF/MP/MLP) — accepter
// sans choisir bloque la promotion, choisir MP l'applique correctement.
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
  const sample = '📂:d1\t[M] Medecin Specialite\t100001\tM\tS1\t\tf0\t01/01\t0\t01/01\tf4';
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  await page.evaluate((sample) => {
    pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
    document.getElementById('weekStartInput').value='2026-10-17';
    document.getElementById('tableauText').value = sample;
    document.getElementById('tableauText').dispatchEvent(new Event('input'));
    document.getElementById('reaText').value = '1. Medecin Specialite - Réa : 80';
    document.getElementById('reaText').dispatchEvent(new Event('input'));
  }, sample);
  await page.evaluate(() => document.getElementById('analyzeBtn').click());
  await page.waitForTimeout(1000);
  const key = await page.evaluate(() => { document.getElementById('launchQuestionsModal').style.display='none'; state.formationOperationEntries=[]; state.formationOperationLoadState='found'; return state.parsed.rows.find(r=>r.name==='Medecin Specialite').key; });

  // Accepte la promotion SANS choisir de spécialité -> doit etre bloque, en attente de choix
  const afterUpYes = await page.evaluate((key) => {
    state.overrides[key] = { upDecision: true };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Medecin Specialite');
    return { specialtyMissing: e.specialtyMissing, promoted: e.promoted, targetGrade: e.targetGrade };
  }, key);
  t('Accepter sans choisir de spécialité : promotion PAS encore effective (spécialité manquante)', afterUpYes.specialtyMissing === true && afterUpYes.promoted === false, JSON.stringify(afterUpYes));

  // Choisit MP (psychologue) -> promotion effective avec la bonne specialite
  const afterChoice = await page.evaluate((key) => {
    state.overrides[key] = { upDecision: true, upTarget: 'MP' };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Medecin Specialite');
    return { specialtyMissing: e.specialtyMissing, promoted: e.promoted, targetGrade: e.targetGrade, inManualPromotions: ctx.manualPromotions.some(x=>x.name==='Medecin Specialite') };
  }, key);
  t('Après avoir choisi MP : promotion effective avec la bonne spécialité', afterChoice.specialtyMissing === false && afterChoice.promoted === true && afterChoice.targetGrade === 'MP' && afterChoice.inManualPromotions, JSON.stringify(afterChoice));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
