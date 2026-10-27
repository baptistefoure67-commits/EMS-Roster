// Suite autonome (26/10, personnalisation de couleur Pillbox) : lance son
// propre petit serveur HTTP local pour servir le Pillbox fourni via
// PILLBOX_HTML (ou le dossier voisin par défaut) ; saute proprement si
// playwright est absent.
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
  const sample = `📂:dossier1\t[ADD] Alice Haut\t100001\tADD\t\t\tf0\t01/01\t0\t01/01\tf4\n📂:dossier2\t[RF] Formateur Un\t100002\tRF\t\t\tf0\t01/01\t0\t01/01\tf4`;

  async function buildTxt(){
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForTimeout(500);
    await page.evaluate((sample) => {
      pillboxSessionToken='fake'; payRulesReady=true; pillboxAnimEnabled=false;
      document.getElementById('weekStartInput').value='2026-10-17';
      document.getElementById('tableauText').value = sample;
      document.getElementById('tableauText').dispatchEvent(new Event('input'));
      document.getElementById('reaText').value = '1. Alice Haut - Réa : 120\\n2. Formateur Un - Réa : 80';
      document.getElementById('reaText').dispatchEvent(new Event('input'));
    }, sample);
    await page.evaluate(() => document.getElementById('analyzeBtn').click());
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      state.ppaList=[{id:1,name:'Alice Haut',amount:'500000',reason:'',employeeId:'100001'}];
      state.activiteSuivi={ 'id:100002': { recrutements: 2, formations: 3 } };
      state.activiteSuiviLoadError = null;
      const ctx = buildContext();
      return {
        detail: buildDetailPayesText(ctx),
      };
    });
  }

  // Thème par défaut
  const before = await buildTxt();

  // Thème violet appliqué
  await page.evaluate(() => { pillboxSaveTheme('#7c3aed'); });
  const after = await buildTxt();

  t('TXT détail des payes : identique au caractère près avant/après thème', before.detail === after.detail, before.detail===after.detail ? '' : 'DIFFÉRENT — voir diff manuel');
  if(before.detail !== after.detail){
    for(let i=0;i<Math.max(before.detail.length, after.detail.length);i++){
      if(before.detail[i] !== after.detail[i]){ console.log("premiere difference a l index", i, JSON.stringify(before.detail.slice(i,i+40)), "vs", JSON.stringify(after.detail.slice(i,i+40))); break; }
    }
  }

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
