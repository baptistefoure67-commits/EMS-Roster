import subprocess,time,json,urllib.request,websocket,pathlib,sys
HTML=pathlib.Path('/mnt/data/pillbox_urgent_work/index.html').read_text(encoding='utf-8')
checks=0

def chk(cond,msg):
    global checks
    if not cond: raise AssertionError(msg)
    checks+=1
    print('✅',msg)

p=subprocess.Popen(['/usr/bin/chromium','--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=9231','--remote-allow-origins=*','--user-data-dir=/tmp/chromium-pb-urgent','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
ws=None
try:
    time.sleep(0.8)
    tabs=json.load(urllib.request.urlopen('http://127.0.0.1:9231/json'))
    ws=websocket.create_connection(tabs[0]['webSocketDebuggerUrl'],timeout=25,max_size=40_000_000)
    seq=0
    def call(method,params):
        nonlocal_dummy=None
        global seq
        seq+=1
        ws.send(json.dumps({'id':seq,'method':method,'params':params}))
        while True:
            r=json.loads(ws.recv())
            if r.get('id')==seq: return r
    fid=call('Page.getFrameTree',{})['result']['frameTree']['frame']['id']
    call('Page.setDocumentContent',{'frameId':fid,'html':HTML})
    time.sleep(0.4)
    def ev(expr):
        r=call('Runtime.evaluate',{'expression':expr,'returnByValue':True,'awaitPromise':True})
        rr=r.get('result',{})
        if 'exceptionDetails' in rr:
            raise RuntimeError(rr['exceptionDetails'].get('exception',{}).get('description') or rr['exceptionDetails'])
        return rr['result'].get('value')
    chk(ev('typeof buildContext')=='function','real Pillbox buildContext loaded in Chromium')
    ev(r'''(()=>{
      document.getElementById('weekStartInput').value='2026-10-17'; document.getElementById('recordInput').value='9999';
      window.__mk=(key,id,name,grade,paye,infoRaw='',absRaw='',benevole=false)=>({key,dossier:key,id:String(id),name,grade,role:'',info:parseInfo(infoRaw),abs:parseAbsence(absRaw,getWeekStart()),upRaw:'',payeRaw:String(paye),arriveeRaw:'01/01/2026',isNew:false,benevole,licencie:false,aliases:[]});
      window.__reset=(rows,reaPairs,overrides={})=>{ const reaMap={}; reaPairs.forEach(([n,v])=>reaMap[normalizeNameForMatch(n)]=v); state.parsed={rows,reaByName:true,reaMap,anomalies:[],wdvNames:[]}; state.overrides=overrides; state.ppaList=[];state.primeOptionnelleList=[];state.signalements=[];state.signalementsLoaded=true;state.signalementsLoadError=null;state.absenceSignalements=[];state.stgAbsenceSignalements=[];state.longAbsenceSignalements=[];state.absenceSignalementsLoaded=true;state.absenceSignalementsLoadError=null;state.formationOperationEntries=[];state.formationOperationLoadState='found';state.activiteSuivi={};state.activiteSuiviLoadError=null;};
      return true;
    })()''')

    # Full varied fake week: financial total, Top3 zero exclusion, BNVL, absence, legacy volunteer.
    res=ev(r'''(()=>{
      const rows=[__mk('k1','1','Alice Active','A',6000000),__mk('k2','2','Bob Active','INF',7000000),__mk('k3','3','Charlie Zero','M',8000000),__mk('k4','4','Helen HG Zero','ADD',11500000),__mk('k5','5','Volunteer Max','A',6000000,'','',true),__mk('k6','6','Absent Under','A',6000000,'','17/10/2026 - 23/10/2026'),__mk('k7','7','Legacy Volunteer','A',6000000)];
      __reset(rows,[['Alice Active',100],['Bob Active',80],['Charlie Zero',0],['Helen HG Zero',0],['Volunteer Max',999],['Absent Under',40],['Legacy Volunteer',500]],{k7:{benevole:true}});
      const c=buildContext(), txt=buildPayes(c), amounts=[...txt.matchAll(/Paye : \*\*(\d+) \$\*\*/g)].map(m=>+m[1]);
      const by=Object.fromEntries(c.employees.map(e=>[e.name,{rea:e.reaCount,b:e.benevole,p:e.paye,f:c.finalPaye(e),d:e.deduction,abs:e.isAbsentThisWeek}]));
      return {pod:c.podiumTiers.flatMap(t=>t.people.map(e=>e.name)),total:c.totalPaye,sum:amounts.reduce((a,b)=>a+b,0),by};
    })()''')
    chk(res['pod']==['Alice Active','Bob Active','Absent Under'],'Top3 contains only positive-rea non-volunteers')
    chk('Helen HG Zero' not in res['pod'],'exempt HG at 0 rea is excluded from Top3')
    chk(res['total']==res['sum'],'weekly total exactly equals generated Payes file sum')
    chk(res['by']['Helen HG Zero']['f']==11500000,'exempt HG at 0 rea is included in paid total/file')
    chk(res['by']['Volunteer Max']['f']==0 and res['by']['Volunteer Max']['b'],'BNVL tag is zero total')
    chk(res['by']['Legacy Volunteer']['f']==0 and res['by']['Legacy Volunteer']['b'],'legacy ov.benevole becomes effective and zero total')
    chk(res['by']['Absent Under']['p']==40*14000 and res['by']['Absent Under']['d']==6000000,'absent under quota loses fixed salary but keeps rea pay')

    # All-zero and only-one-positive podium edge cases.
    z=ev(r'''(()=>{const r=[__mk('a','1','Zero A','A',6000000),__mk('h','2','Zero HG','ADD',11500000)];__reset(r,[['Zero A',0],['Zero HG',0]]);const c=buildContext();return c.podiumTiers.length;})()''')
    chk(z==0,'all-zero week produces no Top3 and no rank bonus')
    one=ev(r'''(()=>{const r=[__mk('a','1','Only Positive','A',6000000),__mk('b','2','Zero Other','INF',7000000),__mk('h','3','Zero HG','ADD',11500000)];__reset(r,[['Only Positive',7],['Zero Other',0],['Zero HG',0]]);const c=buildContext();return c.podiumTiers.map(t=>({rank:t.rank,n:t.people.map(x=>x.name)}));})()''')
    chk(one==[{'rank':1,'n':['Only Positive']}],'single positive employee is the only podium member')

    # HG manual fire is answered but remains displayed/undoable.
    hg=ev(r'''(()=>{const r=__mk('hg','9','HG Inactive','ADD',11500000,'Z3');__reset([r],[['HG Inactive',0]],{});let c=buildContext();const before={full:c.hgRetrogradeList.length,un:c.unansweredHgRetrograde.length,block:c.hasUnresolvedDecisions};state.overrides={hg:{hgManualFire:true}};c=buildContext();return {before,after:{full:c.hgRetrogradeList.length,un:c.unansweredHgRetrograde.length,block:c.hasUnresolvedDecisions}};})()''')
    chk(hg['before']['full']==1 and hg['before']['un']==1 and hg['before']['block'],'untreated HG retrograde blocks closure')
    chk(hg['after']['full']==1 and hg['after']['un']==0 and not hg['after']['block'],'manual-fire HG remains visible but no longer blocks closure')
    tile=ev(r'''(()=>{const r=__mk('hg','9','HG Inactive','ADD',11500000,'Z3');__reset([r],[['HG Inactive',0]],{});render();const before=+document.querySelector('.stat-tile.t-amber .stat-num').textContent;state.overrides={hg:{hgManualFire:true}};render();const after=+document.querySelector('.stat-tile.t-amber .stat-num').textContent;return {before,after};})()''')
    chk(tile=={'before':1,'after':0},'À valider tile follows the real unresolved HG decision count')

    # Partial licence decisions in all four categories.
    lic=ev(r'''(()=>{
      INF_PROPOSAL_ENABLED=true; EXTRA_Q_PROPOSAL_GRADES=['M']; EXTRA_Q_PROPOSAL_THRESHOLD=3;
      const rows=[__mk('s1','11','STG Done','STG',5000000,'Q1'),__mk('s2','12','STG Wait','STG',5000000,'Q1'),__mk('a1','13','A Done','A',6000000,'Q2'),__mk('a2','14','A Wait','A',6000000,'Q2'),__mk('i1','15','INF Done','INF',7000000,'Q2'),__mk('i2','16','INF Wait','INF',7000000,'Q2'),__mk('m1','17','M Done','M',8000000,'Q2'),__mk('m2','18','M Wait','M',8000000,'Q2')];
      __reset(rows,rows.map(r=>[r.name,0]),{s1:{stgLicenceDecision:false},a1:{aLicenceDecision:false},i1:{infLicenceDecision:false},m1:{extraQLicenceDecision:false}});
      const c=buildContext(); return {p:[c.pendingStgLicenceList.length,c.pendingALicenceList.length,c.pendingInfLicenceList.length,c.pendingExtraQLicenceList.length],u:[c.unansweredStgLicence.length,c.unansweredALicence.length,c.unansweredInfLicence.length,c.unansweredExtraQLicence.length],block:c.hasUnresolvedDecisions};
    })()''')
    chk(lic['p']==[2,2,2,2],'all four licence groups keep both pending rows visible')
    chk(lic['u']==[1,1,1,1] and lic['block'],'each partially answered licence group still has exactly one blocker')

    # Operation training error state reaches the real UP rendering.
    op=ev(r'''(()=>{const r=__mk('up','20','Lea Test','A',6000000,'S1');__reset([r],[['Lea Test',100]]);state.formationOperationLoadState='error';const c=buildContext();render(c);const e=c.employees[0];return {up:e.upEligible,unver:e.formationOperationUnverifiable,text:document.getElementById('results').innerHTML.includes('Formation Opération non vérifiable')};})()''')
    chk(op['up'] and op['unver'] and op['text'],'real A→INF question displays Formation Opération non vérifiable on Firebase failure')

    # Activity error is tri-state, not fake 0/0.
    act=ev(r'''(()=>{state.activiteSuiviLoadError='firebase down';return activiteVerification({id:'x',name:'X'}).state;})()''')
    chk(act=='unverifiable','activity read failure resolves to explicit unverifiable state')
    act_render=ev(r'''(()=>{const r=__mk('mf','30','Formateur Test','MF',9000000);__reset([r],[['Formateur Test',0]]);state.activiteSuiviLoadError='firebase down';render();return document.getElementById('results').innerHTML.includes('activité Formateur/Psychologue non vérifiable');})()''')
    chk(act_render,'quota decision UI shows activity non-verifiable instead of fake 0/0')

    xss=ev(r'''(()=>{const r=__mk('p','40','Real Person','ADD',11500000);__reset([r],[['Real Person',1]]);document.getElementById('ppaBulkText').value='@[ADD] <img src=x onerror=alert(1)> ➜ 500000$';addPpaBulk();return state.ppaBulkFeedback;})()''')
    chk('&lt;img' in xss and '<img' not in xss,'PPA bulk feedback escapes pasted HTML instead of interpreting it')

    print(f'✅ Browser E2E Pillbox: {checks} checks passed')
finally:
    try:
        if ws: ws.close()
    except: pass
    p.terminate()
