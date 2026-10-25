// Suite autonome : lance son propre petit serveur HTTP local pour servir
// index.html (pas besoin de le démarrer séparément) ; saute proprement si
// le paquet playwright n'est pas installé.
const path = require('path'), http = require('http'), fs = require('fs');
let chromiumMod;
try{ ({ chromium: chromiumMod } = require('playwright')); }
catch(e){ console.log('⏭️  SKIP navigateur : paquet playwright absent (npm i playwright).'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const server = http.createServer((req,res)=>{
  const p = path.join(ROOT, req.url.split('?')[0]==='/'?'/index.html':req.url);
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

  await page.evaluate(() => {
    document.getElementById('accessGate').style.display='none';
    document.getElementById('appContent').style.display='';
    currentUserLevel = 'OWNER'; currentUserDiscordId = '111'; currentSessionToken='fake';
    userCaps = { manage_permissions: true };
    employees = [{discordId:'999', name:'Cible Test', grade:'MC'}];
    individualAllPermsCache = ['manage_absences','manage_pay_rules','view_logs','force_logout'];
    effectiveByGradeCache = { MC: { manage_absences:false, manage_pay_rules:false, view_logs:false, force_logout:false } };
    individualPermsCache = { '999': {
      manage_absences: { CD:null, D:true, DG:null, OWNER:null, protection: { type:'D', authorDiscordId:'333', authorName:'Aaron', authorLevel:'D', createdAt: Date.now() } },
      manage_pay_rules: { CD:null, D:null, DG:null, OWNER:null, protection: { type:'OWNER_PLUS', authorDiscordId:'111', authorName:'Baptiste', authorLevel:'OWNER', createdAt: Date.now() } },
      view_logs: { CD:null, D:null, DG:null, OWNER:null, protection: null },
    }};
    document.getElementById('individualPermPersonSelect').innerHTML = '<option value="999">Cible Test</option>';
    document.getElementById('individualPermPersonSelect').value = '999';
    renderIndividualPermTableForSelected();
  });

  const html1 = await page.evaluate(()=>document.getElementById('individualPermTable').innerHTML);
  t('Badge 🔒D affiché pour manage_absences', /🔒 D/.test(html1));
  t('Badge 🔐OWNER++ affiché pour manage_pay_rules', /🔐 OWNER\+\+/.test(html1));
  t('Badge 🔓 affiché pour view_logs (non protégé)', /🔓/.test(html1));

  const btnsDisabled = await page.evaluate(()=>{
    const btns = [...document.querySelectorAll('[data-indiv-set="manage_absences"]')];
    return btns.every(b=>b.disabled);
  });
  t('Boutons désactivés pour une permission protégée', btnsDisabled);

  const btnsEnabled = await page.evaluate(()=>{
    const btns = [...document.querySelectorAll('[data-indiv-set="view_logs"]')];
    return btns.every(b=>!b.disabled);
  });
  t('Boutons actifs pour une permission NON protégée', btnsEnabled);

  // Staging : clique "Autorisé" sur view_logs -> doit apparaître en attente, pas d'appel réseau
  let networkCalls = 0;
  await page.route('**/manage-individual-permissions', route => { networkCalls++; route.fulfill({status:200, body:'{}'}); });
  await page.evaluate(()=>{
    document.querySelector('[data-indiv-set="view_logs"][data-indiv-value="true"]').click();
  });
  await page.waitForTimeout(150);
  t('Clic sur une valeur : AUCUN appel réseau immédiat (mise en attente)', networkCalls === 0, 'appels='+networkCalls);
  const pendingHtml = await page.evaluate(()=>document.getElementById('individualPermTable').innerHTML);
  t('Ligne marquée "non enregistré"', /non enregistré/.test(pendingHtml));
  const saveBtnVisible = await page.evaluate(()=>getComputedStyle(document.getElementById('btnIndivSaveBatch')).display !== 'none');
  t('Bouton "Enregistrer" apparaît', saveBtnVisible);
  const pendingCountText = await page.evaluate(()=>document.getElementById('indivPendingCount').textContent);
  t('Compteur = 1', pendingCountText === '1', pendingCountText);

  // Reclique sur la même valeur déjà active pour force_logout (jamais touché) -> devrait juste pas ajouter en attente différemment ; testons plutôt annuler le pending en recliquant "Hériter" sur view_logs d'abord à true puis repasser sur l'état d'origine (null) doit retirer du pending
  await page.evaluate(()=>{ document.querySelector('[data-indiv-set="view_logs"][data-indiv-value="cancel"]').click(); });
  const countAfterRevert = await page.evaluate(()=>document.getElementById('indivPendingCount') ? document.getElementById('indivPendingCount').textContent : null);
  t('Revenir à la valeur déjà enregistrée retire du pending (0)', countAfterRevert === '0' || countAfterRevert === null, countAfterRevert);

  // Modale de protection : clique sur le badge OWNER++ avec OWNER connecté -> doit proposer "Retirer"
  await page.evaluate(()=>{ document.querySelector('[data-protect-perm="manage_pay_rules"]').click(); });
  await page.waitForTimeout(100);
  const modalVisible = await page.evaluate(()=>getComputedStyle(document.getElementById('protectionConfirmModal')).display !== 'none');
  const modalTitle = await page.evaluate(()=>document.getElementById('protectionConfirmTitle').textContent);
  t('Modale protection s\'ouvre (pas de window.confirm)', modalVisible);
  t('Titre mentionne OWNER++', /OWNER\+\+/.test(modalTitle), modalTitle);
  const modalButtons = await page.evaluate(()=>[...document.querySelectorAll('#protectionConfirmActions button')].map(b=>b.textContent));
  t('Options proposées cohérentes (Retirer + D/DG/OWNER/OWNER++)', modalButtons.some(b=>/Retirer/.test(b)), JSON.stringify(modalButtons));

  // Ferme en cliquant Annuler
  await page.evaluate(()=>document.getElementById('protectionConfirmModal').querySelector('.btn-ghost').click());
  const modalClosedAfterCancel = await page.evaluate(()=>getComputedStyle(document.getElementById('protectionConfirmModal')).display === 'none');
  t('Annuler ferme la modale sans action', modalClosedAfterCancel);

  // Un simple DG connecté ne doit PAS pouvoir ouvrir d'action sur OWNER++ (juste un toast, pas de modale)
  await page.evaluate(()=>{ currentUserLevel='DG'; renderIndividualPermTableForSelected(); });
  await page.evaluate(()=>{ document.querySelector('[data-protect-perm="manage_pay_rules"]').click(); });
  await page.waitForTimeout(100);
  const modalStillClosedForDG = await page.evaluate(()=>getComputedStyle(document.getElementById('protectionConfirmModal')).display === 'none');
  t('DG : clique sur badge OWNER++ -> pas de modale (juste refus)', modalStillClosedForDG);

  // Flux complet "Enregistrer" (setBatch) : on remet currentUserLevel à OWNER,
  // on met une valeur en attente sur une permission NON protégée, et on
  // vérifie le contenu exact envoyé au serveur + la mise à jour de l'état.
  await page.evaluate(()=>{ currentUserLevel='OWNER'; renderIndividualPermTableForSelected(); });
  let sentBody = null;
  await page.unroute('**/manage-individual-permissions').catch(()=>{});
  await page.route('**/manage-individual-permissions', route => {
    sentBody = JSON.parse(route.request().postData());
    route.fulfill({status:200, contentType:'application/json', body: JSON.stringify({
      ok:true, applied:1, refused:[],
      person: { ...sentBody.operations ? {} : {} , view_logs: { CD:null, D:null, DG:null, OWNER:true, protection:null } },
    })});
  });
  await page.evaluate(()=>{ document.querySelector('[data-indiv-set="view_logs"][data-indiv-value="true"]').click(); });
  await page.evaluate(()=>{ document.getElementById('btnIndivSaveBatch').click(); });
  await page.waitForTimeout(300);
  t('setBatch envoyé avec action=setBatch', sentBody && sentBody.action === 'setBatch', JSON.stringify(sentBody));
  t('setBatch : une seule opération pour view_logs=true', sentBody && sentBody.operations.length===1 && sentBody.operations[0].permissionName==='view_logs' && sentBody.operations[0].value===true, JSON.stringify(sentBody && sentBody.operations));
  const afterSaveHtml = await page.evaluate(()=>document.getElementById('individualPermTable').innerHTML);
  t('Après Enregistrer : plus de "non enregistré"', !/non enregistré/.test(afterSaveHtml));
  const saveBtnHiddenAfter = await page.evaluate(()=>getComputedStyle(document.getElementById('btnIndivSaveBatch')).display === 'none');
  t('Bouton Enregistrer disparaît après la sauvegarde', saveBtnHiddenAfter);

  console.log(results.join('\n'));
  console.log(`\n${results.length-failed}/${results.length} réussis, erreurs JS: ${errors.length}`);
  errors.forEach(e=>console.log(' - ERREUR JS:', e));
  await browser.close();
  server.close();
  process.exit(failed || errors.length ? 1 : 0);
})();
