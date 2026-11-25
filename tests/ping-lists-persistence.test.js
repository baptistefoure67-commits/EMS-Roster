const path=require("path"),crypto=require("crypto"),assert=require("assert");
const DIR=path.join(__dirname,"..","netlify","functions");
const {privateKey}=crypto.generateKeyPairSync("rsa",{modulusLength:2048,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
process.env.SESSION_SECRET="ping-list-persistence";process.env.FIREBASE_CLIENT_EMAIL="test@example.com";process.env.FIREBASE_PRIVATE_KEY=privateKey;process.env.FIREBASE_WEB_API_KEY="test";
const {sign}=require(path.join(DIR,"session-token"));
const original=[{id:"emp1",name:"Test Employee",discordId:"123456789012345678",grade:"M",licencie:false}];
let db;
function reset(){db={rosterEmsData:{employees:JSON.parse(JSON.stringify(original)),savedAt:1}};}
reset();
global.fetch=async(url,opts={})=>{
 const u=String(url),method=opts.method||"GET";
 if(u.includes("identitytoolkit"))return{ok:true,status:200,json:async()=>({idToken:"fake-token"})};
 if(u.includes("rosterEmsData")){
  if(method==="GET")return{ok:true,status:200,headers:{get:()=>"etag"},json:async()=>db.rosterEmsData};
  if(method==="PUT"){db.rosterEmsData=JSON.parse(opts.body);return{ok:true,status:200,json:async()=>db.rosterEmsData};}
 }
 return{ok:true,status:200,json:async()=>({})};
};
delete require.cache[require.resolve(path.join(DIR,"protected-write.js"))];
const handler=require(path.join(DIR,"protected-write.js")).handler;
async function call(payload){
 const token=sign({discordId:"1",name:"Test",level:"ADD",exp:Date.now()+3600000},process.env.SESSION_SECRET);
 const r=await handler({httpMethod:"POST",body:JSON.stringify({token,action:"editEmployee",payload})});
 return{status:r.statusCode,data:JSON.parse(r.body)};
}
(async()=>{
 reset();
 let r=await call({id:"emp1",excludeFromPingLists:true});
 assert.strictEqual(r.status,200);assert.strictEqual(db.rosterEmsData.employees[0].excludeFromPingLists,true);
 console.log("✅ protected-write enregistre l'exclusion manuelle dans Firebase");
 reset();
 r=await call({id:"emp1",excludeFromPingLists:false});
 assert.strictEqual(r.status,200);assert.strictEqual(db.rosterEmsData.employees[0].excludeFromPingLists,false);
 console.log("✅ protected-write persiste la réactivation");
 reset();
 r=await call({id:"emp1"});
 assert.strictEqual(r.status,200);assert.strictEqual(db.rosterEmsData.employees[0].excludeFromPingLists,undefined);
 console.log("✅ ancien employé sans champ conservé sans migration destructive");
})().catch(e=>{console.error(e);process.exit(1);});
