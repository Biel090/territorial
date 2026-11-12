const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server');

function makeRoom() {
  return {
    mode: 'classic', state: 'playing', t: 0,
    players: [null], buildings: [null], cityTiles: [null], territoryTiles: [new Set()],
    owner: new Uint8Array(game.W * game.H).fill(0),
    structures: new Uint8Array(game.W * game.H),
    cityPopulation: new Float32Array(game.W * game.H),
    attacks: [], boats: [], marches: [], pacts: new Set(), pactRequests: new Set(),
    ceasefires: new Map(), ch: [], clients: new Set()
  };
}

function addPlayer(room, name, bot = false) {
  const player = game.addPlayer(room, name, 0, bot);
  player.alive = true;
  return player;
}

function claim(room, player, x, y) {
  const index = y * game.W + x;
  room.owner[index] = player.id;
  player.tiles++;
  room.territoryTiles[player.id].add(index);
  return index;
}

test('classic land clicks send every available soldier regardless of client percentage', () => {
  const room = makeRoom(), attacker = addPlayer(room, 'Attacker'), defender = addPlayer(room, 'Defender');
  attacker.bal = 250;
  claim(room, attacker, 1, 5);
  claim(room, defender, 2, 5);

  game.attack(room, attacker, 2, 5, 0.1);

  assert.equal(attacker.bal, 0);
  assert.equal(room.attacks.length, 1);
  assert.equal(room.attacks[0].troops, 250);
});

test('classic naval clicks send every available soldier', () => {
  const room = makeRoom(), attacker = addPlayer(room, 'Attacker'), defender = addPlayer(room, 'Defender');
  room.owner.fill(game.WATER);
  attacker.bal = 180;
  claim(room, attacker, 1, 5);
  claim(room, defender, 5, 5);

  game.boat(room, attacker, 5, 5, 0.2);

  assert.equal(attacker.bal, 0);
  assert.equal(room.boats.length, 1);
  assert.equal(room.boats[0].troops, 180 * 0.96875);
});

test('classic pact blocks an attack until explicitly betrayed', () => {
  const room = makeRoom(), attacker = addPlayer(room, 'Attacker'), ally = addPlayer(room, 'Ally');
  attacker.bal = 120;
  const target = claim(room, ally, 2, 5);
  claim(room, attacker, 1, 5);
  room.pacts.add(`${attacker.id}:${ally.id}`);

  game.attack(room, attacker, 2, 5, 0.25);
  assert.equal(room.attacks.length, 0);
  assert.equal(attacker.bal, 120);

  game.attack(room, attacker, 2, 5, 0.25, true);
  assert.equal(room.pacts.size, 0);
  assert.equal(room.attacks[0].troops, 120);
  assert.ok(room.attacks[0].fr.has(target));
});
