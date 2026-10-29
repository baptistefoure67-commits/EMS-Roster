// Suite autonome (test global avant clôture) : vérifie l'avertissement à
// confirmation obligatoire pour RF/RP/MF/MP/MLP/RL — proposé, "Non" ne
// l'applique pas, "Oui" l'applique, la personne reste active dans les
// deux cas (seul le compteur Q avance ou non).
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
  const sample = '📂:d1\t[RF] Formateur Quota\t100001\tRF\t\t\tf0\t01/01\t0\t01/01\tf4';
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);
  await page.evaluate((sample) => {
    pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
    document.getElementById('weekStartInput').value='2026-10-17';
    document.getElementById('tableauText').value = sample;
    document.getElementById('tableauText').dispatchEvent(new Event('input'));
    document.getElementById('reaText').value = '1. Formateur Quota - Réa : 5';
    document.getElementById('reaText').dispatchEvent(new Event('input'));
  }, sample);
  await page.evaluate(() => document.getElementById('analyzeBtn').click());
  await page.waitForTimeout(1000);
  const key = await page.evaluate(() => { document.getElementById('launchQuestionsModal').style.display='none'; return state.parsed.rows.find(r=>r.name==='Formateur Quota').key; });

  const before = await page.evaluate(() => {
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Formateur Quota');
    return { pendingManualQ: e.pendingManualQ, inPendingQ: ctx.pendingQ.some(x=>x.name==='Formateur Quota'), inUnanswered: ctx.unansweredQ.some(x=>x.name==='Formateur Quota') };
  });
  t('RF qui rate son quota : avertissement PROPOSÉ (RF/RP/MF/MP/MLP/RL confirmation obligatoire)', before.pendingManualQ === true && before.inUnanswered, JSON.stringify(before));

  // Refuse d'appliquer le Q cette semaine
  const afterNon = await page.evaluate((key) => {
    state.overrides[key] = { applyQ: false };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Formateur Quota');
    return { inUnanswered: ctx.unansweredQ.some(x=>x.name==='Formateur Quota'), stillActive: ctx.actifs.some(x=>x.name==='Formateur Quota') };
  }, key);
  t('Répondre explicitement "ne pas appliquer" : plus en attente, personne toujours active', !afterNon.inUnanswered && afterNon.stillActive, JSON.stringify(afterNon));

  // Confirme l'avertissement
  const afterOui = await page.evaluate((key) => {
    state.overrides[key] = { applyQ: true };
    const ctx = buildContext();
    const e = ctx.actifs.find(x=>x.name==='Formateur Quota');
    return { inUnanswered: ctx.unansweredQ.some(x=>x.name==='Formateur Quota'), stillActive: ctx.actifs.some(x=>x.name==='Formateur Quota') };
  }, key);
  t('Confirmer l application : plus en attente, personne toujours active (juste son Q qui avance)', !afterOui.inUnanswered && afterOui.stillActive, JSON.stringify(afterOui));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
