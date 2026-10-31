/* IPL Auction engine — shared by browser (Solo, static) and Node server.
   No DOM here. All money in ₹ Cr, 1 decimal in the UI.
   Rules enforced in ONE place (validateBid): purse, squad max, overseas
   max, minimum funds to fill remaining slots, bid increments, no duplicates.
   AI never bids beyond its budget or a rule — validateBid is checked for
   AI bids exactly as for human bids.
   In the browser players.js loads first and provides poolFor/SET_ORDER.
   In Node, load them here so the engine is testable on its own. */
if(typeof poolFor==='undefined' && typeof require!=='undefined'){ try{ const d=require('./players.js'); global.poolFor=d.poolFor; global.SET_ORDER=d.SET_ORDER; }catch(e){} }
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function nextBid(current, base){
  if(!current) return base;
  if(current<1) return +(current+0.1).toFixed(1);
  if(current<2) return +(current+0.2).toFixed(1);
  if(current<5) return +(current+0.5).toFixed(1);
  return +(current+1).toFixed(1);
}
const PERSONALITIES = {
  aggressive:{label:'Aggressive bidder', aggression:1.20, valueBias:1.0, roleBoost:{}, agePref:'any'},
  analytical:{label:'Analytical bidder', aggression:1.00, valueBias:1.0, roleBoost:{}, agePref:'any'},
  star:{label:'Star-player hunter', aggression:1.00, valueBias:1.0, roleBoost:{}, agePref:'any'},
  budget:{label:'Budget-conscious bidder', aggression:0.80, valueBias:1.0, roleBoost:{}, agePref:'any'},
  rolefocused:{label:'Role-focused bidder', aggression:1.00, valueBias:1.0, roleBoost:{}, agePref:'any'},
  competitive:{label:'Competitive bidder', aggression:1.10, valueBias:1.0, roleBoost:{}, agePref:'any'},
  value:{label:'Value hunter', aggression:0.90, valueBias:1.0, roleBoost:{}, agePref:'any'},
  batting:{label:'Batting specialist', aggression:1.10, valueBias:1.0, roleBoost:{Batter:1.25,'Wicketkeeper':1.15}, agePref:'any'},
  bowling:{label:'Bowling specialist', aggression:1.10, valueBias:1.0, roleBoost:{'Fast Bowler':1.30,Spinner:1.25}, agePref:'any'},
  allrounder:{label:'All-rounder hunter', aggression:1.15, valueBias:1.0, roleBoost:{'All-rounder':1.35}, agePref:'any'},
  balanced:{label:'Balanced strategist', aggression:1.00, valueBias:1.0, roleBoost:{}, agePref:'any'},
  young:{label:'Young talent scout', aggression:1.00, valueBias:1.0, roleBoost:{}, agePref:'young'},
  tactical:{label:'Tactical competitor', aggression:1.05, valueBias:1.0, roleBoost:{}, agePref:'any'}
};
const AI_DEFAULTS = [
  {name:'Mumbai Meteors', manager:'Asha Rao', color:'#005da9', personality:'aggressive'},
  {name:'Delhi Dynamos', manager:'Vikram Mehta', color:'#1a7ae0', personality:'analytical'},
  {name:'Chennai Chargers', manager:'Priya Nair', color:'#f5d90a', personality:'star'},
  {name:'Kolkata Kings', manager:'Arjun Sen', color:'#6a1fa2', personality:'budget'},
  {name:'Jaipur Royals', manager:'Meera Joshi', color:'#e84a8a', personality:'rolefocused'},
  {name:'Hyderabad Hawks', manager:'Rahul Verma', color:'#ff7a00', personality:'competitive'},
  {name:'Bengaluru Blasters', manager:'Sneha Kulkarni', color:'#e01e2b', personality:'young'},
  {name:'Punjab Panthers', manager:'Karan Singh', color:'#c8102e', personality:'batting'},
  {name:'Gujarat Gladiators', manager:'Divya Patel', color:'#0a2a5b', personality:'bowling'}
];
function makeTeam(id, name, abbr, color, manager, isHuman, personality){
  return {id, name, abbr: abbr||name.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase(), color, manager, isHuman:!!isHuman, personality: personality||'balanced', purse:0, squad:[], retained:[]};
}
function roleCounts(team){ const c={}; team.squad.forEach(p=>c[p.role]=(c[p.role]||0)+1); return c; }
function overseasCount(team){ return team.squad.filter(p=>p.country!=='India').length; }
function wkCount(team){ return team.squad.filter(p=>p.role==='Wicketkeeper').length; }
function slotsLeft(team, rules){ return rules.squadMax - team.squad.length; }
function reserveNeeded(team, rules, state) {
  // Available bidding budget = remaining purse - minimum reserve for
  // REQUIRED squad positions only (up to squadMin, not squadMax).
  // Reserving all the way to squadMax would over-reserve and kill
  // realistic bidding for stars. The reserve adapts to what is left
  // in the pool: the cheapest bases for the slots still required,
  // plus a small buffer, so it is never unnecessarily large.
  const required = Math.max(0, rules.squadMin - team.squad.length - 1);
  if (required <= 0) return 0;
  let bases = [];
  if (state && state.queue) bases = state.queue.map(p => p.base).sort((a, b) => a - b);
  let reserve = 0;
  for (let i = 0; i < required; i++) reserve += (bases[i] !== undefined ? bases[i] : 0.5);
  reserve += required * 0.2; // small buffer for bid increments
  return +reserve.toFixed(1);
}
function validateBid(state, team, amount){
  const rules=state.rules;
  if(state.phase!=='bidding') return 'Auction is not in bidding phase';
  if(!state.current) return 'No player is currently on auction';
  if(amount <= state.current.bid) return `Bid must be higher than ₹${state.current.bid.toFixed(1)} Cr`;
  if(amount !== nextBid(state.current.bid, state.current.player.base) && amount < state.current.bid + 0.1) return 'Bid increment is too small';
  if(team.squad.length >= rules.squadMax) return `Squad limit reached (${rules.squadMax})`;
  if(state.current.player.country!=='India' && overseasCount(team) >= rules.overseasMax) return `Overseas limit reached (${rules.overseasMax})`;
  if(team.squad.some(p=>p.name===state.current.player.name)) return 'Player is already in this squad';
  if(state.sold.some(s=>s.player.name===state.current.player.name)) return 'Player has already been sold';
  // Budget + reserve: you may not spend money needed to fill remaining slots.
  const after = team.purse - amount;
  if(after < 0) return 'Bid is beyond the remaining purse';
  if(after < reserveNeeded(team, rules, state) && team.squad.length+1 < rules.squadMin) return `You must keep ₹${reserveNeeded(team, rules, state).toFixed(1)} Cr in reserve to fill the remaining required squad slots`;
  return null;
}
function teamNeed(team, rules){
  const c=roleCounts(team);
  return {
    wk: Math.max(0, 1 - wkCount(team)),
    batter: Math.max(0, 4 - (c['Batter']||0)),
    pace: Math.max(0, 3 - (c['Fast Bowler']||0)),
    spin: Math.max(0, 2 - (c['Spinner']||0)),
    allrounder: Math.max(0, 2 - (c['All-rounder']||0)),
    total: Math.max(0, rules.squadMin - team.squad.length)
  };
}
// Dynamic player valuation (rewritten 2026-10-28 — the old formula capped
// stars at ~₹7 Cr and is deleted, not just scaled up).
// 1) Core value from skill: interpolated, NOT linear. A 94-rated star is
//    worth far more than twice a 70-rated specialist, as in a real auction.
//    Guideline core values (before need/scarcity/personality):
//    skill 100 -> 25, 95 -> 20, 90 -> 15, 85 -> 11, 80 -> 8, 75 -> 5.5,
//    70 -> 3.8, 65 -> 2.5, 60 -> 1.5, 50 -> 0.6, 40 -> 0.3, 30 -> 0.2 Cr.
//    These are guidelines, not hard limits — need, scarcity, demand and
//    personality can push a war above them, and a low-demand player can
//    sell below them.
// 2) Tier: Uncapped players are discounted (potential, not proven);
//    Young players slightly discounted; Veterans/Established at full value.
// 3) Team need: a player filling a missing WK / pace / spin / all-rounder
//    slot is worth much more to THAT team than to a team already covered.
// 4) Scarcity: few players left in this role in the remaining pool.
// 5) Demand / competition: how many other teams still need this role and
//    can still afford the current bid.
// 6) Budget availability: a rich team (high purse per remaining slot)
//    can pay more; a tight team scales down, never below its reserve.
function coreSkillValue(skill) {
  const pts = [[30,0.2],[40,0.3],[50,0.6],[60,1.5],[65,2.5],[70,3.8],[75,5.5],[80,7],[85,10],[90,14],[95,19],[100,24]];
  if (skill <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (skill <= pts[i][0]) {
      const [x0,y0] = pts[i-1], [x1,y1] = pts[i];
      return y0 + (y1 - y0) * (skill - x0) / (x1 - x0);
    }
  }
  return 25;
}
function competingTeams(state, team, player, amount) {
  // Other teams that still need this role and can afford this bid
  return state.teams.filter(t => t.id !== team.id && t.purse >= amount &&
    (player.role === 'Wicketkeeper' ? wkCount(t) === 0 :
     player.role === 'Batter' ? (roleCounts(t)['Batter']||0) < 4 :
     player.role === 'Fast Bowler' ? (roleCounts(t)['Fast Bowler']||0) < 3 :
     player.role === 'Spinner' ? (roleCounts(t)['Spinner']||0) < 2 :
     player.role === 'All-rounder' ? (roleCounts(t)['All-rounder']||0) < 2 : true)).length;
}
function targetPrice(state, team, player) {
  const pers = PERSONALITIES[team.personality] || PERSONALITIES.balanced;
  const skill = player.role === 'All-rounder' ? (player.bat * 0.55 + player.bowl * 0.45)
    : (player.role === 'Wicketkeeper' ? Math.max(player.bat, 60) : Math.max(player.bat, player.bowl));
  let value = coreSkillValue(skill);
  // Tier / reputation / international experience
  if (player.tier === 'Uncapped') value *= 0.30;
  else if (player.tier === 'Young') value *= 0.85;
  // Personality base multiplier
  value *= pers.aggression;
  const boost = (pers.roleBoost[player.role] || 1); value *= boost;
  if (pers.agePref === 'young' && (player.tier === 'Young' || player.tier === 'Uncapped')) value *= 1.25;
  if (pers.agePref === 'young' && player.tier === 'Veteran') value *= 0.8;
  // Star hunter: pay a premium only for elite players, not for everyone
  if (team.personality === 'star' && skill >= 88) value *= 1.25;
  if (team.personality === 'star' && skill < 80) value *= 0.90;
  // Team-specific need (role-focused teams feel this most)
  const need = teamNeed(team, state.rules);
  let needMult = 1;
  if (player.role === 'Wicketkeeper' && need.wk > 0) needMult = 1.35;
  else if (player.role === 'Batter' && need.batter > 0) needMult = 1.15;
  else if (player.role === 'Fast Bowler' && need.pace > 0) needMult = 1.15;
  else if (player.role === 'Spinner' && need.spin > 0) needMult = 1.15;
  else if (player.role === 'All-rounder' && need.allrounder > 0) needMult = 1.20;
  if (team.personality === 'rolefocused' && needMult > 1) needMult = 1 + (needMult - 1) * 1.3;
  value *= needMult;
  // Scarcity: few left in this role
  const leftInRole = state.queue.filter(p => p.role === player.role).length + 1;
  const totalLeft = Math.max(1, state.queue.length + 1);
  if (leftInRole <= 3) value *= 1.10;
  else if (leftInRole / totalLeft < 0.10) value *= 1.06;
  // Demand / competition: other teams needing this role push the price up,
  // especially for competitive teams
  const rivals = competingTeams(state, team, player, state.current ? state.current.bid : player.base);
  let compMult = 1 + Math.min(3, rivals) * 0.06;
  if (team.personality === 'competitive') compMult = 1 + Math.min(3, rivals) * 0.12;
  value *= compMult;
  // Budget availability: purse per remaining slot
  const slots = Math.max(1, slotsLeft(team, state.rules));
  const avgAffordable = team.purse / slots;
  if (avgAffordable > 10) value *= 1.10;
  else if (avgAffordable > 6) value *= 1.05;
  else if (avgAffordable < 3) value *= 0.85;
  else if (avgAffordable < 1.5) value *= 0.70;
  // Never value a player below base, and never above what the team can
  // actually pay after its required reserve (available bidding budget)
  // Desperation: if the team is still below the minimum squad size and
  // the pool is nearly gone, it must fill slots — raise the target so it
  // does not finish with 3 players and ₹89 Cr unspent.
  const toMin = Math.max(0, state.rules.squadMin - team.squad.length);
  if (toMin > 0 && state.queue.length <= toMin * 3) value *= 1.35;
  const available = team.purse - reserveNeeded(team, state.rules, state);
  value = Math.min(value, Math.max(player.base, available));
  return +Math.max(player.base, value).toFixed(1);
}
function aiShouldBid(state, team, player, amount) {
  if (team.isHuman) return false;
  const err = validateBid(state, team, amount);
  if (err) return false;
  const target = targetPrice(state, team, player);
  if (amount > target) return false;
  // Bidding war behaviour is driven by headroom (target - amount), not
  // by a fixed random chance: far below value, almost always bid;
  // near the ceiling, bid less often — analytical teams stop first,
  // aggressive / competitive teams fight on. This gives early
  // withdrawals AND long wars, from the same formula.
  const headroom = (target - amount) / Math.max(1, target);
  let chance = 0.30 + headroom * 1.10;
  if (team.personality === 'aggressive') chance += 0.20;
  if (team.personality === 'star' && target >= 12) chance += 0.15;
  if (team.personality === 'budget') chance -= 0.20;
  if (team.personality === 'analytical') chance -= 0.10;
  if (team.personality === 'competitive') {
    const leader = state.current && state.current.leader ? state.teams.find(t => t.id === state.current.leader) : null;
    if (leader && competingTeams(state, team, player, amount) >= 2) chance += 0.20;
  }
  if (team.personality === 'rolefocused') {
    const need = teamNeed(team, state.rules);
    if ((player.role === 'Wicketkeeper' && need.wk > 0) || (player.role === 'Fast Bowler' && need.pace > 0) || (player.role === 'Spinner' && need.spin > 0)) chance += 0.20;
  }
  chance = Math.max(0.05, Math.min(0.97, chance));
  return Math.random() < chance;
}
function newAuction(config){
  const rules={purse:config.purse||120, squadMin:config.squadMin||11, squadMax:config.squadMax||15, overseasMax:config.overseasMax||6, timer:config.timer||15, poolSet:config.poolSet||'stars', format:config.format||'mega'};
  const pool = poolFor(rules.poolSet);
  // Order: set order, marquee first, then shuffled within set for variety (seeded by date in UI, random here)
  const ordered=[];
  SET_ORDER.forEach(set=>{ const arr=pool.filter(p=>p.set===set); for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } ordered.push(...arr); });
  const teams=[];
  config.humans.forEach((h,i)=>{ const t=makeTeam('human'+i, h.teamName, h.abbr, h.color, h.manager, true, null); t.purse=rules.purse; teams.push(t); });
  let aiIdx=0;
  while(teams.length<10){
    const def = config.aiTeams && config.aiTeams[aiIdx] ? config.aiTeams[aiIdx] : AI_DEFAULTS[aiIdx%AI_DEFAULTS.length];
    // Skip AI name duplicates with humans
    if(teams.some(t=>t.name.toLowerCase()===def.name.toLowerCase())){ aiIdx++; continue; }
    const t=makeTeam('ai'+aiIdx, def.name, def.abbr, def.color, def.manager, false, def.personality);
    t.purse=rules.purse; teams.push(t); aiIdx++;
    if(aiIdx>30) break;
  }
  // Mini auction retentions: humans/AI in config.retentions {teamId:[playerNames]}
  if(rules.format==='mini' && config.retentions){
    teams.forEach(t=>{
      const names=config.retentions[t.id]||[];
      names.slice(0,4).forEach(n=>{
        const p=pool.find(x=>x.name===n); if(!p) return;
        t.squad.push({...p, price:p.base}); t.retained.push(p.name); t.purse-=p.base;
        const qi=ordered.findIndex(x=>x.name===n); if(qi>=0) ordered.splice(qi,1);
      });
    });
  }
  return {
    rules, teams, queue:ordered, sold:[], unsold:[], history:[],
    current:null, timer:0, phase:'setup', paused:false, hostId: teams[0].id,
    round:'main', unsoldRoundDone:false, winner:null, analysis:null,
    chat:[], log:[]
  };
}
function startNextPlayer(state){
  if(state.queue.length===0){
    if(state.unsold.length>0 && !state.unsoldRoundDone){
      state.round='unsold'; state.unsoldRoundDone=true;
      state.queue=[...state.unsold]; state.unsold=[];
      state.log.push('Final unsold round: unsold players return at their base price.');
    } else {
      state.phase='finished'; state.current=null;
      state.analysis=analyseAll(state); state.winner=pickWinner(state.analysis);
      return null;
    }
  }
  const player=state.queue.shift();
  state.current={player, bid:0, leader:null, bids:[]};
  state.timer=state.rules.timer; state.phase='bidding'; state.paused=false;
  state.log.push(`Auctioneer: ${player.name} — ${player.role}, ${player.country}. Base price ₹${player.base.toFixed(1)} Cr.`);
  return state.current;
}
function placeBid(state, teamId, amount){
  const team=state.teams.find(t=>t.id===teamId); if(!team) return {ok:false, why:'Team not found'};
  const err=validateBid(state, team, amount);
  if(err) return {ok:false, why:err};
  state.current.bid=amount; state.current.leader=teamId;
  state.current.bids.push({team:team.name, teamId, amount, at:Date.now()});
  state.timer=state.rules.timer; // countdown resets on a valid bid
  state.log.push(`${team.name} bid ₹${amount.toFixed(1)} Cr for ${state.current.player.name}.`);
  state.history.push({player:state.current.player.name, team:team.name, amount, type:'bid'});
  return {ok:true, team, amount};
}
function finishCurrentPlayer(state){
  const cur=state.current; if(!cur) return null;
  if(cur.leader){
    const team=state.teams.find(t=>t.id===cur.leader);
    team.squad.push({...cur.player, price:cur.bid}); team.purse-=cur.bid;
    state.sold.push({player:cur.player, team:team.name, teamId:team.id, price:cur.bid});
    state.log.push(`SOLD! ${cur.player.name} to ${team.name} for ₹${cur.bid.toFixed(1)} Cr.`);
    state.history.push({player:cur.player.name, team:team.name, amount:cur.bid, type:'sold'});
  } else {
    state.unsold.push(cur.player);
    state.log.push(`Unsold: no bid for ${cur.player.name} at ₹${cur.player.base.toFixed(1)} Cr.`);
    state.history.push({player:cur.player.name, team:'—', amount:0, type:'unsold'});
  }
  state.current=null;
  return startNextPlayer(state);
}
function tick(state, seconds){
  if(state.phase!=='bidding' || state.paused) return null;
  state.timer-=seconds;
  if(state.timer<=5 && state.timer>2) state.log.push('Going once…');
  if(state.timer<=2 && state.timer>0) state.log.push('Going twice…');
  if(state.timer<=0){ return finishCurrentPlayer(state); }
  return null;
}
/* ---- Analysis + Winner (transparent, statistics-based) ---- */
function analyseTeam(state, team){
  const s=team.squad;
  const byRole=roleCounts(team);
  const batters=[...s].sort((a,b)=>b.bat-a.bat);
  const bowlers=[...s].sort((a,b)=>b.bowl-a.bowl);
  const topBat=batters.slice(0,7);
  const topBowl=bowlers.slice(0,5);
  const batting = topBat.length? topBat.reduce((a,p)=>a+p.bat,0)/topBat.length : 0;
  const bowling = topBowl.length? topBowl.reduce((a,p)=>a+p.bowl,0)/topBowl.length : 0;
  const pace=s.filter(p=>p.role==='Fast Bowler').length, spin=s.filter(p=>p.role==='Spinner').length;
  const allr=s.filter(p=>p.role==='All-rounder').length;
  const wk=wkCount(team);
  const wkQuality = wk? Math.max(...s.filter(p=>p.role==='Wicketkeeper').map(p=>p.bat)) : 0;
  const finishers=s.filter(p=>p.role==='All-rounder'||p.role==='Batter').slice(-3);
  const finishing = finishers.length? finishers.reduce((a,p)=>a+p.bat,0)/finishers.length : 0;
  const spent = state.rules.purse - team.purse;
  const avgPrice = s.length? spent/s.length : 0;
  const valueScore = s.length? clamp( (s.reduce((a,p)=>a+Math.max(p.bat,p.bowl),0)/s.length) / Math.max(1,avgPrice) * 10, 0, 100) : 0;
  // Balance: penalise missing pace, spin, WK, or all-rounders
  let balance=100;
  if(pace===0) balance-=25; if(spin===0) balance-=20; if(wk===0) balance-=30; if(allr===0) balance-=15;
  if(s.length < state.rules.squadMin) balance-= (state.rules.squadMin - s.length)*8;
  balance=clamp(balance,0,100);
  const wkScore = wk===0?0:clamp(wkQuality,0,100);
  // Overall: batting 35%, bowling 35%, balance 10%, WK/depth 10%, value 10%
  const overall = +(batting*0.35 + bowling*0.35 + balance*0.10 + wkScore*0.10 + valueScore*0.10).toFixed(1);
  const bestValue = s.length? [...s].sort((a,b)=> (Math.max(a.bat,a.bowl)/Math.max(0.1,a.price)) - (Math.max(b.bat,b.bowl)/Math.max(0.1,b.price)))[0] : null;
  const mostExpensive = s.length? [...s].sort((a,b)=>b.price-a.price)[0] : null;
  const weak=[];
  if(wk===0) weak.push('No wicketkeeper');
  if(pace<2) weak.push('Thin pace attack');
  if(spin<1) weak.push('No specialist spinner');
  if(allr<1) weak.push('No all-rounder depth');
  if(batters.length<5) weak.push('Thin batting depth');
  if(s.length < state.rules.squadMin) weak.push(`Squad below minimum (${s.length}/${state.rules.squadMin})`);
  // Recommended XI: 1 WK, 5 batters, 2 all-rounders, 3 bowlers (pace+spin), overseas ≤4
  const xi=[]; const used=new Set();
  const pick=(filter, n)=>{ [...s].filter(p=>!used.has(p.name)&&filter(p)).sort((a,b)=> (Math.max(b.bat,b.bowl)-Math.max(a.bat,a.bowl))).slice(0,n).forEach(p=>{xi.push(p); used.add(p.name);}); };
  pick(p=>p.role==='Wicketkeeper',1);
  pick(p=>p.role==='Batter',5);
  pick(p=>p.role==='All-rounder',2);
  pick(p=>p.role==='Fast Bowler'||p.role==='Spinner',3);
  // Fill to 11 with best remaining, respecting overseas ≤4 in XI
  [...s].filter(p=>!used.has(p.name)).sort((a,b)=>Math.max(b.bat,b.bowl)-Math.max(a.bat,a.bowl)).forEach(p=>{
    if(xi.length>=11) return;
    if(p.country!=='India' && xi.filter(x=>x.country!=='India').length>=4) return;
    xi.push(p); used.add(p.name);
  });
  const battingOrder=[...xi].sort((a,b)=>b.bat-a.bat);
  const bowlingCombo=[...xi].filter(p=>p.bowl>=60).sort((a,b)=>b.bowl-a.bowl).slice(0,5);
  return {team:team.name, teamId:team.id, color:team.color, isHuman:team.isHuman, manager:team.manager,
    squadSize:s.length, spent:+spent.toFixed(1), purseLeft:+team.purse.toFixed(1), overseas:overseasCount(team),
    batting:+batting.toFixed(1), bowling:+bowling.toFixed(1), pace, spin, allrounders:allr, wk, wkQuality,
    finishing:+finishing.toFixed(1), balance:+balance.toFixed(1), value:+valueScore.toFixed(1), overall,
    bestValue: bestValue?{name:bestValue.name, price:bestValue.price, rating:Math.max(bestValue.bat,bestValue.bowl)}:null,
    mostExpensive: mostExpensive?{name:mostExpensive.name, price:mostExpensive.price}:null,
    weak, xi: xi.map(p=>p.name), battingOrder: battingOrder.map(p=>p.name), bowlingCombo: bowlingCombo.map(p=>p.name),
    squad: s.map(p=>({name:p.name, role:p.role, country:p.country, price:p.price, bat:p.bat, bowl:p.bowl}))
  };
}
function analyseAll(state){ return state.teams.map(t=>analyseTeam(state,t)); }
function pickWinner(analysis){
  // Winner = highest overall. Tie-breaks, in order: bowling, batting, lower spend (budget efficiency), larger squad.
  const sorted=[...analysis].sort((a,b)=>{
    if(b.overall!==a.overall) return b.overall-a.overall;
    if(b.bowling!==a.bowling) return b.bowling-a.bowling;
    if(b.batting!==a.batting) return b.batting-a.batting;
    if(a.spent!==b.spent) return a.spent-b.spent;
    return b.squadSize-a.squadSize;
  });
  const w=sorted[0];
  const cats={batting:sorted.reduce((m,x)=>x.batting>m.batting?x:m), bowling:sorted.reduce((m,x)=>x.bowling>m.bowling?x:m), value:sorted.reduce((m,x)=>x.value>m.value?x:m), balance:sorted.reduce((m,x)=>x.balance>m.balance?x:m)};
  return {winner:w, rankings:sorted, categoryLeaders:cats,
    reason:`${w.team} wins on overall squad strength (${w.overall}/100): batting ${w.batting}, bowling ${w.bowling}, balance ${w.balance}, wicketkeeping ${w.wkQuality}, value ${w.value}. Tie-breaks are bowling, then batting, then lower spend.`};
}
function auctioneerLine(state, kind){
  const lines={
    intro:['The auctioneer calls the next name…','Up next, a player every team will want…','Here comes the next name from the auction list…'],
    bid:['And we have a bid!','The bidding is heating up!','A new highest bid on the board!'],
    sold:['Sold! A fine addition to that squad.','Sold — the gavel comes down!','Sold, and the room applauds.'],
    unsold:['No takers this time — unsold.','The gavel falls with no bid — unsold.','Unsold, and we move on.']
  };
  const arr=lines[kind]||lines.intro; return arr[Math.floor(Math.random()*arr.length)];
}
if(typeof module!=='undefined'){ module.exports={clamp,nextBid,PERSONALITIES,AI_DEFAULTS,makeTeam,roleCounts,overseasCount,wkCount,slotsLeft,reserveNeeded,validateBid,teamNeed,coreSkillValue,competingTeams,targetPrice,aiShouldBid,newAuction,startNextPlayer,placeBid,finishCurrentPlayer,tick,analyseTeam,analyseAll,pickWinner,auctioneerLine}; }

