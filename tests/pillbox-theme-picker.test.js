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
  const errors = []; page.on('pageerror', e=>errors.push(e.message+' | '+e.stack));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  // 1) valeur par defaut au premier chargement
  const r1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Par défaut : --theme-primary = rouge d\'origine', r1 === '#c8102e', r1);

  // 2) ouvre la modale, selectionne violet, VERIFIE que c'est juste un apercu (pas encore sauvegarde)
  await page.evaluate(() => { document.getElementById('pillboxAccessGate').style.display='none'; document.getElementById('pillboxAppContent').style.display=''; document.getElementById('launchQuestionsModal').style.display='none'; });
  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.waitForTimeout(100);
  const modalVisible = await page.evaluate(() => getComputedStyle(document.getElementById('pillboxThemeModal')).display !== 'none');
  t('Modale s\'ouvre (pas de window.prompt)', modalVisible);

  await page.evaluate(() => document.querySelector('.pillbox-theme-preset[data-hex="#7c3aed"]').click());
  await page.waitForTimeout(50);
  const r2 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('pillboxThemeColor'),
  }));
  t('Aperçu en direct appliqué (violet)', r2.live === '#7c3aed', r2.live);
  t('MAIS rien n\'est encore sauvegardé (pas d\'Appliquer cliqué)', r2.saved === null, r2.saved);

  // 3) ferme SANS appliquer -> revient au rouge d'origine
  await page.evaluate(() => document.getElementById('pillboxThemeModal').click());
  await page.waitForTimeout(50);
  const r3 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Fermer sans appliquer restaure la couleur précédente', r3 === '#c8102e', r3);

  // 4) reouvre, choisit rose, clique Appliquer -> persiste
  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.evaluate(() => document.querySelector('.pillbox-theme-preset[data-hex="#db2777"]').click());
  await page.evaluate(() => document.getElementById('pillboxThemeApplyBtn').click());
  await page.waitForTimeout(50);
  const r4 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('pillboxThemeColor'),
    logoRotate: getComputedStyle(document.documentElement).getPropertyValue('--theme-logo-hue-rotate').trim(),
  }));
  t('Après Appliquer : couleur persistée (rose)', r4.live === '#db2777' && r4.saved === '#db2777', JSON.stringify(r4));
  t('Le logo a bien une rotation de teinte calculée (pas 0deg pour le rose)', r4.logoRotate !== '0deg', r4.logoRotate);

  // 5) recharge la page -> le rose doit persister SANS flash (chargé des le head)
  await page.reload();
  await page.waitForTimeout(100);
  const r5 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Persiste après rechargement de la page', r5 === '#db2777', r5);

  // 6) Réinitialiser -> retour exact au défaut, plus de stockage
  await page.evaluate(() => { document.getElementById('pillboxAccessGate').style.display='none'; document.getElementById('pillboxAppContent').style.display=''; document.getElementById('launchQuestionsModal').style.display='none'; });
  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.evaluate(() => document.getElementById('pillboxThemeResetBtn').click());
  await page.waitForTimeout(50);
  const r6 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('pillboxThemeColor'),
  }));
  t('Réinitialiser : retour au rouge d\'origine ET préférence supprimée', r6.live === '#c8102e' && r6.saved === null, JSON.stringify(r6));

  // 7) couleur personnalisee via <input type=color>
  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.evaluate(() => { document.getElementById('pillboxThemeCustomInput').value = '#00ff00'; document.getElementById('pillboxThemeCustomInput').dispatchEvent(new Event('input')); });
  await page.waitForTimeout(50);
  const r7 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Sélecteur personnalisé (input color) fonctionne en aperçu', r7 === '#00ff00', r7);
  await page.evaluate(() => document.getElementById('pillboxThemeApplyBtn').click());

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
