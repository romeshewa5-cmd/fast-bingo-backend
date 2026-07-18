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

// Ground connection to your live environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🌲 Supabase client initialized successfully.");

// --- STATE MANAGEMENT ---
let gameLoopState = "waiting"; 
let countdownTimer = 40;
let pulledNumbersPool = [];
let availableBalls = [];
let gameIntervalLoop = null;
let currentActiveGameId = null;

function resetAvailableBalls() {
  availableBalls = [];
  for (let i = 1; i <= 75; i++) availableBalls.push(i);
  pulledNumbersPool = [];
}
resetAvailableBalls();

// Core Lobby Countdown Ticker Loop
setInterval(async () => {
  if (gameLoopState === "waiting") {
    countdownTimer--;
    
    // Broadcast countdown timer live to all active sockets
    io.emit('room_tick', { state: "waiting", timeRemaining: countdownTimer });
    
    if (countdownTimer <= 0) {
      gameLoopState = "playing";
      countdownTimer = 40;
      currentActiveGameId = "GM" + Math.floor(100000 + Math.random() * 900000);
      
      io.emit('room_tick', { state: "playing", timeRemaining: 0, gameId: currentActiveGameId });
      startBallDroppingEngine();
    }
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
    
    io.emit('ball_drawn', { number: ballNumber });
  }, 3500); 
}

function handleGameTerminatingVictory() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  gameLoopState = "waiting";
  countdownTimer = 12; // 7 seconds animation presentation + 5 seconds countdown transition buffer
}

// --- SECURE AUTH & MANAGEMENT API ENDPOINTS ---
app.post('/api/register', async (req, res) => {
  const { username, phone_number } = req.body;
  try {
    // Check if player exists by phone number first
    let { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('phone_number', phone_number)
      .single();

    if (!player) {
      // Create new account if phone number is new
      const { data: newPlayer, error: insError } = await supabase
        .from('players')
        .insert([{ username, phone_number, balance: 100 }]) // Gift starter 100 ETB balance
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

// --- SOCKET SOCKET HANDLERS ---
io.on('connection', (socket) => {
  console.log(`⚡ Player Connected: ${socket.id}`);

  socket.on('claim_bingo', (data) => {
    if (gameLoopState === "playing") {
      handleGameTerminatingVictory();
      io.emit('opponent_victory', {
        winnerName: data.username,
        cardNum: data.cardNum
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ Player Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Fast Bingo backend running on port ${PORT}`);
});