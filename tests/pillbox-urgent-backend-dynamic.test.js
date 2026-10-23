const assert=require('assert'), path=require('path');
const ROOT=path.resolve(__dirname,'..','netlify','functions');
process.env.SESSION_SECRET='urgent-secret';
process.env.FIREBASE_CLIENT_EMAIL='fake@test.invalid';
process.env.FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----';
process.env.FIREBASE_WEB_API_KEY='fake-web';
process.env.GEMINI_API_KEY='fake-gemini';
process.env.GEMINI_OCR_MODEL='gemini-fixed-test';
const tokens=require(path.join(ROOT,'session-token.js'));
let checks=0; const eq=(a,b,m)=>{assert.strictEqual(a,b,m);checks++}; const ok=(v,m)=>{assert.ok(v,m);checks++};
function resp(status,data,headers={}){return {ok:status>=200&&status<300,status,headers:{get:(k)=>headers[String(k).toLowerCase()]??headers[k]??null},async json(){return data;},async text(){return typeof data==='string'?data:JSON.stringify(data)}}}
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports}}
function fresh(file){const id=require.resolve(file);delete require.cache[id];return require(file)}

(async()=>{
  const permPath=path.join(ROOT,'permissions.js'), firePath=path.join(ROOT,'firebase-token.js'), logsPath=path.join(ROOT,'logs.js');
  const actualPerms=fresh(permPath);
  mock(firePath,{createFirebaseCustomToken:()=> 'custom'});
  mock(logsPath,{logAction:async()=>({ok:true})});

  // canFor must fail closed if strict permission reads fail.
  global.fetch=async()=>resp(500,{error:'down'});
  const failClosed=await actualPerms.canFor({level:'ADD',discordId:'p1'},'use_pillbox_terminal','idtoken');
  eq(failClosed,false,'canFor refuses when strict permission read fails');

  // setAbsenceAlertDecision: individual deny then individual grant, targeted write only.
  let permCtx={custom:null,individual:{p1:{manage_absences:{OWNER:false}}}};
  mock(permPath,{...actualPerms,loadPermissionContext:async()=>permCtx});
  let store={old:{decision:'oui'}}; let wholeBranchTouched=false; let targetedWrites=[];
  global.fetch=async(url,opt={})=>{
    url=String(url); const method=opt.method||'GET';
    if(url.includes('identitytoolkit')) return resp(200,{idToken:'idtoken'});
    if(url.includes('/rosterAbsenceAlertDecisions.json')){wholeBranchTouched=true; throw new Error('whole branch must not be touched by setAbsenceAlertDecision');}
    const m=url.match(/rosterAbsenceAlertDecisions\/([^/?]+)\.json/);
    if(m && method==='PUT') { const key=decodeURIComponent(m[1]); store[key]=JSON.parse(opt.body); targetedWrites.push(key); return resp(200,{}); }
    throw new Error(`unexpected proxy fetch ${method} ${url}`);
  };
  let proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  const tokADD=tokens.sign({discordId:'p1',name:'Denied',level:'ADD',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  let out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':tokADD},body:JSON.stringify({action:'setAbsenceAlertDecision',alertKey:'new-alert',decision:'non'})});
  eq(out.statusCode,403,'individual manage_absences deny overrides ADD grade');
  eq(targetedWrites.length,0,'denied absence decision writes nothing');

  permCtx={custom:null,individual:{p2:{manage_absences:{OWNER:true}}}};
  proxy=fresh(path.join(ROOT,'pillbox-proxy.js'));
  const tokMC=tokens.sign({discordId:'p2',name:'Granted',level:'MC',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  out=await proxy.handler({httpMethod:'POST',headers:{'x-pillbox-session':tokMC},body:JSON.stringify({action:'setAbsenceAlertDecision',alertKey:'new-alert',decision:'non'})});
  eq(out.statusCode,200,'individual manage_absences grant can allow lower grade');
  eq(targetedWrites.at(-1),'new-alert','absence writes only requested alert key');
  eq(store.old.decision,'oui','pre-existing absence decision remains untouched');
  eq(store['new-alert'].decision,'non','new decision saved');
  eq(wholeBranchTouched,false,'no whole-branch absence read/write occurred');

  // Gemini: server owns model and prompt; arbitrary payload/model is refused.
  mock(permPath,{...actualPerms,canFor:async()=>true});
  let googleCalls=0, googleUrl='', googlePayload=null;
  global.fetch=async(url,opt={})=>{googleCalls++;googleUrl=String(url);googlePayload=JSON.parse(opt.body);return resp(200,{candidates:[]});};
  let gem=fresh(path.join(ROOT,'gemini-ocr-proxy.js'));
  const gtok=tokens.sign({discordId:'p3',name:'OCR',level:'ADD',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  out=await gem.handler({httpMethod:'POST',headers:{'x-pillbox-session':gtok},body:JSON.stringify({imageBase64:'aGVsbG8=',mimeType:'image/png',rosterNames:[],model:'evil-model'})});
  eq(out.statusCode,400,'Gemini rejects client-selected model'); eq(googleCalls,0,'invalid Gemini request never reaches Google');
  out=await gem.handler({httpMethod:'POST',headers:{'x-pillbox-session':gtok},body:JSON.stringify({imageBase64:'aGVsbG8=',mimeType:'image/png',rosterNames:['Djam Mas']})});
  eq(out.statusCode,200,'valid strict OCR request accepted'); eq(googleCalls,1,'valid OCR calls Google once');
  ok(googleUrl.includes('/models/gemini-fixed-test:generateContent'),'Google URL uses server-side model');
  const prompt=googlePayload.contents[0].parts[0].text; ok(prompt.includes('MISSION : extraire CHAQUE ligne visible'),'server constructs EMS OCR prompt'); ok(prompt.includes('Djam Mas'),'server safely adds roster hint');
  ok(!JSON.stringify(googlePayload).includes('evil-model'),'client model cannot leak into payload');
  const tooBig='A'.repeat(8*1024*1024+4);
  out=await gem.handler({httpMethod:'POST',headers:{'x-pillbox-session':gtok},body:JSON.stringify({imageBase64:tooBig,mimeType:'image/png',rosterNames:[]})});
  eq(out.statusCode,413,'oversized OCR image refused'); eq(googleCalls,1,'oversized OCR never reaches Google');

  // Delete: distinguish Firebase read error, use ETag, reject race.
  mock(permPath,{...actualPerms,can:()=>true,loadPermissionContext:async()=>({custom:null,individual:null})});
  const dtok=tokens.sign({discordId:'p4',name:'Weeks',level:'ADD',origin:'pillbox',exp:Date.now()+600000},process.env.SESSION_SECRET);
  let mode='read500', seenDeleteHeaders=null, archiveCount=0;
  global.fetch=async(url,opt={})=>{
    url=String(url); const method=opt.method||'GET';
    if(url.includes('identitytoolkit')) return resp(200,{idToken:'idtoken'});
    if(url.includes('pillboxWeekHistory/2026-10-17.json')&&method==='GET'){
      if(mode==='read500') return resp(500,{error:'firebase down'});
      return resp(200,{processedAt:1,summary:{}},{etag:'"v1"'});
    }
    if(url.includes('pillboxWeekHistoryArchive')&&method==='PUT'){archiveCount++;return resp(200,{});}
    if(url.includes('pillboxWeekHistory/2026-10-17.json')&&method==='DELETE'){seenDeleteHeaders=opt.headers||{}; return mode==='race'?resp(412,{error:'changed'}):resp(200,{});}
    throw new Error(`unexpected delete fetch ${method} ${url}`);
  };
  let del=fresh(path.join(ROOT,'pillbox-delete-week.js'));
  out=await del.handler({httpMethod:'POST',body:JSON.stringify({token:dtok,weekKey:'2026-10-17'})}); eq(out.statusCode,502,'Firebase read 500 is not fake 404'); eq(archiveCount,0,'read failure archives nothing');
  mode='ok'; del=fresh(path.join(ROOT,'pillbox-delete-week.js')); out=await del.handler({httpMethod:'POST',body:JSON.stringify({token:dtok,weekKey:'2026-10-17'})}); eq(out.statusCode,200,'normal archive+conditional delete succeeds'); eq(seenDeleteHeaders['If-Match'],'"v1"','conditional delete sends source ETag');
  mode='race'; del=fresh(path.join(ROOT,'pillbox-delete-week.js')); out=await del.handler({httpMethod:'POST',body:JSON.stringify({token:dtok,weekKey:'2026-10-17'})}); eq(out.statusCode,409,'concurrent week change returns conflict');

  // Reopen: read error != absent.
  let reopenMode='error';
  global.fetch=async(url,opt={})=>{url=String(url);const method=opt.method||'GET';if(url.includes('identitytoolkit'))return resp(200,{idToken:'idtoken'});if(method==='GET')return reopenMode==='error'?resp(500,{error:'down'}):resp(200,null);throw new Error('unexpected reopen fetch')};
  let reopen=fresh(path.join(ROOT,'pillbox-reopen-week.js')); out=await reopen.handler({httpMethod:'POST',body:JSON.stringify({token:dtok,weekKey:'2026-10-17'})}); eq(out.statusCode,502,'reopen Firebase failure is 502');
  reopenMode='absent'; reopen=fresh(path.join(ROOT,'pillbox-reopen-week.js')); out=await reopen.handler({httpMethod:'POST',body:JSON.stringify({token:dtok,weekKey:'2026-10-17'})}); eq(out.statusCode,404,'reopen true null is 404');

  console.log(`✅ Urgent backend dynamic: ${checks} checks passed`);
})().catch(e=>{console.error(e);process.exit(1)});
