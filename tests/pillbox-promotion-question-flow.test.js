// Suite autonome (test global avant clôture) : vérifie le vrai cycle
// d'une question de promotion (UP) — proposée, puis confirmée par "Oui",
// avec le grade cible correctement enregistré et la paye de la semaine
// en cours restant sur l'ancien grade.
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
  const sample = '📂:d1\t[A] Ambulancier UP\t100001\tA\tS1\t\tf0\t01/01\t0\t01/01\tf4';
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  await page.evaluate((sample) => {
    pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
    document.getElementById('weekStartInput').value='2026-10-17';
    document.getElementById('tableauText').value = sample;
    document.getElementById('tableauText').dispatchEvent(new Event('input'));
    document.getElementById('reaText').value = '1. Ambulancier UP - Réa : 80';
    document.getElementById('reaText').dispatchEvent(new Event('input'));
  }, sample);
  await page.evaluate(() => document.getElementById('analyzeBtn').click());
  await page.waitForTimeout(1000);

  // AVANT la décision : proposée mais pas encore appliquée
  const before = await page.evaluate(() => {
    document.getElementById('launchQuestionsModal').style.display='none';
    state.formationOperationEntries=[]; state.formationOperationLoadState='found';
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Ambulancier UP');
    return { grade: e.grade, inManualPromotions: ctx.manualPromotions.some(x=>x.name==='Ambulancier UP'), inUnanswered: ctx.unansweredUp.some(x=>x.name==='Ambulancier UP') };
  });
  t('Avant décision : grade encore A, proposition en attente', before.grade === 'A' && before.inUnanswered && !before.inManualPromotions, JSON.stringify(before));

  // Accepte la promotion — EXACTEMENT comme le bouton "Oui" le ferait (via state.overrides)
  const key = await page.evaluate(() => state.parsed.rows.find(r=>r.name==='Ambulancier UP').key);
  const after = await page.evaluate((key) => {
    state.overrides[key] = { upDecision: true };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Ambulancier UP');
    return {
      inManualPromotions: ctx.manualPromotions.some(x=>x.name==='Ambulancier UP'),
      inUnanswered: ctx.unansweredUp.some(x=>x.name==='Ambulancier UP'),
      promoted: e.promoted, targetGrade: e.targetGrade, gradeThisWeek: e.grade,
    };
  }, key);
  t('Après "Oui" : passe de "en attente" à "confirmée"', after.inManualPromotions && !after.inUnanswered, JSON.stringify(after));
  t('Grade cible bien enregistré (A → INF)', after.promoted === true && after.targetGrade === 'INF', JSON.stringify(after));
  t("Paye de CETTE semaine reste sur l ancien grade (A) — promotion effective la semaine suivante", after.gradeThisWeek === 'A', after.gradeThisWeek);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
