const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server');

function makeRoom(mode = 'economic') {
  return {
    mode, state: 'playing', host: 0, winner: 0, land: 0, t: 0, stances: { eco: 20, bal: 45, mob: 75 },
    players: [null], buildings: [null], cityTiles: [null], territoryTiles: [new Set()],
    owner: new Uint8Array(game.W * game.H).fill(0),
    structures: new Uint8Array(game.W * game.H),
    rad: new Int32Array(game.W * game.H),
    cityPopulation: new Float32Array(game.W * game.H),
    attacks: [], boats: [], marches: [], shipRequests: [], shipOffers: [], peaceOffers: [],
    nextMarketId: 1, ceasefires: new Map(), ch: [], clients: new Set(), pacts: new Set(), pactRequests: new Set()
  };
}

function addTestPlayer(room, name, team = 0, bot = false) {
  const player = game.addPlayer(room, name, team, bot);
  player.alive = true;
  return player;
}

function claim(room, player, x, y) {
  const i = y * game.W + x;
  room.owner[i] = player.id;
  player.tiles++;
  room.territoryTiles[player.id].add(i);
  return i;
}

test('economic players start with 10,000 euros; civilians produce income and ships', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id] = { cities: 1, shipyards: 1, armsFactories: 1 };
  room.cityTiles[player.id].add(0);
  room.cityPopulation[0] = 500;
  player.population = 500;
  player.allocation = 40;
  player.bal = 198;

  assert.equal(player.money, 10000);
  game.processEconomicPlayer(room, player);
  assert.equal(player.population, 502.5);
  assert.equal(player.money, 10007.5);
  assert.equal(player.bal, 201);
  assert.equal(game.economyStatus(room, player).shipRate, 0.1);

  for (let i = 0; i < 10; i++) game.processEconomicPlayer(room, player);
  assert.equal(player.ships, 1);
});

test('economic spawn assigns starting residents to the starting city', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.state = 'lobby';
  room.owner.fill(0);

  assert.equal(game.spawn(room, player, 20, 20), true);
  assert.equal(player.population, 600);
  assert.equal(room.cityPopulation[20 * game.W + 20], 600);
});

test('population growth stays within the capacity of owned cities', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id].cities = 1;
  room.cityTiles[player.id].add(0);
  room.cityPopulation[0] = 999.9;
  player.population = 999.9;
  player.allocation = 35;

  game.processEconomicPlayer(room, player);
  assert.ok(player.population <= 1000.00001);
  assert.equal(game.economyStatus(room, player).populationGrowthRate, 0);
});

test('city, shipyard, and arms factory investments charge euros and track buildings', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  player.money = 10000;
  player.population = 1000;
  room.buildings[player.id].cities = 1;
  const shipyard = claim(room, player, 20, 20);
  assert.equal(game.buildStructure(room, player, shipyard, 'shipyard'), true);
  assert.equal(player.money, 6000);
  assert.equal(game.buildingCounts(room, player.id).shipyards, 1);

  const arms = claim(room, player, 21, 20);
  assert.equal(game.buildStructure(room, player, arms, 'armsFactory'), true);
  assert.equal(player.money, 2500);
  assert.equal(game.buildingCounts(room, player.id).armsFactories, 1);
  assert.equal(game.buildStructure(room, player, claim(room, player, 22, 20), 'carFactory'), false);
});

test('banks require a city, cost 3,000 euros, are economic-only, and cap at five', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  player.money = 20000;
  const firstBank = claim(room, player, 20, 20);
  assert.equal(game.buildStructure(room, player, firstBank, 'bank'), false);

  room.buildings[player.id].cities = 1;
  assert.equal(game.buildStructure(room, player, firstBank, 'bank'), true);
  assert.equal(player.money, 17000);
  for (let i = 1; i < 5; i++) {
    assert.equal(game.buildStructure(room, player, claim(room, player, 20 + i, 20), 'bank'), true);
  }
  assert.equal(game.buildingCounts(room, player.id).banks, 5);
  assert.equal(game.buildStructure(room, player, claim(room, player, 25, 20), 'bank'), false);

  const classic = makeRoom('classic'), classicPlayer = addTestPlayer(classic, 'Classic');
  classic.buildings[classicPlayer.id].cities = 1;
  assert.equal(game.buildStructure(classic, classicPlayer, claim(classic, classicPlayer, 20, 20), 'bank'), false);
});

