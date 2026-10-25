// Suite autonome (bloc 3 — cahier des charges) : lance son propre petit
// serveur HTTP local pour servir le Pillbox fourni via PILLBOX_HTML (ou le
// dossier voisin par défaut) ; saute proprement si playwright est absent.
const path = require('path'), http = require('http'), fs = require('fs');
const { pillboxHtmlPath } = require('./_helpers');
let chromiumMod;
try{ ({ chromium: chromiumMod } = require('playwright')); }
catch(e){ console.log('⏭️  SKIP navigateur : paquet playwright absent (npm i playwright).'); process.exit(0); }
const PB_PATH = pillboxHtmlPath();
const server = http.createServer((req,res)=>{
  const p = (req.url.split('?')[0]==='/'||req.url.split('?')[0]==='/index.html') ? PB_PATH : null;
  if(!p){ res.writeHead(404); res.end(); return; }
  fs.readFile(p, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end(data); });
});


const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  await new Promise(r=>server.listen(0, r));
  const PORT = server.address().port;
  const browser = await chromiumMod.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message+' | '+e.stack));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  const r = await page.evaluate(() => {
    document.getElementById('weekStartInput').value='2026-10-17'; document.getElementById('recordInput').value='9999';
    const mk=(key,id,name,grade,paye,infoRaw='')=>({key,dossier:key,id:String(id),name,grade,role:'',info:parseInfo(infoRaw),abs:parseAbsence('',getWeekStart()),upRaw:'',payeRaw:String(paye),arriveeRaw:'01/01/2026',isNew:false,benevole:false,licencie:false,aliases:[]});
    const rows=[
      mk('k1','1','Alice Haut','ADD',11500000),
      mk('k2','2','Bob Up','A',6000000,'S1'), // éligible UP
      mk('k3','3','Charlie Bas','STG',5000000),
    ];
    const m={}; m[normalizeNameForMatch('Alice Haut')]=100; m[normalizeNameForMatch('Bob Up')]=100; m[normalizeNameForMatch('Charlie Bas')]=0;
    state.parsed={rows,reaByName:true,reaMap:m,anomalies:[{type:'correspondance approximative appliquée (à vérifier)', raw:'"Bobb" -> "Bob Up"'}],wdvNames:[]};
    state.overrides={ k2:{ upDecision:false } }; // Bob : UP proposé mais REFUSÉ
    state.ppaList=[{id:1,name:'Alice Haut',amount:'1000000',reason:'',employeeId:'1'}];
    state.primeOptionnelleList=[];
    state.signalements=[]; state.signalementsLoaded=true; state.signalementsLoadError=null;
    state.absenceSignalements=[]; state.stgAbsenceSignalements=[]; state.longAbsenceSignalements=[];
    state.absenceSignalementsLoaded=true; state.absenceSignalementsLoadError=null;
    state.formationOperationEntries=[]; state.formationOperationLoadState='found';
    state.activiteSuivi={}; state.activiteSuiviLoadError=null;

    const ctx = buildContext();
    const detail = buildWeekHistoryDetail(ctx);
    return { detail, totalReanimations_expected: 200 };
  });

  t('totalReanimations = somme des réa des actifs (100+100+0=200)', r.detail.totalReanimations===200, JSON.stringify(r.detail.totalReanimations));
  t('PPA : 1 bénéficiaire, bon montant, bon total', r.detail.ppaList.length===1 && r.detail.ppaList[0].montant===1000000 && r.detail.ppaTotal===1000000, JSON.stringify(r.detail.ppaList));
  t('Promotion refusée détectée (Bob, upDecision=false)', r.detail.promotionsRefusees.length===1 && r.detail.promotionsRefusees[0].name==='Bob Up', JSON.stringify(r.detail.promotionsRefusees));
  t('Quota non atteint : Charlie Bas (0 réa, STG non exempté)', r.detail.quotasNonAtteints.some(q=>q.name==='Charlie Bas'), JSON.stringify(r.detail.quotasNonAtteints));
  t('Correspondance manuelle remontée depuis les anomalies', r.detail.correspondancesManuelles.length===1 && /Bobb/.test(r.detail.correspondancesManuelles[0]), JSON.stringify(r.detail.correspondancesManuelles));
  t('Top3 présent et cohérent (Alice+Bob à égalité à 100 réa -> rang 1 partagé)', r.detail.top3.length>=1 && r.detail.top3[0].personnes.includes('Alice Haut') && r.detail.top3[0].personnes.includes('Bob Up'), JSON.stringify(r.detail.top3));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
