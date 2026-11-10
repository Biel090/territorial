const http = require('http'), fs = require('fs'), path = require('path'), { WebSocketServer } = require('ws');
const W = 384, H = 192, WATER = 255, NB = 20, TICK = 200, D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const server = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); r.end(page) });
const wss = new WebSocketServer({ server }), rooms = {};

function genMap(seed) {
  let s = seed; const R = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const N = 19, g = Array.from({ length: N * N }, R), m = new Uint8Array(W * H);
  const continents = Array.from({ length: 3 + (R() * 4 | 0) }, () => ({
    x: .12 + R() * .76, y: .16 + R() * .68, rx: .16 + R() * .2, ry: .22 + R() * .2
  }));
  for (let y = 0; y < H; y++)for (let x = 0; x < W; x++) {
    const fx = x / W * (N - 3) + 1, fy = y / H * (N - 3) + 1, ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy;
    const v = g[iy * N + ix] * (1 - ax) * (1 - ay) + g[iy * N + ix + 1] * ax * (1 - ay) + g[(iy + 1) * N + ix] * (1 - ax) * ay + g[(iy + 1) * N + ix + 1] * ax * ay;
    const nx = x / W, ny = y / H;
    let mass = -Infinity;
    for (const c of continents) mass = Math.max(mass, 1 - Math.hypot((nx - c.x) / c.rx, (ny - c.y) / c.ry));
    m[y * W + x] = mass + (v - .5) * .34 > .1 ? 0 : WATER;
  }
  return m;
}
function loadMap() { return genMap(Math.random() * 0x100000000 >>> 0); }
function addPlayer(r, name, team, bot) {
  const p = { id: r.players.length, name, team, bot, bal: 100, resources: 100, allocation: 50, tiles: 0, alive: false, rate: 0, skill: .3 + Math.random() * .7 };
  r.players.push(p); return p;
}
function allBuildingCounts(r) {
  const counts = new Map();
  for (let i = 0; i < r.structures.length; i++)if (r.structures[i]) {
    const id = r.owner[i], count = counts.get(id) || { cities: 0, factories: 0 };
    if (r.structures[i] === 1) count.cities++;
    else if (r.structures[i] === 2) count.factories++;
    counts.set(id, count);
  }
  return counts;
}
function buildingCounts(r, id) {
  return allBuildingCounts(r).get(id) || { cities: 0, factories: 0 };
}
function pair(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function allied(r, a, b) { return r.pacts.has(pair(a, b)); }
function status(r) {
  const counts = allBuildingCounts(r);
  send(r, {
    t: 's', p: r.players.slice(1).map(p => {
      const { cities, factories } = counts.get(p.id) || { cities: 0, factories: 0 };
      return [p.id, p.name, p.tiles, Math.floor(p.bal), p.alive, p.rate, Math.floor(p.resources), p.allocation, cities, factories];
    }),
    state: r.state, host: r.host, winner: r.winner, mode: r.mode, allies: [...r.pacts].map(k => k.split(':').map(Number))
  });
}
function set(r, i, id) { const o = r.owner[i]; if (o && o !== WATER) r.players[o].tiles--; r.owner[i] = id; if (id) r.players[id].tiles++; r.ch.push(i, id); }
function spawn(r, p, x, y) {
  if (r.state !== 'lobby') return false;
  if (x < 7 || y < 7 || x >= W - 7 || y >= H - 7 || r.owner[y * W + x] !== 0) return false;
  for (let dy = -6; dy <= 6; dy++)for (let dx = -6; dx <= 6; dx++) { const o = r.owner[(y + dy) * W + x + dx]; if (o && o !== WATER) return false; }
  for (let dy = -3; dy <= 3; dy++)for (let dx = -3; dx <= 3; dx++)if (dx * dx + dy * dy <= 9 && r.owner[(y + dy) * W + x + dx] === 0) set(r, (y + dy) * W + x + dx, p.id);
  p.alive = true; p.bal = 100; return true;
}
function newRoom(code, mode = 'classic') {
  const r = {
    code, owner: loadMap(), structures: new Uint8Array(W * H), mode, players: [null], attacks: [], boats: [], ch: [], clients: new Set(), land: 0, t: 0,
    state: 'lobby', host: 0, winner: 0, pacts: new Set(), pactRequests: new Set()
  };
  for (const v of r.owner) if (v === 0) r.land++;
  for (let i = 1; i <= NB; i++) {
    const p = addPlayer(r, 'Bot ' + i, i, true);
    for (let k = 0; k < 300 && !p.alive; k++)spawn(r, p, Math.random() * W | 0, Math.random() * H | 0);
  }
  r.timer = setInterval(() => tick(r), TICK); rooms[code] = r; return r;
}
function attack(r, p, tx, ty, pct, betray = false) {
  if (r.state !== 'playing' || !p.alive || tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  const O = r.owner, t = O[ty * W + tx];
  if (t === WATER || t === p.id || (t && p.team !== 0 && r.players[t].team === p.team)) return;
  const betraying = t && allied(r, p.id, t);
  if (betraying && !betray) return;
  let at = r.attacks.find(a => a.a === p.id && a.t === t && !a.done);
  const fr = at ? at.fr : new Set();
  for (let k = 0; k < W * H; k++)if (O[k] === t) {
    const x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of D4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && O[ny * W + nx] === p.id) { fr.add(k); break; } }
  }
  if (!fr.size) return;
  const troops = p.bal * Math.min(1, Math.max(.01, pct)); if (troops < 5) return;
  if (r.mode === 'economic' && t && troops <= r.players[t].bal) return;
  if (betraying) { r.pacts.delete(pair(p.id, t)); status(r); }
  p.bal -= troops;
  if (at) at.troops += troops; else r.attacks.push({ a: p.id, t, troops, fr, done: false });
}
function boat(r, p, tx, ty, pct, betray = false) {
  if (r.state !== 'playing' || !p.alive || tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  const O = r.owner, clicked = O[ty * W + tx], size = W * H;
  if (clicked && allied(r, p.id, clicked) && !betray) return;
  const targetOwner = clicked === WATER ? null : clicked;
  const eligible = owner => owner !== WATER && owner !== p.id &&
    !(owner && p.team !== 0 && r.players[owner].team === p.team) &&
    !(owner && allied(r, p.id, owner) && !betray) &&
    (targetOwner === null || owner === targetOwner);
  const targetByWater = new Int32Array(size); targetByWater.fill(-1);
  const targetDistance = new Float64Array(size); targetDistance.fill(Infinity);
  let closestTarget = -1, closestD = Infinity;
  for (let i = 0; i < size; i++) {
    const owner = O[i]; if (!eligible(owner)) continue;
    const x = i % W, y = (i / W) | 0;
    if (!D4.some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && O[(y + dy) * W + x + dx] === WATER)) continue;
    const d = (x - tx) ** 2 + (y - ty) ** 2;
    if (d < closestD) { closestD = d; closestTarget = i; }
    for (const [dx, dy] of D4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const wi = ny * W + nx;
      if (O[wi] === WATER && d < targetDistance[wi]) { targetDistance[wi] = d; targetByWater[wi] = i; }
    }
  }
  if (closestTarget < 0) return;
  const previousStart = new Int32Array(size); previousStart.fill(-1);
  const previous = new Int32Array(size); previous.fill(-2);
  const queue = new Int32Array(size); let head = 0, tail = 0;
  for (let i = 0; i < size; i++)if (O[i] === p.id) {
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of D4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const wi = ny * W + nx;
      if (O[wi] === WATER && previous[wi] === -2) { previous[wi] = -1; previousStart[wi] = i; queue[tail++] = wi; }
    }
  }
  let end = -1, L = -1;
  while (head < tail && end < 0) {
    const wi = queue[head++];
    if (targetByWater[wi] >= 0) { end = wi; L = targetByWater[wi]; break; }
    const x = wi % W, y = (wi / W) | 0;
    for (const [dx, dy] of D4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (O[ni] === WATER && previous[ni] === -2) { previous[ni] = wi; previousStart[ni] = previousStart[wi]; queue[tail++] = ni; }
    }
  }
  if (end < 0) return;
  const path = [L];
  for (let i = end; i >= 0; i = previous[i]) path.push(i);
  path.push(previousStart[end]);
  path.reverse();
  const targetOwnerId = O[L], betraying = targetOwnerId && allied(r, p.id, targetOwnerId);
  const troops = p.bal * Math.min(1, Math.max(.01, pct)); if (troops < 5) return;
  if (r.mode === 'economic' && targetOwnerId && troops * .96875 <= r.players[targetOwnerId].bal) return;
  if (betraying) { r.pacts.delete(pair(p.id, targetOwnerId)); status(r); }
  p.bal -= troops;
  r.boats.push({ a: p.id, path, L, troops: troops * .96875, t0: r.t, dur: Math.max(1, Math.ceil((path.length - 1) / 2)) });
}
function runBoats(r) {
  const O = r.owner, P = r.players;
  r.boats = r.boats.filter(b => {
    if (r.t < b.t0 + b.dur) return true;
    const A = P[b.a], t = O[b.L];
    if (!A.alive || t === WATER || t === b.a || (t && A.team !== 0 && P[t].team === A.team) || (t && allied(r, b.a, t))) { if (A.alive) A.bal += b.troops; return false; }
    if (r.mode === 'economic' && t && b.troops <= P[t].bal) { if (A.alive) A.bal += b.troops; return false; }
    const fr = new Set();
    const lx = b.L % W, ly = (b.L / W) | 0;
    for (let dy = -3; dy <= 3; dy++)for (let dx = -3; dx <= 3; dx++) { const x = lx + dx, y = ly + dy; if (x >= 0 && y >= 0 && x < W && y < H && O[y * W + x] === t) fr.add(y * W + x); }
    r.attacks.push({ a: b.a, t, troops: b.troops, fr, done: false }); return false;
  });
}
function runAttacks(r) {
  const O = r.owner, P = r.players;
  for (const at of r.attacks) {
    const A=P[at.a],D=at.t?P[at.t]:null;
    if(allied(r,at.a,at.t)){if(A.alive)A.bal+=at.troops;at.done=true;continue;}
    let n=Math.min(at.fr.size,3+Math.floor(Math.sqrt(at.troops)/2));
    for (const i of at.fr) {
      if (n-- <= 0) break; at.fr.delete(i); if (O[i] !== at.t) continue;
      const dens = D ? D.bal / Math.max(D.tiles, 1) : 0, cost = D ? Math.max(1, dens * 1.17) : 1;
      if (at.troops < cost) { at.troops = 0; break; }
      at.troops -= cost; if (D) D.bal = Math.max(0, D.bal - dens);
      set(r, i, at.a);
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of D4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && O[ny * W + nx] === at.t) at.fr.add(ny * W + nx); }
    }
    if (!A.alive || at.troops < 1 || !at.fr.size) { if (A.alive) A.bal += at.troops; at.done = true; }
  }
  r.attacks = r.attacks.filter(a => !a.done);
}
function botThink(r, b) {
  const O = r.owner, P = r.players, neu = [], en = [];
  for (let k = 0; k < 80; k++) {
    const x = Math.random() * W | 0, y = Math.random() * H | 0, t = O[y * W + x];
    if (t === WATER || t === b.id) continue;
    let adj = false; for (const [dx, dy] of D4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && O[ny * W + nx] === b.id) { adj = true; break; } }
    if (!adj) continue;
    if (t === 0) neu.push([x, y]); else en.push([x, y, P[t].bal / Math.max(P[t].tiles, 1)]);
  }
  const pct = .3 + .4 * b.skill;
  if (neu.length && b.bal > 20) { const c = neu[0]; attack(r, b, c[0], c[1], pct * .7); }
  else if (en.length) { en.sort((a, c) => a[2] - c[2]); const c = en[0]; if (b.bal * pct > c[2] * (10 - 6 * b.skill)) attack(r, b, c[0], c[1], pct); }
}
function send(r, o) { const s = JSON.stringify(o); for (const c of r.clients) if (c.readyState === 1) c.send(s); }
function tick(r) {
  r.pulse = (r.pulse || 0) + 1;
  if (r.state === 'playing') {
    r.t++; runAttacks(r); runBoats(r);
    for (const p of r.players) if (p && p.alive && p.tiles === 0) { p.alive = false; p.bal = 0; }
    const alive = r.players.slice(1).filter(p => p.alive);
    if (alive.length <= 1) { r.state = 'over'; r.winner = alive.length ? alive[0].id : 0; r.attacks = []; r.boats = []; }
    if (r.t % 5 === 0) {
      const counts = r.mode === 'economic' ? allBuildingCounts(r) : null;
      for (const p of r.players) {
        if (!p || !p.alive) continue;
        if (r.mode === 'economic') {
          const { cities, factories } = counts.get(p.id) || { cities: 0, factories: 0 };
          const production = p.tiles * .3 + cities * 3 + factories * 6;
          p.bal += production * p.allocation / 100;
          p.resources += production * (100 - p.allocation) / 100;
          p.rate = 0;
        } else {
          p.rate = .02 * Math.max(0, 1 - p.bal / (100 * p.tiles));
          p.bal += p.tiles * .3 + p.bal * p.rate;
        }
        if (p.bot && Math.random() < .25 + .5 * p.skill) botThink(r, p);
      }
      status(r);
    }
  } else if (r.pulse % 5 === 0) status(r);
  if (r.boats.length || r.hadBoats) {
    r.hadBoats = r.boats.length > 0;
    send(r, {
      t: 'b', b: r.boats.map(b => {
        const progress = Math.min(b.path.length - 1, Math.max(0, (r.t - b.t0) / b.dur * (b.path.length - 1)));
        const segment = Math.min(b.path.length - 2, Math.floor(progress)), fraction = progress - segment;
        const from = b.path[segment], to = b.path[segment + 1];
        return [from % W + ((to % W) - (from % W)) * fraction, (from / W | 0) + (((to / W | 0) - (from / W | 0)) * fraction), b.a];
      })
    });
  }
  if (r.ch.length) { send(r, { t: 'd', c: r.ch }); r.ch = []; }
}
wss.on('connection', ws => {
  let r = null, p = null;
  ws.on('message', m => {
    let d; try { d = JSON.parse(m) } catch { return }
    if (d.t === 'join' && !r) {
      const code = String(d.room || '').toUpperCase().slice(0, 4);
      if (code && !rooms[code]) return ws.send(JSON.stringify({ t: 'err', m: 'Aquesta sala no existeix' }));
      const room = code ? rooms[code] : newRoom(
        Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join(''),
        d.mode === 'economic' ? 'economic' : 'classic'
      );
      if (room.clients.size >= 4) return ws.send(JSON.stringify({ t: 'err', m: 'Sala plena' }));
      if (room.state !== 'lobby') return ws.send(JSON.stringify({ t: 'err', m: 'La partida ja ha començat' }));
      r = room; p = addPlayer(r, String(d.name || 'Jugador').slice(0, 16), 0, false); r.clients.add(ws);
      ws.playerId = p.id;
      if (!r.host) r.host = p.id;
      ws.send(JSON.stringify({
        t: 'init', code: r.code, w: W, h: H, nb: NB, me: p.id, land: r.land, owner: Buffer.from(r.owner).toString('base64'),
        structures: Buffer.from(r.structures).toString('base64'), state: r.state, host: r.host, mode: r.mode
      }));
      status(r);
    } else if (r && d.t === 'spawn' && !p.alive) spawn(r, p, d.x | 0, d.y | 0);
    else if (r && d.t === 'start' && p.id === r.host && r.state === 'lobby') { r.state = 'playing'; r.t = 0; status(r); }
    else if (r && d.t === 'allocate' && r.mode === 'economic') {
      p.allocation = Math.min(100, Math.max(0, Number(d.value) || 0));
      status(r);
    } else if (r && d.t === 'build' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      const i = Number(d.i) | 0, type = d.building;
      if (i < 0 || i >= W * H || r.owner[i] !== p.id || r.structures[i]) return;
      const cost = type === 'city' ? 60 : type === 'factory' ? 120 : 0;
      if (!cost || p.resources < cost) return;
      if (type === 'factory' && !buildingCounts(r, p.id).cities) return;
      p.resources -= cost;
      r.structures[i] = type === 'city' ? 1 : 2;
      send(r, { t: 'building', i, type: r.structures[i] });
      status(r);
    }
    else if (r && d.t === 'restart' && p.id === r.host && r.state === 'over') {
      r.owner = loadMap(); r.structures = new Uint8Array(W * H); r.attacks = []; r.boats = []; r.ch = []; r.t = 0; r.winner = 0; r.state = 'lobby'; r.pacts.clear(); r.pactRequests.clear();
      for (const player of r.players.slice(1)) { player.tiles = 0; player.alive = false; player.bal = 100; player.resources = 100; player.allocation = 50; player.rate = 0; }
      r.land = 0; for (const v of r.owner) if (v === 0) r.land++;
      for (const bot of r.players.slice(1).filter(player => player.bot)) {
        for (let k = 0; k < 300 && !bot.alive; k++)spawn(r, bot, Math.random() * W | 0, Math.random() * H | 0);
      }
      r.ch = []; send(r, { t: 'reset', owner: Buffer.from(r.owner).toString('base64'), structures: Buffer.from(r.structures).toString('base64') }); status(r);
    } else if (r && d.t === 'atk') attack(r, p, d.x | 0, d.y | 0, +d.pct || .3, !!d.betray);
    else if (r && d.t === 'boat') boat(r, p, d.x | 0, d.y | 0, +d.pct || .3, !!d.betray);
    else if (r && d.t === 'pact' && r.state === 'playing') {
      const o = r.players[d.to | 0], key = `${p.id}:${d.to | 0}`;
      if (o && !o.bot && o !== p && o.alive && p.alive && !allied(r, p.id, o.id)) {
        r.pactRequests.add(key); for (const c of r.clients) if (c.playerId === o.id) c.send(JSON.stringify({ t: 'pactRequest', from: p.id, name: p.name }));
      }
    } else if (r && d.t === 'pactReply' && r.state === 'playing') {
      const from = d.from | 0, key = `${from}:${p.id}`;
      if (r.pactRequests.delete(key) && d.accept && p.alive && r.players[from] && r.players[from].alive) {
        r.pacts.add(pair(from, p.id)); status(r);
      }
    } else if (r && d.t === 'give' && r.state === 'playing') { const o = r.players[d.to | 0]; if (o && !o.bot && o !== p && o.alive && p.alive) { const a = p.bal * Math.min(.5, Math.max(.01, +d.pct || .25)); p.bal -= a; o.bal += a; } }
  });
  ws.playerId = null;
  ws.on('close', () => {
    if (!r) return; r.clients.delete(ws);
    if (p.alive) { for (let i = 0; i < W * H; i++)if (r.owner[i] === p.id) set(r, i, 0); p.alive = false; p.bal = 0; }
    for (const key of [...r.pacts]) if (key.split(':').map(Number).includes(p.id)) r.pacts.delete(key);
    for (const key of [...r.pactRequests]) if (key.split(':').map(Number).includes(p.id)) r.pactRequests.delete(key);
    if (r.host === p.id) { const next = [...r.clients].map(c => c.playerId).find(id => id); r.host = next || 0; }
    status(r);
    if (!r.clients.size) { clearInterval(r.timer); delete rooms[r.code]; }
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Servidor a http://localhost:' + (process.env.PORT || 3000)));
