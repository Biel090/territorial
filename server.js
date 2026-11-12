const http = require('http'), fs = require('fs'), path = require('path'), { WebSocketServer } = require('ws');
const W = 384, H = 192, WATER = 255, NB = 20, TICK = 200, D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const STRUCTURE = Object.freeze({ city: 1, shipyard: 3, armsFactory: 4 });
const STARTING_MONEY = 10000, CIVILIAN_INCOME_RATE = .025, ARMS_FACTORY_RATE = 10, SHIPYARD_INTERVAL = 10;
const CITY_COST = 2500, SHIPYARD_COST = 4000, ARMS_FACTORY_COST = 3500;
const SHIP_PRICE = 1500, SOLDIERS_PER_SHIP = 100, PEACE_DURATION = 600, MARCHES_PER_TICK = 2;
const BASE_W = 288, BASE_H = 112;
const worldMap = new Uint8Array(fs.readFileSync(path.join(__dirname, 'world.bin')));
if (worldMap.length !== BASE_W * BASE_H) throw new Error('world.bin has an unexpected size');
const regions = {
  americas: { x: 0, y: 0, w: 142, h: BASE_H },
  europe_africa: { x: 72, y: 0, w: 122, h: BASE_H },
  asia_pacific: { x: 146, y: 0, w: 142, h: BASE_H },
  world: { x: 0, y: 0, w: BASE_W, h: BASE_H }
};
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
function loadMap(territory = 'random') {
  if (territory === 'random') return genMap(Math.random() * 0x100000000 >>> 0);
  const region = regions[territory] || regions.world;
  const map = new Uint8Array(W * H).fill(WATER);
  const scale = Math.min(W / region.w, H / region.h);
  const drawW = Math.round(region.w * scale), drawH = Math.round(region.h * scale);
  const offsetX = Math.floor((W - drawW) / 2), offsetY = Math.floor((H - drawH) / 2);
  for (let y = 0; y < drawH; y++)for (let x = 0; x < drawW; x++) {
    const sx = region.x + Math.min(region.w - 1, Math.floor(x / scale));
    const sy = region.y + Math.min(region.h - 1, Math.floor(y / scale));
    map[(offsetY + y) * W + offsetX + x] = worldMap[sy * BASE_W + sx];
  }
  return map;
}
function addPlayer(r, name, team, bot) {
  const p = {
    id: r.players.length, name, team, bot, bal: 100, money: STARTING_MONEY,
    allocation: 35, population: 0, tiles: 0, alive: false, rate: 0,
    ships: 0, shipProgress: 0, skill: .5 + Math.random() * .5
  };
  r.players.push(p);
  r.buildings.push({ cities: 0, shipyards: 0, armsFactories: 0 });
  r.cityTiles.push(new Set());
  r.territoryTiles.push(new Set());
  return p;
}
function reindexRoom(r) {
  r.buildings = Array.from({ length: r.players.length }, () => ({ cities: 0, shipyards: 0, armsFactories: 0 }));
  r.cityTiles = Array.from({ length: r.players.length }, () => new Set());
  r.territoryTiles = Array.from({ length: r.players.length }, () => new Set());
  for (let i = 0; i < r.owner.length; i++) {
    const id = r.owner[i];
    if (id === WATER) continue;
    r.territoryTiles[id].add(i);
    if (r.structures[i]) trackBuilding(r, id, i, r.structures[i], 1);
  }
}
function buildingCounts(r, id) {
  return r.buildings[id] || { cities: 0, shipyards: 0, armsFactories: 0 };
}
function factoryCount(counts) { return counts.shipyards + counts.armsFactories; }
function combatEfficiency(r, id) {
  if (r.mode !== 'economic') return 1;
  return 1 + Math.min(1, buildingCounts(r, id).armsFactories * .1);
}
function armyCapacity(p) { return p.population * p.allocation / 100; }
function populationGrowthRate(p, counts) {
  const remaining = counts.cities * 1000 - p.population;
  if (remaining < .001) return 0;
  return Math.min(p.population * .01 * p.population / 1000, remaining);
}
function economicWorkforce(p, counts) {
  const civilians = p.population * (100 - p.allocation) / 100;
  const productionWorkers = civilians;
  const shipWorkers = counts.shipyards ? productionWorkers : 0;
  return {
    civilians, productionWorkers, shipWorkers,
    incomeRate: civilians * CIVILIAN_INCOME_RATE,
    shipRate: counts.shipyards ? Math.min(counts.shipyards, shipWorkers / 100) / SHIPYARD_INTERVAL : 0
  };
}
function economyStatus(r, p) {
  const counts = buildingCounts(r, p.id), workforce = economicWorkforce(p, counts);
  return {
    id: p.id, money: Math.floor(p.money), ships: Math.floor(p.ships),
    productionWorkers: Math.floor(workforce.productionWorkers),
    incomeRate: workforce.incomeRate, shipRate: workforce.shipRate,
    populationGrowthRate: populationGrowthRate(p, counts),
    recruitmentRate: Math.min(counts.armsFactories * ARMS_FACTORY_RATE, Math.max(0, armyCapacity(p) - p.bal)),
    armyCapacity: armyCapacity(p),
    combatEfficiency: combatEfficiency(r, p.id),
    shipyards: counts.shipyards, armsFactories: counts.armsFactories,
  };
}
function trackBuilding(r, id, i, type, delta) {
  if (!id || !type) return;
  const counts = r.buildings[id];
  if (type === STRUCTURE.city) {
    counts.cities += delta;
    if (delta > 0) r.cityTiles[id].add(i);
    else r.cityTiles[id].delete(i);
  } else if (type === STRUCTURE.shipyard) counts.shipyards += delta;
  else if (type === STRUCTURE.armsFactory) counts.armsFactories += delta;
}
function setStructure(r, id, i, type) {
  r.structures[i] = type;
  r.cityPopulation[i] = 0;
  trackBuilding(r, id, i, type, 1);
  send(r, { t: 'building', i, type });
}
function buildStructure(r, p, i, type) {
  if (i < 0 || i >= W * H || r.owner[i] !== p.id || r.structures[i]) return false;
  const counts = buildingCounts(r, p.id);
  const structure = STRUCTURE[type];
  const cost = type === 'city' ? CITY_COST : type === 'shipyard' ? SHIPYARD_COST : type === 'armsFactory' ? ARMS_FACTORY_COST : 0;
  if (!cost || p.money < cost) return false;
  if (type === 'city' && counts.cities && p.population < counts.cities * 1000) return false;
  if (structure !== STRUCTURE.city && (!counts.cities || factoryCount(counts) >= 10)) return false;
  p.money -= cost;
  setStructure(r, p.id, i, structure);
  status(r);
  return true;
}
function pair(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }
function allied(r, a, b) { return r.pacts.has(pair(a, b)); }
function sameTeam(r, a, b) { return !!(r.players[a].team && r.players[a].team === r.players[b].team); }
function cleanupPlayerState(r, playerId) {
  r.marches = r.marches.filter(march => march.a !== playerId);
  r.shipRequests = r.shipRequests.filter(request => request.buyer !== playerId);
  const activeRequests = new Set(r.shipRequests.map(request => request.id));
  r.shipOffers = r.shipOffers.filter(offer => offer.seller !== playerId && activeRequests.has(offer.request));
  r.peaceOffers = r.peaceOffers.filter(offer => offer.from !== playerId && offer.to !== playerId);
  for (const key of [...r.pacts]) if (key.split(':').map(Number).includes(playerId)) r.pacts.delete(key);
  for (const key of [...r.pactRequests]) if (key.split(':').map(Number).includes(playerId)) r.pactRequests.delete(key);
  for (const key of [...r.ceasefires.keys()]) if (key.split(':').map(Number).includes(playerId)) r.ceasefires.delete(key);
}
function status(r) {
  const shipRequests = (r.shipRequests || []).filter(request => request.remaining > 0 && request.expiresAt > r.t).map(request => ({
    id: request.id, buyer: request.buyer, quantity: request.remaining, maxPrice: request.maxPrice,
    name: r.players[request.buyer].name, offers: (r.shipOffers || []).filter(offer => offer.request === request.id && offer.remaining > 0)
      .map(offer => ({ id: offer.id, seller: offer.seller, name: r.players[offer.seller].name, bot: r.players[offer.seller].bot, quantity: offer.remaining, price: offer.price }))
  }));
  const peaceOffers = (r.peaceOffers || []).filter(offer => offer.expiresAt > r.t).map(offer => ({
    id: offer.id, from: offer.from, to: offer.to, amount: offer.amount, name: r.players[offer.from].name
  }));
  send(r, {
    t: 's', p: r.players.slice(1).map(p => {
      const counts = buildingCounts(r, p.id);
      return [p.id, p.name, p.tiles, Math.floor(p.bal), p.alive, p.rate, Math.floor(p.money), p.allocation, counts.cities,
        factoryCount(counts), Math.floor(p.population), 1, Math.floor(p.population * (100 - p.allocation) / 100)];
    }),
    economy: r.mode === 'economic' ? r.players.slice(1).map(p => economyStatus(r, p)) : undefined,
    shipRequests: r.mode === 'economic' ? shipRequests : undefined,
    peaceOffers: r.mode === 'economic' ? peaceOffers : undefined,
    marches: r.mode === 'economic' ? (r.marches || []).map(march => {
      const i = march.path[Math.min(march.index, march.path.length - 1)];
      return [i % W, (i / W) | 0, march.a, march.waitingShip];
    }) : undefined,
    threats: r.mode === 'economic' ? r.players.slice(1).map(player => [
      player.id, r.players.slice(1).filter(attacker => attacker && attacker.id !== player.id &&
        incomingArmy(r, attacker.id, player.id) > 0).map(attacker => attacker.id)
    ]) : undefined,
    state: r.state, host: r.host, winner: r.winner, mode: r.mode, allies: [...r.pacts].map(k => k.split(':').map(Number)),
    ceasefires: [...(r.ceasefires || [])].filter(([, until]) => until > r.t).map(([key, until]) => [...key.split(':').map(Number), until - r.t])
  });
}
function set(r, i, id) {
  const o = r.owner[i];
  const structure = r.structures[i];
  const ownershipChange = o && o !== WATER && o !== id && structure;
  if (ownershipChange) {
    trackBuilding(r, o, i, structure, -1);
    if (id) trackBuilding(r, id, i, structure, 1);
  }
  if (o && o !== WATER && o !== id && r.structures[i] === 1) {
    const residents = r.cityPopulation[i];
    r.players[o].population = Math.max(0, r.players[o].population - residents);
    r.players[o].bal = Math.min(r.players[o].bal, armyCapacity(r.players[o]));
    if (id) r.players[id].population += residents;
  }
  if (o && o !== WATER) r.players[o].tiles--;
  if (r.territoryTiles[o]) r.territoryTiles[o].delete(i);
  r.owner[i] = id;
  if (id) {
    r.players[id].tiles++;
    r.territoryTiles[id].add(i);
  } else {
    r.territoryTiles[0].add(i);
    if (r.structures[i]) {
      r.structures[i] = 0;
      r.cityPopulation[i] = 0;
      send(r, { t: 'building', i, type: 0 });
    }
  }
  r.ch.push(i, id);
}
function spawn(r, p, x, y) {
  if (r.state !== 'lobby') return false;
  if (x < 7 || y < 7 || x >= W - 7 || y >= H - 7 || r.owner[y * W + x] !== 0) return false;
  for (let dy = -6; dy <= 6; dy++)for (let dx = -6; dx <= 6; dx++) { const o = r.owner[(y + dy) * W + x + dx]; if (o && o !== WATER) return false; }
  for (let dy = -3; dy <= 3; dy++)for (let dx = -3; dx <= 3; dx++)if (dx * dx + dy * dy <= 9 && r.owner[(y + dy) * W + x + dx] === 0) set(r, (y + dy) * W + x + dx, p.id);
  p.alive = true; p.bal = 100;
  if (r.mode === 'economic') {
    p.population = 600;
    p.allocation = p.bot ? 40 + Math.round(p.skill * 25) : 35;
    p.money = STARTING_MONEY;
    const city = y * W + x;
    setStructure(r, p.id, city, 1);
    r.cityPopulation[city] = p.population;
  }
  return true;
}
function sendPlayer(r, id, message) {
  const data = JSON.stringify(message);
  for (const c of r.clients) if (c.playerId === id && c.readyState === 1) c.send(data);
}
function actionError(r, p, message) {
  if (!p.bot) sendPlayer(r, p.id, { t: 'err', m: message });
}
function selectTroops(p, pct, selection) {
  const available = Math.max(0, p.bal);
  if (selection && selection.mode === 'exact') {
    const amount = Number(selection.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > available) return null;
    return amount;
  }
  const percent = Math.min(1, Math.max(.01, Number(pct) || .3));
  return available * percent;
}
function requiredShips(troops) { return Math.ceil(troops / SOLDIERS_PER_SHIP); }
function ceasefireActive(r, a, b) {
  return (r.ceasefires.get(pair(a, b)) || 0) > r.t;
}
function canTransit(r, p, owner) {
  return owner === 0 || owner === p.id || (owner !== WATER && (allied(r, p.id, owner) ||
    (p.team && r.players[owner].team === p.team)));
}
function findMarchPath(r, p, target, start = -1, betray = false, avoidWater = false) {
  const size = W * H, previous = new Int32Array(size).fill(-2), queue = new Int32Array(size);
  const targetOwner = r.owner[target];
  const attackOwner = targetOwner && targetOwner !== WATER && targetOwner !== p.id &&
    !sameTeam(r, p.id, targetOwner) && (!allied(r, p.id, targetOwner) || betray) &&
    !ceasefireActive(r, p.id, targetOwner) ? targetOwner : 0;
  let closestTarget = -1, closestTargetParent = -1, closestDistance = Infinity;
  let head = 0, tail = 0;
  const buildPath = end => {
    const path = [];
    for (let at = end; at >= 0; at = previous[at]) path.push(at);
    return path.reverse();
  };
  const addStart = i => {
    if (i >= 0 && i < size && previous[i] === -2) { previous[i] = -1; queue[tail++] = i; }
  };
  if (start >= 0) addStart(start);
  else for (const i of r.territoryTiles[p.id]) addStart(i);
  while (head < tail) {
    const i = queue[head++];
    if (i === target) {
      return buildPath(i);
    }
    const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of D4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const owner = r.owner[ni];
      if (attackOwner && owner === attackOwner) {
        const distance = (nx - target % W) ** 2 + (ny - ((target / W) | 0)) ** 2;
        if (distance < closestDistance) {
          closestTarget = ni;
          closestTargetParent = i;
          closestDistance = distance;
        }
        continue;
      }
      if (previous[ni] !== -2) continue;
      if (avoidWater && owner === WATER) continue;
      const destination = ni === target && owner !== WATER && owner !== p.id &&
        !(owner && sameTeam(r, p.id, owner)) &&
        !(owner && allied(r, p.id, owner) && !betray) && !(owner && ceasefireActive(r, p.id, owner));
      if (owner === WATER || canTransit(r, p, owner) || destination) {
        previous[ni] = i;
        queue[tail++] = ni;
      }
    }
  }
  if (closestTarget >= 0) return [...buildPath(closestTargetParent), closestTarget];
  return null;
}
function nearestLandTarget(r, p, x, y) {
  let best = -1, distance = Infinity;
  for (let i = 0; i < r.owner.length; i++) {
    const owner = r.owner[i];
    if (owner === WATER || owner === p.id || (owner && (allied(r, p.id, owner) || sameTeam(r, p.id, owner) || ceasefireActive(r, p.id, owner)))) continue;
    const d = (i % W - x) ** 2 + (((i / W) | 0) - y) ** 2;
    if (d < distance) { best = i; distance = d; }
  }
  return best;
}
function orderMarch(r, p, x, y, pct, selection, betray = false) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  let target = y * W + x;
  if (r.owner[target] === WATER) target = nearestLandTarget(r, p, x, y);
  if (target < 0 || r.owner[target] === p.id || (r.owner[target] && allied(r, p.id, r.owner[target]) && !betray)) return;
  const clickedOwner = r.owner[target];
  if (clickedOwner && (ceasefireActive(r, p.id, clickedOwner) || sameTeam(r, p.id, clickedOwner))) {
    actionError(r, p, 'No pots atacar aquest jugador durant l’alt el foc o si sou del mateix equip.');
    return;
  }
  const troops = selectTroops(p, pct, selection);
  if (troops === null || troops < 5) { actionError(r, p, 'L’expedició necessita almenys 5 soldats disponibles.'); return; }
  let path = findMarchPath(r, p, target, -1, betray);
  if (!path) { actionError(r, p, 'No hi ha cap ruta fins al destí sense travessar territori aliè sense permís.'); return; }
  target = path[path.length - 1];
  const owner = r.owner[target];
  if (owner && (ceasefireActive(r, p.id, owner) || sameTeam(r, p.id, owner))) {
    actionError(r, p, 'No pots atacar aquest jugador durant l’alt el foc o si sou del mateix equip.');
    return;
  }
  if (path.some(i => r.owner[i] === WATER) && p.ships - reservedShips(r, p.id) < requiredShips(troops)) {
    const landPath = findMarchPath(r, p, target, -1, betray, true);
    if (landPath) path = landPath;
  }
  if (owner && allied(r, p.id, owner) && betray) r.pacts.delete(pair(p.id, owner));
  p.bal -= troops;
  r.marches.push({ a: p.id, target, targetOwner: owner, troops, path, index: 0, waitingShip: false, atSea: false });
  status(r);
}
function runMarches(r) {
  r.marches = r.marches.filter(march => {
    const p = r.players[march.a];
    if (!p || !p.alive) return false;
    const currentOwner = r.owner[march.target];
    if (currentOwner === march.a || currentOwner === WATER || (currentOwner && allied(r, march.a, currentOwner)) ||
        (currentOwner && (sameTeam(r, march.a, currentOwner) || ceasefireActive(r, march.a, currentOwner)))) {
      p.bal += march.troops;
      return false;
    }
    const currentCell = march.path[march.index], currentCellOwner = r.owner[currentCell];
    if (currentCell !== march.target && currentCellOwner !== WATER && !canTransit(r, p, currentCellOwner)) {
      p.bal += march.troops;
      return false;
    }
    let moved = 0;
    while (march.index < march.path.length - 1 && moved < MARCHES_PER_TICK) {
      const next = march.path[march.index + 1], owner = r.owner[next];
      const isTarget = next === march.target;
      if (owner !== WATER && !canTransit(r, p, owner) && !isTarget) {
        const path = findMarchPath(r, p, march.target, march.path[march.index]);
        if (!path) { p.bal += march.troops; return false; }
        march.path = path; march.index = 0;
        continue;
      }
      if (owner === WATER && !march.atSea) {
        const needed = requiredShips(march.troops);
        if (p.ships - reservedShips(r, p.id) < needed) {
          const landPath = findMarchPath(r, p, march.target, march.path[march.index], false, true);
          if (landPath) {
            march.path = landPath;
            march.index = 0;
            continue;
          }
          march.waitingShip = true;
          break;
        }
        p.ships -= needed;
        march.atSea = true;
      } else if (owner !== WATER && march.atSea) march.atSea = false;
      march.waitingShip = false;
      march.index++;
      moved++;
    }
    if (march.index < march.path.length - 1) return true;
    const targetOwner = r.owner[march.target];
    if (targetOwner === 0) {
      r.attacks.push({ a: p.id, t: 0, troops: march.troops, efficiency: combatEfficiency(r, p.id), fr: new Set([march.target]), done: false });
      return false;
    }
    if (!targetOwner || targetOwner === WATER || targetOwner === p.id ||
        allied(r, p.id, targetOwner) || sameTeam(r, p.id, targetOwner) || ceasefireActive(r, p.id, targetOwner)) {
      p.bal += march.troops;
      return false;
    }
    r.attacks.push({ a: p.id, t: targetOwner, troops: march.troops, efficiency: combatEfficiency(r, p.id), fr: new Set([march.target]), done: false });
    return false;
  });
}
function newRoom(code, mode = 'classic', territory = 'random') {
  const r = {
    code, owner: loadMap(territory), structures: new Uint8Array(W * H), cityPopulation: new Float32Array(W * H), mode, territory, players: [null], buildings: [null], cityTiles: [null], territoryTiles: [new Set()], attacks: [], boats: [], marches: [], shipRequests: [], shipOffers: [], peaceOffers: [], nextMarketId: 1, ceasefires: new Map(), ch: [], clients: new Set(), land: 0, t: 0,
    state: 'lobby', host: 0, winner: 0, pacts: new Set(), pactRequests: new Set()
  };
  for (let i = 0; i < r.owner.length; i++)if (r.owner[i] === 0) { r.land++; r.territoryTiles[0].add(i); }
  reindexRoom(r);
  for (let i = 1; i <= NB; i++) {
    const p = addPlayer(r, 'Bot ' + i, i, true);
    for (let k = 0; k < 300 && !p.alive; k++)spawn(r, p, Math.random() * W | 0, Math.random() * H | 0);
  }
  r.timer = setInterval(() => tick(r), TICK); rooms[code] = r; return r;
}
function attack(r, p, tx, ty, pct, betray = false, selection = null) {
  if (r.state !== 'playing' || !p.alive || tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  if (r.mode === 'economic') return orderMarch(r, p, tx, ty, pct, selection, betray);
  const O = r.owner, t = O[ty * W + tx];
  if (t === WATER || t === p.id || (t && p.team !== 0 && r.players[t].team === p.team)) return;
  const betraying = t && allied(r, p.id, t);
  if (betraying && !betray) return;
  let at = r.attacks.find(a => a.a === p.id && a.t === t && !a.done);
  const fr = at ? at.fr : new Set();
  for (const k of r.territoryTiles[t]) {
    const x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of D4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && O[ny * W + nx] === p.id) { fr.add(k); break; } }
  }
  if (!fr.size) return;
  const troops = selectTroops(p, pct, selection);
  if (troops === null) { actionError(r, p, 'No tens prou soldats disponibles per aquesta expedicio.'); return; }
  if (troops < 5) { actionError(r, p, 'Una expedicio necessita almenys 5 soldats.'); return; }
  const efficiency = combatEfficiency(r, p.id);
  if (r.mode === 'economic' && t && (troops * efficiency <= r.players[t].bal * combatEfficiency(r, t))) return;
  if (betraying) { r.pacts.delete(pair(p.id, t)); status(r); }
  p.bal -= troops;
  if (at) {
    at.efficiency = (at.troops * at.efficiency + troops * efficiency) / (at.troops + troops);
    at.troops += troops;
  } else r.attacks.push({ a: p.id, t, troops, efficiency, fr, done: false });
}
function boat(r, p, tx, ty, pct, betray = false, selection = null) {
  if (r.state !== 'playing' || !p.alive || tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  if (r.mode === 'economic') return orderMarch(r, p, tx, ty, pct, selection, betray);
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
  if (closestTarget < 0) { actionError(r, p, 'No hi ha cap costa enemiga disponible per a aquesta ruta.'); return; }
  const previousStart = new Int32Array(size); previousStart.fill(-1);
  const previous = new Int32Array(size); previous.fill(-2);
  const queue = new Int32Array(size); let head = 0, tail = 0;
  for (const i of r.territoryTiles[p.id]) {
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
  if (end < 0) { actionError(r, p, 'No s’ha trobat una ruta marítima cap a aquesta costa.'); return; }
  const path = [L];
  for (let i = end; i >= 0; i = previous[i]) path.push(i);
  path.push(previousStart[end]);
  path.reverse();
  const targetOwnerId = O[L], betraying = targetOwnerId && allied(r, p.id, targetOwnerId);
  const troops = selectTroops(p, pct, selection);
  if (troops === null) { actionError(r, p, 'No tens prou soldats disponibles per aquesta expedicio.'); return; }
  if (troops < 5) { actionError(r, p, 'Una expedicio necessita almenys 5 soldats.'); return; }
  const efficiency = combatEfficiency(r, p.id);
  if (r.mode === 'economic' && targetOwnerId && troops * .96875 * efficiency <= r.players[targetOwnerId].bal * combatEfficiency(r, targetOwnerId)) return;
  if (betraying) { r.pacts.delete(pair(p.id, targetOwnerId)); status(r); }
  p.bal -= troops;
  r.boats.push({ a: p.id, path, L, troops: troops * .96875, efficiency, t0: r.t, dur: Math.max(1, Math.ceil((path.length - 1) / 2)) });
}
function runBoats(r) {
  const O = r.owner, P = r.players;
  r.boats = r.boats.filter(b => {
    if (r.t < b.t0 + b.dur) return true;
    const A = P[b.a], t = O[b.L];
    if (!A.alive || t === WATER || t === b.a || (t && A.team !== 0 && P[t].team === A.team) || (t && allied(r, b.a, t))) { if (A.alive) A.bal += b.troops; return false; }
    if (r.mode === 'economic' && t && b.troops * b.efficiency <= P[t].bal * combatEfficiency(r, t)) { if (A.alive) A.bal += b.troops; return false; }
    const fr = new Set();
    const lx = b.L % W, ly = (b.L / W) | 0;
    for (let dy = -3; dy <= 3; dy++)for (let dx = -3; dx <= 3; dx++) { const x = lx + dx, y = ly + dy; if (x >= 0 && y >= 0 && x < W && y < H && O[y * W + x] === t) fr.add(y * W + x); }
    r.attacks.push({ a: b.a, t, troops: b.troops, efficiency: b.efficiency, fr, done: false }); return false;
  });
}
function runAttacks(r) {
  const O = r.owner, P = r.players;
  for (const at of r.attacks) {
    const A = P[at.a], D = at.t ? P[at.t] : null;
    if (r.mode === 'economic' && D && ceasefireActive(r, at.a, at.t)) {
      if (A.alive) A.bal += at.troops;
      at.done = true;
      continue;
    }
    if (D && (allied(r, at.a, at.t) || sameTeam(r, at.a, at.t))) {
      if (A.alive) A.bal += at.troops;
      at.done = true;
      continue;
    }
    const attackEfficiency = at.efficiency || combatEfficiency(r, at.a);
    let n = Math.min(at.fr.size, Math.ceil((3 + Math.floor(Math.sqrt(at.troops) / 2)) * attackEfficiency));
    for (const i of at.fr) {
      if (n-- <= 0) break; at.fr.delete(i); if (O[i] !== at.t) continue;
      const dens = D ? D.bal / Math.max(D.tiles, 1) : 0;
      const defenseEfficiency = D ? combatEfficiency(r, D.id) : 1;
      const cost = D ? Math.max(.1, dens * 1.17 * defenseEfficiency / attackEfficiency) : 1 / attackEfficiency;
      if (at.troops < cost) {
        at.troops = 0;
        if (D) actionError(r, A, `Atac aturat: l’enemic defensa amb ${dens.toFixed(1)} soldats per territori. Envia més soldats o prova una altra frontera.`);
        break;
      }
      at.troops -= cost;
      if (D) D.bal = Math.max(0, D.bal - dens);
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
  for (let k = 0; k < 600; k++) {
    const x = Math.random() * W | 0, y = Math.random() * H | 0, t = O[y * W + x];
    if (t === WATER || t === b.id || (t && (P[t].team === b.team || allied(r, b.id, t)))) continue;
    let adj = false; for (const [dx, dy] of D4) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && O[ny * W + nx] === b.id) { adj = true; break; } }
    if (!adj) continue;
    if (t === 0) neu.push([x, y]); else en.push([x, y, P[t].bal / Math.max(P[t].tiles, 1)]);
  }
  const pct = .6 + .38 * b.skill;
  en.sort((a, c) => a[2] - c[2]);
  const target = en.find(([x, y]) => {
    const defender = P[O[y * W + x]];
    return b.bal * pct * combatEfficiency(r, b.id) > defender.bal * combatEfficiency(r, defender.id) * (1.1 - b.skill * .08);
  });
  if (target) attack(r, b, target[0], target[1], pct);
  else if (neu.length && b.bal > 15) {
    const c = neu[Math.random() * Math.min(neu.length, 20) | 0];
    attack(r, b, c[0], c[1], pct);
  }
}
function botEconomicThink(r, b) {
  const counts = buildingCounts(r, b.id);
  const desiredAllocation = b.population < 850 ? 40 : Math.min(85, 55 + Math.floor(b.skill * 30));
  b.allocation = desiredAllocation;
  b.bal = Math.min(b.bal, armyCapacity(b));
  let building = null;
  if (counts.cities && b.population >= counts.cities * 1000 && b.money >= CITY_COST) building = 'city';
  else if (factoryCount(counts) < 10 && b.money >= Math.min(SHIPYARD_COST, ARMS_FACTORY_COST)) {
    if (!counts.armsFactories) building = 'armsFactory';
    else if (!counts.shipyards) building = 'shipyard';
    else building = 'shipyard';
  }
  if (!building) return;
  for (const i of r.territoryTiles[b.id]) {
    if (!r.structures[i] && buildStructure(r, b, i, building)) return;
  }
}
function processEconomicPlayer(r, p) {
  const counts = buildingCounts(r, p.id);
  const workforce = economicWorkforce(p, counts);
  let growth = populationGrowthRate(p, counts);
  for (const i of r.cityTiles[p.id]) {
    if (growth <= 0) break;
    const added = Math.min(growth, 1000 - r.cityPopulation[i]);
    r.cityPopulation[i] += added;
    p.population += added;
    growth -= added;
  }
  p.money += workforce.incomeRate;
  p.shipProgress += workforce.shipRate;
  const newShips = Math.floor(p.shipProgress + 1e-9);
  p.ships += newShips; p.shipProgress -= newShips;
  p.bal = Math.min(armyCapacity(p), p.bal + counts.armsFactories * ARMS_FACTORY_RATE);
}
function validQuantity(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
}
function reservedShips(r, sellerId) {
  return r.shipOffers.filter(offer => offer.seller === sellerId && offer.remaining > 0 && offer.expiresAt > r.t)
    .reduce((sum, offer) => sum + offer.remaining, 0);
}
function createShipRequest(r, buyer, quantityValue, maxPriceValue) {
  const quantity = validQuantity(quantityValue), maxPrice = validQuantity(maxPriceValue);
  if (!buyer.alive || !quantity || !maxPrice || buyer.money < maxPrice) {
    return actionError(r, buyer, 'Indica una quantitat i un preu màxim vàlids, i comprova els diners disponibles.');
  }
  const request = { id: r.nextMarketId++, buyer: buyer.id, remaining: quantity, maxPrice, expiresAt: r.t + 3000 };
  r.shipRequests.push(request);
  status(r);
}
function createShipOffer(r, seller, requestId, quantityValue, priceValue) {
  const request = r.shipRequests.find(item => item.id === Number(requestId) && item.remaining > 0 && item.expiresAt > r.t);
  const quantity = validQuantity(quantityValue), price = validQuantity(priceValue);
  if (!seller.alive || !request || !r.players[request.buyer].alive || request.buyer === seller.id || !quantity || !price ||
      price > request.maxPrice || quantity > request.remaining ||
      quantity > seller.ships - reservedShips(r, seller.id)) {
    return actionError(r, seller, 'Oferta no vàlida: comprova la demanda, el preu i els vaixells disponibles.');
  }
  if (r.shipOffers.some(offer => offer.request === request.id && offer.seller === seller.id && offer.remaining > 0)) {
    return actionError(r, seller, 'Ja tens una oferta activa per aquesta demanda.');
  }
  r.shipOffers.push({ id: r.nextMarketId++, request: request.id, seller: seller.id, remaining: quantity, price, expiresAt: request.expiresAt });
  status(r);
}
function acceptShipOffer(r, buyer, offerId, quantityValue) {
  const offer = r.shipOffers.find(item => item.id === Number(offerId) && item.remaining > 0 && item.expiresAt > r.t);
  const request = offer && r.shipRequests.find(item => item.id === offer.request && item.remaining > 0 && item.expiresAt > r.t);
  const seller = offer && r.players[offer.seller];
  const quantity = validQuantity(quantityValue);
  const total = offer ? offer.price * quantity : 0;
  if (!offer || !request || request.buyer !== buyer.id || !buyer.alive || !seller || !seller.alive ||
      !quantity || quantity > offer.remaining || quantity > request.remaining ||
      offer.price > request.maxPrice || !Number.isSafeInteger(total) || buyer.money < total || seller.ships < quantity) {
    return actionError(r, buyer, 'No es pot acceptar aquesta oferta: revisa la demanda, el saldo i l’estoc.');
  }
  buyer.money -= total;
  seller.money += total;
  buyer.ships += quantity;
  seller.ships -= quantity;
  offer.remaining -= quantity;
  request.remaining -= quantity;
  if (!request.remaining) {
    for (const other of r.shipOffers) if (other.request === request.id) other.remaining = 0;
  }
  status(r);
}
function incomingArmy(r, attackerId, targetId) {
  let total = 0;
  for (const attack of r.attacks) if (!attack.done && attack.a === attackerId && attack.t === targetId) total += attack.troops;
  for (const march of r.marches) if (march.a === attackerId && r.owner[march.target] === targetId) total += march.troops;
  for (const boat of r.boats) if (boat.a === attackerId && r.owner[boat.L] === targetId) total += boat.troops;
  return total;
}
function cancelIncomingAttacks(r, attackerId, targetId) {
  for (const attack of r.attacks) {
    if (!attack.done && attack.a === attackerId && attack.t === targetId) {
      if (r.players[attackerId].alive) r.players[attackerId].bal += attack.troops;
      attack.done = true;
    }
  }
  r.attacks = r.attacks.filter(attack => !attack.done);
  r.marches = r.marches.filter(march => {
    if (march.a !== attackerId || r.owner[march.target] !== targetId) return true;
    if (r.players[attackerId].alive) r.players[attackerId].bal += march.troops;
    return false;
  });
  r.boats = r.boats.filter(boat => {
    if (boat.a !== attackerId || r.owner[boat.L] !== targetId) return true;
    if (r.players[attackerId].alive) r.players[attackerId].bal += boat.troops;
    return false;
  });
}
function acceptPeaceOffer(r, responder, offerId, accept) {
  const index = r.peaceOffers.findIndex(offer => offer.id === Number(offerId) && offer.to === responder.id && offer.expiresAt > r.t);
  if (index < 0) return actionError(r, responder, 'Aquesta proposta de pau ja no és activa.');
  const offer = r.peaceOffers[index], payer = r.players[offer.from];
  if (!accept || !payer || !payer.alive || !responder.alive || payer.money < offer.amount ||
      incomingArmy(r, responder.id, payer.id) <= 0) {
    r.peaceOffers.splice(index, 1);
    if (payer) sendPlayer(r, payer.id, { t: 'peaceResult', accepted: false, name: responder.name });
    status(r);
    return;
  }
  payer.money -= offer.amount;
  responder.money += offer.amount;
  r.ceasefires.set(pair(payer.id, responder.id), r.t + PEACE_DURATION);
  cancelIncomingAttacks(r, responder.id, payer.id);
  r.peaceOffers.splice(index, 1);
  sendPlayer(r, payer.id, { t: 'peaceResult', accepted: true, name: responder.name, amount: offer.amount });
  sendPlayer(r, responder.id, { t: 'peaceResult', accepted: true, name: payer.name, amount: offer.amount });
  status(r);
}
function proposePeace(r, payer, attackerId, amountValue) {
  const attacker = r.players[attackerId], amount = validQuantity(amountValue);
  if (!payer.alive || !attacker || attacker === payer || !attacker.alive || !amount ||
      payer.money < amount || incomingArmy(r, attacker.id, payer.id) <= 0) {
    return actionError(r, payer, 'No pots proposar pau: cal una oferta vàlida i un atac en curs.');
  }
  const offer = { id: r.nextMarketId++, from: payer.id, to: attacker.id, amount, expiresAt: r.t + 300 };
  r.peaceOffers.push(offer);
  if (attacker.bot) {
    const threshold = Math.max(500, Math.ceil(incomingArmy(r, attacker.id, payer.id) * 5));
    acceptPeaceOffer(r, attacker, offer.id, amount >= threshold);
    return;
  }
  sendPlayer(r, attacker.id, { t: 'peaceOffer', id: offer.id, from: payer.id, name: payer.name, amount });
  status(r);
}
function botMarketThink(r, bot) {
  for (const request of r.shipRequests) {
    if (request.remaining <= 0 || request.expiresAt <= r.t || request.buyer === bot.id) continue;
    if (r.shipOffers.some(offer => offer.request === request.id && offer.seller === bot.id && offer.remaining > 0)) continue;
    const available = Math.floor(bot.ships - reservedShips(r, bot.id));
    const price = SHIP_PRICE;
    if (available > 0 && request.maxPrice >= price) {
      r.shipOffers.push({ id: r.nextMarketId++, request: request.id, seller: bot.id,
        remaining: Math.min(available, request.remaining), price, expiresAt: request.expiresAt });
    }
  }
}
function cancelShipRequest(r, buyer, requestId) {
  const request = r.shipRequests.find(item => item.id === Number(requestId) && item.buyer === buyer.id && item.remaining > 0);
  if (!request) return actionError(r, buyer, 'La demanda ja no existeix.');
  request.remaining = 0;
  for (const offer of r.shipOffers) if (offer.request === request.id) offer.remaining = 0;
  status(r);
}
function cancelShipOffer(r, seller, offerId) {
  const offer = r.shipOffers.find(item => item.id === Number(offerId) && item.seller === seller.id && item.remaining > 0);
  if (!offer) return actionError(r, seller, 'L’oferta ja no existeix.');
  offer.remaining = 0;
  status(r);
}
function send(r, o) { const s = JSON.stringify(o); for (const c of r.clients) if (c.readyState === 1) c.send(s); }
function tick(r) {
  r.pulse = (r.pulse || 0) + 1;
  if (r.state === 'playing') {
    r.t++;
    for (const [key, until] of r.ceasefires) if (until <= r.t) r.ceasefires.delete(key);
    r.shipRequests = r.shipRequests.filter(request => request.expiresAt > r.t && request.remaining > 0);
    r.shipOffers = r.shipOffers.filter(offer => offer.expiresAt > r.t && offer.remaining > 0);
    r.peaceOffers = r.peaceOffers.filter(offer => offer.expiresAt > r.t);
    if (r.mode === 'economic') {
      for (const p of r.players) if (p && p.bot && p.alive) botMarketThink(r, p);
      runMarches(r);
    }
    runAttacks(r); runBoats(r);
    for (const p of r.players) if (p && p.alive && p.tiles === 0) {
      p.alive = false;
      p.bal = 0;
      cleanupPlayerState(r, p.id);
    }
    const alive = r.players.slice(1).filter(p => p.alive);
    if (alive.length <= 1) { r.state = 'over'; r.winner = alive.length ? alive[0].id : 0; r.attacks = []; r.boats = []; }
    if (r.t % 5 === 0) {
      for (const p of r.players) {
        if (!p || !p.alive) continue;
        if (r.mode === 'economic') {
          processEconomicPlayer(r, p);
          p.rate = 0;
        } else {
          p.rate = .02 * Math.max(0, 1 - p.bal / (100 * p.tiles));
          p.bal += p.tiles * .3 + p.bal * p.rate;
        }
        if (p.bot) {
          if (r.mode === 'economic') botEconomicThink(r, p);
          if (Math.random() < .4 + .5 * p.skill) botThink(r, p);
        }
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
      let room;
      if (code) room = rooms[code];
      else {
        let newCode;
        do {
          newCode = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.random() * 24 | 0]).join('');
        } while (rooms[newCode]);
        const territory = Object.hasOwn(regions, d.territory) || d.territory === 'random' ? d.territory : 'random';
        room = newRoom(newCode, d.mode === 'economic' ? 'economic' : 'classic', territory);
      }
      if (room.clients.size >= 4) return ws.send(JSON.stringify({ t: 'err', m: 'Sala plena' }));
      if (room.state !== 'lobby') return ws.send(JSON.stringify({ t: 'err', m: 'La partida ja ha començat' }));
      r = room; p = addPlayer(r, String(d.name || 'Jugador').slice(0, 16), 0, false); r.clients.add(ws);
      ws.playerId = p.id;
      if (!r.host) r.host = p.id;
      ws.send(JSON.stringify({
        t: 'init', code: r.code, w: W, h: H, nb: NB, me: p.id, land: r.land, owner: Buffer.from(r.owner).toString('base64'),
        structures: Buffer.from(r.structures).toString('base64'), state: r.state, host: r.host, mode: r.mode, territory: r.territory
      }));
      status(r);
    } else if (r && d.t === 'spawn' && !p.alive) spawn(r, p, d.x | 0, d.y | 0);
    else if (r && d.t === 'start' && p.id === r.host && r.state === 'lobby') { r.state = 'playing'; r.t = 0; status(r); }
    else if (r && d.t === 'allocate' && r.mode === 'economic' && p.alive) {
      p.allocation = Math.min(100, Math.max(0, Number(d.value) || 0));
      p.bal = Math.min(p.bal, armyCapacity(p));
      status(r);
    } else if (r && d.t === 'build' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      if (!buildStructure(r, p, Number(d.i) | 0, d.building)) actionError(r, p, 'No pots construir aquí: comprova el territori, el cost i el límit de fàbriques.');
    } else if (r && d.t === 'shipRequest' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      createShipRequest(r, p, d.quantity, d.maxPrice);
    } else if (r && d.t === 'shipOffer' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      createShipOffer(r, p, d.request, d.quantity, d.price);
    } else if (r && d.t === 'shipAccept' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      acceptShipOffer(r, p, d.offer, d.quantity);
    } else if (r && d.t === 'shipRequestCancel' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      cancelShipRequest(r, p, d.request);
    } else if (r && d.t === 'shipOfferCancel' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      cancelShipOffer(r, p, d.offer);
    } else if (r && d.t === 'peaceOffer' && r.mode === 'economic' && r.state === 'playing' && p.alive) {
      proposePeace(r, p, d.to | 0, d.amount);
    } else if (r && d.t === 'peaceReply' && r.mode === 'economic' && r.state === 'playing') {
      acceptPeaceOffer(r, p, d.offer, !!d.accept);
    } else if (r && d.t === 'restart' && p.id === r.host && r.state === 'over') {
      r.owner = loadMap(r.territory); r.structures = new Uint8Array(W * H); r.cityPopulation = new Float32Array(W * H); r.attacks = []; r.boats = []; r.marches = []; r.shipRequests = []; r.shipOffers = []; r.peaceOffers = []; r.ceasefires.clear(); r.ch = []; r.t = 0; r.winner = 0; r.state = 'lobby'; r.pacts.clear(); r.pactRequests.clear();
      for (const player of r.players.slice(1)) {
        player.tiles = 0; player.alive = false; player.bal = 100; player.money = STARTING_MONEY;
        player.allocation = 35; player.population = 0; player.rate = 0;
        player.ships = 0; player.shipProgress = 0;
      }
      r.land = 0; for (const v of r.owner) if (v === 0) r.land++;
      reindexRoom(r);
      for (const bot of r.players.slice(1).filter(player => player.bot)) {
        for (let k = 0; k < 300 && !bot.alive; k++)spawn(r, bot, Math.random() * W | 0, Math.random() * H | 0);
      }
      r.ch = []; send(r, { t: 'reset', owner: Buffer.from(r.owner).toString('base64'), structures: Buffer.from(r.structures).toString('base64') }); status(r);
    } else if (r && d.t === 'atk') attack(r, p, d.x | 0, d.y | 0, +d.pct || .3, !!d.betray, { mode: d.expeditionMode, amount: d.amount });
    else if (r && d.t === 'boat') boat(r, p, d.x | 0, d.y | 0, +d.pct || .3, !!d.betray, { mode: d.expeditionMode, amount: d.amount });
    else if (r && d.t === 'pact' && r.state === 'playing') {
      const o = r.players[d.to | 0], key = `${p.id}:${d.to | 0}`;
      if (o && !o.bot && o !== p && o.alive && p.alive && !allied(r, p.id, o.id)) {
        r.pactRequests.add(key);
        for (const c of r.clients) if (c.playerId === o.id && c.readyState === 1) c.send(JSON.stringify({ t: 'pactRequest', from: p.id, name: p.name }));
      }
    } else if (r && d.t === 'pactReply' && r.state === 'playing') {
      const from = d.from | 0, key = `${from}:${p.id}`;
      if (r.pactRequests.delete(key) && d.accept && p.alive && r.players[from] && r.players[from].alive) {
        r.pacts.add(pair(from, p.id)); status(r);
      }
    } else if (r && d.t === 'give' && r.state === 'playing') {
      const o = r.players[d.to | 0];
      if (o && !o.bot && o !== p && o.alive && p.alive) {
        const available = Math.max(0, p.bal);
        const capacity = r.mode === 'economic' ? Math.max(0, armyCapacity(o) - o.bal) : Infinity;
        const a = Math.min(available * Math.min(.5, Math.max(.01, +d.pct || .25)), capacity);
        if (a > 0) {
          p.bal -= a; o.bal += a;
        }
      }
    }
  });
  ws.playerId = null;
  ws.on('close', () => {
    if (!r) return; r.clients.delete(ws);
    if (p.alive) { for (let i = 0; i < W * H; i++)if (r.owner[i] === p.id) set(r, i, 0); p.alive = false; p.bal = 0; }
    cleanupPlayerState(r, p.id);
    if (r.host === p.id) { const next = [...r.clients].map(c => c.playerId).find(id => id); r.host = next || 0; }
    status(r);
    if (!r.clients.size) { clearInterval(r.timer); delete rooms[r.code]; }
  });
});
if (require.main === module) {
  server.listen(process.env.PORT || 3000, () => console.log('Servidor a http://localhost:' + (process.env.PORT || 3000)));
}
module.exports = {
  W, H, WATER, STRUCTURE, STARTING_MONEY, CIVILIAN_INCOME_RATE, SHIP_PRICE, PEACE_DURATION, addPlayer, spawn, buildingCounts,
  armyCapacity, populationGrowthRate, economicWorkforce, economyStatus, combatEfficiency, buildStructure, processEconomicPlayer,
  createShipRequest, createShipOffer, acceptShipOffer, orderMarch, findMarchPath, runMarches,
  runAttacks, proposePeace, acceptPeaceOffer, incomingArmy, botMarketThink, attack, boat
};
