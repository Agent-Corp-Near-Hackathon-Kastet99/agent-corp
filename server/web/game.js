import {header,api,esc} from './chain.js';
import {visible} from './heist-core.js';
document.querySelector('#header').innerHTML=header('game');
const canvas=document.querySelector('#game'),ctx=canvas.getContext('2d'),message=document.querySelector('#message'),label=document.querySelector('#state'),lootHud=document.querySelector('#hud-loot'),energyHud=document.querySelector('#hud-energy'),alertHud=document.querySelector('#game-alert');
let level,state,previousState,changedAt=0,busy=false,direction=null,sprint=false,ready=false;
function setState(next){previousState=state;state=next;changedAt=performance.now()}
const receipt=sessionStorage.getItem('heistReceipt');
if(receipt)document.querySelector('#receipt').innerHTML=`<p><a href="${esc(receipt)}">View pass transaction ↗</a></p>`;
function draw(){
  ctx.fillStyle='#699651';ctx.fillRect(0,0,canvas.width,canvas.height);if(!state||!level)return;
  // A little garden around the house gives the scene a readable top-down frame.
  for(let y=0;y<canvas.height;y+=35)for(let x=0;x<canvas.width;x+=42){ctx.fillStyle=(x+y)%3?'#729e58':'#618d4a';ctx.beginPath();ctx.ellipse(x+12,y+12,10,5,.4,0,Math.PI*2);ctx.fill()}
  const size=56,ox=(canvas.width-level.rows[0].length*size)/2,oy=30;
  const residents=[state.resident,state.secondResident].filter(Boolean);
  const sight=new Set(residents.flatMap(r=>visible(level,r)).map(p=>`${p.x},${p.y}`));
  level.rows.forEach((row,y)=>[...row].forEach((t,x)=>{
    const px=ox+x*size,py=oy+y*size;
    const kitchen=y>=6&&x>=7;
    ctx.fillStyle=t==='#'?'#c8945e':sight.has(`${x},${y}`)?'#f2d896':kitchen?((x+y)%2?'#c7d9bb':'#e0e9d2'):((x+y)%2?'#e9c79d':'#f1d8b3');ctx.fillRect(px,py,size,size);
    if(t==='#'){ctx.fillStyle='#f4e7c4';ctx.fillRect(px,py,size,10);ctx.fillStyle='#a46f48';ctx.fillRect(px,py+42,size,10);ctx.fillStyle='rgba(95,65,44,.18)';ctx.fillRect(px,py+36,size,6)}
    if(t==='D'){ctx.fillStyle='#895b3b';ctx.fillRect(px+size*.4,py+3,10,size-6);ctx.fillStyle='#e8b75f';ctx.beginPath();ctx.arc(px+25,py+29,2,0,Math.PI*2);ctx.fill()}
    if(t==='T'){ctx.fillStyle='#6e4a38';ctx.beginPath();ctx.roundRect(px+3,py+5,46,40,6);ctx.fill();ctx.fillStyle='#7bb7ba';ctx.fillRect(px+8,py+9,36,25);ctx.fillStyle='#e8ffff';ctx.font='bold 8px sans-serif';ctx.fillText('AI NEWS',px+10,py+24)}
    if(t==='P'){ctx.fillStyle='#b96846';ctx.beginPath();ctx.roundRect(px+12,py+19,28,24,4);ctx.fill();ctx.fillStyle='#4f8e57';ctx.beginPath();ctx.arc(px+26,py+17,13,0,Math.PI*2);ctx.fill()}
    if(t==='H'){ctx.fillStyle='#5d9668';ctx.beginPath();ctx.roundRect(px+3,py+4,46,44,12);ctx.fill();ctx.fillStyle='#84b978';for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(px+14+i*12,py+17+(i%2)*10,7,0,Math.PI*2);ctx.fill()}ctx.fillStyle='#f5ffdd';ctx.font='bold 11px sans-serif';ctx.fillText('HIDE',px+12,py+39)}
    if(t==='F'){ctx.fillStyle='#677e73';ctx.beginPath();ctx.roundRect(px+6,py+5,40,42,5);ctx.fill();ctx.fillStyle='#f5f8e8';ctx.beginPath();ctx.roundRect(px+8,py+2,36,39,4);ctx.fill();ctx.fillStyle='#99afa2';ctx.fillRect(px+9,py+19,34,2);ctx.fillRect(px+13,py+7,3,8);ctx.fillRect(px+13,py+24,3,8);ctx.fillStyle='#d48349';ctx.font='bold 7px sans-serif';ctx.fillText('SNACKS',px+21,py+32)}
    if(t==='E'){ctx.fillStyle='#446e4a';ctx.beginPath();ctx.roundRect(px+4,py+4,44,44,7);ctx.fill();ctx.fillStyle='#fff6d5';ctx.font='bold 11px sans-serif';ctx.fillText('EXIT',px+12,py+29)}
  }));
  for(const item of state.ram.filter(r=>!r.taken)){const x=ox+item.x*size,y=oy+item.y*size;ctx.fillStyle='#fff0a1';ctx.beginPath();ctx.arc(x+26,y+25,21,0,Math.PI*2);ctx.fill();ctx.fillStyle='#314e3f';ctx.beginPath();ctx.roundRect(x+10,y+16,32,19,3);ctx.fill();ctx.fillStyle='#b9e77d';ctx.fillRect(x+13,y+19,26,12);ctx.fillStyle='#385c46';for(let i=0;i<3;i++)ctx.fillRect(x+16+i*7,y+22,4,6);ctx.fillStyle='#fff';ctx.font='bold 7px sans-serif';ctx.fillText('RAM',x+17,y+14)}
  for(const [actor,color,old] of [...residents.map(r=>[r,r.mode==='chase'?'#bd5c4c':r===state.resident?'#ad795f':'#7d7598',r===state.resident?previousState?.resident:previousState?.secondResident]),[state.player,state.hidden?'#83a988':'#2f6043',previousState?.player]]){
    const blend=Math.min(1,(performance.now()-changedAt)/180), ax=old?old.x+(actor.x-old.x)*blend:actor.x, ay=old?old.y+(actor.y-old.y)*blend:actor.y;
    const x=ox+ax*size+size/2,y=oy+ay*size+size/2;
    ctx.fillStyle='rgba(0,0,0,.18)';ctx.beginPath();ctx.ellipse(x,y+15,15,6,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x-13,y-4,26,20,8);ctx.fill();
    ctx.fillStyle=actor===state.player?'#e1b58f':'#e3b69b';ctx.beginPath();ctx.arc(x,y-7,9,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=actor===state.player?'#26332c':'#604b40';ctx.beginPath();ctx.arc(x,y-11,7,Math.PI,Math.PI*2);ctx.fill();
    if(actor.mode==='chase'){ctx.fillStyle='#9e3f32';ctx.font='bold 17px sans-serif';ctx.textAlign='center';ctx.fillText('!',x,y-19);ctx.textAlign='start'}
  }
  const chasing=residents.some(r=>r.mode==='chase');
  const loot=`${state.ram.filter(r=>r.taken).length} / ${state.ram.length}`;
  if(lootHud.textContent!==loot)lootHud.textContent=loot;
  energyHud.style.width=`${Math.max(0,Math.min(100,(state.stamina??15)/15*100))}%`;
  alertHud.classList.toggle('visible',chasing&&state.status==='playing');
  const heading=state.status==='won'?'Mission complete':state.status==='caught'?'Caught':chasing?'Spotted — run!':state.hidden?'Hidden':'Infiltration';
  const status=state.status==='won'?'Both RAM sticks recovered.':state.status==='caught'?'The resident caught you. Restart to try again.':`${state.ram.filter(r=>r.taken).length} / ${state.ram.length} RAM · Sprint ${Math.round((state.stamina??15)/15*100)}%${state.hidden?' · In cover':''}`;
  if(label.textContent!==heading)label.textContent=heading;
  if(message.textContent!==status)message.textContent=status;
}
async function update(){if(!ready||busy||!state||state.status!=='playing')return;busy=true;try{const result=await api('/api/game/step',{action:{mode:'realtime',direction,sprint}});setState(result.state);draw()}catch(e){message.textContent=e.message}finally{busy=false}}
const keys={ArrowUp:'up',w:'up',ArrowDown:'down',s:'down',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};
const held=new Set();function refresh(){direction=[...held].at(-1)??null}
document.addEventListener('keydown',e=>{if(e.key==='Shift'){sprint=true;e.preventDefault()}else if(keys[e.key]){held.add(keys[e.key]);refresh();e.preventDefault()}});
document.addEventListener('keyup',e=>{if(e.key==='Shift')sprint=false;else if(keys[e.key]){held.delete(keys[e.key]);refresh()}});
window.addEventListener('blur',()=>{held.clear();direction=null;sprint=false});
document.querySelectorAll('[data-move]').forEach(button=>{button.addEventListener('pointerdown',e=>{e.preventDefault();button.setPointerCapture(e.pointerId);held.add(button.dataset.move);refresh()});const release=()=>{held.delete(button.dataset.move);refresh()};button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release)});
const sprintButton=document.querySelector('#sprint');sprintButton.addEventListener('pointerdown',e=>{e.preventDefault();sprintButton.setPointerCapture(e.pointerId);sprint=true});['pointerup','pointercancel','lostpointercapture'].forEach(name=>sprintButton.addEventListener(name,()=>{sprint=false}));
document.querySelector('#restart').onclick=async()=>{if(busy)return;busy=true;try{const r=await api('/api/game/step',{action:'restart'});setState(r.state);await api('/api/game/step',{action:{mode:'realtime',direction:null,sprint:false}}).then(r=>{setState(r.state)});draw()}catch(e){message.textContent=e.message}finally{busy=false}};
try{try{await api('/api/demo/session',{})}catch(e){if(e.status!==402)throw e;throw new Error('Demo wallet has no pass. Buy one in the store first.')}const result=await api('/api/game/levels/house-01');level=result.level;state=result.state;const started=await api('/api/game/step',{action:{mode:'realtime',direction:null,sprint:false}});setState(started.state);ready=true;const animate=()=>{draw();requestAnimationFrame(animate)};requestAnimationFrame(animate);setInterval(update,200)}catch(e){label.textContent='Pass locked';message.textContent=e.message}
