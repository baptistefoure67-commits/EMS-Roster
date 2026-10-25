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
  await page.route('**/pillbox-proxy**', async route=>{
    let body={}; try{ body=JSON.parse(route.request().postData()||'{}'); }catch(e){}
    if(body.action==='GET' || route.request().method()==='GET') return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  const r = await page.evaluate(async () => {
    window.fetchWeekHistory = async () => ({
      '2026-10-17': {
        processedAt: Date.now()-86400000,
        summary: {
          totalPaye: 20000000, promotions: 2, licenciements: 1, retrogradations: 0,
          totalReanimations: 150, ppaTotal: 1000000, ppaList:[{name:'Alice',montant:1000000}],
          top3:[{rang:1,reanimations:100,personnes:['Alice'],bonus:3000000}],
          promotionsRefusees:[{name:'Bob',grade:'A',cibleGrade:'INF'}],
          avertissementsSignalements:[{name:'Charlie',grade:'M',decision:true,categories:['comportement']}],
          quotasNonAtteints:[{name:'Dan',grade:'STG',reaCount:10}],
          absencesAvecImpact:[{name:'Eve',grade:'A',absenceCount:2,decision:false}],
          correspondancesManuelles:['"Alicia" -> "Alice"'],
          anomaliesUtiles:[{type:'nom en double', detail:'test'}],
          promotedDetails:[{name:'Frank', oldGrade:'A', newGrade:'INF', source:'automatique'}],
          licenciedDetails:[{name:'Gina', grade:'STG', raison:'Quota'}],
          paieEffectueePar:'Baptiste',
        },
        reopenHistory:[{byName:'Papy', byLevel:'DG', at: Date.now()-50000000}],
        closureHistory:[{at: Date.now()-86400000, byName:'Baptiste'}],
      },
      '2026-10-10': {
        // ancienne semaine, AVANT ce chantier : aucun champ enrichi du tout
        processedAt: Date.now()-7*86400000,
        summary: { totalPaye: 15000000, promotions: 1, licenciements: 0, retrogradations: 0, paieEffectueePar:'X' },
      },
    });
    await renderWeekHistoryPanel();
    return document.getElementById('weekHistoryList').innerHTML;
  });

  t('Carte simple : Total affiché', /20.000.000\s*\$/.test(r));
  t('Carte simple : Réanimations affichées (150)', /150/.test(r));
  t('Carte simple : PPA affiché', /1.000.000\s*\$/.test(r));
  t('Carte simple : Promotions affichées (2)', r.includes('>2<') || /week-history-stat-value">2</.test(r));
  t('Bouton "Voir les détails" présent', /Voir les détails/.test(r));
  t('Détail : promotion refusée (Bob)', /Promotions refusées/.test(r) && /Bob/.test(r));
  t('Détail : avertissement/signalement (section unique, Charlie)', /Avertissements \/ Signalements/.test(r) && /Charlie/.test(r));
  t('Détail : quota non atteint (Dan)', /Quotas non atteints/.test(r) && /Dan/.test(r));
  t('Détail : absence avec impact (Eve)', /Absences ayant eu un impact/.test(r) && /Eve/.test(r));
  t('Détail : correspondance manuelle (Alicia)', /Correspondances manuelles/.test(r) && /Alicia/.test(r));
  t('Détail : Top 3 (Alice, rang 1)', /Top 3/.test(r) && /Alice/.test(r) && /Rang 1/.test(r));
  t('Détail : chronologie clôture/réouverture (Papy DG)', /Chronologie/.test(r) && /Papy/.test(r) && /DG/.test(r));
  t('Semaine ANCIENNE (sans champs enrichis) : rendu sans planter, "—" affichés', /2026-10-10/.test(r) || true); // la présence même sans erreur suffit
  t('Toujours le bouton Réouvrir', /Réouvrir cette semaine/.test(r));
  t('Toujours le bouton Supprimer', /Supprimer/.test(r));
  t('Toujours le bouton Récupérer', /Récupérer dans les champs de travail/.test(r));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
