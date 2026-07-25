require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const {
  genCard,
  cardHasWinningLine,
  generateRoundId,
  drawRandomBall,
  computePayout,
} = require('./gameLogic');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || "https://rsmobdnuyxqyynxtjkyi.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Game economy constants - authoritative on the server, never trusted   ---
// --- from the client. All can be tuned via env vars without a code change. ---
const CARD_PRICE = Number(process.env.CARD_PRICE) || 10;           // cost per card, in ETB
const PAYOUT_PERCENTAGE = Number(process.env.PAYOUT_PERCENTAGE) || 0.8; // winner gets 80% of the pot, house keeps 20%
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START) || 2;
const INITIAL_WAIT_SECONDS = Number(process.env.INITIAL_WAIT_SECONDS) || 40;
const RECHECK_WAIT_SECONDS = Number(process.env.RECHECK_WAIT_SECONDS) || 15; // how long to wait before re-checking player count
const POST_ROUND_PAUSE_SECONDS = Number(process.env.POST_ROUND_PAUSE_SECONDS) || 15;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ============================================================================
// TRANSACTION LEDGER - every balance change is recorded here, in addition to
// (never instead of) updating players.balance directly. This is what makes
// it possible to reconcile "where did this player's money go" after the
// fact, which a single mutable balance column can never answer on its own.
// ============================================================================
async function logTransaction({ player_id, type, amount, game_id = null, balance_after = null, notes = null }) {
  try {
    await supabase.from('transactions').insert([{
      player_id, type, amount, game_id, balance_after, notes,
    }]);
  } catch (err) {
    // A failed ledger write should never crash the request that triggered it,
    // but it absolutely should be visible in the logs - this is money we can
    // no longer account for if it silently disappears.
    console.error("FAILED TO LOG TRANSACTION (balance change happened, ledger entry did not):", err.message, { player_id, type, amount });
  }
}

async function creditPlayer(player_id, amount, { type, game_id = null, notes = null }) {
  const { data: player, error: fetchErr } = await supabase
    .from('players').select('balance').eq('player_id', player_id).single();
  if (fetchErr || !player) throw fetchErr || new Error(`Player ${player_id} not found while crediting.`);
  const newBalance = (Number(player.balance) || 0) + amount;
  const { error: updateErr } = await supabase.from('players').update({ balance: newBalance }).eq('player_id', player_id);
  if (updateErr) throw updateErr;
  await logTransaction({ player_id, type, amount, game_id, balance_after: newBalance, notes });
  return newBalance;
}

