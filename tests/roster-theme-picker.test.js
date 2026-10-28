// Suite autonome (26/10, personnalisation de couleur Roster) : lance son
// propre petit serveur HTTP local pour servir le index.html du Roster
// lui-même ; saute proprement si playwright est absent.
const path = require("path"), http = require("http"), fs = require("fs");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const ROSTER_PATH = path.join(__dirname, "..", "index.html");
const server = http.createServer((req,res)=>{
  const p = (req.url.split("?")[0]==="/"||req.url.split("?")[0]==="/index.html") ? ROSTER_PATH : null;
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

  const r1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Par défaut : --theme-primary = bleu d\'origine', r1 === '#2563eb', r1);

  await page.evaluate(() => { document.getElementById('accessGate').style.display='none'; document.getElementById('appContent').style.display=''; });
  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  await page.waitForTimeout(100);
  const modalVisible = await page.evaluate(() => getComputedStyle(document.getElementById('rosterThemeModal')).display !== 'none');
  t('Modale s\'ouvre (pas de window.prompt)', modalVisible);

  await page.evaluate(() => document.querySelector('.roster-theme-preset[data-hex="#7c3aed"]').click());
  await page.waitForTimeout(50);
  const r2 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('rosterThemeColor'),
  }));
  t('Aperçu en direct appliqué (violet)', r2.live === '#7c3aed', r2.live);
  t('Rien n\'est encore sauvegardé', r2.saved === null, r2.saved);

  await page.evaluate(() => {
    const modal = document.getElementById('rosterThemeModal');
    modal.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }));
    modal.dispatchEvent(new MouseEvent('click', { bubbles:true }));
  });
  await page.waitForTimeout(50);
  const r3 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Fermer sans appliquer restaure la couleur précédente', r3 === '#2563eb', r3);

  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  await page.evaluate(() => document.querySelector('.roster-theme-preset[data-hex="#db2777"]').click());
  await page.evaluate(() => document.getElementById('rosterThemeApplyBtn').click());
  await page.waitForTimeout(50);
  const r4 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('rosterThemeColor'),
  }));
  t('Après Appliquer : couleur persistée (rose)', r4.live === '#db2777' && r4.saved === '#db2777', JSON.stringify(r4));

  await page.reload();
  await page.waitForTimeout(100);
  const r5 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Persiste après rechargement de la page', r5 === '#db2777', r5);

  await page.evaluate(() => { document.getElementById('accessGate').style.display='none'; document.getElementById('appContent').style.display=''; });
  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  await page.evaluate(() => document.getElementById('rosterThemeResetBtn').click());
  await page.waitForTimeout(50);
  const r6 = await page.evaluate(() => ({
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
    saved: localStorage.getItem('rosterThemeColor'),
  }));
  t('Réinitialiser : retour au bleu d\'origine ET préférence supprimée', r6.live === '#2563eb' && r6.saved === null, JSON.stringify(r6));

  // --cyan/--blue (animations) jamais modifiees malgre le theme violet
  await page.evaluate(() => rosterSaveTheme('#7c3aed'));
  const r7 = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { cyan: cs.getPropertyValue('--cyan').trim(), blue: cs.getPropertyValue('--blue').trim() };
  });
  t('--cyan (animations) jamais touché par le thème', r7.cyan === '#38bdf8', r7.cyan);
  t('--blue (animations) jamais touché par le thème', r7.blue === '#2563eb', r7.blue);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
