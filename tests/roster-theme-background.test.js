// Suite autonome (26/10) : le fond du Roster (lueurs douces) doit suivre
// le thème, pas rester codé en dur sur le bleu/cyan d'origine.
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

  const r = await page.evaluate(() => {
    rosterSaveTheme('#dc2626'); // rouge
    const cs = getComputedStyle(document.documentElement);
    return { glow1: cs.getPropertyValue('--theme-bg-glow-1').trim(), glow2: cs.getPropertyValue('--theme-bg-glow-2').trim() };
  });
  t('--theme-bg-glow-1 suit le thème (plus jamais le bleu d\'origine en dur)', !r.glow1.includes('37,99,235'), r.glow1);
  t('--theme-bg-glow-2 suit le thème (plus jamais le cyan d\'origine en dur)', !r.glow2.includes('56,189,248'), r.glow2);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
