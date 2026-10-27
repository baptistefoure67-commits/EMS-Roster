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
  const dialogs = [];
  page.on('dialog', async d=>{ dialogs.push(d.message()); await d.accept(); });
  await page.route('**/pillbox-proxy**', async route=>{
    let body={}; try{ body=JSON.parse(route.request().postData()||'{}'); }catch(e){}
    if(body.action==='getWeekHistoryEntry') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,state:'absent',entry:null})});
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    pillboxSessionToken = btoa(JSON.stringify({discordId:'1',name:'Baptiste',level:'ADD',exp:Date.now()+7200000})).replace(/=+$/,'')+'.sig';
    payRulesReady=true; pillboxAnimEnabled=false;
    // Une semaine PLUS RECENTE est déjà dans l'historique (2026-10-24)
    window.fetchWeekHistory = async () => ({ '2026-10-24': { processedAt: Date.now(), summary:{ totalPaye: 1000 } } });
    // Mais le formulaire est resté chargé sur une semaine PLUS ANCIENNE (simulateur d'oubli après un "Récupérer")
    document.getElementById('weekStartInput').value = '2026-10-10';
    const mk=(key,id,name,grade,paye)=>({key,dossier:key,id:String(id),name,grade,role:'',info:parseInfo(''),abs:parseAbsence('',getWeekStart()),upRaw:'',payeRaw:String(paye),arriveeRaw:'01/01/2026',isNew:false,benevole:false,licencie:false,aliases:[]});
    const rows=[mk('k1','1','Alice Haut','ADD',11500000)];
    const m={}; m[normalizeNameForMatch('Alice Haut')]=10;
    state.parsed={rows,reaByName:true,reaMap:m,anomalies:[],wdvNames:[]}; state.overrides={};
    state.ppaList=[];state.primeOptionnelleList=[];state.signalements=[];state.signalementsLoaded=true;state.signalementsLoadError=null;state.absenceSignalements=[];state.stgAbsenceSignalements=[];state.longAbsenceSignalements=[];state.absenceSignalementsLoaded=true;state.absenceSignalementsLoadError=null;state.formationOperationEntries=[];state.formationOperationLoadState='found';state.activiteSuivi={};state.activiteSuiviLoadError=null;
    document.getElementById('launchQuestionsModal').style.display='none';
    render();
  });
  await page.evaluate(() => { document.querySelector('[data-action="finishWeek"]').click(); });
  await page.waitForTimeout(500);

  t('Un avertissement explicite apparaît (ancienne semaine chargée alors qu\'une plus récente existe)', dialogs.some(d=>/PLUS ANCIENNE/.test(d)), JSON.stringify(dialogs));
  t('L\'avertissement mentionne bien la date de la semaine la plus récente déjà close (2026-10-24)', dialogs.some(d=>d.includes('2026-10-24')), JSON.stringify(dialogs));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
