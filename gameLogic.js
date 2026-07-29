const crypto = require('crypto');

// Mirrors the client's card generation exactly (same seeded PRNG) so the
// server can independently verify a claimed card without trusting the client.
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

// Checks rows, columns, diagonals, AND four corners
function cardHasWinningLine(cardNum, drawnNumbers) {
  const card = genCard(cardNum);
  const calledSet = new Set(drawnNumbers);
  const isMarked = (c, r) => card[c][r] === 0 || calledSet.has(card[c][r]);

  // 1. Horizontal rows (5 across)
  for (let r = 0; r < 5; r++) {
    if ([0, 1, 2, 3, 4].every(c => isMarked(c, r))) return true;
  }
  // 2. Vertical columns (5 down)
  for (let c = 0; c < 5; c++) {
    if ([0, 1, 2, 3, 4].every(r => isMarked(c, r))) return true;
  }
  // 3. Main Diagonal (top-left to bottom-right)
  if ([0, 1, 2, 3, 4].every(i => isMarked(i, i))) return true;

  // 4. Anti Diagonal (top-right to bottom-left)
  if ([0, 1, 2, 3, 4].every(i => isMarked(4 - i, i))) return true;

  // 5. Four Corners (top-left, top-right, bottom-left, bottom-right)
  if (isMarked(0, 0) && isMarked(4, 0) && isMarked(0, 4) && isMarked(4, 4)) return true;

  return false;
}

// Cryptographically-secure random round ID (6 digits)
function generateRoundId() {
  return String(crypto.randomInt(100000, 1000000));
}

// Cryptographically-secure pick of one remaining ball from the pool.
function drawRandomBall(ballPool) {
  if (!ballPool || ballPool.length === 0) return null;
  const idx = crypto.randomInt(0, ballPool.length);
  return ballPool[idx];
}

// Pot-based payout
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