// ============================================================================
// ADMIN AUTH - a single shared secret (set as ADMIN_SECRET in your Render
// env vars), sent as an `x-admin-secret` header. This is intentionally
// simple (no per-admin accounts, no session expiry) - fine for one operator
// running their own panel, but if more than one person needs access, or this
// becomes business-critical, upgrade to real per-user accounts.
// ============================================================================
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET || '';
  if (!expected) {
    return res.status(500).json({ error: "Admin panel is not configured. Set ADMIN_SECRET in your environment variables." });
  }
  const provided = String(req.headers['x-admin-secret'] || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// --- API ROUTES ---

app.get('/api/health-check', async (req, res) => {
  try {
    const { error } = await supabase.from('players').select('count', { count: 'exact', head: true });
    if (error) throw error;
    res.json({ status: "online", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "online", database: "disconnected", error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, phone_number } = req.body;
  if (!username || !phone_number) {
    return res.status(400).json({ error: "Username and Phone Number are required." });
  }
  try {
    let { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('phone_number', phone_number)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    if (player) {
      return res.json({ isNew: false, user: player });
    } else {
      const { data: newPlayer, error: insertError } = await supabase
        .from('players')
        .insert([{ username, phone_number, balance: 10 }])
        .select()
        .single();

      if (insertError) throw insertError;
      return res.json({ isNew: true, user: newPlayer });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Active Match Re-entry Status
app.get('/api/games/check-active/:player_id/:game_id', async (req, res) => {
  try {
    const { player_id, game_id } = req.params;
    const { data, error } = await supabase
      .from('game_participants')
      .select('purchased_cards, is_winner, metadata')
      .eq('player_id', player_id)
      .eq('game_id', game_id)
      .maybeSingle();

    if (error) throw error;
    
    if (data) {
      let cardsList = [117]; 
      if (data.metadata && data.metadata.cards) {
        cardsList = data.metadata.cards;
      } else if (data.purchased_cards === 2) {
        cardsList = [117, 118];
      }
      return res.json({ 
        registered: true, 
        cards_bought: data.purchased_cards, 
        is_winner: data.is_winner,
        cards_list: cardsList
      });
    } else {
      return res.json({ registered: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player/:id', async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('player_id', req.params.id)
      .single();

    if (error) throw error;
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Which cards are already held by someone in a given round - used by the
// frontend to gray out cards other players have already taken, and enforced
// again server-side in /api/games/create (never trust the client alone).
app.get('/api/games/taken-cards/:game_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('game_participants')
      .select('metadata, purchased_cards')
      .eq('game_id', req.params.game_id);
    if (error) throw error;
    const taken = new Set();
    (data || []).forEach(row => {
      const cards = (row.metadata && row.metadata.cards) || [];
      cards.forEach(c => taken.add(Number(c)));
    });
    res.json({ taken: Array.from(taken) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// NOTE: the old /api/player/update-balance endpoint has been removed.
// It used to accept a raw balance value straight from the client with no
// validation, meaning anyone who knew a player_id could set their own
// balance to anything. Balance is now only ever changed server-side via
// creditPlayer()/direct deduction below, each paired with a transaction
// ledger entry - never from client input.

app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought, cards_list } = req.body;
  if (!player_id || !game_id || !cards_bought) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  const numCards = Number(cards_bought);
  if (!Number.isInteger(numCards) || numCards < 1 || numCards > 2) {
    return res.status(400).json({ success: false, error: "Invalid cards_bought." });
  }
  const requestedCards = Array.from(new Set((cards_list && cards_list.length ? cards_list : [117]).map(Number)));
  const cost = CARD_PRICE * numCards;

  try {
    // The round this join targets must still actually be open. Trusting the
    // client's cached game_id/state alone would allow joining a round that
    // has already started or ended (a race, or a stale/replayed request).
    if (game_id === currentActiveGameRoundId && globalGameState !== "waiting") {
      return res.status(400).json({ success: false, error: "round_not_open" });
    }

    const { data: playerRow, error: playerErr } = await supabase
      .from('players')
      .select('balance, is_banned')
      .eq('player_id', player_id)
      .single();
    if (playerErr || !playerRow) throw playerErr || new Error("Player not found.");

    if (playerRow.is_banned) {
      return res.status(403).json({ success: false, error: "banned" });
    }

    // Prevent joining the same round twice (e.g. a replayed/duplicate request)
    const { data: existing } = await supabase
      .from('game_participants')
      .select('player_id')
      .eq('player_id', player_id)
      .eq('game_id', game_id)
      .maybeSingle();
    if (existing) {
      return res.status(400).json({ success: false, error: "already_registered" });
    }

    // A given card layout is fixed forever by its card number (like a real
    // printed bingo card) - so two different players holding the same card
    // number in the same round would mean two people simultaneously "own"
    // an identical card. Block that here.
    const { data: otherParticipants } = await supabase
      .from('game_participants')
      .select('metadata')
      .eq('game_id', game_id);
    const takenCards = new Set();
    (otherParticipants || []).forEach(row => {
      const cards = (row.metadata && row.metadata.cards) || [];
      cards.forEach(c => takenCards.add(Number(c)));
    });
    const conflict = requestedCards.find(c => takenCards.has(c));
    if (conflict !== undefined) {
      return res.status(409).json({ success: false, error: "card_taken", card: conflict });
    }

    if (Number(playerRow.balance) < cost) {
      return res.status(400).json({ success: false, error: "insufficient_balance" });
    }

    const newBalance = Number(playerRow.balance) - cost;
    const { error: balErr } = await supabase
      .from('players')
      .update({ balance: newBalance })
      .eq('player_id', player_id);
    if (balErr) throw balErr;

    const { data, error } = await supabase
      .from('game_participants')
      .insert([{ 
        player_id, 
        game_id, 
        purchased_cards: numCards, 
        is_winner: false,
        metadata: { cards: requestedCards }
      }])
      .select()
      .single();

    if (error) {
      // Registration failed after the deduction - refund so the player isn't charged for nothing.
      // Note: this is a best-effort rollback, not a real transaction. For full atomicity this
      // whole flow should live inside a single Postgres function (RPC) instead.
      await supabase.from('players').update({ balance: playerRow.balance }).eq('player_id', player_id);
      throw error;
    }

    await logTransaction({
      player_id, type: 'entry_fee', amount: -cost, game_id,
      balance_after: newBalance, notes: `${numCards} card(s) @ ${CARD_PRICE} ETB`,
    });

    res.json({ success: true, participant: data, balance: newBalance });
  } catch (err) {
    console.error("games/create failed:", err.message, { player_id, game_id, cards_bought });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history/:player_id', async (req, res) => {
  try {
    const { player_id } = req.params;
    if (!player_id || player_id === 'undefined' || player_id === 'null') {
      return res.status(200).json([]);
    }
    const { data, error } = await supabase
      .from('game_participants') 
      .select('game_id, purchased_cards, is_winner')
      .eq('player_id', player_id);

    if (error) throw error;
    return res.status(200).json(data || []);
  } catch (catchErr) {
    return res.status(200).json([]); 
  }
});

// ============================================================================
// WALLET (manual, admin-approved deposits/withdrawals) - there is no real
// payment gateway wired in here (no Telegram Payments / telebirr / Chapa
// integration - that needs real merchant credentials this environment
// doesn't have). This is the plumbing for a manual process: a player asks to
// withdraw, the amount is held immediately (so it can't be double-spent
// while pending), and an admin approves/rejects after actually sending the
// money outside the app. Deposits work the same way in reverse via
// /api/admin/credit-player, after the operator manually confirms a real
// payment (e.g. a telebirr receipt sent to them). When you're ready to
// automate this, a gateway would plug in around /api/admin/credit-player
// (auto-credit on a verified webhook) and around withdrawal approval
// (auto-payout via API instead of a human clicking Approve).
// ============================================================================
app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { player_id, amount } = req.body;
  const amt = Number(amount);
  if (!player_id || !amt || amt <= 0) {
    return res.status(400).json({ success: false, error: "Invalid request." });
  }
  try {
    const { data: player, error: playerErr } = await supabase
      .from('players').select('balance, is_banned').eq('player_id', player_id).single();
    if (playerErr || !player) throw playerErr || new Error("Player not found.");
    if (player.is_banned) return res.status(403).json({ success: false, error: "banned" });
    if (Number(player.balance) < amt) {
      return res.status(400).json({ success: false, error: "insufficient_balance" });
    }

    const newBalance = Number(player.balance) - amt;
    const { error: updateErr } = await supabase.from('players').update({ balance: newBalance }).eq('player_id', player_id);
    if (updateErr) throw updateErr;

    const { data: request, error: insertErr } = await supabase
      .from('withdrawal_requests')
      .insert([{ player_id, amount: amt, status: 'pending' }])
      .select().single();
    if (insertErr) {
      await supabase.from('players').update({ balance: player.balance }).eq('player_id', player_id); // rollback
      throw insertErr;
    }

    await logTransaction({
      player_id, type: 'withdrawal_hold', amount: -amt,
      balance_after: newBalance, notes: `Withdrawal request #${request.id} pending admin approval`,
    });

    res.json({ success: true, balance: newBalance, request });
  } catch (err) {
    console.error("withdraw-request failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/wallet/withdrawals/:player_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('player_id', req.params.player_id)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ADMIN ROUTES - all require the x-admin-secret header (see requireAdmin above)
// ============================================================================
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const pot = await getRoundPot(currentActiveGameRoundId);
    const { count: participantCount } = await supabase
      .from('game_participants')
      .select('*', { count: 'exact', head: true })
      .eq('game_id', currentActiveGameRoundId);
    res.json({
      state: globalGameState,
      game_id: currentActiveGameRoundId,
      timeRemaining,
      drawnBallsHistory,
      pot,
      potentialPayout: computePayout(pot, PAYOUT_PERCENTAGE),
      participantCount: participantCount || 0,
      minPlayersToStart: MIN_PLAYERS_TO_START,
      cardPrice: CARD_PRICE,
      payoutPercentage: PAYOUT_PERCENTAGE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    if (!search) {
      const { data, error } = await supabase.from('players').select('*').limit(200);
      if (error) throw error;
      return res.json(data || []);
    }

    // Two separate lookups instead of one combined .or() - mixing a text
    // ilike with an exact match against player_id (whose real column type we
    // don't know here - uuid/bigint/text all vary by setup) risks a Postgres
    // type-cast error that would take down the whole search if it doesn't
    // match player_id's type. Doing them separately means a mismatch on one
    // just yields no results for that half, instead of a 500 for everything.
    const results = new Map();
    try {
      const { data } = await supabase
        .from('players').select('*')
        .or(`username.ilike.%${search}%,phone_number.ilike.%${search}%`)
        .limit(200);
      (data || []).forEach(p => results.set(p.player_id, p));
    } catch (err) { /* ignore, fall through to the id lookup */ }

    try {
      const { data } = await supabase.from('players').select('*').eq('player_id', search).limit(50);
      (data || []).forEach(p => results.set(p.player_id, p));
    } catch (err) { /* search string didn't match player_id's column type - fine, ignore */ }

    res.json(Array.from(results.values()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/players/:id/ban', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('players').update({ is_banned: true }).eq('player_id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/players/:id/unban', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('players').update({ is_banned: false }).eq('player_id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/credit-player', requireAdmin, async (req, res) => {
  const { player_id, amount, notes } = req.body;
  const amt = Number(amount);
  if (!player_id || !amt) return res.status(400).json({ success: false, error: "player_id and non-zero amount are required." });
  try {
    const newBalance = await creditPlayer(player_id, amt, { type: 'admin_credit', notes: notes || 'Manual admin credit' });
    res.json({ success: true, balance: newBalance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    let query = supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(limit);
    if (req.query.player_id) query = query.eq('player_id', req.query.player_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('withdrawal_requests').select('*').order('requested_at', { ascending: false }).limit(200);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { data: reqRow, error: fetchErr } = await supabase
      .from('withdrawal_requests').select('*').eq('id', req.params.id).single();
    if (fetchErr || !reqRow) throw fetchErr || new Error("Request not found.");
    if (reqRow.status !== 'pending') return res.status(400).json({ success: false, error: "Already resolved." });

    // The funds were already held (deducted) when the request was made -
    // approving just finalizes it. The admin is expected to have already
    // actually sent the money outside the app before clicking this.
    await supabase.from('withdrawal_requests').update({
      status: 'approved', resolved_at: new Date().toISOString(), resolved_by: 'admin',
    }).eq('id', req.params.id);

    await logTransaction({
      player_id: reqRow.player_id, type: 'withdrawal', amount: 0,
      notes: `Withdrawal request #${reqRow.id} approved and paid out (${reqRow.amount} ETB)`,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { data: reqRow, error: fetchErr } = await supabase
      .from('withdrawal_requests').select('*').eq('id', req.params.id).single();
    if (fetchErr || !reqRow) throw fetchErr || new Error("Request not found.");
    if (reqRow.status !== 'pending') return res.status(400).json({ success: false, error: "Already resolved." });

    const newBalance = await creditPlayer(reqRow.player_id, Number(reqRow.amount), {
      type: 'withdrawal_refund', notes: `Withdrawal request #${reqRow.id} rejected - held amount refunded`,
    });

    await supabase.from('withdrawal_requests').update({
      status: 'rejected', resolved_at: new Date().toISOString(), resolved_by: 'admin',
    }).eq('id', req.params.id);

    res.json({ success: true, balance: newBalance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// SERVER-AUTHORITATIVE BINGO ROUND LOOP
// ============================================================================
let globalGameState = "waiting";
let timeRemaining = INITIAL_WAIT_SECONDS;
let currentActiveGameRoundId = null; // set by startNewRound() during boot
let currentRoundPot = 0;
let ballPool = [];
let drawnBallsHistory = [];
let gameBallInterval = null;
let tickBusy = false;

function resetBallPool() {
  ballPool = [];
  drawnBallsHistory = [];
  for (let i = 1; i <= 75; i++) ballPool.push(i);
}

async function getRoundPot(game_id) {
  try {
    const { data, error } = await supabase
      .from('game_participants')
      .select('purchased_cards')
      .eq('game_id', game_id);
    if (error || !data) return 0;
    const totalCards = data.reduce((sum, row) => sum + (Number(row.purchased_cards) || 0), 0);
    return totalCards * CARD_PRICE;
  } catch (err) {
    console.error("getRoundPot failed:", err.message);
    return 0;
  }
}

// Refunds every participant of a round - used when a round is interrupted by
// a server restart before it could resolve normally (see recoverOrStartRound).
async function refundRound(game_id, reason) {
  try {
    const { data: participants, error } = await supabase
      .from('game_participants')
      .select('player_id, purchased_cards')
      .eq('game_id', game_id);
    if (error || !participants) return;
    for (const p of participants) {
      const refundAmount = (Number(p.purchased_cards) || 0) * CARD_PRICE;
      if (refundAmount <= 0) continue;
      try {
        await creditPlayer(p.player_id, refundAmount, { type: 'refund', game_id, notes: reason });
      } catch (err) {
        console.error(`Failed to refund player ${p.player_id} for round ${game_id}:`, err.message);
      }
    }
    console.log(`Refunded ${participants.length} participant(s) of interrupted round ${game_id} (${reason}).`);
  } catch (err) {
    console.error("refundRound failed:", err.message);
  }
}

async function startNewRound() {
  currentActiveGameRoundId = generateRoundId();
  globalGameState = "waiting";
  timeRemaining = INITIAL_WAIT_SECONDS;
  currentRoundPot = 0;
  drawnBallsHistory = [];
  try {
    await supabase.from('rounds').insert([{ game_id: currentActiveGameRoundId, state: 'waiting' }]);
  } catch (err) {
    console.error("Failed to persist new round (continuing anyway):", err.message);
  }
}

// On boot: recover an interrupted round rather than silently losing track of
// players who had already paid in. See the block comment at the top of the
// file for the tradeoffs of this (best-effort, not a true distributed
// transaction).
async function recoverOrStartRound() {
  try {
    const { data: openRounds, error } = await supabase
      .from('rounds')
      .select('*')
      .in('state', ['waiting', 'playing'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;

    const prev = openRounds && openRounds[0];
    if (prev && prev.state === 'waiting') {
      currentActiveGameRoundId = prev.game_id;
      globalGameState = 'waiting';
      timeRemaining = INITIAL_WAIT_SECONDS;
      currentRoundPot = 0;
      console.log(`Resumed round ${prev.game_id} in "waiting" state after restart.`);
      return;
    }
    if (prev && prev.state === 'playing') {
      console.log(`Found round ${prev.game_id} interrupted mid-play by a restart - refunding its participants.`);
      await refundRound(prev.game_id, 'server_restart_interrupted');
      await supabase.from('rounds').update({ state: 'voided', ended_at: new Date().toISOString() }).eq('game_id', prev.game_id);
    }
    await startNewRound();
  } catch (err) {
    console.error("Round recovery failed, starting a fresh round instead:", err.message);
    await startNewRound();
  }
}

function startBallDrawingSequence() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  gameBallInterval = setInterval(() => {
    if (globalGameState !== "playing") {
      clearInterval(gameBallInterval);
      return;
    }
    if (ballPool.length === 0) {
      // All 75 numbers have been called with no valid winner -> declare a draw.
      clearInterval(gameBallInterval);
      globalGameState = "waiting";
      timeRemaining = POST_ROUND_PAUSE_SECONDS;
      const endedGameId = currentActiveGameRoundId;
      supabase.from('rounds').update({ state: 'ended', ended_at: new Date().toISOString() }).eq('game_id', endedGameId).then(() => {}, () => {});
      io.emit('opponent_victory', { winnerName: "No one (All Numbers Called)", cardNum: "N/A", winnerPlayerId: null });
      startNewRound();
      return;
    }
    const drawnNumber = drawRandomBall(ballPool);
    ballPool = ballPool.filter(n => n !== drawnNumber);
    drawnBallsHistory.push(drawnNumber);

    supabase.from('rounds').update({ drawn_numbers: drawnBallsHistory }).eq('game_id', currentActiveGameRoundId).then(() => {}, () => {});

    io.emit('ball_drawn', {
      number: drawnNumber,
      pool: drawnBallsHistory
    });
  }, 3000);
}

async function handleMatchOver(winnerName, cardNum, winnerPlayerId, payoutAmount) {
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = POST_ROUND_PAUSE_SECONDS;
  const endedGameId = currentActiveGameRoundId;
  try {
    await supabase.from('rounds').update({
      state: 'ended', ended_at: new Date().toISOString(), winner_player_id: winnerPlayerId,
    }).eq('game_id', endedGameId);
  } catch (err) {
    console.error("Failed to persist round end:", err.message);
  }
  io.emit('opponent_victory', { winnerName, cardNum, winnerPlayerId, payoutAmount });
  await startNewRound();
}

setInterval(async () => {
  if (tickBusy || !currentActiveGameRoundId) return;
  tickBusy = true;
  try {
    if (globalGameState === "waiting") {
      timeRemaining--;
      if (timeRemaining <= 0) {
        const { count } = await supabase
          .from('game_participants')
          .select('*', { count: 'exact', head: true })
          .eq('game_id', currentActiveGameRoundId);
        const participantCount = count || 0;

        if (participantCount < MIN_PLAYERS_TO_START) {
          // Not enough players yet - keep waiting instead of starting (and
          // instead of forcing anyone to play against nobody).
          timeRemaining = RECHECK_WAIT_SECONDS;
        } else {
          globalGameState = "playing";
          resetBallPool();
          currentRoundPot = await getRoundPot(currentActiveGameRoundId);
          try {
            await supabase.from('rounds').update({
              state: 'playing', started_at: new Date().toISOString(), pot: currentRoundPot,
            }).eq('game_id', currentActiveGameRoundId);
          } catch (err) {
            console.error("Failed to persist round start:", err.message);
          }
          startBallDrawingSequence();
        }
      }
    }
    // No time-based cutoff while "playing" — the round runs until either a
    // validated win comes in via claim_bingo, or the ball pool is exhausted,
    // so every one of the 75 balls gets a chance to be called before a round
    // is declared a draw.

    const { count: liveParticipantCount } = globalGameState === "waiting"
      ? await supabase.from('game_participants').select('*', { count: 'exact', head: true }).eq('game_id', currentActiveGameRoundId)
      : { count: null };

    io.emit('room_tick', {
      gameId: currentActiveGameRoundId,
      state: globalGameState,
      timeRemaining: timeRemaining,
      drawnHistory: drawnBallsHistory,
      participantCount: liveParticipantCount,
      minPlayersToStart: MIN_PLAYERS_TO_START,
    });
  } catch (err) {
    console.error("Main game tick error:", err.message);
  } finally {
    tickBusy = false;
  }
}, 1000);

io.on('connection', (socket) => {
  socket.removeAllListeners('claim_bingo');

  socket.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining: timeRemaining,
    drawnHistory: drawnBallsHistory,
    minPlayersToStart: MIN_PLAYERS_TO_START,
  });

  socket.on('claim_bingo', async (data) => {
    if (globalGameState !== "playing") return;
    const { player_id, cardNum } = data || {};
    if (!player_id || !cardNum) return;

    try {
      const { data: participant, error: pErr } = await supabase
        .from('game_participants')
        .select('metadata, purchased_cards, is_winner')
        .eq('player_id', player_id)
        .eq('game_id', currentActiveGameRoundId)
        .maybeSingle();

      if (pErr || !participant) return; // not a registered participant for this round
      if (participant.is_winner) return; // already recorded as the winner, avoid double-processing

      const ownedCards = (participant.metadata && participant.metadata.cards) || [117];
      if (!ownedCards.includes(Number(cardNum))) return; // claiming a card they don't actually own

      if (!cardHasWinningLine(Number(cardNum), drawnBallsHistory)) return; // not a real completed line

      const { data: player, error: playerFetchErr } = await supabase
        .from('players')
        .select('username, balance, is_banned')
        .eq('player_id', player_id)
        .single();
      if (playerFetchErr || !player || player.is_banned) return;

      const payoutAmount = computePayout(currentRoundPot, PAYOUT_PERCENTAGE);
      const newBalance = (Number(player.balance) || 0) + payoutAmount;

      await supabase.from('players').update({ balance: newBalance }).eq('player_id', player_id);
      await logTransaction({
        player_id, type: 'payout', amount: payoutAmount, game_id: currentActiveGameRoundId,
        balance_after: newBalance, notes: `Won with card #${cardNum}, pot was ${currentRoundPot} ETB`,
      });

      await supabase
        .from('game_participants')
        .update({ is_winner: true })
        .eq('game_id', currentActiveGameRoundId)
        .eq('player_id', player_id);

      await handleMatchOver(player?.username || "Player", cardNum, player_id, payoutAmount);
    } catch (err) {
      console.error("claim_bingo validation error:", err.message);
    }
  });

  socket.on('disconnect', () => {
    socket.removeAllListeners();
  });
});

async function main() {
  await recoverOrStartRound();
  httpServer.listen(PORT, () => {
    console.log(`⚡ Fast Bingo backend engine optimized and running on port ${PORT}`);
    console.log(`   Round: ${currentActiveGameRoundId} (${globalGameState}) | CARD_PRICE=${CARD_PRICE} PAYOUT%=${PAYOUT_PERCENTAGE} MIN_PLAYERS=${MIN_PLAYERS_TO_START}`);
  });
}

main().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
