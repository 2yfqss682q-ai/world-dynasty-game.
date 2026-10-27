import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||4173);
const GEMINI_API_KEY=process.env.GEMINI_API_KEY||'';
const GAME_ACCESS_CODE=process.env.GAME_ACCESS_CODE||'';
const GEMINI_MODEL=process.env.GEMINI_MODEL||'gemini-2.5-flash-lite';
const LIMIT=Math.max(1,Math.min(200,Number(process.env.GEMINI_DAILY_LIMIT||60)));
const INTERVAL=Math.max(6500,Number(process.env.GEMINI_INTERVAL_MS||7500));
const READY=Boolean(GEMINI_API_KEY&&GAME_ACCESS_CODE);
const TYPES=new Set(['policy','law','budget','project','research','recruit','demobilize','relief','explore','extract','message','gift','propose','respond','declare_war','peace','loan','trade','spy']);
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
  'type doit appartenir à allowedActions. Les cibles et identifiants doivent exister dans le contexte.',
  'Exemples: project={"project":"routes|fermes|hopital|ecoles|eau|logement|port|mines|ateliers|fortifications","provinceId":"id"}, policy={"field":"taxRate","value":0.2}, research={"technology":"id"}, propose={"target":id,"kind":"alliance|commerce|non_agression"}, respond={"proposalId":id,"accept":true}, message={"target":id,"text":"..."}.'
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
const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.json':'application/json'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
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
    const file=url.pathname==='/'?path.join(ROOT,'index.html'):null;
    if(!file)return reply(res,404,{error:'Page introuvable'});
    res.writeHead(200,{'content-type':mime['.html'],'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin'});
    if(req.method==='HEAD'){res.end();return;}
    fs.createReadStream(file).on('error',()=>res.end('Erreur')).pipe(res);
  }catch(e){return reply(res,500,{error:'Erreur du serveur'});}
});
server.listen(PORT,'0.0.0.0',()=>console.log('WORLD DYNASTY sur le port '+PORT+' ; Gemini '+(READY?'configuré':'en attente de clé')));
export {server};
