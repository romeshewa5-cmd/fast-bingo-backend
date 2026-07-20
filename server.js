require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || "https://rsmobdnuyxqyynxtjkyi.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Game economy constants - authoritative on the server, never trusted from the client.
const CARD_PRICE = 10;
const WIN_PAYOUT = 304;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

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

// NOTE: the old /api/player/update-balance endpoint has been removed.
// It used to accept a raw balance value straight from the client with no
// validation, meaning anyone who knew a player_id could set their own
// balance to anything. Balance is now only ever changed server-side:
// entry fees are deducted in /api/games/create, and payouts are credited
// in the claim_bingo socket handler below - both computed from
// server-controlled constants (CARD_PRICE, WIN_PAYOUT), never from
// client input.

app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought, cards_list } = req.body;
  if (!player_id || !game_id || !cards_bought) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  const cost = CARD_PRICE * Number(cards_bought);

  try {
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

    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('balance')
      .eq('player_id', player_id)
      .single();
    if (playerErr || !player) throw playerErr || new Error("Player not found.");

    if (player.balance < cost) {
      return res.status(400).json({ success: false, error: "insufficient_balance" });
    }

    const newBalance = player.balance - cost;
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
        purchased_cards: cards_bought, 
        is_winner: false,
        metadata: { cards: cards_list || [117] }
      }])
      .select()
      .single();

    if (error) {
      // Registration failed after the deduction - refund so the player isn't charged for nothing.
      // Note: this is a best-effort rollback, not a real transaction. For full atomicity this
      // whole flow should live inside a single Postgres function (RPC) instead.
      await supabase.from('players').update({ balance: player.balance }).eq('player_id', player_id);
      throw error;
    }

    res.json({ success: true, participant: data, balance: newBalance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/games/update-status', async (req, res) => {
  const { game_id, player_id, is_winner } = req.body;
  try {
    const { data, error } = await supabase
      .from('game_participants')
      .update({ is_winner })
      .eq('game_id', game_id)
      .eq('player_id', player_id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// --- SERVER BINGO LOOP ---
function generateRoundId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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
  card[2][2] = 0;
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

let globalGameState = "waiting"; 
let timeRemaining = 40;
let currentActiveGameRoundId = generateRoundId();
let ballPool = [];
let drawnBallsHistory = [];
let gameBallInterval = null;

function resetBallPool() {
  ballPool = [];
  drawnBallsHistory = [];
  for (let i = 1; i <= 75; i++) ballPool.push(i);
}
resetBallPool();

setInterval(() => {
  if (globalGameState === "waiting") {
    timeRemaining--;
    if (timeRemaining <= 0) {
      globalGameState = "playing";
      resetBallPool();
      startBallDrawingSequence();
    }
  }
  // No time-based cutoff while "playing" — the round runs until either a
  // validated win comes in via claim_bingo, or the ball pool is exhausted
  // (see startBallDrawingSequence), so every one of the 75 balls gets a chance
  // to be called before a round is declared a draw.
  
  io.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining: timeRemaining,
    drawnHistory: drawnBallsHistory
  });
}, 1000);

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
      timeRemaining = 30;
      currentActiveGameRoundId = generateRoundId();
      io.emit('opponent_victory', { winnerName: "No one (All Numbers Called)", cardNum: "N/A", winnerPlayerId: null });
      return;
    }
    const randomIndex = Math.floor(Math.random() * ballPool.length);
    const drawnNumber = ballPool.splice(randomIndex, 1)[0];
    drawnBallsHistory.push(drawnNumber);
    
    io.emit('ball_drawn', {
      number: drawnNumber,
      pool: drawnBallsHistory
    });
  }, 3000);
}

function handleMatchOver(winnerName, cardNum, winnerPlayerId) {
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = 15; 
  io.emit('opponent_victory', { winnerName, cardNum, winnerPlayerId });
  currentActiveGameRoundId = generateRoundId();
}

io.on('connection', (socket) => {
  socket.removeAllListeners('claim_bingo');

  socket.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining: timeRemaining,
    drawnHistory: drawnBallsHistory
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
        .select('username, balance')
        .eq('player_id', player_id)
        .single();
      if (playerFetchErr || !player) return;

      const newBalance = (player.balance || 0) + WIN_PAYOUT;

      await supabase
        .from('players')
        .update({ balance: newBalance })
        .eq('player_id', player_id);

      await supabase
        .from('game_participants')
        .update({ is_winner: true })
        .eq('game_id', currentActiveGameRoundId)
        .eq('player_id', player_id);

      handleMatchOver(player?.username || "Player", cardNum, player_id);
    } catch (err) {
      console.error("claim_bingo validation error:", err.message);
    }
  });

  socket.on('disconnect', () => {
    socket.removeAllListeners();
  });
});

httpServer.listen(PORT, () => {
  console.log(`⚡ Fast Bingo backend engine optimized and running on port ${PORT}`);
});