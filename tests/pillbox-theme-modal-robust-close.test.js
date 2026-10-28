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
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById('pillboxAccessGate').style.display='none'; document.getElementById('pillboxAppContent').style.display=''; document.getElementById('launchQuestionsModal').style.display='none'; });

  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.evaluate(() => document.querySelector('.pillbox-theme-preset[data-hex="#7c3aed"]').click());
  await page.evaluate(() => {
    const modal = document.getElementById('pillboxThemeModal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles:true, target: modal }));
  });
  await page.waitForTimeout(50);
  const r1 = await page.evaluate(() => ({
    modalStillOpen: getComputedStyle(document.getElementById('pillboxThemeModal')).display !== 'none',
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
  }));
  t('Un clic synthétique isolé ne ferme PLUS la modale (corrigé)', r1.modalStillOpen, JSON.stringify(r1));
  t('La couleur en cours de choix (violet) n\'est pas perdue', r1.live === '#7c3aed', r1.live);

  await page.mouse.click(5, 5);
  await page.waitForTimeout(50);
  const r2 = await page.evaluate(() => getComputedStyle(document.getElementById('pillboxThemeModal')).display);
  t('Un vrai clic sur le fond ferme toujours normalement', r2 === 'none', r2);

  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  await page.evaluate(() => document.getElementById('pillboxThemeCloseBtn').click());
  await page.waitForTimeout(50);
  const r3 = await page.evaluate(() => getComputedStyle(document.getElementById('pillboxThemeModal')).display);
  t('Le bouton ✕ ferme bien la modale', r3 === 'none', r3);

  await page.evaluate(() => document.getElementById('pillboxThemeBtn').click());
  const r4 = await page.evaluate(() => !!document.querySelector('.pillbox-theme-preset[data-effect="holographic"]'));
  t('Le preset "Holographique" existe', r4);
  await page.evaluate(() => document.querySelector('.pillbox-theme-preset[data-effect="holographic"]').click());
  const r5 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Cliquer "Holographique" applique bien sa couleur de base (#ff74d4) — désormais un mode animé, plus une simple couleur fixe', r5 === '#ff74d4', r5);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
