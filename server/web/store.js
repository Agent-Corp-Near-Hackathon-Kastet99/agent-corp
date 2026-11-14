import {header,view,api,tnear,deployment} from './chain.js';
document.querySelector('#header').innerHTML=header('store');
const status=document.querySelector('#status'),buy=document.querySelector('#buy'),connect=document.querySelector('#connect'),disconnect=document.querySelector('#disconnect'),walletStatus=document.querySelector('#wallet-status'),demo=document.querySelector('#demo');
let player,dep;
async function refresh(){
  dep=await deployment();
  const c=await view('get_config');document.querySelector('#price').textContent=tnear(c.constraints.pass_price);
  try{player=await api('/api/player/me')}catch(e){if(e.status!==401)throw e;player=undefined}
  walletStatus.textContent=player?`Connected: ${player.account}`:'Use your NEAR testnet wallet. No real money.';
  connect.hidden=!!player;disconnect.hidden=!player;
  buy.disabled=!player||player.hasPass||c.paused;buy.textContent=player?.hasPass?'Your pass is active':'Buy with my wallet';
  status.textContent=player?.hasPass?'Your pass is active. Play with your own score.':player?'Ready. Review the amount in your wallet before signing.':'Connect and sign a login message to buy a pass.';
  demo.hidden=!dep.demoActions;
}
connect.onclick=async()=>{connect.disabled=true;status.textContent='Open MyNearWallet and approve the login message…';try{const {connectPlayer}=await import('./wallet.js');await connectPlayer();await refresh()}catch(e){status.textContent=e.message}finally{connect.disabled=false}};
disconnect.onclick=async()=>{try{const {disconnectPlayer}=await import('./wallet.js');await disconnectPlayer();await refresh()}catch(e){status.textContent=e.message}};
buy.onclick=async()=>{buy.disabled=true;status.textContent='Review and sign the testnet purchase in your wallet…';try{const {buyPlayerPass}=await import('./wallet.js');const tx=await buyPlayerPass();if(tx)sessionStorage.setItem('heistReceipt',`${dep.explorer}/txns/${tx}`);location.href='/game'}catch(e){status.textContent=e.message;buy.disabled=false}};
demo.onclick=async()=>{demo.disabled=true;try{await api('/api/player/logout',{});await api('/api/demo/session',{});location.href='/game'}catch(e){status.textContent=e.message;demo.disabled=false}};
try{await refresh()}catch(e){status.textContent=e.message}
document.querySelector('#quote').onclick=async()=>{const out=document.querySelector('#quote-result');out.textContent='Requesting mainnet preview…';try{const q=await api('/api/intents/quote?asset=usdc-near');out.textContent=q.available?`${(Number(q.inputAmount)/1e6).toFixed(6)} USDC for 1 wNEAR · preview only`:q.reason}catch(e){out.textContent=e.message}};
