// Suite autonome (signalé par l'utilisateur) : la modale de couleur ne
// doit plus se fermer sur un évènement clic isolé/synthétique (causé par
// le sélecteur <input type="color"> natif sur certains navigateurs), tout
// en gardant un vrai clic sur le fond fonctionnel, plus un bouton ✕ fiable.
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
  const errors = []; page.on('pageerror', e=>errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.getElementById('accessGate').style.display='none'; document.getElementById('appContent').style.display=''; });

  // 1) Un clic "synthétique" isolé sur le fond (comme un évènement bizarre
  // déclenché par le sélecteur natif, SANS mousedown préalable dessus) ne
  // doit PLUS fermer la modale.
  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  await page.evaluate(() => document.querySelector('.roster-theme-preset[data-hex="#7c3aed"]').click());
  await page.evaluate(() => {
    const modal = document.getElementById('rosterThemeModal');
    modal.dispatchEvent(new MouseEvent('click', { bubbles:true, target: modal }));
  });
  await page.waitForTimeout(50);
  const r1 = await page.evaluate(() => ({
    modalStillOpen: getComputedStyle(document.getElementById('rosterThemeModal')).display !== 'none',
    live: getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim(),
  }));
  t('Un clic synthétique isolé ne ferme PLUS la modale (corrigé)', r1.modalStillOpen, JSON.stringify(r1));
  t('La couleur en cours de choix (violet) n\'est pas perdue', r1.live === '#7c3aed', r1.live);

  // 2) Un VRAI clic (mousedown + click sur le fond) continue de fermer normalement
  await page.evaluate(() => {
    const modal = document.getElementById('rosterThemeModal');
    const rect = modal.getBoundingClientRect();
  });
  await page.mouse.click(5, 5); // coin du fond, loin de la carte centrale
  await page.waitForTimeout(50);
  const r2 = await page.evaluate(() => getComputedStyle(document.getElementById('rosterThemeModal')).display);
  t('Un vrai clic sur le fond ferme toujours normalement', r2 === 'none', r2);

  // 3) Le bouton ✕ fonctionne
  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  await page.evaluate(() => document.getElementById('rosterThemeCloseBtn').click());
  await page.waitForTimeout(50);
  const r3 = await page.evaluate(() => getComputedStyle(document.getElementById('rosterThemeModal')).display);
  t('Le bouton ✕ ferme bien la modale', r3 === 'none', r3);

  // 4) Les presets "spéciaux" sont bien présents et appliquent une vraie couleur fixe
  await page.evaluate(() => document.getElementById('rosterThemeBtn').click());
  const r4 = await page.evaluate(() => {
    const btn = document.querySelector('.roster-theme-preset[data-hex="#d946ef"]');
    return { exists: !!btn, title: btn && btn.title };
  });
  t('Le preset "Holographique" existe', r4.exists, JSON.stringify(r4));
  await page.evaluate(() => document.querySelector('.roster-theme-preset[data-hex="#d946ef"]').click());
  const r5 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Cliquer "Holographique" applique une vraie couleur fixe (#d946ef)', r5 === '#d946ef', r5);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
