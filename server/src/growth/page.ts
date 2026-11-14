/**
 * Mission Control: one static page, no framework, no external requests.
 * All dynamic text is inserted with textContent. The admin token comes from the URL hash
 * (#token=...) and is sent only as a header to same-origin /api/growth/* calls.
 * NOTE: this file is a TS template literal: the inline script deliberately uses no backticks, no "dollar-brace"
 * and no backslash escapes.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Corp — Mission Control</title>
<style>
:root{--bg:#0b0f1a;--panel:#121a2b;--line:#1f2b45;--text:#e8eefc;--dim:#8fa0c4;--ok:#39ff9c;--warn:#ffb347;--bad:#ff5d73;--blue:#6aa8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}
h1{font-size:16px;margin:0 12px 0 0;letter-spacing:.04em}
.badge{padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim);font-size:12px}
.badge.dry{color:var(--warn);border-color:var(--warn)}.badge.live{color:var(--ok);border-color:var(--ok)}.badge.bad{color:var(--bad);border-color:var(--bad)}
button{background:#1a2742;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
button:hover{border-color:var(--blue)}button:disabled{opacity:.4;cursor:default}button.ok{border-color:var(--ok);color:var(--ok)}button.no{border-color:var(--bad);color:var(--bad)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;padding:14px 18px}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
section.wide{grid-column:1/-1}
h2{font-size:12px;margin:0 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}
.pre{white-space:pre-wrap;word-break:break-word}.dim{color:var(--dim)}
.strip{display:flex;gap:6px;flex-wrap:wrap}.step{padding:4px 10px;border:1px solid var(--line);border-radius:6px;color:var(--dim)}
.step.running{color:var(--blue);border-color:var(--blue);animation:p 1s infinite}.step.done{color:var(--ok);border-color:var(--ok)}.step.error{color:var(--bad);border-color:var(--bad)}.step.skipped{opacity:.5}
@keyframes p{50%{opacity:.45}}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.gallery figure{margin:0;border:1px solid var(--line);border-radius:6px;overflow:hidden}.gallery figure.sel{border-color:var(--ok)}
.gallery img{width:100%;display:block;background:#000}.gallery figcaption{padding:4px 6px;font-size:11px;color:var(--dim)}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:8px}
.row{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
.feed div{padding:3px 0;border-bottom:1px solid var(--line);font-size:12px}
.funnel{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px}.funnel b{display:block;font-size:22px}
.st-DENIED,.st-FAILED,.st-REJECTED{color:var(--bad)}.st-EXECUTED,.st-APPROVED{color:var(--ok)}.st-PENDING_APPROVAL,.st-HUMAN_TASK,.st-DEFERRED,.st-EXECUTING{color:var(--warn)}
#auth{padding:30px}
</style></head><body>
<header><h1>AGENT CORP · MISSION CONTROL</h1><span id="mode" class="badge">…</span><span id="llm" class="badge"></span><span id="tools" class="badge"></span><span id="budget" class="badge"></span>
<span style="flex:1"></span>
<button id="run">Run cycle</button><button id="measure">Measure latest</button><button id="probe">Guardrail probe</button><button id="seed">Seed example</button></header>
<div id="auth" hidden>Open this page with the admin token: <span class="dim">/growth#token=…</span> (printed in the server log at startup).</div>
<main id="main">
<section><h2>CEO</h2><div id="ceo" class="pre dim">No cycle yet.</div></section>
<section><h2>Pipeline</h2><div id="strip" class="strip"></div><div id="stepnote" class="dim pre" style="margin-top:8px"></div></section>
<section class="wide"><h2>Assets</h2><div id="gallery" class="gallery"></div></section>
<section><h2>Approval inbox</h2><div id="inbox"></div></section>
<section><h2>Human tasks</h2><div id="tasks"></div></section>
<section><h2>Funnel (7 days)</h2><div id="funnel" class="funnel"></div><div id="funnelnote" class="dim" style="margin-top:6px"></div></section>
<section class="wide"><h2>Board vote</h2><div id="board"></div></section>
<section class="wide"><h2>Confirmed growth expenses · testnet reimbursements</h2><div id="expenses"></div></section>
<section><h2>Learnings</h2><div id="learn" class="pre dim"></div></section>
<section class="wide"><h2>Actions</h2><div id="actions" class="feed"></div></section>
<section class="wide"><h2>Activity feed</h2><div id="feed" class="feed"></div></section>
</main>
<script>
(function(){
var qs=new URLSearchParams(location.hash.slice(1));
var token=qs.get("token")||sessionStorage.getItem("gtoken")||"";
if(qs.get("token")){sessionStorage.setItem("gtoken",token);history.replaceState(null,"",location.pathname);}
if(!token){document.getElementById("auth").hidden=false;document.getElementById("main").hidden=true;return;}
function $(id){return document.getElementById(id);}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function api(path,body){return fetch(path,{method:body===undefined?"GET":"POST",headers:{"x-growth-admin":token,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j;});});}
function approver(){var a=localStorage.getItem("approver");if(!a){a=prompt("Your name (recorded as approver):")||"";if(a)localStorage.setItem("approver",a);}return a;}
var blobs={};
function loadImg(img,file){if(blobs[file]){img.src=blobs[file];return;}fetch("/api/growth/assets/"+file.split("/").map(encodeURIComponent).join("/"),{headers:{"x-growth-admin":token}}).then(function(r){return r.blob();}).then(function(b){blobs[file]=URL.createObjectURL(b);img.src=blobs[file];});}
function act(label,fn){return function(){var b=this;b.disabled=true;fn().then(refresh).catch(function(e){alert(label+": "+e.message);}).then(function(){b.disabled=false;});};}
$("run").onclick=act("run",function(){return api("/api/growth/run",{});});
$("probe").onclick=act("probe",function(){return api("/api/growth/probe",{});});
$("seed").onclick=act("seed",function(){return api("/api/growth/seed",{});});
$("measure").onclick=act("measure",function(){return api("/api/growth/state").then(function(s){var c=s.cycles.filter(function(x){return !x.seeded;}).pop();if(!c)throw new Error("no cycle to measure");return api("/api/growth/measure",{cycle:c.cycle});});});
function actionCard(a,withButtons){
  var c=el("div","card");
  var h=el("div","",a.kind+(a.channel?" · "+a.channel:"")+(a.costUsd?" · $"+a.costUsd.toFixed(2):""));h.appendChild(el("span","dim"," · "+(a.level||"")));c.appendChild(h);
  c.appendChild(el("div","pre",(a.text||a.summary)));
  (a.parts||[]).forEach(function(p){c.appendChild(el("div","pre dim","↳ reply: "+p.text));});
  if(a.reason)c.appendChild(el("div","dim",a.reason));
  if(withButtons){
    var r=el("div","row");
    if(a.status==="PENDING_APPROVAL"){
      var ok=el("button","ok","Approve & publish");ok.onclick=act("approve",function(){var by=approver();if(!by)return Promise.reject(new Error("name required"));return api("/api/growth/approvals/"+a.id+"/approve",{by:by});});
      var no=el("button","no","Reject");no.onclick=act("reject",function(){var by=approver();if(!by)return Promise.reject(new Error("name required"));var why=prompt("Reason?")||"rejected";return api("/api/growth/approvals/"+a.id+"/reject",{by:by,reason:why});});
      r.appendChild(ok);r.appendChild(no);
    } else if(a.status==="HUMAN_TASK"){
      var d=el("button","ok","Mark done (paste proof URL)");d.onclick=act("done",function(){var by=approver();if(!by)return Promise.reject(new Error("name required"));var u=prompt("https:// URL of the post you made:");if(!u)return Promise.reject(new Error("proof URL required"));return api("/api/growth/tasks/"+a.id+"/done",{by:by,url:u});});
      r.appendChild(d);
    }
    c.appendChild(r);
  }
  return c;
}
function boardPanel(b){
  var root=$("board");root.textContent="";
  if(!b||!b.enabled){root.appendChild(el("div","dim","Board governance is disabled in growth/policy.yaml: the owner cap applies."));return;}
  var cap=el("div","pre","Growth cap per cycle: $"+b.effectiveCycleCapUsd+" (owner ceiling $"+b.ownerCycleCapUsd+", bootstrap $"+b.bootstrapUsd+")");root.appendChild(cap);
  root.appendChild(el("div","dim",b.basis+" · chain: "+b.chain+(b.error?" ("+b.error+")":"")+(b.contributorsWithUnits!==undefined?" · contributors with units: "+b.contributorsWithUnits:"")));
  var bar=el("div","row");var sync=el("button","","Sync & finalize");sync.onclick=act("sync",function(){return api("/api/growth/board/sync",{});});bar.appendChild(sync);root.appendChild(bar);
  if(!b.canWrite)root.appendChild(el("div","st-DEFERRED","Chain writes are off in dry-run (set GROWTH_BOARD_WRITES=on to use the testnet contract). Reading still works."));
  var o=b.open;
  if(o){
    var card=el("div","card");card.appendChild(el("div","","OPEN · proposal #"+o.id+": "+o.title));
    var total=0;o.options.forEach(function(x){total+=Number(x.tally)||0;});
    o.options.forEach(function(x,i){
      var pct=total?Math.round(100*(Number(x.tally)||0)/total):0;
      var row=el("div","row");row.appendChild(el("span","","option "+i+": $"+x.capUsd+" per cycle · "+x.tally+" units ("+pct+"%)"));
      if(o.votable&&b.canWrite&&b.demoVoting){["alice","bob"].forEach(function(w){var v=el("button","ok",w+" votes");v.onclick=act("vote",function(){return api("/api/growth/board/vote",{wallet:w,option:i,proposalId:o.id});});row.appendChild(v);});}
      card.appendChild(row);
    });
    card.appendChild(el("div","dim",o.voters+" voted · "+(o.votable?"ends "+new Date(o.endsAtMs).toLocaleTimeString():"voting period over")+" · contributors vote from their own wallets; demo buttons only on a demo contract"));
    if(!o.votable&&b.canWrite){var f=el("button","ok","Finalize");f.onclick=act("finalize",function(){return api("/api/growth/board/finalize",{proposalId:o.id});});card.appendChild(f);}
    root.appendChild(card);
  } else root.appendChild(el("div","dim","No open vote."));
  (b.recent||[]).filter(function(x){return x.status!=="Open";}).slice(0,3).forEach(function(x){
    var t="#"+x.id+" "+x.title+" → "+(x.status==="Passed"?"passed: option "+x.passedOption+" ($"+x.options[x.passedOption].capUsd+")":"no change");
    root.appendChild(el("div","dim",t));
  });
}
function expensePanel(s){
  var root=$("expenses");root.textContent="";var data=s.expenses||{rows:[],enabled:false};
  root.appendChild(el("div","dim",data.enabled?"Record a paid service receipt. CEO approval and oracle payment use tNEAR at the configured demo rate.":"Disabled. Set GROWTH_EXPENSE_PAYEE and GROWTH_EXPENSE_WRITES=on in live mode. Estimates and dry-run costs are never paid invoices."));
  data.rows.forEach(function(r){var row=el("div","card",r.status+" · $"+r.actualUsd+" · "+r.payee+" · action "+r.actionId);if(r.status!=="PAID"&&data.enabled){var button=el("button","","Reconcile / retry payment");button.onclick=act("expense",function(){return api("/api/growth/expenses/"+r.actionId,{reconcile:true});});row.appendChild(button);}root.appendChild(row);});
  if(!data.enabled)return;
  s.actions.filter(function(a){return a.status==="EXECUTED"&&!a.summary.startsWith("[DRY]")&&["llm","exa","fal"].indexOf(a.kind.split(".")[0])>=0&&!data.rows.some(function(r){return r.actionId===a.id;});}).forEach(function(a){
    var card=el("div","card",a.kind+" · "+a.summary);var button=el("button","","Record confirmed paid receipt");
    button.onclick=act("expense",function(){var by=approver();var amount=prompt("Actual paid USD amount (not the estimate):");var url=prompt("HTTPS receipt URL, without secret tokens:");if(!by||!amount||!url)return Promise.reject(new Error("Receipt, actual amount and approver required"));return api("/api/growth/expenses/"+a.id,{by:by,actualUsd:amount,evidenceUrl:url});});card.appendChild(button);root.appendChild(card);
  });
}
function render(s){
  var m=s.mode;var mode=$("mode");mode.textContent=m.dryRun?"DRY-RUN (nothing leaves this machine)":"LIVE";mode.className="badge "+(m.dryRun?"dry":"live");
  $("llm").textContent="LLM: "+(m.llmLive?m.model:"dry stand-in");
  $("tools").textContent="tools: "+(m.tools.length?m.tools.join(", "):"none");
  var b=$("budget");b.textContent="spent $"+s.budget.spentUsd.toFixed(2)+" / $"+s.budget.totalCapUsd+" · cycle cap $"+s.budget.effectiveCycleCapUsd+(m.paused?" · PAUSED":"")+(m.urlIsPlaceholder?" · product.url is a placeholder":"");b.className="badge"+(m.paused||(m.urlIsPlaceholder&&!m.dryRun)?" bad":"");
  $("run").disabled=m.busy;
  boardPanel(s.board);
  expensePanel(s);
  var cyc=s.cycles.length?s.cycles[s.cycles.length-1]:null;
  var ceo=$("ceo");ceo.textContent="";
  if(cyc&&cyc.directive){var d=cyc.directive;
    ceo.className="pre";
    ceo.appendChild(el("div","","Cycle "+cyc.cycle+(cyc.seeded?" (SEEDED EXAMPLE)":"")+(cyc.dryRun?" [DRY]":"")+" · stage: "+d.stage));
    ceo.appendChild(el("div","","Diagnosis: "+d.diagnosis));
    ceo.appendChild(el("div","","Bet: "+d.bet.hypothesis));
    ceo.appendChild(el("div","dim","channel "+d.bet.channel+" · target "+d.bet.metric+" ≥ "+d.bet.target+" in "+d.bet.hours+"h · budget $"+d.budget_usd));
    if(cyc.measurement){var mm=cyc.measurement;ceo.appendChild(el("div","","Result: "+mm.metric+" = "+mm.value+" vs "+mm.target+" → "+mm.outcome.toUpperCase()+" (source: "+mm.funnelSource+")"));}
    if(cyc.error)ceo.appendChild(el("div","st-FAILED","Stopped: "+cyc.error));
  } else {ceo.className="pre dim";ceo.textContent="No cycle yet. Press Run cycle.";}
  var strip=$("strip");strip.textContent="";var notes=[];
  ["sense","decide","research","create","gate","publish","measure","learn"].forEach(function(n){var st=cyc?cyc.steps.filter(function(x){return x.name===n;}).pop():null;strip.appendChild(el("span","step "+(st?st.status:""),n));if(st&&st.note)notes.push(n+": "+st.note);});
  $("stepnote").textContent=notes.join("\\n");
  var g=$("gallery");g.textContent="";
  (cyc?cyc.assets:[]).forEach(function(a){var f=el("figure",a.selected?"sel":"");
    if(a.kind==="image"){var img=el("img");img.alt=a.prompt||"asset";loadImg(img,a.file);f.appendChild(img);}else{f.appendChild(el("div","pre dim",a.file));}
    f.appendChild(el("figcaption","",(a.selected?"SELECTED · ":"")+(a.model||a.kind)+" · $"+a.costUsd.toFixed(2)+(a.prompt?" · "+a.prompt.slice(0,80):"")));g.appendChild(f);});
  if(!g.childNodes.length)g.appendChild(el("div","dim","No assets yet."));
  var inbox=$("inbox");inbox.textContent="";s.pending.forEach(function(a){inbox.appendChild(actionCard(a,true));});if(!s.pending.length)inbox.appendChild(el("div","dim","Nothing waiting."));
  var tasks=$("tasks");tasks.textContent="";s.humanTasks.forEach(function(a){tasks.appendChild(actionCard(a,true));});if(!s.humanTasks.length)tasks.appendChild(el("div","dim","No human tasks."));
  var f=$("funnel");f.textContent="";["page_view","game_page_view","wallet_connect","pass_click"].forEach(function(k){var d=el("div");d.appendChild(el("b","",String(s.funnel[k]||0)));d.appendChild(el("span","dim",k));f.appendChild(d);});
  $("funnelnote").textContent="first-party events: "+s.counts.events+" · waitlist: "+s.counts.waitlist+" · zero means zero (no seeded numbers)";
  $("learn").textContent=s.learnings||"No learnings yet.";
  var acts=$("actions");acts.textContent="";s.actions.slice(0,40).forEach(function(a){var d=el("div");d.appendChild(el("span","st-"+a.status,a.status+" "));d.appendChild(el("span","",a.kind+" — "+a.summary.slice(0,110)));if(a.url){var u=el("span","dim"," → "+a.url);d.appendChild(u);}if(a.reason&&a.status==="DENIED")d.appendChild(el("span","dim"," ("+a.reason.slice(0,120)+")"));acts.appendChild(d);});
}
function feed(){fetch("/api/activity").then(function(r){return r.json();}).then(function(list){var f=$("feed");f.textContent="";list.filter(function(x){return x.actor==="MARKETING"||x.actor==="CEO"||x.actor==="BIZDEV";}).slice(0,30).forEach(function(x){f.appendChild(el("div","",new Date(x.ts).toLocaleTimeString()+" ["+x.actor+"] "+x.text));});}).catch(function(){});}
function refresh(){return api("/api/growth/state").then(render).then(feed).catch(function(e){$("budget").textContent="error: "+e.message;$("budget").className="badge bad";});}
refresh();setInterval(refresh,2500);
})();
</script></body></html>`;