test('each bank needs 100 civilians for its full 25-euro income', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id] = { cities: 1, shipyards: 0, armsFactories: 0, banks: 2 };
  player.population = 198;
  player.allocation = 50;
  let economy = game.economyStatus(room, player);
  assert.equal(economy.banks, 2);
  assert.equal(economy.staffedBanks, 0);
  assert.equal(economy.incomeRate, 2.475);

  player.population = 200;
  economy = game.economyStatus(room, player);
  assert.equal(economy.staffedBanks, 1);
  assert.equal(economy.incomeRate, 27.5);
  game.processEconomicPlayer(room, player);
  assert.equal(player.money, 10027.5);
});

test('economic bots build banks when they can fully staff them', () => {
  const room = makeRoom(), bot = addTestPlayer(room, 'Bot', 1, true);
  bot.skill = 0.5;
  bot.money = 3000;
  bot.population = 600;
  room.buildings[bot.id].cities = 1;
  claim(room, bot, 20, 20);

  game.botEconomicThink(room, bot);

  assert.equal(game.buildingCounts(room, bot.id).banks, 1);
  assert.equal(bot.money, 0);
});

test('arms factories increase combat effectiveness while classic mode stays unchanged', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id].armsFactories = 2;
  assert.equal(game.combatEfficiency(room, player.id), 1.2);
  player.bal = 100;
  claim(room, player, 20, 20);
  game.orderMarch(room, player, 21, 20, 0.5, { mode: 'exact', amount: 50 });
  game.runMarches(room);
  assert.equal(room.attacks[0].efficiency, 1.2);

  room.buildings[player.id].armsFactories = 20;
  assert.equal(game.combatEfficiency(room, player.id), 2);
  room.mode = 'classic';
  assert.equal(game.combatEfficiency(room, player.id), 1);
});

test('ship requests accept priced offers atomically and allow partial fills', () => {
  const room = makeRoom(), buyer = addTestPlayer(room, 'Buyer'), seller = addTestPlayer(room, 'Seller');
  seller.ships = 4;
  game.createShipRequest(room, buyer, 3, 2000);
  const requestId = room.shipRequests[0].id;
  game.createShipOffer(room, seller, requestId, 3, 1500);
  const offerId = room.shipOffers[0].id;
  game.acceptShipOffer(room, buyer, offerId, 2);

  assert.equal(buyer.money, 7000);
  assert.equal(seller.money, 13000);
  assert.equal(buyer.ships, 2);
  assert.equal(seller.ships, 2);
  assert.equal(room.shipRequests[0].remaining, 1);
  assert.equal(room.shipOffers[0].remaining, 1);
});

test('ship market rejects unaffordable or over-stocked trades without transfers', () => {
  const room = makeRoom(), buyer = addTestPlayer(room, 'Buyer'), seller = addTestPlayer(room, 'Seller');
  seller.ships = 2;
  game.createShipRequest(room, buyer, 2, 9000);
  game.createShipOffer(room, seller, room.shipRequests[0].id, 2, 8000);
  const offerId = room.shipOffers[0].id;
  buyer.money = 1000;

  game.acceptShipOffer(room, buyer, offerId, 1);
  assert.equal(buyer.money, 1000);
  assert.equal(seller.money, 10000);
  assert.equal(buyer.ships, 0);
  assert.equal(seller.ships, 2);

  game.createShipRequest(room, buyer, 3, 500);
  game.createShipOffer(room, seller, room.shipRequests[1].id, 3, 400);
  assert.equal(room.shipOffers.length, 1);
});

test('bots offer ships in response to requests within the requested price limit', () => {
  const room = makeRoom(), buyer = addTestPlayer(room, 'Buyer'), bot = addTestPlayer(room, 'Bot', 1, true);
  bot.ships = 3;
  game.createShipRequest(room, buyer, 2, game.SHIP_PRICE);
  game.botMarketThink(room, bot);

  assert.equal(room.shipOffers.length, 1);
  assert.equal(room.shipOffers[0].seller, bot.id);
  assert.equal(room.shipOffers[0].remaining, 2);
  assert.equal(room.shipOffers[0].price, game.SHIP_PRICE);
});

