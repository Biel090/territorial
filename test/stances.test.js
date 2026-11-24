const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../server');

test('new rooms default and clamp posture percentages; economic spawn starts balanced', () => {
  const room = game.newRoom('STNC', 'economic', 'random', { eco: 130, mob: -2 });
  try {
    assert.deepEqual(room.stances, { eco: 100, bal: 45, mob: 0 });
    const player = game.addPlayer(room, 'Player', 0, false);
    room.owner.fill(0);
    assert.equal(game.spawn(room, player, 20, 20), true);
    assert.equal(player.allocation, room.stances.bal);
  } finally {
    clearInterval(room.timer);
  }
});
