// Suite autonome (bloc 3, suite — demandé) : reconstruction à l'affichage
// des anciennes semaines archivées avant ce chantier, à partir de
// sessionSnapshot, SANS JAMAIS réécrire l'archive ni perturber le travail
// en cours de l'utilisateur. Lance son propre petit serveur HTTP local ;
// saute proprement si playwright est absent.
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
  await page.route('**/pillbox-proxy**', async route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(500);

  const r = await page.evaluate(async () => {
    // État de travail ACTUEL de l'utilisateur, qui ne doit SURTOUT PAS être perturbé
    document.getElementById('weekStartInput').value = '2026-11-01';
    document.getElementById('tableauText').value = 'TEXTE EN COURS DE SAISIE';
    state.overrides = { zzz: { upDecision: true } };
    state.ppaList = [{id:99, name:'EnCours', amount:'1', reason:'', employeeId:'z'}];

    // Semaine ANCIENNE, archivée AVANT ce chantier : aucun champ enrichi,
    // mais sessionSnapshot présent (c'était déjà le cas avant).
    const oldEntry = {
      processedAt: Date.now()-20*86400000,
      summary: { totalPaye: 18700000, promotions: 1, licenciements: 0, retrogradations: 0, paieEffectueePar: 'X' },
      sessionSnapshot: {
        tableauText: '📂:dossier1\t[ADD] Alice Haut\t100001\tADD\t\t\tf0\t01/01\t0\t01/01\tf4\n📂:dossier2\t[A] Bob Up\t100002\tA\tS1\t\tf0\t01/01\t0\t01/01\tf4',
        reaText: '1. Alice Haut - Réa : 120\n2. Bob Up - Réa : 80',
        weekStartInput: '2026-10-03',
        state: { overrides: { k2: { upDecision: false } }, ppaList: [{id:1,name:'Alice Haut',amount:'500000',reason:'',employeeId:'1'}], primeOptionnelleList: [] },
      },
    };

    window.fetchWeekHistory = async () => ({ '2026-10-03': oldEntry });
    await renderWeekHistoryPanel();
    const html = document.getElementById('weekHistoryList').innerHTML;

    return {
      html,
      // état de travail après coup -> doit être strictement identique à avant
      weekStartAfter: document.getElementById('weekStartInput').value,
      tableauAfter: document.getElementById('tableauText').value,
      overridesAfter: JSON.stringify(state.overrides),
      ppaAfter: JSON.stringify(state.ppaList),
    };
  });

  t('Reconstruction : bannière "reconstruits à l\'affichage" affichée', /reconstruits à l.affichage/.test(r.html));
  t('Reconstruction : avertissement "tarifs actuels" affiché (pas de payRulesUsed archivé)', /tarifs actuels/.test(r.html));
  t('Réanimations reconstruites (120+80=200)', /200/.test(r.html.match(/Réanimations[\s\S]{0,200}/)[0]));
  t('PPA reconstruit (500 000, Alice Haut)', /Alice Haut/.test(r.html) && /500.000/.test(r.html));
  t('Promotion refusée reconstruite (Bob Up)', /Promotions refusées/.test(r.html) && /Bob Up/.test(r.html));
  t('Avertissements/Signalements : "Non disponible pour cette ancienne semaine"', /Non disponible pour cette ancienne semaine/.test(r.html));

  t('AUCUNE perturbation du travail en cours : weekStartInput intact', r.weekStartAfter === '2026-11-01', r.weekStartAfter);
  t('AUCUNE perturbation : tableauText intact', r.tableauAfter === 'TEXTE EN COURS DE SAISIE', r.tableauAfter);
  t('AUCUNE perturbation : state.overrides intact', r.overridesAfter === JSON.stringify({ zzz: { upDecision: true } }), r.overridesAfter);
  t('AUCUNE perturbation : state.ppaList intact', JSON.parse(r.ppaAfter)[0].name === 'EnCours', r.ppaAfter);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close(); server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
