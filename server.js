import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||4173);
const GEMINI_API_KEY=process.env.GEMINI_API_KEY||'';
const GAME_ACCESS_CODE=process.env.GAME_ACCESS_CODE||'';
const GEMINI_MODEL=process.env.GEMINI_MODEL||'gemini-3.5-flash-lite';
const LIMIT=Math.max(1,Math.min(200,Number(process.env.GEMINI_DAILY_LIMIT||60)));
const INTERVAL=Math.max(6500,Number(process.env.GEMINI_INTERVAL_MS||7500));
const READY=Boolean(GEMINI_API_KEY&&GAME_ACCESS_CODE);
const TYPES=new Set(['policy','law','budget','project','program','embargo','lift_embargo','research','recruit','demobilize','relief','explore','extract','message','gift','propose','respond','declare_war','peace','loan','trade','request_trade','spy']);
const sessions=new Map(), failures=new Map();
let calls=0, day='', lastCall=0;

function reply(res,status,obj,extra={}){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra});
  res.end(JSON.stringify(obj));
}
function state(){
  const now=new Date().toISOString().slice(0,10);
  if(day!==now){day=now;calls=0;}
  return {day,calls};
}
function secureMatch(a,b){
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(),crypto.createHash('sha256').update(String(b)).digest());
}
function originAllowed(req){
  if(!req.headers.origin)return true;
  try{
    const origin=new URL(req.headers.origin);
    const host=req.headers.host;
    return origin.host===host && (origin.protocol==='https:'||origin.protocol==='http:');
  }catch{return false;}
}
function session(req){
  const token=(req.headers.cookie||'').match(/(?:^|;\s*)wd_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!token)return false;
  const exp=sessions.get(token);
  if(!exp||exp<Date.now()){if(token)sessions.delete(token);return false;}
  return true;
}
async function body(req,max=24000){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Requête trop volumineuse');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function validateInput(x){
  return !!(x&&typeof x==='object'&&!Array.isArray(x)&&Number.isInteger(x.countryId)&&x.countryId>=0&&x.countryId<=9&&x.self&&Array.isArray(x.allowedActions)&&x.allowedActions.length<=40&&x.allowedActions.every(a=>TYPES.has(a))&&Array.isArray(x.publicNeighbors));
}
const instruction=[
  'Tu représentes exclusivement les institutions et les intérêts stratégiques du pays décrit dans self. Aucune personnalité, dynastie ou vie privée individuelle.',
  'Tu es une IA nationale autonome, indépendante des neuf autres pays IA et du pays du joueur. Tes décisions doivent être ambitieuses, cohérentes, réalisables et non centrées sur Astérie.',
  'Tu n’as connaissance que du contexte fourni, de ta mémoire privée et des courriers que tu reçois.',
  'Poursuis tes objectifs, choisis une politique, propose une négociation, commerce, enquête, construis, réforme ou prépare une guerre selon tes priorités.',
  'Ne favorise jamais Astérie seulement parce qu’elle est le pays du joueur.',
  'Ne crée pas de monnaie, ressources, décisions d’autrui, armées ou traités fictifs.',
  'Élabore un programme national de 2 à 4 actions concrètes et différentes, par ordre de priorité. Réponds aux propositions reçues, développe les infrastructures, explore les échanges et protège les intérêts du pays. Évite les dépêches vides. Chaque action sera vérifiée et pourra être refusée par le moteur.',
  'Réponds uniquement en JSON valide de la forme {"strategy":"objectif national concis","actions":[{"type":"action","payload":{},"reason":"raison courte"}]}.',
  'type doit appartenir à allowedActions. Les cibles et identifiants doivent exister dans le contexte. Si un pays manque de vivres, request_trade peut demander un achat au vendeur. Évite les programmes nationaux coûteux si la trésorerie est limitée.',
  'Un embargo sur les échanges avec un pays doit être motivé par un intérêt économique ou diplomatique concret et évalué au regard des coûts de représailles.',
  'Exemples: program={"sector":"industrialisation|transport|agriculture|sante|education","budget":300,"duration":365,"provinceId":"id"}, embargo={"target":id}, lift_embargo={"target":id}, request_trade={"target":id,"resource":"cereales","quantity":3,"price":5}, project={"project":"routes|fermes|hopital|ecoles|eau|logement|port|mines|ateliers|fortifications","provinceId":"id"}, policy={"field":"taxRate","value":0.2}, research={"technology":"id"}, propose={"target":id,"kind":"alliance|commerce|non_agression"}, respond={"proposalId":id,"accept":true}, message={"target":id,"text":"..."}.'
].join('\n');
async function decide(input){
  const abort=AbortSignal.timeout(35000);
  const res=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(GEMINI_MODEL)+':generateContent',{
    method:'POST',signal:abort,
    headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY},
    body:JSON.stringify({
      systemInstruction:{parts:[{text:instruction}]},
      contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],
      generationConfig:{responseMimeType:'application/json',temperature:0.9,maxOutputTokens:1400}
    })
  });
  const data=await res.json();
  if(!res.ok){const error=new Error(data?.error?.message||'Erreur Gemini');error.status=res.status;throw error;}
  const txt=(data?.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('');
  const parsed=JSON.parse(txt);
  const candidates=Array.isArray(parsed.actions)?parsed.actions:[parsed];
  const actions=candidates.slice(0,4).filter(action=>action&&TYPES.has(action.type)&&input.allowedActions.includes(action.type)&&action.payload&&typeof action.payload==='object'&&!Array.isArray(action.payload)).map(action=>({type:action.type,payload:action.payload,reason:String(action.reason||'').slice(0,240)}));
  if(!actions.length)throw Error('Programme Gemini invalide');
  return {strategy:String(parsed.strategy||'Priorités nationales').slice(0,200),actions};
}

