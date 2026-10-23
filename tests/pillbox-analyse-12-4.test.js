// Pillbox 12.4 / Roster 14.6 — « Analyser la semaine » : animation immédiate, vérification en
// parallèle, repli ancien serveur, délai maximum, silhouette sans fond, permissions lues en parallèle.
// Partie 1 (Node pur) : toujours exécutée. Partie 2 (navigateur) : exécutée si le paquet « playwright »
// est installé (sinon SKIP, sans échec). SKIP_SLOW=1 saute les 2 scénarios de plus de 10 s.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { readPillbox } = require('./_helpers');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const pill = readPillbox();
let ok = 0, ko = 0;
const t = (name, cond, extra='') => { if(cond){ ok++; console.log('✅', name); } else { ko++; console.log('❌', name, extra); } };

// ───────────── Partie 1 : serveur + code statique ─────────────
async function serverPart(){
  const perms = require(path.join(FN, 'permissions.js'));
  const realFetch = global.fetch;
  const mk = (map, latency=0, log=[]) => async (url) => {
    const u = String(url); const key = u.includes('rosterPermissionsOverride') ? 'override' : u.includes('rosterIndividualPermissions') ? 'individual' : 'autre';
    log.push({ key, at: Date.now() });
    if(latency) await new Promise(r => setTimeout(r, latency));
    const v = map[key];
    if(v === 'throw') throw new Error('réseau coupé');
    if(typeof v === 'number') return { ok:false, status:v, json: async()=>null };
    return { ok:true, status:200, json: async()=> v };
  };
  // lectures parallèles
  { const log=[]; global.fetch = mk({ override:{ ADD:{ manage_absences:true } }, individual:{ x:1 } }, 120, log);
    const t0 = Date.now(); const r = await perms.loadPermissionContext('tok', { strict:true }); const dt = Date.now()-t0;
    t('Permissions : les 2 lectures partent en parallèle (≈120 ms, pas ≈240 ms)', dt < 200 && Math.abs(log[0].at-log[1].at) < 40, `dt=${dt}`);
    t('Permissions : résultat identique (custom normalisé + individual)', r.custom && r.custom.ADD && r.individual && r.individual.x === 1); }
  // strict : échecs
  { global.fetch = mk({ override:500, individual:{} });
    await assert.rejects(perms.loadPermissionContext('tok',{strict:true}), /par grade refusée \(500\)/); t('Strict : échec « par grade » => erreur', true); }
  { global.fetch = mk({ override:{}, individual:503 });
    await assert.rejects(perms.loadPermissionContext('tok',{strict:true}), /individuelles refusée \(503\)/); t('Strict : échec « individuelles » => erreur', true); }
  { global.fetch = mk({ override:500, individual:503 });
    await assert.rejects(perms.loadPermissionContext('tok',{strict:true}), /par grade refusée \(500\)/); t('Strict : les 2 échouent => l’erreur « par grade » prime comme avant', true); }
  { global.fetch = mk({ override:'throw', individual:{} });
    await assert.rejects(perms.loadPermissionContext('tok',{strict:true}), /réseau coupé/); t('Strict : coupure réseau => erreur (fail-closed)', true); }
  // non strict
  { global.fetch = mk({ override:500, individual:{ y:2 } });
    const r = await perms.loadPermissionContext('tok'); t('Non strict : « par grade » illisible => null, individuelles conservées', r.custom === null && r.individual.y === 2); }
  { global.fetch = mk({ override:{ ADD:{ manage_absences:true } }, individual:'throw' });
    const r = await perms.loadPermissionContext('tok'); t('Non strict : individuelles illisibles => null, « par grade » conservé', r.individual === null && r.custom && r.custom.ADD); }
  // aucun cache
  { const log=[]; const map = { override:{}, individual:{ a:1 } }; global.fetch = mk(map, 0, log);
    await perms.loadPermissionContext('tok',{strict:true}); map.individual = { a:2 };
    const r2 = await perms.loadPermissionContext('tok',{strict:true});
    t('Aucun cache : 2 appels = 4 lectures, un droit modifié est vu dès l’appel suivant', log.length === 4 && r2.individual.a === 2, `lectures=${log.length}`); }
  // canFor fail-closed
  { global.fetch = mk({ override:500, individual:{} });
    const r = await perms.canFor({ level:'ADD', discordId:'1' }, 'manage_absences', 'tok'); t('canFor : lecture des permissions en échec => refus', r === false); }
  { global.fetch = mk({ override:{}, individual:{} });
    const r = await perms.canFor({ level:'ADD', discordId:'1' }, 'manage_absences', 'tok'); t('canFor : lecture OK => décision normale du grade (ADD autorisé)', r === true); }
  global.fetch = realFetch;

  // code statique Pillbox
  const fb = (pill.match(/const CHARACTER_PORTRAIT_FALLBACK = "([^"]*)"/)||[])[1] || '';
  t('Silhouette de remplacement : plus aucun fond plein (pas de <rect>)', fb && !/%3Crect/i.test(fb) && /%3Ccircle/.test(fb) && /%3Cpath/.test(fb));
  const h = pill.indexOf("document.getElementById('analyzeBtn').addEventListener('click'");
  const handler = pill.slice(h, pill.indexOf('function tryAutoImportFromHash', h));
  t('Clic : la vérification part AVANT la scène (même tick, sans await avant)', handler.indexOf('checkWeekAlreadyProcessed(key)') > -1 && handler.indexOf('checkWeekAlreadyProcessed(key)') < handler.indexOf('showAnalysisAnimation('));
  t('Clic : porte (gate) + arrêt anticipé branchés sur la scène', /showAnalysisAnimation\(\(\)=>runAnalysis\(resetOverrides\), gate, check\.then/.test(handler));
  t('Vérification : délai max + repli UNIQUEMENT sur « Action POST inconnue » (400)', /WEEK_CHECK_TIMEOUT_MS\s*=\s*10000/.test(pill) && /err\.status === 400 && \/Action POST inconnue\/i/.test(pill));
  t('Aucun calcul de paie touché : totalPaye = même population que buildPayes', /const totalPaye = payesPopulation/.test(pill) && !/EXEMPT\.has\(e\.grade\) && e\.reaCount===0\)\)/.test(pill.slice(pill.indexOf('const totalPaye = payesPopulation'), pill.indexOf('const totalPaye = payesPopulation')+300)));
}

