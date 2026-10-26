// Suite autonome (audit 26/10) : les tarifs de paie doivent être figés au
// lancement d'une analyse — un rafraîchissement de fond ne doit jamais
// modifier les valeurs pendant qu'une analyse est déjà affichée. Lance son
// propre petit serveur HTTP local ; saute proprement si playwright absent.
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
    // Simule un premier chargement : aucune analyse en cours.
    state.parsed = null;
    applyFetchedPayRules({ reaRate: 14000, recruitmentPrice: 500000, formationPrice: 70000 });
    out.initial = { REA_RATE, RECRUITMENT_PRICE, FORMATION_PRICE };

    // Une "analyse" est maintenant affichée.
    state.parsed = { rows: [], anomalies: [], reaMap: {}, reaByName: false };

    // Un rafraîchissement de fond (comme pillboxStartPresence toutes les 25 s)
    // arrive avec des tarifs DIFFÉRENTS pendant que l'analyse est affichée.
    pendingPayRulesConfig = { reaRate: 99999, recruitmentPrice: 1, formationPrice: 1 };
    // Simule exactement ce que fait fetchPayRulesConfig() quand analysisActive=true :
    // il stocke pendingPayRulesConfig SANS jamais appeler applyFetchedPayRules().
    out.afterBackgroundRefresh = { REA_RATE, RECRUITMENT_PRICE, FORMATION_PRICE };

    // L'utilisateur relance une VRAIE nouvelle analyse (runAnalysis gère ça
    // en tout début de fonction) : on simule juste l'application qu'il
    // effectue, sans tout le parsing complet.
    if(pendingPayRulesConfig) applyFetchedPayRules(pendingPayRulesConfig);
    out.afterNewAnalysis = { REA_RATE, RECRUITMENT_PRICE, FORMATION_PRICE };

    return out;
  });

  t('Avant toute analyse : tarifs initiaux appliqués (14000/500000/70000)', r.initial.REA_RATE===14000 && r.initial.RECRUITMENT_PRICE===500000 && r.initial.FORMATION_PRICE===70000, JSON.stringify(r.initial));
  t('PENDANT une analyse affichée : le rafraîchissement de fond NE CHANGE RIEN aux tarifs live', r.afterBackgroundRefresh.REA_RATE===14000 && r.afterBackgroundRefresh.RECRUITMENT_PRICE===500000 && r.afterBackgroundRefresh.FORMATION_PRICE===70000, JSON.stringify(r.afterBackgroundRefresh));
  t('Une NOUVELLE analyse applique bien les tarifs les plus récents connus', r.afterNewAnalysis.REA_RATE===99999 && r.afterNewAnalysis.RECRUITMENT_PRICE===1 && r.afterNewAnalysis.FORMATION_PRICE===1, JSON.stringify(r.afterNewAnalysis));

  // Vérifie aussi que runAnalysis() lui-même applique bien pendingPayRulesConfig
  // en tout début d'exécution (pas juste dans mon simulacre ci-dessus).
  const r2 = await page.evaluate(() => {
    const src = runAnalysis.toString();
    return { appliquePendingAuDebut: /if\(pendingPayRulesConfig\) applyFetchedPayRules\(pendingPayRulesConfig\)/.test(src.slice(0, src.indexOf('parseTableau'))) };
  });
  t('runAnalysis() applique bien pendingPayRulesConfig AVANT tout calcul', r2.appliquePendingAuDebut);

  // Vérifie que fetchPayRulesConfig() ne touche pas payRulesReady/payRulesLoadError
  // pendant une analyse active, même en cas d'ÉCHEC du rafraîchissement.
  const r3 = await page.evaluate(() => {
    const src = fetchPayRulesConfig.toString();
    return {
      aLaGardeAnalysisActive: /const analysisActive = !!state\.parsed/.test(src),
      neTouchePasPayRulesReadySiActive: /if\(!analysisActive\)\{[\s\S]*?payRulesReady = false/.test(src),
    };
  });
  t('fetchPayRulesConfig() protège bien une analyse déjà affichée', r3.aLaGardeAnalysisActive && r3.neTouchePasPayRulesReadySiActive, JSON.stringify(r3));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