test('land marches expand from a neutral target instead of capturing only one pixel', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A');
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  const target = 5 * game.W + 5;

  game.orderMarch(room, attacker, 5, 5, 0.5, { mode: 'exact', amount: 100 });
  assert.equal(room.marches.length, 1);
  game.runMarches(room);
  assert.equal(room.owner[5 * game.W + 3], 0);
  assert.equal(room.owner[target], 0);
  game.runMarches(room);
  assert.equal(room.owner[target], 0);
  for (let i = 0; i < 30 && room.attacks.length === 0; i++) game.runMarches(room);
  for (let i = 0; i < 30 && room.attacks.length; i++) game.runAttacks(room);

  assert.equal(room.owner[target], attacker.id);
  assert.ok(attacker.tiles > 1);
});

test('marches reach an enemy border when the clicked tile is inside its territory', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A'), defender = addTestPlayer(room, 'B');
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  for (let y = 5; y <= 7; y++) for (let x = 10; x <= 12; x++) claim(room, defender, x, y);
  const clicked = 6 * game.W + 11;

  game.orderMarch(room, attacker, 11, 6, 0.5, { mode: 'exact', amount: 50 });

  assert.equal(room.marches.length, 1);
  const march = room.marches[0];
  assert.notEqual(march.target, clicked);
  assert.equal(room.owner[march.target], defender.id);
  assert.ok(march.path.slice(0, -1).every(i => room.owner[i] !== defender.id));
  for (let i = 0; i < 50 && room.marches.length; i++) game.runMarches(room);
  assert.equal(room.attacks[0].t, defender.id);
});

test('land expansion does not turn foreign transit territory into a route', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A'), foreign = addTestPlayer(room, 'B');
  claim(room, attacker, 1, 5);
  for (let y = 0; y < game.H; y++) claim(room, foreign, 2, y);
  const target = 5 * game.W + 3;

  assert.equal(game.findMarchPath(room, attacker, target), null);
});

test('marches wait at the shore without a ship, then resume after one is available', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A');
  room.owner.fill(game.WATER);
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  const target = 5 * game.W + 5;
  room.owner[target] = 0;
  room.territoryTiles[0].add(target);

  game.orderMarch(room, attacker, 5, 5, 0.5, { mode: 'exact', amount: 100 });
  game.runMarches(room);
  assert.equal(room.marches[0].waitingShip, true);
  assert.equal(room.owner[target], 0);
  assert.equal(attacker.bal, 0);

  attacker.ships = 1;
  for (let i = 0; i < 4; i++) game.runMarches(room);
  assert.equal(room.attacks.length, 1);
  game.runAttacks(room);
  assert.equal(room.owner[target], attacker.id);
  assert.equal(attacker.ships, 0);
  assert.equal(attacker.bal, 99);
});

test('marches choose a longer land route when ships are unavailable', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A');
  room.owner.fill(game.WATER);
  attacker.bal = 100;
  for (let x = 1; x <= 9; x++) room.owner[game.W + x] = 0;
  for (let y = 1; y <= 5; y++) {
    room.owner[y * game.W + 1] = 0;
    room.owner[y * game.W + 9] = 0;
  }
  claim(room, attacker, 1, 5);
  const target = 5 * game.W + 9;

  game.orderMarch(room, attacker, 9, 5, 0.5, { mode: 'exact', amount: 50 });
  assert.ok(room.marches[0].path.every(i => room.owner[i] !== game.WATER));
  for (let i = 0; i < 10 && room.marches.length; i++) game.runMarches(room);

  assert.equal(room.attacks.length, 1);
  for (let i = 0; i < 10 && room.attacks.length; i++) game.runAttacks(room);
  assert.equal(room.owner[target], attacker.id);
  assert.equal(attacker.ships, 0);
});

test('march routes cannot cross a foreign border without permission', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A'), foreign = addTestPlayer(room, 'B');
  claim(room, attacker, 1, 5);
  for (let y = 0; y < game.H; y++) claim(room, foreign, 2, y);
  const target = 5 * game.W + 3;

  assert.equal(game.findMarchPath(room, attacker, target), null);
  room.pacts.add('1:2');
  assert.ok(game.findMarchPath(room, attacker, target));
});

