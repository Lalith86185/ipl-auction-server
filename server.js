// IPL Mega Auction — authoritative multiplayer server (Node + ws)
// Run:  npm install && node server.js   (PORT env, default 8080)
// Frontend: index.html in this folder, or any static host. Set the server
// URL on the home screen (default ws://localhost:8080, on Render: wss://<your-service>.onrender.com).
//
// SERVER OWNS EVERYTHING: room codes, star selections, current player,
// highest bid, leader, countdown (server timer), budgets, squads, sold/
// unsold, history, analysis. Clients send only intents. Messages are
// processed sequentially (Node is single-threaded), so simultaneous bids
// and star picks are decided in arrival order — first valid wins, the
// other gets a rejection. No bid, pick or purchase is trusted from a client.
//
// Up to 10 human teams per room (4-digit code). Star selection starts
// when the host clicks Start, after at least 2 teams have joined.
// PERSISTENCE: rooms are saved to data/rooms.json after every change
// (atomic: write temp file, then rename). This is the multiplayer
// database — NOT localStorage. On server restart, rooms reload.
// Refresh/reconnect: a client rejoins with {code, teamName} and gets the
// full state. If a player disconnects, the timer PAUSES and the auction
// resumes when they return. If the host disconnects, the other player
// becomes host. If both disconnect, the room persists and can be rejoined.
//
// FREE HOSTING: see DEPLOY.md. Render free tier spins down after ~15 min
// idle (first request is slow) — that is a Render limit, not a bug.
const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const { PLAYERS, poolFor } = require('./js/players.js');
const E = require('./js/engine.js');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function saveRooms(rooms) {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...rooms.values()].map(r => serializeRoom(r)), null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) { console.error('save failed', e.message); }
}
function serializeRoom(room) {
  const { interval, sockets, ...rest } = room;
  // sockets are not serializable; teams carry disconnected flags
  return { ...rest, sockets: undefined, interval: undefined };
}
function loadRooms() {
  const rooms = new Map();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const r of arr) {
        if (!r || !r.code) continue;
        r.sockets = [];
        rooms.set(r.code, r);
      }
    }
  } catch (e) { console.error('load failed', e.message); }
  return rooms;
}
const rooms = loadRooms();

