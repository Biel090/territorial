const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server');

function makeRoom(mode = 'economic') {
  return {
    mode, state: 'playing', host: 0, winner: 0, land: 0,
    players: [null], buildings: [null], cityTiles: [null], territoryTiles: [new Set()],
    owner: new Uint8Array(game.W * game.H).fill(game.WATER),
    structures: new Uint8Array(game.W * game.H),
    cityPopulation: new Float32Array(game.W * game.H),
    attacks: [], boats: [], ch: [], clients: new Set(), pacts: new Set()
  };
}

function addTestPlayer(room, name, team = 0) {
  const player = game.addPlayer(room, name, team, false);
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

test('economic growth follows population and remains capped by city capacity', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id].cities = 1;
  room.cityTiles[player.id].add(0);
  room.cityPopulation[0] = 500;
  player.population = 500;
  player.allocation = 40;
  player.foodAllocation = 50;
  player.resources = 0;

  game.processEconomicPlayer(room, player);
  assert.equal(player.population, 502.5);
  assert.equal(player.food, 4.5);
  assert.equal(player.resources, 7.5);

  player.population = 999.9;
  room.cityPopulation[0] = 999.9;
  game.processEconomicPlayer(room, player);
  assert.ok(player.population <= 1000.00001);
});

test('specialized factories produce logistics and recruit only to allocated army capacity', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id] = { cities: 1, carFactories: 1, shipyards: 1, armsFactories: 1 };
  room.cityTiles[player.id].add(0);
  room.cityPopulation[0] = 1000;
  player.population = 1000;
  player.allocation = 20;
  player.foodAllocation = 0;
  player.bal = 198;

  game.processEconomicPlayer(room, player);
  assert.equal(player.bal, 200);
  assert.equal(game.economyStatus(room, player).carRate, 0.1);
  assert.equal(game.economyStatus(room, player).shipRate, 0.1);

  player.allocation = 0;
  player.foodAllocation = 0;
  player.bal = 0;
  player.carProgress = 0;
  player.shipProgress = 0;
  for (let i = 0; i < 10; i++) game.processEconomicPlayer(room, player);
  assert.equal(player.cars, 1);
  assert.equal(player.ships, 1);
});

test('factory construction updates the specialized factory counts', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  room.buildings[player.id].cities = 1;
  player.resources = 400;
  player.population = 1000;
  const i = claim(room, player, 20, 20);

  assert.equal(game.buildStructure(room, player, i, 'carFactory'), true);
  assert.equal(game.buildingCounts(room, player.id).carFactories, 1);
  assert.equal(room.structures[i], game.STRUCTURE.carFactory);
  claim(room, player, 21, 20);
  assert.equal(game.buildStructure(room, player, i + 1, 'armsFactory'), true);
  assert.equal(game.buildingCounts(room, player.id).armsFactories, 1);
});

test('fixed-price trades transfer listed stock and food atomically', () => {
  const room = makeRoom(), seller = addTestPlayer(room, 'Seller'), buyer = addTestPlayer(room, 'Buyer');
  seller.population = buyer.population = 1000;
  seller.allocation = buyer.allocation = 100;
  seller.bal = 50; seller.cars = 2; buyer.food = 500;

  game.setMarketOffer(room, seller, 'soldiers', 10);
  game.setMarketOffer(room, seller, 'cars', 2);
  game.buyFromPlayer(room, buyer, seller.id, 'soldiers', 5);
  game.buyFromPlayer(room, buyer, seller.id, 'cars', 1);

  assert.equal(seller.bal, 45);
  assert.equal(buyer.bal, 105);
  assert.equal(seller.food, 105);
  assert.equal(buyer.food, 395);
  assert.equal(seller.cars, 1);
  assert.equal(buyer.cars, 1);

  game.setMarketOffer(room, seller, 'cars', 0);
  game.buyFromPlayer(room, buyer, seller.id, 'cars', 1);
  assert.equal(seller.cars, 1);
  assert.equal(buyer.cars, 1);
});