/* ---- 5-credit star selection (multiplayer mega auction, 2026-10-31) ----
   Credits are SEPARATE from the main auction purse.
   capped Indian = 3 credits, overseas = 1, uncapped Indian = 1. Total 5.
   Category is a GAME classification (see note in players.js / README):
   overseas = country != India; uncapped = India + (Uncapped set/tier, or
   Young + base <= 0.5); otherwise capped. It is NOT claimed to be the
   official BCCI uncapped list. */
const STAR_CREDITS = {capped:3, overseas:1, uncapped:1};
function starCategory(player){
  if(player.country !== 'India') return 'overseas';
  if(player.set === 'Uncapped' || player.tier === 'Uncapped') return 'uncapped';
  if(player.tier === 'Young' && player.base <= 0.5) return 'uncapped';
  return 'capped';
}
function starCreditsUsed(team){
  return (team.stars||[]).reduce((a,p)=>a+STAR_CREDITS[starCategory(p)],0);
}
function validateStarSelection(room, team, player){
  if(room.phase !== 'stars') return 'Star selection is not open';
  if(team.confirmedStars) return 'Your selections are already confirmed and locked';
  const cat = starCategory(player);
  if((team.stars||[]).some(p=>p.name===player.name)) return 'You already selected this player';
  if((team.stars||[]).some(p=>starCategory(p)===cat)) return `You already have a ${cat} star player (one per category)`;
  if(room.teams.some(t=> (t.stars||[]).some(p=>p.name===player.name))) return 'This player was already selected by the other team';
  if(room.teams.some(t=> t.squad.some(p=>p.name===player.name))) return 'This player is already in a squad';
  if(starCreditsUsed(team) + STAR_CREDITS[cat] > 5) return 'Not enough star credits (you have 5 total)';
  if(!room.pool.some(p=>p.name===player.name)) return 'This player is not in the available pool';
  return null;
}
function analyseWithPrediction(state, team){
  const a = analyseTeam(state, team);
  const bestBat = team.squad.length ? [...team.squad].sort((x,y)=>y.bat-x.bat)[0] : null;
  const bestBowl = team.squad.length ? [...team.squad].sort((x,y)=>y.bowl-x.bowl)[0] : null;
  const bestAR = team.squad.filter(p=>p.role==='All-rounder').sort((x,y)=>(y.bat+y.bowl)-(x.bat+x.bowl))[0] || null;
  const bestOver = team.squad.filter(p=>p.country!=='India').sort((x,y)=>Math.max(y.bat,y.bowl)-Math.max(x.bat,x.bowl))[0] || null;
  return {...a, bestBat: bestBat?bestBat.name:null, bestBowl: bestBowl?bestBowl.name:null, bestAR: bestAR?bestAR.name:null, bestOverseas: bestOver?bestOver.name:null,
    strongest: a.batting>=a.bowling?'Batting':'Bowling', weakest: a.batting<a.bowling?'Batting':'Bowling'};
}
function predictWinner(analyses){
  // Transparent: overall difference -> win probability via logistic curve.
  // This is an ESTIMATE, not a guaranteed result. Formula is shown in UI.
  const s=[...analyses].sort((a,b)=>b.overall-a.overall);
  if(s.length<2) return null;
  const diff = s[0].overall - s[1].overall;
  const prob = 1/(1+Math.exp(-diff/8));
  return {winner:s[0], runnerUp:s[1], diff:+diff.toFixed(1), prob:+prob.toFixed(2), probPct:Math.round(prob*100),
    explanation:`${s[0].team} leads on overall squad score (${s[0].overall} vs ${s[1].overall}, difference ${diff.toFixed(1)}). Win probability is estimated as 1 / (1 + exp(-difference / 8)) = ${Math.round(prob*100)}% for ${s[0].team} and ${100-Math.round(prob*100)}% for ${s[1].team}. This is a prediction from squad ratings, not a guaranteed match result.`};
}
if(typeof module!=='undefined'){ module.exports.STAR_CREDITS=STAR_CREDITS; module.exports.starCategory=starCategory; module.exports.starCreditsUsed=starCreditsUsed; module.exports.validateStarSelection=validateStarSelection; module.exports.analyseWithPrediction=analyseWithPrediction; module.exports.predictWinner=predictWinner; }