const SANDBOX_TYPES=new Set(['observe','move','explore','gather','build','experiment','communicate','offer_trade','accept_trade','raid']);
function validateSandboxInput(x){
  return Boolean(x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.agentId==='string'&&/^a[0-9]{1,12}$/.test(x.agentId)&&
    Number.isInteger(x.day)&&x.day>=0&&x.day<=5000000&&
    x.agent&&typeof x.agent==='object'&&x.civilization&&typeof x.civilization==='object'&&
    Array.isArray(x.observedTiles)&&x.observedTiles.length<=110&&
    Array.isArray(x.memory)&&x.memory.length<=12&&Array.isArray(x.otherAgents)&&x.otherAgents.length<=25);
}
const sandboxInstruction=[
  'Tu es un véritable agent de décision, indépendant des autres agents, dans un monde physique simulé.',
  'Aucun rôle, aucune personnalité, aucune mission, aucune histoire, aucun objectif ne t’est imposé.',
  'Tu reçois seulement des lois physiques, la description de ce que tu peux percevoir, les stocks observables, tes messages et ta propre mémoire.',
  'Tu choisis librement une action possible, ou observe si tu préfères ne rien faire. Une absence de progrès est autorisée.',
  'Toutes les ressources et actions sont soumises aux lois du moteur. Tu ne peux pas inventer des stocks, des constructions, des déplacements ou des décisions d’autrui.',
  'Tu n’es PAS un narrateur. Ne prédis pas une évolution du monde. Sélectionne uniquement l’action que TU décides maintenant.',
  'Actions disponibles: observe {}; move/explore {x:int,z:int}; gather {x:int,z:int,resource:"wood|stone|iron|food",amount:int de 1 à 12}; build {x:int,z:int,structure:"hut|farm|workshop|tower|mine|port"}; experiment {topic:"agriculture|metallurgie|construction|navigation|medecine"}; communicate {targetAgent:id,message:texte}; offer_trade {targetCiv:id,resource:"wood|stone|iron|food",amount:int}; accept_trade {offerId:id}; raid {targetCiv:id}.',
  'Une action peut échouer si les conditions concrètes sont insuffisantes. Les échecs seront ajoutés à ta mémoire et te seront montrés plus tard.',
  'Tu peux agir pour ton propre groupe, explorer, dialoguer, ne rien faire, ou expérimenter. Ce choix doit venir de toi, pas de consignes scénaristiques.',
  'Réponds uniquement en un objet JSON {"type":"action","reason":"motivation factuelle courte",...parametres}. Pas de Markdown.'
].join('\n');
async function decideSandboxAgent(input){
  const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(GEMINI_MODEL)+':generateContent',{
    method:'POST',signal:AbortSignal.timeout(35000),
    headers:{'content-type':'application/json','x-goog-api-key':GEMINI_API_KEY},
    body:JSON.stringify({systemInstruction:{parts:[{text:sandboxInstruction}]},contents:[{role:'user',parts:[{text:JSON.stringify(input)}]}],
      generationConfig:{responseMimeType:'application/json',temperature:.96,maxOutputTokens:650}})
  });
  const json=await response.json();
  if(!response.ok){const err=new Error(json?.error?.message||'Gemini indisponible');err.status=response.status;throw err;}
  const txt=(json?.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('').trim();
  let parsed;
  try{parsed=JSON.parse(txt);}catch{throw new Error('La réponse Gemini ne contient pas un JSON valide');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!SANDBOX_TYPES.has(parsed.type))throw new Error('L’agent a proposé une action non autorisée');
  if(JSON.stringify(parsed).length>2000)throw new Error('Réponse de l’agent trop longue');
  const output={type:parsed.type,reason:String(parsed.reason||'Choix autonome').slice(0,180)};
  for(const key of ['x','z','amount'])if(parsed[key]!==undefined){if(!Number.isInteger(parsed[key])||Math.abs(parsed[key])>10000)throw new Error('Coordonnées ou quantité invalides');output[key]=parsed[key];}
  for(const key of ['resource','structure','topic','targetAgent','targetCiv','offerId','message'])if(parsed[key]!==undefined){if(typeof parsed[key]!=='string'||parsed[key].length>250)throw new Error('Paramètres invalides');output[key]=parsed[key];}
  return output;
}
const sandboxFiles=new Map([
  ['/sandbox',path.join(ROOT,'sandbox/index.html')],
  ['/sandbox/',path.join(ROOT,'sandbox/index.html')],
  ['/sandbox/index.html',path.join(ROOT,'sandbox/index.html')],
  ['/sandbox/style.css',path.join(ROOT,'sandbox/style.css')],
  ['/sandbox/game.js',path.join(ROOT,'sandbox/game.js')],
  ['/sandbox/vendor/three.module.js',path.join(ROOT,'node_modules/three/build/three.module.js')],
  ['/sandbox/vendor/three.core.js',path.join(ROOT,'node_modules/three/build/three.core.js')],
  ['/sandbox/vendor/addons/controls/OrbitControls.js',path.join(ROOT,'node_modules/three/examples/jsm/controls/OrbitControls.js')]
]);