test('market rejects sales that exceed buyer capacity without charging food', () => {
  const room = makeRoom(), seller = addTestPlayer(room, 'Bot'), buyer = addTestPlayer(room, 'Buyer');
  seller.bot = true;
  seller.population = buyer.population = 1000;
  seller.allocation = buyer.allocation = 100;
  seller.bal = 10; seller.offers.soldiers = 1;
  buyer.bal = 1000; buyer.food = 10;

  game.buyFromPlayer(room, buyer, seller.id, 'soldiers', 1);
  assert.equal(seller.bal, 10);
  assert.equal(seller.food, 0);
  assert.equal(buyer.bal, 1000);
  assert.equal(buyer.food, 10);
});

test('bots list only surplus soldiers and logistics automatically', () => {
  const room = makeRoom(), bot = addTestPlayer(room, 'Bot');
  bot.bot = true; bot.population = 1000; bot.allocation = 100;
  bot.bal = 800; bot.cars = 4; bot.ships = 3;

  game.updateBotOffers(bot);
  assert.equal(bot.offers.soldiers, 300);
  assert.equal(bot.offers.cars, 3);
  assert.equal(bot.offers.ships, 2);
});

test('direct vehicle purchases require resources and add inventory', () => {
  const room = makeRoom(), player = addTestPlayer(room, 'A');
  player.resources = 200;
  game.buyDirect(room, player, 'cars', 2);
  assert.equal(player.resources, 0);
  assert.equal(player.cars, 2);
});

test('land and sea expeditions consume the matching logistics; classic attacks do not', () => {
  const room = makeRoom(), attacker = addTestPlayer(room, 'A'), defender = addTestPlayer(room, 'B');
  attacker.population = 1000; attacker.allocation = 100; attacker.bal = 200; attacker.cars = 1;
  defender.population = 1000; defender.allocation = 100; defender.bal = 1;
  claim(room, attacker, 1, 1);
  const landTarget = claim(room, defender, 2, 1);

  game.attack(room, attacker, 2, 1, 0.5, false, { mode: 'exact', amount: 100 });
  assert.equal(attacker.bal, 100);
  assert.equal(attacker.cars, 0);
  assert.equal(room.attacks.length, 1);

  attacker.bal = 200; attacker.cars = 1; room.attacks = [];
  game.attack(room, attacker, 2, 1, 0.5, false, { mode: 'percent' });
  assert.equal(attacker.bal, 100);
  assert.equal(attacker.cars, 0);

  attacker.bal = 200; attacker.cars = 0; room.attacks = [];
  game.attack(room, attacker, 2, 1, 0.5, false, { mode: 'exact', amount: 100 });
  assert.equal(attacker.bal, 200);
  assert.equal(room.attacks.length, 0);

  room.owner.fill(game.WATER);
  room.territoryTiles[attacker.id].clear(); room.territoryTiles[defender.id].clear();
  attacker.tiles = defender.tiles = 0;
  claim(room, attacker, 1, 1); claim(room, defender, 10, 1);
  attacker.ships = 1;
  game.boat(room, attacker, 10, 1, 0.5, false, { mode: 'exact', amount: 100 });
  assert.equal(attacker.ships, 0);
  assert.equal(attacker.bal, 100);
  assert.equal(room.boats.length, 1);

  room.owner.fill(game.WATER);
  room.territoryTiles[attacker.id].clear(); room.territoryTiles[defender.id].clear();
  attacker.tiles = defender.tiles = 0;
  claim(room, attacker, 1, 1); claim(room, defender, 2, 1);
  room.mode = 'classic'; attacker.bal = 200;
  game.attack(room, attacker, 2, 1, 0.5);
  assert.equal(attacker.bal, 100);
  assert.equal(room.attacks.length, 1);
  assert.equal(landTarget, game.W + 2);
});
