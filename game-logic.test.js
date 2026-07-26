// Run with: npm test  (uses Node's built-in test runner, no extra deps needed)
//
// These tests exercise gameLogic.js directly - pure functions with no
// Express/Socket.io/Supabase involved - so they run instantly and don't
// need a live database or server.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  genCard,
  cardHasWinningLine,
  generateRoundId,
  drawRandomBall,
  computePayout,
} = require('../gameLogic');

test('genCard: is deterministic - same card number always produces the same layout', () => {
  const a = genCard(42);
  const b = genCard(42);
  assert.deepEqual(a, b);
});

test('genCard: different card numbers produce different layouts', () => {
  const a = genCard(1);
  const b = genCard(2);
  assert.notDeepEqual(a, b);
});

test('genCard: has a free space at the center (column N, row 2)', () => {
  const card = genCard(117);
  assert.equal(card[2][2], 0);
});

test('genCard: each column only contains numbers from its correct B/I/N/G/O range', () => {
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const card = genCard(73);
  card.forEach((column, colIndex) => {
    const [lo, hi] = ranges[colIndex];
    column.forEach((value, rowIndex) => {
      if (colIndex === 2 && rowIndex === 2) return; // free space
      assert.ok(value >= lo && value <= hi, `card[${colIndex}][${rowIndex}]=${value} out of range [${lo},${hi}]`);
    });
  });
});

test('genCard: no duplicate numbers within a single card', () => {
  const card = genCard(5);
  const flat = card.flat().filter(v => v !== 0);
  assert.equal(new Set(flat).size, flat.length);
});

test('cardHasWinningLine: true once every number in a full row has been drawn', () => {
  const cardNum = 42;
  const card = genCard(cardNum);
  // Row 0 across all 5 columns (skip the free-space cell if it happens to fall here - it won't at row 0)
  const rowNumbers = [0, 1, 2, 3, 4].map(col => card[col][0]);
  assert.equal(cardHasWinningLine(cardNum, rowNumbers), true);
});

test('cardHasWinningLine: true once every number in a full column has been drawn', () => {
  const cardNum = 8;
  const card = genCard(cardNum);
  const colNumbers = card[0]; // full B column, 5 numbers, no free space here
  assert.equal(cardHasWinningLine(cardNum, colNumbers), true);
});

test('cardHasWinningLine: the free space counts as already marked (column N only needs the other 4)', () => {
  const cardNum = 3;
  const card = genCard(cardNum);
  const nColumnWithoutFree = [card[2][0], card[2][1], card[2][3], card[2][4]]; // skip row 2, the free space
  assert.equal(cardHasWinningLine(cardNum, nColumnWithoutFree), true);
});

test('cardHasWinningLine: false when no line is complete', () => {
  const cardNum = 99;
  assert.equal(cardHasWinningLine(cardNum, []), false);
  assert.equal(cardHasWinningLine(cardNum, [1, 2, 3]), false); // arbitrary, near-certainly not a full line
});

test('cardHasWinningLine: false for a near-miss (one number short of a full row)', () => {
  const cardNum = 61;
  const card = genCard(cardNum);
  const rowNumbers = [0, 1, 2, 3, 4].map(col => card[col][1]).filter((v, i) => i !== 4); // drop the last one
  assert.equal(cardHasWinningLine(cardNum, rowNumbers), false);
});

test('cardHasWinningLine: does NOT count a diagonal as a win (matches the client, which only checks rows/columns)', () => {
  const cardNum = 27;
  const card = genCard(cardNum);
  const diagonal = [card[0][0], card[1][1], card[3][3], card[4][4]]; // card[2][2] is the free space
  // A diagonal alone should not trigger a win unless it happens to also complete a real row/column.
  assert.equal(cardHasWinningLine(cardNum, diagonal), false);
});

test('generateRoundId: produces a 6-digit numeric string', () => {
  for (let i = 0; i < 20; i++) {
    const id = generateRoundId();
    assert.match(id, /^\d{6}$/);
  }
});

test('generateRoundId: is not trivially predictable (spot check for variety across calls)', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateRoundId()));
  assert.ok(ids.size > 1, 'expected some variety across 50 generated round IDs');
});

test('drawRandomBall: returns a value from the pool and does not mutate it', () => {
  const pool = [5, 12, 33, 61];
  const poolCopy = [...pool];
  const drawn = drawRandomBall(pool);
  assert.ok(poolCopy.includes(drawn));
  assert.deepEqual(pool, poolCopy); // unchanged
});

test('drawRandomBall: returns null for an empty pool', () => {
  assert.equal(drawRandomBall([]), null);
});

test('computePayout: winner gets the configured percentage of the pot, rounded down', () => {
  assert.equal(computePayout(100, 0.8), 80);
  assert.equal(computePayout(150, 0.8), 120);
  assert.equal(computePayout(101, 0.8), 80); // 80.8 -> floor to 80, never overpay
});

test('computePayout: zero or negative pot pays out nothing', () => {
  assert.equal(computePayout(0, 0.8), 0);
  assert.equal(computePayout(-50, 0.8), 0);
});

test('computePayout: never pays out more than the pot itself, even at 100%', () => {
  const pot = 37;
  assert.ok(computePayout(pot, 1) <= pot);
});
