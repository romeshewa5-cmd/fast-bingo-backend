const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Create HTTP Server
const server = http.createServer(app);

// Initialize Socket.io properly on the server instance
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust to your actual frontend domain when ready
    methods: ["GET", "POST"]
  }
});

// Mock or configure your Supabase Client here
const SUPABASE_URL = process.env.SUPABASE_URL || "https://your-project.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "your-anon-key";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("🌲 Supabase client initialized successfully.");

// --- STATE SYNCHRONIZATION AND BALL ENGINE TERMINATION ---
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

// Lobby countdown loop
setInterval(() => {
  if (gameLoopState === "waiting") {
    countdownTimer--;
    io.emit('room_tick', { state: "waiting", timeRemaining: countdownTimer });
    
    if (countdownTimer <= 0) {
      gameLoopState = "playing";
      countdownTimer = 40;
      currentActiveGameId = "DB" + Math.random().toString(36).substr(2, 6).toUpperCase();
      io.emit('room_tick', { state: "playing", timeRemaining: 0, gameId: currentActiveGameId });
      startBallDroppingEngine();
    }
  }
}, 1000);

function startBallDroppingEngine() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  resetAvailableBalls();
  
  gameIntervalLoop = setInterval(async () => {
    // Stop loops immediately if the state changes due to a win
    if (gameLoopState !== "playing" || availableBalls.length === 0) {
      clearInterval(gameIntervalLoop);
      return;
    }
    const randomIndex = Math.floor(Math.random() * availableBalls.length);
    const ballNumber = availableBalls.splice(randomIndex, 1)[0];
    pulledNumbersPool.push(ballNumber);
    
    io.emit('ball_drawn', { number: ballNumber });

    try {
      if (supabase && currentActiveGameId) {
        await supabase.from('games').update({ drawn_numbers: pulledNumbersPool }).eq('game_id', currentActiveGameId);
      }
    } catch (err) {
      console.error("Supabase update skipped or errored:", err.message);
    }
  }, 3500); 
}

function handleGameTerminatingVictory() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  gameLoopState = "waiting";
  countdownTimer = 12; // Gives 7 seconds for presentation layout + 5 seconds buffer before next round
}

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
  console.log(`⚡ Player Connected: ${socket.id}`);

  socket.on('claim_bingo', (data) => {
    if (gameLoopState === "playing") {
      console.log(`🏆 BINGO Claimed by: ${data.username}`);
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

// --- REST ENDPOINTS PLACEHOLDERS ---
app.post('/api/register', (req, res) => {
  const { username, phone_number } = req.body;
  // Temporary mock payload profile structure
  res.json({ user: { player_id: "p_" + Math.floor(Math.random()*10000), username, phone_number, balance: 10 } });
});

app.get('/api/player/:id', (req, res) => {
  res.json({ player_id: req.params.id, balance: 10 });
});

app.post('/api/player/update-balance', (req, res) => {
  res.json({ success: true });
});

app.post('/api/games/create', (req, res) => {
  res.json({ success: true });
});

app.post('/api/games/update-status', (req, res) => {
  res.json({ success: true });
});

// Bind to port 10000 for Render deployment compatibility
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Fast Bingo backend is running on port ${PORT}`);
});