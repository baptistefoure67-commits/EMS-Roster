// Suite autonome (26/10) : vérifie l'indépendance TOTALE entre les thèmes
// Roster et Pillbox — changer l'un ne doit jamais affecter l'autre, et
// chacun utilise sa propre clé localStorage. Lance deux petits serveurs
// HTTP locaux ; saute proprement si playwright est absent.
const path = require("path"), http = require("http"), fs = require("fs");
const { pillboxHtmlPath } = require("./_helpers");
let chromiumMod;
try{ ({ chromium: chromiumMod } = require("playwright")); }
catch(e){ console.log("⏭️  SKIP navigateur : paquet playwright absent (npm i playwright)."); process.exit(0); }
const ROSTER_PATH = path.join(__dirname, "..", "index.html");
const PB_PATH = pillboxHtmlPath();
function makeServer(filePath){
  return http.createServer((req,res)=>{
    const p = (req.url.split("?")[0]==="/"||req.url.split("?")[0]==="/index.html") ? filePath : null;
    if(!p){ res.writeHead(404); res.end(); return; }
    fs.readFile(p, (err,data)=>{ if(err){ res.writeHead(404); res.end(); return; } res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"}); res.end(data); });
  });
}
const rosterServer = makeServer(ROSTER_PATH);
const pillboxServer = makeServer(PB_PATH);


const results = []; let failed = 0;
const t = (name, cond, extra='') => { if(cond){results.push('✅ '+name);} else {results.push('❌ '+name+' -> '+extra); failed++;} };

(async()=>{
  await new Promise(r=>rosterServer.listen(0, r));
  await new Promise(r=>pillboxServer.listen(0, r));
  const PORT_ROSTER = rosterServer.address().port;
  const PORT_PILLBOX = pillboxServer.address().port;
  const browser = await chromiumMod.launch();
  const rosterPage = await browser.newPage();
  const pillboxPage = await browser.newPage();

  await rosterPage.goto(`http://localhost:${PORT_ROSTER}/index.html`);
  await pillboxPage.goto(`http://localhost:${PORT_PILLBOX}/index.html`);
  await rosterPage.waitForTimeout(300); await pillboxPage.waitForTimeout(300);

  await rosterPage.evaluate(() => rosterSaveTheme('#7c3aed'));   // Roster -> violet
  await pillboxPage.evaluate(() => pillboxSaveTheme('#dc2626')); // Pillbox -> rouge vif

  await rosterPage.reload(); await pillboxPage.reload();
  await rosterPage.waitForTimeout(300); await pillboxPage.waitForTimeout(300);

  const rosterColor = await rosterPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  const pillboxColor = await pillboxPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Roster = violet après rechargement', rosterColor === '#7c3aed', rosterColor);
  t('Pillbox = rouge vif après rechargement (indépendant)', pillboxColor === '#dc2626', pillboxColor);

  // Change Roster -> bleu ; Pillbox ne doit PAS bouger
  await rosterPage.evaluate(() => rosterSaveTheme('#2563eb'));
  await rosterPage.waitForTimeout(100);
  const pillboxColorAfter = await pillboxPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim());
  t('Changer Roster -> bleu ne modifie PAS Pillbox (toujours rouge vif)', pillboxColorAfter === '#dc2626', pillboxColorAfter);

  // Verifie les cles localStorage separees
  const rosterKeys = await rosterPage.evaluate(() => Object.keys(localStorage));
  const pillboxKeys = await pillboxPage.evaluate(() => Object.keys(localStorage));
  t('Roster utilise bien la clé rosterThemeColor', rosterKeys.includes('rosterThemeColor'));
  t('Pillbox utilise bien la clé pillboxThemeColor (différente)', pillboxKeys.includes('pillboxThemeColor'));

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis`);
  await browser.close(); rosterServer.close(); pillboxServer.close();
  process.exit(failed ? 1 : 0);
})();
