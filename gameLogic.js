// Pure game-logic functions, kept separate from server.js (Express/Socket.io/
// Supabase wiring) specifically so they can be unit tested without needing to
// spin up a real server or database connection. Nothing in this file has any
// side effects or I/O.

const crypto = require('crypto');

// Mirrors the client's card generation exactly (same seeded PRNG) so the
// server can independently verify a claimed card without trusting the client.
// NOTE: this PRNG is intentionally deterministic (not crypto-random) - a
// given card number always produces the same 5x5 layout, the same way a
// physical bingo card always has the same numbers printed on it. The actual
// randomness in the game comes from which numbers get drawn, not from the
// card layout - see drawRandomBall() below, which IS crypto-secure.
function seededRand(s) {
  return () => { s = (s * 1664525 + 1013904223) & 0xFFFFFFFF; return (s >>> 0) / 0xFFFFFFFF; };
}

function genCard(n) {
  const r = seededRand(n * 31337);
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const card = ranges.map(([lo, hi]) => {
    const pool = [];
    for (let i = lo; i <= hi; i++) pool.push(i);
    const picks = [];
    while (picks.length < 5) {
      const idx = Math.floor(r() * pool.length);
      picks.push(pool.splice(idx, 1)[0]);
    }
    return picks;
  });
  card[2][2] = 0; // free space
  return card;
}

// Checks only rows/columns (no diagonals), matching the client's own win check.
function cardHasWinningLine(cardNum, drawnNumbers) {
  const card = genCard(cardNum);
  const calledSet = new Set(drawnNumbers);
  const isMarked = (c, r) => card[c][r] === 0 || calledSet.has(card[c][r]);
  for (let i = 0; i < 5; i++) {
    if ([0, 1, 2, 3, 4].every(j => isMarked(j, i))) return true; // row i
    if ([0, 1, 2, 3, 4].every(j => isMarked(i, j))) return true; // column i
  }
  return false;
}

// Cryptographically-secure random round ID (6 digits, as a string, matching
// the existing format so nothing downstream needs to change).
function generateRoundId() {
  return String(crypto.randomInt(100000, 1000000));
}

// Cryptographically-secure pick of one remaining ball from the pool.
// Returns the drawn number; does NOT mutate the input array.
function drawRandomBall(ballPool) {
  if (!ballPool || ballPool.length === 0) return null;
  const idx = crypto.randomInt(0, ballPool.length);
  return ballPool[idx];
}

// Pot-based payout: the winner gets a percentage of what was actually
// collected in entry fees for that round, not a fixed number regardless of
// how many players joined. Rounds down to the nearest whole unit of currency.
function computePayout(totalPot, payoutPercentage) {
  if (!totalPot || totalPot <= 0) return 0;
  return Math.floor(totalPot * payoutPercentage);
}

module.exports = {
  seededRand,
  genCard,
  cardHasWinningLine,
  generateRoundId,
  drawRandomBall,
  computePayout,
};