function genCode() {
  for (let i = 0; i < 100; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return String(Math.floor(1000 + Math.random() * 9000)) + String(Math.floor(Math.random() * 10));
}
function send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
function broadcast(room, o) { for (const s of room.sockets) send(s, o); }
function publicState(room) {
  return {
    code: room.code, phase: room.phase, config: room.config,
    teams: room.teams.map(t => ({ ...t, disconnected: !!t.disconnected })),
    pool: room.pool, queue: room.queue.slice(0, 8),
    current: room.current, timerLeft: room.timerLeft, paused: room.paused, pauseReason: room.pauseReason,
    sold: room.sold, unsold: room.unsold, history: room.history.slice(-200),
    chat: room.chat.slice(-100), log: room.log.slice(-40),
    analysis: room.analysis, winner: room.winner, hostTeamId: room.hostTeamId,
    serverTime: Date.now()
  };
}
function pushLog(room, text) { room.log.push(text); if (room.log.length > 100) room.log.shift(); }
function money(x) { return '₹' + Number(x).toFixed(1) + ' Cr'; }


const AI_DEFS = [
  { name: 'Mumbai Meteors', abbr: 'MM', color: '#005da9', personality: 'aggressive' },
  { name: 'Delhi Dynamos', abbr: 'DD', color: '#1a7ae0', personality: 'analytical' },
  { name: 'Chennai Chargers', abbr: 'CC', color: '#f5d90a', personality: 'star' },
  { name: 'Kolkata Kings', abbr: 'KK', color: '#6a1fa2', personality: 'budget' },
  { name: 'Jaipur Royals', abbr: 'JR', color: '#e84a8a', personality: 'rolefocused' },
  { name: 'Hyderabad Hawks', abbr: 'HH', color: '#ff7a00', personality: 'competitive' },
  { name: 'Bengaluru Blasters', abbr: 'BB', color: '#e01e2b', personality: 'young' },
  { name: 'Punjab Panthers', abbr: 'PP', color: '#c8102e', personality: 'batting' },
  { name: 'Gujarat Gladiators', abbr: 'GG', color: '#0a2a5b', personality: 'bowling' },
];
function addAITeams(room) {
  // Fill the room up to maxTeams with AI teams. AI teams pick stars
  // automatically (best available in each category, no duplicates) and
  // are already confirmed, so humans only need to confirm their own.
  const maxT = room.config.maxTeams || 10;
  const usedNames = new Set(room.teams.map(t => t.name));
  const takenPlayers = new Set();
  room.teams.forEach(t => (t.stars || []).forEach(p => takenPlayers.add(p.name)));
  let idx = 0;
  while (room.teams.length < maxT && idx < AI_DEFS.length) {
    const def = AI_DEFS[idx++];
    if (usedNames.has(def.name)) continue;
    const team = {
      id: 'ai_' + Date.now() + '_' + idx, manager: 'AI Manager', name: def.name, abbr: def.abbr,
      color: def.color, logo: '', isHuman: false, personality: def.personality,
      purse: room.config.purse, squad: [], stars: [], confirmedStars: true, disconnected: false
    };
    // AI stars are NOT picked here — humans pick first. AI picks are
    // assigned at auction start (in star-confirm) from whatever is left,
    // so AI can never steal Kohli from a human who wanted him.
    room.teams.push(team);
    pushLog(room, `${team.name} (AI) joined to fill the room.`);
  }
}
function aiBidTick(room) {
  // At most one AI bid per server tick (1 second). Uses the engine's
  // targetPrice / aiShouldBid, then the server's own validateBid gate,
  // so AI can never overspend or break squad rules.
  if (room.phase !== 'auction' || room.paused || !room.current) return;
  const ais = room.teams.filter(t => !t.isHuman && !t.disconnected);
  if (!ais.length) return;
  // Shuffle so no AI always wins the tick
  for (let i = ais.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ais[i], ais[j]] = [ais[j], ais[i]]; }
  const cur = room.current;
  const nextAmt = cur.bid === 0 ? cur.player.base : E.nextBid(cur.bid, cur.player.base);
  // Engine's aiShouldBid expects phase='bidding', current={player,bid},
  // and sold entries as {player:{name}} — build that shape, otherwise
  // its internal validateBid always fails and AI never bids.
  const fakeState = { phase: 'bidding', rules: room.config, teams: room.teams, queue: room.queue, pool: room.pool,
    current: { player: cur.player, bid: cur.bid, leader: cur.leader },
    sold: room.sold.map(x => ({ player: { name: x.player } })) };
  for (const ai of ais) {
    if (cur.leader === ai.id) continue;
    if (validateBid(room, ai, nextAmt)) continue;
    let should = false;
    try { should = E.aiShouldBid(fakeState, ai, cur.player, nextAmt); } catch (e) { should = false; }
    if (!should) continue;
    cur.bid = nextAmt; cur.leader = ai.id; cur.leaderName = ai.name;
    cur.bids.push({ team: ai.name, teamId: ai.id, amount: nextAmt });
    room.timerLeft = room.config.timer;
    room.history.push({ player: cur.player.name, team: ai.name, amount: nextAmt, type: 'bid' });
    pushLog(room, `${ai.name} (AI) bid ${money(nextAmt)} for ${cur.player.name}.`);
    break; // one AI bid per tick
  }
}