// ───────────── Partie 2 : navigateur (Playwright) ─────────────
const SAMPLE = "📂:dossier1\t[MC] Jean Testeur\t100001\tMC\t\t\tf0\t01/01\t0\t01/01\tf4\n📂:dossier2\t[ADD] Marie Absente\t100002\tADD\t\t10/10-20/10\tf0\t01/01\t0\t01/01\tf4\n📂:dossier3\t[CD] Paul Averti\t100003\tCD\tA1:07/08\t\tf0\t01/01\t0\t01/01\tf4\n📂:dossier4\t[MC] Luc Benevole\t100004\tMC\tBNVL\t\tf0\t01/01\t0\t01/01\tf4\n📂:dossier5\t[A] Sophie Quota\t100005\tA\tQ5\t\tf0\t01/01\t0\t01/01\tf4\n";
async function browserPart(){
  let chromium; try{ ({ chromium } = require('playwright')); }catch(e){ console.log('⏭️  SKIP navigateur : paquet « playwright » absent (npm i playwright).'); return; }
  let browser; try{ browser = await chromium.launch(); }catch(e){ console.log('⏭️  SKIP navigateur : Chromium indisponible —', String(e.message).split('\n')[0]); return; }
  const SLOW = !process.env.SKIP_SLOW;
  async function setup(o={}){
    const ctx = await browser.newContext(o.reduced ? { reducedMotion:'reduce' } : {});
    const page = await ctx.newPage();
    const st = { errs:[], dialogs:[], posts:[], gets:0, mode:o.mode||'absent', delay:o.delay??50, dismiss:!!o.dismiss };
    page.on('pageerror', e=>st.errs.push(e.message));
    page.on('dialog', async d=>{ st.dialogs.push(d.type()+':'+d.message().slice(0,70)); if(d.type()==='confirm' && st.dismiss) await d.dismiss(); else await d.accept(); });
    await page.route('**/*', async route=>{
      const req = route.request(), url = req.url();
      if(url === 'http://pillbox.test/index.html') return route.fulfill({ status:200, contentType:'text/html; charset=utf-8', body:pill });
      if(url.startsWith('http://pillbox.test/')) return route.fulfill({ status:404, body:'' });
      if(!/pillbox-proxy/.test(url)) return route.abort();
      let body={}; try{ body=JSON.parse(req.postData()||'{}'); }catch(e){}
      const action = req.method()==='GET' ? 'GET' : body.action; st.posts.push(action);
      const found = { processedAt:Date.now()-86400000, summary:{ promotions:2, licenciements:1, totalPaye:12345678 } };
      const js = (status, o) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(o) });
      if(action === 'getWeekHistoryEntry'){
        if(st.mode==='hang'){ await new Promise(r=>setTimeout(r, 30000)); return route.abort().catch(()=>{}); }
        await new Promise(r=>setTimeout(r, st.delay));
        if(st.mode==='e502') return js(502,{error:'Lecture historique impossible (500)'});
        if(st.mode==='e500') return js(500,{error:'Boom'});
        if(st.mode==='old400' || st.mode==='old400found') return js(400,{error:'Action POST inconnue.'});
        if(st.mode==='other400') return js(400,{error:'Clé de semaine invalide.'});
        if(st.mode==='found') return js(200,{ok:true,state:'found',entry:found});
        return js(200,{ok:true,state:'absent',entry:null});
      }
      if(action === 'GET'){ st.gets++; return js(200,{ weekHistory: st.mode==='old400found' ? {'2026-10-17':found} : {}, readStatus:{weekHistory:'found'} }); }
      return js(200,{});
    });
    await page.goto('http://pillbox.test/index.html'); await page.waitForTimeout(450);
    await page.evaluate(([sample,anim])=>{
      pillboxSessionToken = btoa(JSON.stringify({discordId:'861557966083850250',name:'Baptiste',level:'ADD',exp:Date.now()+7200000})).replace(/=+$/,'')+'.sig';
      pillboxCurrentName='Baptiste'; payRulesReady=true; payRulesLoadError=null; pillboxAnimEnabled=anim; pillboxAnimExcludedSelf=false;
      document.getElementById('weekStartInput').value='2026-10-17';
      window.__runs=0; window.__runAt=null; window.__clickAt=null;
      const orig=window.runAnalysis; window.runAnalysis=function(){ window.__runs++; window.__runAt=performance.now(); return orig.apply(this,arguments); };
      document.getElementById('tableauText').value=sample; document.getElementById('tableauText').dispatchEvent(new Event('input'));
    }, [SAMPLE, o.anim!==false]);
    return { page, ctx, st };
  }
  const click = p => p.evaluate(()=>{ window.__clickAt=performance.now(); document.getElementById('analyzeBtn').click(); const m=document.getElementById('analysisAnimationModal'); return { modalSync:getComputedStyle(m).display==='flex', dt:Math.round(performance.now()-window.__clickAt) }; });
  const info = p => p.evaluate(()=>({ runs:window.__runs, at:window.__runAt?Math.round(window.__runAt-window.__clickAt):null, modal:getComputedStyle(document.getElementById('analysisAnimationModal')).display, btnDis:document.getElementById('analyzeBtn').disabled, sub:document.getElementById('analysisAnimationSubtitle').textContent }));
  const alerted = st => st.dialogs.some(d=>d.startsWith('alert:') && /Impossible de vérifier/.test(d));

  { const {page,st,ctx}=await setup({delay:800}); const c=await click(page);
    t('1  La modale est visible dans le même tick que le clic (vérification lente 800 ms)', c.modalSync && c.dt<100, 'dt='+c.dt);
    await page.waitForTimeout(600); let i=await info(page); t('1  Aucune analyse avant la fin de la scène', i.runs===0 && i.modal==='flex');
    await page.waitForTimeout(6300); i=await info(page); t('1  Analyse exécutée UNE fois vers 5,7 s, modale fermée, bouton réactivé', i.runs===1 && i.at>5400 && i.at<6400 && i.modal==='none' && !i.btnDis, 'at='+i.at);
    t('1  Aucune erreur JS', st.errs.length===0, st.errs.join('|')); await ctx.close(); }
  if(SLOW){ const {page,ctx}=await setup({delay:9000}); await click(page); await page.waitForTimeout(7000); let i=await info(page);
    t('2  Vérification plus lente que la scène : 0 analyse, message « Vérification de la semaine… »', i.runs===0 && i.modal==='flex' && /Vérification de la semaine/.test(i.sub));
    await page.waitForTimeout(3000); i=await info(page); t('2  Puis 1 analyse dès la réponse', i.runs===1 && i.modal==='none' && !i.btnDis); await ctx.close(); }
  { const {page,ctx}=await setup({delay:3000}); await click(page); await page.waitForTimeout(1000);
    await page.evaluate(()=>document.getElementById('skipAnalysisAnimation').click()); await page.waitForTimeout(500);
    let i=await info(page); t('3  « Passer » avant la réponse : rien ne part', i.runs===0 && i.modal==='flex');
    await page.waitForTimeout(2800); i=await info(page); t('3  …1 analyse dès la réponse', i.runs===1 && i.modal==='none');
    await page.waitForTimeout(6000); i=await info(page); t('3  …et toujours 1 seule 6 s plus tard', i.runs===1); await ctx.close(); }
  { const {page,ctx}=await setup({delay:100}); await click(page); await page.waitForTimeout(1500);
    await page.evaluate(()=>document.getElementById('skipAnalysisAnimation').click()); await page.waitForTimeout(300);
    let i=await info(page); t('4  « Passer » après la réponse : analyse immédiate, modale fermée', i.runs===1 && i.modal==='none' && !i.btnDis);
    await page.waitForTimeout(6000); i=await info(page); t('4  Toujours 1 seule analyse', i.runs===1); await ctx.close(); }
  { const a=await setup({delay:2500}); await click(a.page); await a.page.waitForTimeout(700); await a.page.keyboard.press('Escape'); await a.page.waitForTimeout(400);
    let i=await info(a.page); t('5  Échap avant la réponse : attend', i.runs===0 && i.modal==='flex');
    await a.page.waitForTimeout(2600); i=await info(a.page); t('5  …puis 1 analyse', i.runs===1 && i.modal==='none'); await a.ctx.close();
    const b=await setup({delay:50}); await click(b.page); await b.page.waitForTimeout(1200); await b.page.keyboard.press('Escape'); await b.page.waitForTimeout(300);
    i=await info(b.page); t('5  Échap après la réponse : analyse immédiate', i.runs===1 && i.modal==='none'); await b.ctx.close(); }
  { const {page,st,ctx}=await setup({mode:'e502',delay:200}); await click(page); await page.waitForTimeout(1200); const i=await info(page);
    t('6  Vérification en 502 : alerte IMMÉDIATE, modale fermée, 0 analyse, bouton OK', i.runs===0 && i.modal==='none' && !i.btnDis && alerted(st), st.dialogs.join('|')); await ctx.close(); }
  { const {page,st,ctx}=await setup({mode:'e500',delay:100}); await click(page); await page.waitForTimeout(1000); const i=await info(page);
    t('7  Vérification en 500 : blocage + alerte', i.runs===0 && i.modal==='none' && !i.btnDis && alerted(st)); await ctx.close(); }
  if(SLOW){ const {page,st,ctx}=await setup({mode:'hang'}); await click(page); await page.waitForTimeout(11800); const i=await info(page);
    t('8  Serveur muet : après ≈10 s blocage + alerte (jamais silencieux), 0 analyse', i.runs===0 && i.modal==='none' && !i.btnDis && alerted(st), st.dialogs.join('|')); await ctx.close(); }
  { const {page,st,ctx}=await setup({mode:'found',delay:100,dismiss:true}); await click(page); await page.waitForTimeout(6600); const i=await info(page);
    t('9  Semaine déjà traitée + Annuler : 0 analyse, modale fermée, bouton OK', i.runs===0 && i.modal==='none' && !i.btnDis && st.dialogs.some(d=>d.startsWith('confirm:'))); await ctx.close(); }
  { const {page,st,ctx}=await setup({mode:'found',delay:100}); await click(page); await page.waitForTimeout(6700); const i=await info(page);
    t('10 Semaine déjà traitée + Accepter : 1 analyse, 1 seule confirmation', i.runs===1 && i.modal==='none' && st.dialogs.filter(d=>d.startsWith('confirm:')).length===1); await ctx.close(); }
  { const {page,st,ctx}=await setup({delay:100}); await page.evaluate(()=>{ const b=document.getElementById('analyzeBtn'); b.click(); b.click(); b.click(); });
    await page.waitForTimeout(6800); const i=await info(page);
    t('11 Triple clic : 1 vérification, 1 analyse', i.runs===1 && st.posts.filter(a=>a==='getWeekHistoryEntry').length===1, JSON.stringify(st.posts)); await ctx.close(); }
  { const a=await setup({mode:'old400',delay:50}); await a.page.waitForTimeout(1500); const base=a.st.gets; await click(a.page); await a.page.waitForTimeout(6700); const i=await info(a.page);
    t('12 Ancien serveur (400 « Action POST inconnue ») : repli sur l’ancien chemin (1 GET en plus), 1 analyse', i.runs===1 && a.st.gets===base+1 && !a.st.dialogs.some(d=>d.startsWith('alert:')), `GET ${base}→${a.st.gets}`); await a.ctx.close();
    const f=await setup({mode:'old400found',delay:50,dismiss:true}); await click(f.page); await f.page.waitForTimeout(6700); const j=await info(f.page);
    t('12 Ancien serveur + semaine déjà traitée : détectée par le repli (Annuler = 0 analyse)', j.runs===0 && f.st.dialogs.some(d=>d.startsWith('confirm:'))); await f.ctx.close(); }
  { const {page,st,ctx}=await setup({mode:'other400',delay:50}); await page.waitForTimeout(1500); const base=st.gets; await click(page); await page.waitForTimeout(1000); const i=await info(page);
    t('13 Autre 400 : AUCUN repli (0 GET en plus), blocage + alerte', i.runs===0 && st.gets===base && alerted(st), `GET ${base}→${st.gets}`); await ctx.close(); }
  { const {page,st,ctx}=await setup({anim:false,delay:300}); const c=await click(page); await page.waitForTimeout(150);
    const b=await page.evaluate(()=>({dis:document.getElementById('analyzeBtn').disabled,t:document.getElementById('analyzeBtn').innerText.trim()}));
    t('14 Animations coupées : pas de scène, bouton « Vérification rapide… » pendant le contrôle', !c.modalSync && b.dis && /Vérification rapide/.test(b.t));
    await page.waitForTimeout(600); const i=await info(page); t('14 Animations coupées : 1 analyse juste après la réponse, bouton restauré', i.runs===1 && i.modal==='none' && !i.btnDis); await ctx.close();
    const e=await setup({anim:false,mode:'e502',delay:100}); await click(e.page); await e.page.waitForTimeout(700); const k=await info(e.page);
    t('14 Animations coupées + panne : blocage + alerte', k.runs===0 && !k.btnDis && alerted(e.st)); await e.ctx.close();
    const f=await setup({anim:false,mode:'found',dismiss:true,delay:100}); await click(f.page); await f.page.waitForTimeout(700); const m=await info(f.page);
    t('14 Animations coupées + déjà traitée + Annuler : 0 analyse', m.runs===0 && !m.btnDis); await f.ctx.close(); }
  { const {page,ctx}=await setup({reduced:true,delay:100}); await click(page); await page.waitForTimeout(1000); let i=await info(page);
    t('15 Mouvement réduit : scène affichée, pas encore d’analyse', i.modal==='flex' && i.runs===0);
    await page.waitForTimeout(6000); i=await info(page); t('15 Mouvement réduit : 1 analyse à la fin', i.runs===1 && i.modal==='none'); await ctx.close(); }
  { const {page,st,ctx}=await setup({delay:100}); await page.evaluate(()=>{ window.runAnalysis=function(){ throw new Error('boom test'); }; }); await click(page); await page.waitForTimeout(6800);
    const i=await info(page); t('16 Analyse qui plante : modale fermée, alerte, bouton OK', i.modal==='none' && !i.btnDis && st.dialogs.some(d=>/L'analyse a échoué/.test(d))); await ctx.close(); }
  { // semaine complète : même total que le fichier Payes
    const {page,ctx}=await setup({delay:50});
    const r = await page.evaluate(()=>{
      const mk=(key,id,name,grade,paye,infoRaw='',absRaw='',benevole=false)=>({key,dossier:key,id:String(id),name,grade,role:'',info:parseInfo(infoRaw),abs:parseAbsence(absRaw,getWeekStart()),upRaw:'',payeRaw:String(paye),arriveeRaw:'01/01/2026',isNew:false,benevole,licencie:false,aliases:[]});
      const rows=[mk('k1','1','Alice Active','A',6000000),mk('k2','2','Bob Active','INF',7000000),mk('k3','3','Charlie Zero','M',8000000),mk('k4','4','Helen HG Zero','ADD',11500000),mk('k5','5','Volunteer Max','A',6000000,'','',true),mk('k6','6','Absent Under','A',6000000,'','17/10/2026 - 23/10/2026'),mk('k7','7','Legacy Volunteer','A',6000000)];
      const rea=[['Alice Active',100],['Bob Active',80],['Charlie Zero',0],['Helen HG Zero',0],['Volunteer Max',999],['Absent Under',40],['Legacy Volunteer',500]]; const m={}; rea.forEach(([n,v])=>m[normalizeNameForMatch(n)]=v);
      state.parsed={rows,reaByName:true,reaMap:m,anomalies:[],wdvNames:[]}; state.overrides={k7:{benevole:true}}; state.ppaList=[];state.primeOptionnelleList=[];state.signalements=[];state.signalementsLoaded=true;state.signalementsLoadError=null;state.absenceSignalements=[];state.stgAbsenceSignalements=[];state.longAbsenceSignalements=[];state.absenceSignalementsLoaded=true;state.absenceSignalementsLoadError=null;state.formationOperationEntries=[];state.formationOperationLoadState='found';state.activiteSuivi={};state.activiteSuiviLoadError=null;
      const c=buildContext(), txt=buildPayes(c), amounts=[...txt.matchAll(/Paye : \*\*(\d+) \$\*\*/g)].map(x=>+x[1]);
      return { pod:c.podiumTiers.flatMap(x=>x.people.map(e=>e.name)), total:c.totalPaye, sum:amounts.reduce((a,b)=>a+b,0) };
    });
    t('17 Semaine mixte complète : total = somme exacte du fichier Payes (33 580 000 $), Top 3 sans 0 réa', r.total===r.sum && r.total===33580000 && r.pod.join()==='Alice Active,Bob Active,Absent Under', JSON.stringify(r)); await ctx.close(); }
  await browser.close();
}

(async()=>{
  await serverPart(); await browserPart();
  console.log(`\nPillbox 12.4 analyse : ${ok} réussi(s), ${ko} échec(s).`);
  process.exit(ko ? 1 : 0);
})().catch(e=>{ console.error('ERREUR TEST', e); process.exit(1); });