const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');

    if(req.method==='GET'&&url.pathname==='/sandbox/api/status'){
      state();
      return reply(res,200,{available:READY,authenticated:READY&&session(req),model:READY?GEMINI_MODEL:null,
        remaining:READY?Math.max(0,LIMIT-calls):0,limit:LIMIT,minimumIntervalMs:INTERVAL,protocol:'sandbox-v1'});
    }
    if(req.method==='POST'&&url.pathname==='/sandbox/api/decide'){
      if(!originAllowed(req))return reply(res,403,{error:'Origine refusée'});
      if(!READY)return reply(res,503,{error:'Gemini non configuré'});
      if(!session(req))return reply(res,401,{error:'Déverrouillez Gemini avec le code privé du serveur'});
      state();
      if(calls>=LIMIT)return reply(res,429,{error:'Limite quotidienne Gemini atteinte'});
      if(Date.now()-lastCall<INTERVAL)return reply(res,429,{error:'Intervalle minimum entre les décisions Gemini'});
      let input;try{input=await body(req,22000);}catch{return reply(res,400,{error:'Observation JSON invalide ou trop volumineuse'});}
      if(!validateSandboxInput(input))return reply(res,400,{error:'Observation d’agent non conforme'});
      lastCall=Date.now();calls++;
      try{
        const action=await decideSandboxAgent(input);
        return reply(res,200,{action,remaining:Math.max(0,LIMIT-calls)});
      }catch(e){return reply(res,e.status===429?429:502,{error:e.status===429?'Quota Google épuisé':String(e.message||'Erreur Gemini').slice(0,220)});}
    }
    if(req.method==='GET'&&url.pathname==='/api/status'){
      state();
      return reply(res,200,{geminiAvailable:READY,geminiConfigured:READY&&session(req),authenticated:session(req),model:READY?GEMINI_MODEL:null,dailyCallsRemaining:READY?Math.max(0,LIMIT-calls):0,dailyLimit:LIMIT,protocol:'v2'});
    }
    if(req.method==='POST'&&url.pathname==='/api/session'){
      if(!originAllowed(req))return reply(res,403,{error:'Origine refusée'});
      if(!READY)return reply(res,503,{error:'Renseigner GEMINI_API_KEY et GAME_ACCESS_CODE dans Render.'});
      const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].slice(0,80);
      const now=Date.now();
      for(const [t,expiry] of sessions)if(expiry<now)sessions.delete(t);
      const attempts=failures.get(ip)||{n:0,until:0};
      if(attempts.n>=8&&attempts.until>now)return reply(res,429,{error:'Trop de tentatives de connexion.'});
      let input;
      try{input=await body(req,2000);}catch{return reply(res,400,{error:'Requête invalide'});}
      if(typeof input?.accessCode!=='string'||!secureMatch(input.accessCode,GAME_ACCESS_CODE)){
        failures.set(ip,{n:attempts.n+1,until:now+10*60*1000});
        return reply(res,401,{error:'Code privé incorrect'});
      }
      failures.delete(ip);
      const token=crypto.randomBytes(32).toString('hex');
      sessions.set(token,now+24*60*60*1000);
      const isHttps=req.headers['x-forwarded-proto']==='https'||req.socket.encrypted;
      return reply(res,200,{authenticated:true},{'set-cookie':'wd_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400'+(isHttps?'; Secure':'')});
    }
    if(req.method==='POST'&&url.pathname==='/api/agent'){
      if(!originAllowed(req))return reply(res,403,{error:'Origine refusée'});
      if(!READY)return reply(res,503,{error:'Gemini non configuré'});
      if(!session(req))return reply(res,401,{error:'Déverrouille Gemini avec ton code privé'});
      state();
      if(calls>=LIMIT)return reply(res,429,{error:'Limite quotidienne atteinte'});
      if(Date.now()-lastCall<INTERVAL)return reply(res,429,{error:'Intervalle minimum entre les décisions'});
      let input;
      try{input=await body(req);}catch{return reply(res,400,{error:'Contexte trop volumineux ou invalide'});}
      if(!validateInput(input))return reply(res,400,{error:'Contexte agent invalide'});
      lastCall=Date.now();calls++;
      try{return reply(res,200,{decision:await decide(input)});}
      catch(e){return reply(res,e.status===429?429:502,{error:e.status===429?'Quota Gemini épuisé':String(e.message||'Erreur IA').slice(0,250)});}
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return reply(res,405,{error:'Méthode refusée'});
    const file=url.pathname==='/'?path.join(ROOT,'index.html'):sandboxFiles.get(url.pathname);
    if(!file)return reply(res,404,{error:'Page introuvable'});
    const type=mime[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin'});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(file).on('error',()=>res.end('Erreur')).pipe(res);
  }catch(e){return reply(res,500,{error:'Erreur du serveur'});}
});
server.listen(PORT,'0.0.0.0',()=>console.log('WORLD DYNASTY sur le port '+PORT+' ; Gemini '+(READY?'configuré':'en attente de clé')));
export {server};
