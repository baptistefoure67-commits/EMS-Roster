// Suite autonome (bloc 4 — cahier des charges) : lance son propre petit
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
    const out = {};
    RECRUITMENT_PRICE = 500000; FORMATION_PRICE = 70000;
    state.activiteSuiviLoadError = null;
    state.activiteSuivi = {
      'id:1': { recrutements: 3, formations: 7 },     // normal, ventilable
      'id:2': { recrutements: 0, formations: 0 },      // rien a ventiler
      'id:3': { recrutements: 10, formations: 10 },    // depasse les heures
    };

    // 1) ventilation normale (exemple exact du cahier des charges, point 62)
    out.normal = buildPayBreakdown({id:'1', name:'Djam', grade:'MF'}, 5000000);

    // 2) rien a ventiler -> "-" partout, heures intactes
    out.zero = buildPayBreakdown({id:'2', name:'Zero', grade:'MF'}, 5000000);

    // 3) grade non-Formateur (ex: INF) -> jamais de ventilation même avec des compteurs ailleurs
    state.activiteSuivi['id:4'] = { recrutements: 5, formations: 5 };
    out.wrongGrade = buildPayBreakdown({id:'4', name:'PasFormateur', grade:'INF'}, 5000000);

    // 4) Psychologue (MP/RP) -> jamais touché, même grade proche
    state.activiteSuivi['id:5'] = { testsPsy:2, ppa:1, consultations:3 }; // pas recrutements/formations du tout
    out.psy = buildPayBreakdown({id:'5', name:'Psy', grade:'MP'}, 5000000);

    // 5) panne activité -> aucune ventilation, Heures conservées, signalé
    state.activiteSuiviLoadError = "panne simulée";
    out.panne = buildPayBreakdown({id:'1', name:'Djam', grade:'MF'}, 5000000);
    state.activiteSuiviLoadError = null;

    // 6) incohérent : ventilation calculée > Heures dispo -> aucune ventilation, avertissement, pas de négatif
    out.incoherent = buildPayBreakdown({id:'3', name:'Trop', grade:'RF'}, 5000000);

    return out;
  });

  t('Ventilation normale : 3 recrutements à 500k = 1 500 000', r.normal.recrutements && r.normal.recrutements.montant===1500000 && r.normal.recrutements.count===3, JSON.stringify(r.normal));
  t('Ventilation normale : 7 formations à 70k = 490 000', r.normal.formations && r.normal.formations.montant===490000 && r.normal.formations.count===7, JSON.stringify(r.normal));
  t('Ventilation normale : Heures = 5 000 000 - 1 500 000 - 490 000 = 3 010 000 (exemple exact du cahier des charges)', r.normal.heures===3010000, JSON.stringify(r.normal));

  t('0 recrutement / 0 formation -> aucune ventilation (null)', r.zero.recrutements===null && r.zero.formations===null && r.zero.heures===5000000, JSON.stringify(r.zero));

  t('Grade non-Formateur -> jamais de ventilation même avec des compteurs présents ailleurs', r.wrongGrade.recrutements===null && r.wrongGrade.formations===null && r.wrongGrade.heures===5000000, JSON.stringify(r.wrongGrade));

  t('Psychologue (MP) -> totalement intact, aucune ventilation (point 42)', r.psy.recrutements===null && r.psy.formations===null && r.psy.heures===5000000 && !r.psy.warning && !r.psy.unverifiable, JSON.stringify(r.psy));

  t('Panne activité : Heures ORIGINALES conservées (rien retiré)', r.panne.heures===5000000, JSON.stringify(r.panne));
  t('Panne activité : signalée via unverifiable=true', r.panne.unverifiable===true, JSON.stringify(r.panne));
  t('Panne activité : AUCUNE ventilation appliquée', r.panne.recrutements===null && r.panne.formations===null, JSON.stringify(r.panne));

  t('Incohérent (ventilation > Heures) : Heures ORIGINALES conservées', r.incoherent.heures===5000000, JSON.stringify(r.incoherent));
  t('Incohérent : aucune ventilation appliquée (pas de négatif)', r.incoherent.recrutements===null && r.incoherent.formations===null, JSON.stringify(r.incoherent));
  t('Incohérent : avertissement présent', !!r.incoherent.warning, JSON.stringify(r.incoherent));

  // Test réglages centralisés (point 63) : changer le tarif -> tout suit
  const r2 = await page.evaluate(() => {
    RECRUITMENT_PRICE = 500000; FORMATION_PRICE = 70000;
    state.activiteSuiviLoadError = null;
    state.activiteSuivi = { 'id:9': { recrutements: 0, formations: 2 } };
    const before = buildPayBreakdown({id:'9', name:'X', grade:'RF'}, 1000000);
    applyFetchedPayRules({ formationPrice: 90000 }); // simule un changement de réglage
    const after = buildPayBreakdown({id:'9', name:'X', grade:'RF'}, 1000000);
    return { before, after, FORMATION_PRICE };
  });
  t('Réglage centralisé : 70k -> 90k change bien le résultat (point 63)', r2.before.formations.montant===140000 && r2.after.formations.montant===180000 && r2.FORMATION_PRICE===90000, JSON.stringify(r2));

  // Test zéro (point 65)
  const r3 = await page.evaluate(() => {
    state.activiteSuiviLoadError = null;
    state.activiteSuivi = { 'id:10': { recrutements: 0, formations: 0 } };
    return buildPayBreakdown({id:'10', name:'Zero2', grade:'MF'}, 2000000);
  });
  t('0/0 -> "—" (null) pour les deux colonnes (point 65)', r3.recrutements===null && r3.formations===null);

  // Test total inchangé (point 39 / 67) : simuler le calcul complet dans l'UI
  const r4 = await page.evaluate(() => {
    document.getElementById('weekStartInput').value='2026-10-17'; document.getElementById('recordInput').value='9999';
    const mk=(key,id,name,grade,paye)=>({key,dossier:key,id:String(id),name,grade,role:'',info:parseInfo(''),abs:parseAbsence('',getWeekStart()),upRaw:'',payeRaw:String(paye),arriveeRaw:'01/01/2026',isNew:false,benevole:false,licencie:false,aliases:[]});
    const rows=[mk('k1','1','Formateur Test','RF',15000000)]; // fixedSalaryByGrade.RF=10M -> heures=5M
    const m={}; m[normalizeNameForMatch('Formateur Test')]=50;
    state.parsed={rows,reaByName:true,reaMap:m,anomalies:[],wdvNames:[]}; state.overrides={};
    state.ppaList=[];state.primeOptionnelleList=[];state.signalements=[];state.signalementsLoaded=true;state.signalementsLoadError=null;state.absenceSignalements=[];state.stgAbsenceSignalements=[];state.longAbsenceSignalements=[];state.absenceSignalementsLoaded=true;state.absenceSignalementsLoadError=null;state.formationOperationEntries=[];state.formationOperationLoadState='found';
    state.activiteSuiviLoadError = null;
    state.activiteSuivi = { 'id:1': { recrutements: 3, formations: 7 } };
    RECRUITMENT_PRICE=500000; FORMATION_PRICE=70000;
    const ctx = buildContext();
    const totalBefore = ctx.totalPaye;
    const txt = buildDetailPayesText(ctx);
    const html = buildPayeDetailStep(ctx);
    return { totalBefore, txt, html };
  });
  t('TOTAL inchangé par la ventilation (point 39/67) : total = payeTableau + réa + bonus Top3 (ventilation = 0 impact)', r4.totalBefore === 15000000 + 50*14000 + 3000000, JSON.stringify(r4.totalBefore));
  t('TXT contient bien "Recrutements" et "Formations" avec les bons montants', /Recrutements\s*:\s*3\s*×\s*500.000\s*\$\s*=\s*1.500.000\s*\$/.test(r4.txt) && /Formations\s*:\s*7\s*×\s*70.000\s*\$\s*=\s*490.000\s*\$/.test(r4.txt), r4.txt.slice(0,600));
  t('TXT : format "DÉTAIL DE PAYE — NOM" présent (exemple du cahier des charges)', /DÉTAIL DE PAYE — FORMATEUR TEST/.test(r4.txt));
  t('Tableau HTML contient les colonnes Recrutements/Formations', /<th>Recrutements<\/th>/.test(r4.html) && /<th>Formations<\/th>/.test(r4.html));
  t('Tableau HTML : valeur ventilée affichée (3 × ... et 490k ou 490 000)', /3 ×/.test(r4.html) && /490k|490 000/.test(r4.html), r4.html.slice(r4.html.indexOf('<tbody>'), r4.html.indexOf('<tbody>')+900));
  t('Pas de fiche/modale individuelle ajoutée (point 52) : toujours UN seul <table>', (r4.html.match(/<table/g)||[]).length===1, r4.html.match(/<table/g));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
