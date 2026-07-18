const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🌲 Supabase client initialized successfully.");

// --- STATE MANAGEMENT ---
let gameLoopState = "waiting"; 
let countdownTimer = 40; // Unified 40s countdown match block
let pulledNumbersPool = [];
let availableBalls = [];
let gameIntervalLoop = null;
let currentActiveGameId = "GM" + Math.floor(100000 + Math.random() * 900000);

function resetAvailableBalls() {
  availableBalls = [];
  for (let i = 1; i <= 75; i++) availableBalls.push(i);
  pulledNumbersPool = [];
}
resetAvailableBalls();

// Unified Lobby & Card Selection Countdown Ticker Loop
setInterval(async () => {
  if (gameLoopState === "waiting") {
    countdownTimer--;
    
    io.emit('room_tick', { state: "waiting", timeRemaining: countdownTimer, gameId: currentActiveGameId });
    
    if (countdownTimer <= 0) {
      gameLoopState = "playing";
      countdownTimer = 40;
      io.emit('room_tick', { state: "playing", timeRemaining: 0, gameId: currentActiveGameId });
      startBallDroppingEngine();
    }
  } else if (gameLoopState === "playing") {
    // Also emit current status to inside-game connections so timers display cleanly
    io.emit('room_tick', { state: "playing", timeRemaining: 0, gameId: currentActiveGameId });
  }
}, 1000);

function startBallDroppingEngine() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  resetAvailableBalls();
  
  gameIntervalLoop = setInterval(async () => {
    if (gameLoopState !== "playing" || availableBalls.length === 0) {
      clearInterval(gameIntervalLoop);
      return;
    }
    const randomIndex = Math.floor(Math.random() * availableBalls.length);
    const ballNumber = availableBalls.splice(randomIndex, 1)[0];
    pulledNumbersPool.push(ballNumber);
    
    io.emit('ball_drawn', { number: ballNumber, pool: pulledNumbersPool });
  }, 3500); 
}

function handleGameTerminatingVictory() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  gameLoopState = "waiting";
  countdownTimer = 40; // Next game countdown is always 40 seconds across rooms
  currentActiveGameId = "GM" + Math.floor(100000 + Math.random() * 900000);
}

// --- SECURE AUTH & REAL MANAGEMENT ENDPOINTS ---
app.post('/api/register', async (req, res) => {
  const { username, phone_number } = req.body;
  try {
    let { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('phone_number', phone_number)
      .single();

    if (!player) {
      const { data: newPlayer, error: insError } = await supabase
        .from('players')
        .insert([{ username, phone_number, balance: 100 }])
        .select()
        .single();
        
      if (insError) throw insError;
      player = newPlayer;
    }
    res.json({ user: player });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .eq('player_id', req.params.id)
      .single();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/player/update-balance', async (req, res) => {
  const { id, balance } = req.body;
  try {
    await supabase.from('players').update({ balance }).eq('player_id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dynamic Feature Integrations
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('players')
      .select('username, balance')
      .order('balance', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/api/history/:playerId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('games')
      .select('*')
      .eq('player_id', req.params.playerId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought } = req.body;
  try {
    await supabase.from('games').insert([{ player_id, game_id, cards_bought, status: 'playing', is_winner: false }]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/games/update-status', async (req, res) => {
  const { game_id, player_id, status, is_winner } = req.body;
  try {
    await supabase.from('games').update({ status, is_winner }).eq('game_id', game_id).eq('player_id', player_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SOCKET HANDLERS ---
io.on('connection', (socket) => {
  socket.on('claim_bingo', (data) => {
    if (gameLoopState === "playing") {
      handleGameTerminatingVictory();
      io.emit('opponent_victory', {
        winnerName: data.username,
        cardNum: data.cardNum
      });
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Fast Bingo backend running on port ${PORT}`);
});