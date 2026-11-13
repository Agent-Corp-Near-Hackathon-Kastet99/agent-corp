import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { FakeChain } from "./chain.js";
import { Db } from "./db.js";
import { Dispatcher } from "./dispatch.js";
import { fetchPage } from "./fetch.js";
import { Nep413Auth } from "./auth.js";

const chain = new FakeChain();
const db = new Db(process.env.DB_PATH ?? "agentcorp.sqlite");
const dispatcher = new Dispatcher(db,chain);
const auth = new Nep413Auth({ viewAccessKey: async () => undefined });

function json(res: import("node:http").ServerResponse, code: number, body: unknown) { res.writeHead(code,{"content-type":"application/json"}); res.end(JSON.stringify(body)); }
function jobView(id: string) { const j=db.getJob(id); if (!j) return undefined; return { id:j.id,url:j.url,state:j.state,subtasks: (["copy","design"] as const).map(subtask=>{ const a=db.attempts(id,subtask).at(-1); return {subtask,status:a?.status === "done" ? "done" : a?.status === "running" ? "running" : a ? "reassigned" : "queued",elapsedMs:a ? Math.max(0,Date.now()-(a.lease_until-45_000)) : 0}; }), ...(j.teardown_copy&&j.teardown_design?{teardown:{copy:j.teardown_copy,design:j.teardown_design}}:{}), ...(j.receipt_json?{receipt:JSON.parse(j.receipt_json)}:{}), ...(j.state==="refundable"?{refundOpensAt:j.refund_opens_at}:{}) }; }
const server=createServer(async(req,res)=>{ try {
  const url=new URL(req.url??"/","http://localhost");
  if (req.method === "POST" && url.pathname === "/api/jobs") { let body=""; for await (const c of req) body+=c; const {url: target}=JSON.parse(body); const page=await fetchPage(target); const id=randomUUID(); await dispatcher.create(id,page.url,page.text); return json(res,201,{jobId:id,price:"1000000000000000000000000",contractId:process.env.CONTRACT_ID??"agentcorp-fake.testnet"}); }
  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) { const job=jobView(url.pathname.slice(10)); return job?json(res,200,job):json(res,404,{error:"not found"}); }
  if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res,200,{treasuryYocto:"0",network:"testnet",contributors:[],activity:[]});
  if (req.method === "POST" && url.pathname === "/api/admin/proposal") { let body=""; for await (const c of req) body+=c; const {title="Budget split"}=JSON.parse(body); const id=await chain.createProposal({title,options:[{label:"Contributor pool",pct:70},{label:"Treasury",pct:20},{label:"Platform",pct:10}],votingPeriodSecs:"3600"}); return json(res,201,{id}); }
  if (req.method === "GET") { try { const data=await readFile(join(process.cwd(),"server/web/dist",url.pathname === "/" ? "index.html" : url.pathname)); res.end(data); } catch { json(res,404,{error:"not found"}); } return; }
  json(res,405,{error:"method not allowed"});
} catch(e) { json(res,400,{error:e instanceof Error?e.message:"bad request"}); } });
const ws=new WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>{ const path=new URL(req.url??"/","http://localhost").pathname; if (path === "/api/worker" || path === "/api/live") ws.handleUpgrade(req,socket,head,s=>ws.emit("connection",s,req)); else socket.destroy(); });
ws.on("connection",(socket:WebSocket,req)=>{ const path=new URL(req.url??"/","http://localhost").pathname; if(path === "/api/live") return; const c=auth.issue(); socket.send(JSON.stringify({t:"challenge",...c})); let account=""; socket.on("message",async raw=>{ try { const m=JSON.parse(raw.toString()); if(m.t === "login") { await auth.verify(m); account=m.account; await chain.registerContributor(account); const session=randomUUID(); socket.send(JSON.stringify({t:"welcome",account,session})); dispatcher.addWorker({account,send:task=>socket.send(JSON.stringify({t:"task",...task}))}); } else if(m.t === "heartbeat") dispatcher.heartbeat(m.attemptId); else if(m.t === "progress") dispatcher.progress(m.attemptId,m.provisionalUnits); else if(m.t === "result") await dispatcher.result(m.attemptId,m.leaseGeneration,m.text,m.units); else if(m.t === "failed") await dispatcher.failed(m.attemptId,m.leaseGeneration,m.units); } catch(e) { socket.send(JSON.stringify({t:"error",error:e instanceof Error?e.message:"bad message"})); } }); socket.on("close",()=>{if(account) dispatcher.removeWorker(account);}); });
if (process.argv[1]?.endsWith("/src/index.ts")) { dispatcher.reconcile().then(()=>server.listen(8787,()=>console.log("Agent Corp server listening on :8787"))); }
export { server, dispatcher, db, chain };