test('marches stop if a neutral destination becomes a teammate territory in transit', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A', 1), teammate = addTestPlayer(room, 'B', 1);
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  const target = 5 * game.W + 10;

  game.orderMarch(room, attacker, 10, 5, 0.5, { mode: 'exact', amount: 50 });
  game.runMarches(room);
  assert.equal(room.marches.length, 1);
  claim(room, teammate, 10, 5);
  game.runMarches(room);

  assert.equal(room.marches.length, 0);
  assert.equal(attacker.bal, 100);
});

test('marches stop if a foreign player captures the tile they occupy', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A'), foreign = addTestPlayer(room, 'B');
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  game.orderMarch(room, attacker, 10, 5, 0.5, { mode: 'exact', amount: 50 });
  game.runMarches(room);
  const occupied = room.marches[0].path[room.marches[0].index];
  assert.notEqual(occupied, room.marches[0].target);
  claim(room, foreign, occupied % game.W, (occupied / game.W) | 0);

  game.runMarches(room);

  assert.equal(room.marches.length, 0);
  assert.equal(attacker.bal, 100);
});

test('economic orders cannot target a teammate territory', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A', 2), teammate = addTestPlayer(room, 'B', 2);
  attacker.bal = 100;
  claim(room, attacker, 1, 5);
  claim(room, teammate, 2, 5);

  game.orderMarch(room, attacker, 2, 5, 0.5, { mode: 'exact', amount: 50 });

  assert.equal(room.marches.length, 0);
  assert.equal(attacker.bal, 100);
});

test('more soldiers per territory make a player harder to invade', () => {
  const attackScenario = density => {
    const room = makeRoom(), attacker = addTestPlayer(room, 'A'), defender = addTestPlayer(room, 'B');
    const target = claim(room, defender, 20, 20);
    for (let x = 21; x < 30; x++) claim(room, defender, x, 20);
    attacker.bal = 100;
    defender.bal = density * defender.tiles;
    room.attacks.push({ a: attacker.id, t: defender.id, troops: 50, efficiency: 1, fr: new Set([target]), done: false });
    game.runAttacks(room);
    return { room, attacker, defender, target };
  };
  const heavilyDefended = attackScenario(100);
  const lightlyDefended = attackScenario(10);

  assert.equal(heavilyDefended.room.owner[heavilyDefended.target], heavilyDefended.defender.id);
  assert.equal(lightlyDefended.room.owner[lightlyDefended.target], lightlyDefended.attacker.id);
});

test('paid peace cancels an active attack and blocks another attack for two minutes', () => {
  const room = makeRoom(), payer = addTestPlayer(room, 'Payer'), attacker = addTestPlayer(room, 'Attacker');
  const target = claim(room, payer, 10, 10);
  room.attacks.push({ a: attacker.id, t: payer.id, troops: 100, efficiency: 1, fr: new Set([target]), done: false });

  game.proposePeace(room, payer, attacker.id, 500);
  const offerId = room.peaceOffers[0].id;
  game.acceptPeaceOffer(room, attacker, offerId, true);
  assert.equal(payer.money, 9500);
  assert.equal(attacker.money, 10500);
  assert.equal(room.attacks.length, 0);
  assert.equal(room.ceasefires.get('1:2'), room.t + 600);

  game.attack(room, attacker, 10, 10, 1);
  assert.equal(room.marches.length, 0);
});

test('bots accept paid peace only above their deterministic threshold', () => {
  const room = makeRoom(), payer = addTestPlayer(room, 'Payer'), bot = addTestPlayer(room, 'Bot', 1, true);
  room.attacks.push({ a: bot.id, t: payer.id, troops: 200, efficiency: 1, fr: new Set([1]), done: false });
  game.proposePeace(room, payer, bot.id, 500);
  assert.equal(room.ceasefires.has('1:2'), false);
  game.proposePeace(room, payer, bot.id, 1000);
  assert.equal(room.ceasefires.get('1:2'), room.t + 600);
});

test('classic mode attacks remain immediate and do not require a ship', () => {
  const room = makeRoom('classic'), attacker = addTestPlayer(room, 'A'), defender = addTestPlayer(room, 'B');
  attacker.bal = 200;
  const target = claim(room, defender, 2, 1);
  claim(room, attacker, 1, 1);

  game.attack(room, attacker, 2, 1, 0.5);
  assert.equal(room.attacks.length, 1);
  assert.equal(room.marches.length, 0);
  assert.equal(attacker.ships, 0);
  assert.equal(target, game.W + 2);
});