function newRoom(config, host) {
  const code = genCode();
  const rules = {
    purse: config.purse || 120, squadMin: config.squadMin || 11, squadMax: config.squadMax || 15,
    overseasMax: config.overseasMax || 6, timer: config.timer || 15,
    poolSet: config.poolSet || 'all', poolLimit: config.poolLimit || 0,
    starPurseDeduction: config.starPurseDeduction || 'none',
    maxTeams: config.maxTeams || 10,
    solo: !!config.solo
  };
  // Star selection needs the FULL player list (including uncapped players
  // who are not in a 'stars only' auction pool). The auction queue is
  // filtered by poolSet at confirm time, below.
  let pool = PLAYERS.slice();
  // Order: set order, shuffled within set (deterministic enough for a game)
  const ordered = [];
  const sets = ['Marquee', 'Batter', 'Wicketkeeper', 'All-rounder', 'Fast Bowler', 'Spinner', 'Uncapped'];
  for (const set of sets) {
    const arr = pool.filter(p => p.set === set);
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    ordered.push(...arr);
  }
  const room = {
    code, config: rules, phase: 'lobby', hostTeamId: null,
    teams: [], pool: ordered.map(p => ({ ...p, status: 'AVAILABLE', owner: null, stats: null })),
    queue: [], current: null, timerLeft: 0, paused: false, pauseReason: null,
    sold: [], unsold: [], history: [], chat: [], log: [], analysis: null, winner: null,
    sockets: [], recentBids: []
  };
  const team = addTeam(room, host);
  room.hostTeamId = team.id;
  pushLog(room, `Room ${code} created by ${host.teamName}. Waiting for a second player.`);
  rooms.set(code, room);
  return room;
}
function addTeam(room, human) {
  const team = {
    id: 'team_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    manager: human.manager || 'Manager', name: human.teamName, abbr: (human.abbr || human.teamName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().slice(0, 3)),
    color: human.color || '#0b4f8a', logo: human.logo || '', isHuman: true,
    purse: room.config.purse, squad: [], stars: [], confirmedStars: false, disconnected: false
  };
  room.teams.push(team);
  return team;
}
function findTeam(room, teamName) {
  return room.teams.find(t => t.name.toLowerCase() === String(teamName || '').toLowerCase());
}
function startNextPlayer(room) {
  if (room.queue.length === 0) {
    if (room.unsold.length > 0 && !room.unsoldRoundDone) {
      room.unsoldRoundDone = true;
      room.queue = room.unsold.map(u => u.player); room.unsold = [];
      pushLog(room, 'Final unsold round: unsold players return at base price.');
    } else {
      return finishAuction(room);
    }
  }
  const player = room.queue.shift();
  player.status = 'LIVE_AUCTION';
  room.current = { player, bid: 0, leader: null, leaderName: null, bids: [] };
  room.timerLeft = room.config.timer; room.phase = 'auction'; room.paused = false; room.pauseReason = null;
  pushLog(room, `Auctioneer: ${player.name} — ${player.role}, ${player.country}. Base price ${money(player.base)}.`);
  return true;
}
function finishCurrentPlayer(room) {
  const cur = room.current; if (!cur) return;
  const player = cur.player;
  if (cur.leader) {
    const team = room.teams.find(t => t.id === cur.leader);
    const price = cur.bid;
    team.squad.push({ ...player, price, status: 'SOLD', owner: team.name, boughtVia: 'auction' });
    team.purse = +(team.purse - price).toFixed(1);
    player.status = 'SOLD'; player.owner = team.name;
    room.sold.push({ player: player.name, team: team.name, price, base: player.base });
    room.history.push({ player: player.name, team: team.name, amount: price, base: player.base, type: 'sold' });
    pushLog(room, `SOLD! ${player.name} to ${team.name} for ${money(price)}.`);
  } else {
    player.status = 'UNSOLD';
    room.unsold.push({ player });
    room.history.push({ player: player.name, team: '—', amount: 0, base: player.base, type: 'unsold' });
    pushLog(room, `Unsold: no bid for ${player.name} at ${money(player.base)}.`);
  }
  room.current = null;
  startNextPlayer(room);
}
function finishAuction(room) {
  room.phase = 'finished'; room.current = null;
  const fakeState = { rules: room.config, teams: room.teams };
  const analyses = room.teams.map(t => E.analyseWithPrediction(fakeState, t));
  room.analysis = analyses;
  room.winner = E.predictWinner(analyses);
  pushLog(room, `Auction finished. Predicted winner: ${room.winner ? room.winner.winner.team : '—'}.`);
}
function tickRoom(room) {
  if (room.phase !== 'auction' || room.paused || !room.current) return;
  // Pause if any human is disconnected
  if (room.teams.some(t => t.disconnected)) {
    room.paused = true; room.pauseReason = 'A player disconnected — auction paused until they reconnect.';
    broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
  }
  aiBidTick(room);
  room.timerLeft -= 1;
  if (room.timerLeft === 5) pushLog(room, 'Going once…');
  if (room.timerLeft === 2) pushLog(room, 'Going twice…');
  if (room.timerLeft <= 0) finishCurrentPlayer(room);
  broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms);
}
function startTicker(room) {
  if (room.interval) return;
  room.interval = setInterval(() => tickRoom(room), 1000);
}
function validateBid(room, team, amount) {
  const rules = room.config;
  if (room.phase !== 'auction') return 'Auction is not running';
  if (!room.current) return 'No player is on auction';
  if (room.paused) return 'Auction is paused';
  if (room.timerLeft <= 0) return 'Timer has expired';
  const cur = room.current;
  if (cur.leader === team.id) return 'You already hold the highest bid';
  const expected = cur.bid === 0 ? cur.player.base : E.nextBid(cur.bid, cur.player.base);
  if (amount < expected) return `Bid must be at least ${money(expected)} (minimum increment)`;
  if (team.squad.length >= rules.squadMax) return `Squad limit reached (${rules.squadMax})`;
  if (cur.player.country !== 'India' && team.squad.filter(p => p.country !== 'India').length >= rules.overseasMax) return `Overseas limit reached (${rules.overseasMax})`;
  if (team.squad.some(p => p.name === cur.player.name)) return 'Player is already in your squad';
  if (room.sold.some(s => s.player === cur.player.name)) return 'Player has already been sold';
  if (amount > team.purse) return 'Bid is beyond your remaining purse';
  // Reserve for required squad slots (to squadMin, at cheapest remaining bases)
  const required = Math.max(0, rules.squadMin - team.squad.length - 1);
  if (required > 0) {
    const bases = room.queue.map(p => p.base).sort((a, b) => a - b);
    let reserve = 0; for (let i = 0; i < required; i++) reserve += (bases[i] !== undefined ? bases[i] : 0.5);
    reserve += required * 0.2;
    if (team.purse - amount < reserve) return `You must keep ${money(reserve)} in reserve to fill required squad slots`;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size })); }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('IPL Mega Auction server running. Connect with WebSocket. Rooms: ' + rooms.size + '\n');
});
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return send(ws, { type: 'error', error: 'Invalid JSON' }); }

    if (m.type === 'create') {
      const room = newRoom(m.config || {}, m.human || {});
      ws.roomCode = room.code; ws.teamId = room.teams[0].id;
      room.sockets.push(ws); startTicker(room);
      send(ws, { type: 'room', code: room.code, state: publicState(room) });
      saveRooms(rooms); return;
    }

    if (m.type === 'join') {
      const code = String(m.code || '').trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', error: 'Room not found. Check the 4-digit code.' });
      // Reconnect: same team name finds the old seat
      const existing = findTeam(room, m.human && m.human.teamName);
      if (existing && !existing.disconnected) {
        // Same team name while the original player is still connected:
        // this is a duplicate name, NOT a reconnect. Reject it.
        return send(ws, { type: 'error', error: 'Team name already taken in this room.' });
      }
      if (existing) {
        existing.disconnected = false; ws.teamId = existing.id;
        if (room.paused && !room.teams.some(t => t.disconnected)) { room.paused = false; room.pauseReason = null; }
        pushLog(room, `${existing.name} reconnected.`);
      } else {
        const maxT = room.config.maxTeams || 10;
        if (room.teams.filter(t => t.isHuman).length >= maxT) return send(ws, { type: 'error', error: 'This room already has ' + maxT + ' teams.' });
        if (room.phase !== 'lobby' && room.phase !== 'stars') return send(ws, { type: 'error', error: 'Auction already started — new players cannot join mid-auction.' });
        if (findTeam(room, m.human && m.human.teamName)) return send(ws, { type: 'error', error: 'Team name already taken in this room.' });
        const team = addTeam(room, m.human || {});
        ws.teamId = team.id;
        pushLog(room, `${team.name} joined room ${code}.`);
        // Star selection starts only when the host clicks Start (see start-stars below), so late joiners can still enter in lobby phase.
        pushLog(room, `${team.name} joined. ${room.teams.length}/10 teams in room.`);
      }
      ws.roomCode = code; if (!room.sockets.includes(ws)) room.sockets.push(ws); startTicker(room);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }

    const room = rooms.get(ws.roomCode); if (!room) return send(ws, { type: 'error', error: 'Join or create a room first.' });
    const team = room.teams.find(t => t.id === ws.teamId);
    if (!team) return send(ws, { type: 'error', error: 'Team not found in this room.' });

    if (m.type === 'start-stars') {
      if (ws.teamId !== room.hostTeamId) return send(ws, { type: 'error', error: 'Only the host can start star selection.' });
      if (room.phase !== 'lobby') return send(ws, { type: 'error', error: 'Star selection already started.' });
      if (room.teams.length < 2 && !room.config.solo) return send(ws, { type: 'error', error: 'Need at least 2 teams to start.' });
      if (!room.config.solo) addAITeams(room);
      room.phase = 'stars';
      pushLog(room, 'Star selection is open — 5 credits each (capped 3, overseas 1, uncapped 1). AI teams have filled the remaining slots.');
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'star-select') {
      if (room.phase !== 'stars') return send(ws, { type: 'error', error: 'Star selection is not open.' });
      const player = room.pool.find(p => p.name === m.playerName);
      if (!player) return send(ws, { type: 'error', error: 'Player not found in pool.' });
      // validateStarSelection expects room.teams with stars and room.pool
      const fakeRoom = { phase: room.phase, teams: room.teams, pool: room.pool, squad: [] };
      const err = E.validateStarSelection(fakeRoom, team, player);
      if (err) return send(ws, { type: 'error', error: err });
      team.stars.push({ ...player, status: 'PRE_AUCTION_SELECTED', owner: team.name, price: 0 });
      pushLog(room, `${team.name} selected star player ${player.name} (${E.starCategory(player)}, ${E.STAR_CREDITS[E.starCategory(player)]} credits).`);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'star-remove') {
      if (room.phase !== 'stars' || team.confirmedStars) return send(ws, { type: 'error', error: 'Cannot change selections after confirmation.' });
      team.stars = (team.stars || []).filter(p => p.name !== m.playerName);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'star-confirm') {
      if (room.phase !== 'stars') return send(ws, { type: 'error', error: 'Star selection is not open.' });
      if ((team.stars || []).length !== 3) return send(ws, { type: 'error', error: 'Select exactly 3 star players: 1 capped, 1 overseas, 1 uncapped.' });
      team.confirmedStars = true;
      pushLog(room, `${team.name} confirmed star selections.`);
      if ((room.config.solo && room.teams.length >= 1 || room.teams.length >= 2) && room.teams.every(t => t.confirmedStars)) {
        // AI star picks, from what humans left (best by estimated rating)
        const taken = new Set();
        room.teams.forEach(t => (t.stars || []).forEach(p => taken.add(p.name)));
        const byRating = arr => arr.slice().sort((a, b) => Math.max(b.bat, b.bowl) - Math.max(a.bat, a.bowl));
        for (const t of room.teams.filter(x => !x.isHuman)) {
          for (const cat of ['capped', 'overseas', 'uncapped']) {
            const cand = byRating(room.pool.filter(p => E.starCategory(p) === cat && !taken.has(p.name)))[0];
            if (cand) { t.stars.push({ ...cand, status: 'PRE_AUCTION_SELECTED', owner: t.name, price: 0 }); taken.add(cand.name); }
          }
        }
        // Lock, assign, remove from pool, start auction
        for (const t of room.teams) {
          for (const star of t.stars) {
            const poolPlayer = room.pool.find(p => p.name === star.name);
            if (poolPlayer) { poolPlayer.status = 'PRE_AUCTION_SELECTED'; poolPlayer.owner = t.name; }
            t.squad.push({ ...star, status: 'PRE_AUCTION_SELECTED', owner: t.name, boughtVia: 'star', price: 0 });
            if (room.config.starPurseDeduction === 'base') t.purse = +(t.purse - star.base).toFixed(1);
            room.history.push({ player: star.name, team: t.name, amount: 0, base: star.base, type: 'star' });
          }
        }
        room.pool = room.pool.filter(p => p.status === 'AVAILABLE');
        let auctionPool = room.pool;
        if (room.config.poolSet === 'stars') auctionPool = auctionPool.filter(p => p.set === 'Marquee' || p.base >= 1.5);
        if (room.config.poolLimit > 0) auctionPool = auctionPool.slice(0, room.config.poolLimit);
        room.queue = auctionPool.map(p => ({ ...p }));
        room.phase = 'auction';
        pushLog(room, 'All teams confirmed. Star selections are locked. Mega auction starts!');
        startNextPlayer(room);
      }
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'bid') {
      if (m.bidId && room.recentBids.includes(m.bidId)) return send(ws, { type: 'error', error: 'Duplicate bid — this bid was already processed.' });
      const err = validateBid(room, team, m.amount);
      if (err) return send(ws, { type: 'error', error: err });
      if (m.bidId) { room.recentBids.push(m.bidId); if (room.recentBids.length > 200) room.recentBids.shift(); }
      room.current.bid = m.amount; room.current.leader = team.id; room.current.leaderName = team.name;
      room.current.bids.push({ team: team.name, teamId: team.id, amount: m.amount });
      room.timerLeft = room.config.timer; // reset on valid bid
      room.history.push({ player: room.current.player.name, team: team.name, amount: m.amount, type: 'bid' });
      pushLog(room, `${team.name} bid ${money(m.amount)} for ${room.current.player.name}.`);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'pass') {
      pushLog(room, `${team.name} passed on ${room.current ? room.current.player.name : 'this player'}.`);
      broadcast(room, { type: 'state', state: publicState(room) }); return;
    }
    if (m.type === 'pause') {
      if (ws.teamId !== room.hostTeamId) return send(ws, { type: 'error', error: 'Only the host can pause.' });
      room.paused = !room.paused; room.pauseReason = room.paused ? 'Paused by host.' : null;
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'end-auction') {
      if (ws.teamId !== room.hostTeamId) return send(ws, { type: 'error', error: 'Only the host can end the auction.' });
      finishAuction(room);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'chat') {
      room.chat.push({ from: team.name, text: String(m.text || '').slice(0, 300), at: Date.now() });
      broadcast(room, { type: 'chat', from: team.name, text: String(m.text || '').slice(0, 300) });
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms); return;
    }
    if (m.type === 'get-state') {
      return send(ws, { type: 'state', state: publicState(room) });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode); if (!room) return;
    room.sockets = room.sockets.filter(s => s !== ws);
    const team = room.teams.find(t => t.id === ws.teamId);
    if (team) {
      team.disconnected = true;
      if (room.phase === 'auction' || room.phase === 'stars') { room.paused = true; room.pauseReason = `${team.name} disconnected — auction paused until they reconnect.`; }
      // Host transfer
      if (room.hostTeamId === team.id) {
        const other = room.teams.find(t => t.id !== team.id && !t.disconnected);
        if (other) { room.hostTeamId = other.id; pushLog(room, `${other.name} is now host.`); }
      }
      pushLog(room, `${team.name} disconnected. State is preserved.`);
      broadcast(room, { type: 'state', state: publicState(room) }); saveRooms(rooms);
    }
  });
});

// Reloaded rooms need tickers
for (const room of rooms.values()) { room.sockets = []; if (room.phase === 'auction') startTicker(room); }
server.listen(PORT, () => console.log('IPL Mega Auction server on port ' + PORT + ', rooms loaded: ' + rooms.size));
