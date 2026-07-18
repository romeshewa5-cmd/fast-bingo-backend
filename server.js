require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(express.json());
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST"]
}));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase;
if (!supabaseUrl || !supabaseKey) {
  console.error("❌ ERROR: SUPABASE_URL or SUPABASE_KEY is completely missing from environment variables!");
} else {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log("🌲 Supabase client initialized successfully.");
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// REST ENDPOINTS FOR COMPATIBILITY
app.get('/api/health-check', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ status: "offline", error: "Supabase client not initialized" });
  }
  try {
    const { error } = await supabase.from('players').select('id').limit(1);
    if (error) throw error;
    res.json({ status: "online", database: "connected" });
  } catch (err) {
    console.error("Database connection failed:", err.message);
    res.status(500).json({ status: "offline", error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { username, phone_number } = req.body;
  if (!supabase) return res.status(500).json({ error: "Database offline" });
  try {
    let { data: player, error } = await supabase.from('players').select('*').eq('phone_number', phone_number).single();
    if (error && error.code !== 'PGRST116') throw error;
    
    if (player) {
      return res.json({ isNew: false, user: player });
    }
    const { data: newPlayer, error: insErr } = await supabase.from('players').insert([{
      username, phone_number, wallet_main: 0, wallet_play: 10
    }]).select().single();
    if (insErr) throw insErr;
    res.json({ isNew: true, user: newPlayer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Database offline" });
  try {
    const { data, error } = await supabase.from('players').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/player/update-balance', async (req, res) => {
  const { id, wallet_main, wallet_play } = req.body;
  if (!supabase) return res.status(500).json({ error: "Database offline" });
  try {
    const { data, error } = await supabase.from('players').update({ wallet_main, wallet_play }).eq('id', id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/games/create', async (req, res) => {
  res.json({ success: true, message: "Logged locally in-memory match context." });
});
app.post('/api/games/update-status', async (req, res) => {
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.send('<h1>Fast Bingo Server is Up and Running!</h1>');
});

// --- CORE GAME STATE MACHINE (SERVER-AUTHORITATIVE) ---
let gameLoopState = "waiting"; // "waiting" or "playing"
let countdownTimer = 40;
let pulledNumbersPool = [];
let availableBalls = [];
let gameIntervalLoop = null;

function resetAvailableBalls() {
  availableBalls = [];
  for (let i = 1; i <= 75; i++) availableBalls.push(i);
  pulledNumbersPool = [];
}
resetAvailableBalls();

// Central Clock Interval Tick Handler
setInterval(() => {
  if (gameLoopState === "waiting") {
    countdownTimer--;
    io.emit('room_tick', { state: "waiting", timeRemaining: countdownTimer });
    
    if (countdownTimer <= 0) {
      gameLoopState = "playing";
      countdownTimer = 40;
      io.emit('room_tick', { state: "playing", timeRemaining: 0 });
      startBallDroppingEngine();
    }
  }
}, 1000);

function startBallDroppingEngine() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  resetAvailableBalls();
  
  gameIntervalLoop = setInterval(() => {
    if (gameLoopState !== "playing" || availableBalls.length === 0) {
      clearInterval(gameIntervalLoop);
      return;
    }
    const randomIndex = Math.floor(Math.random() * availableBalls.length);
    const ballNumber = availableBalls.splice(randomIndex, 1)[0];
    pulledNumbersPool.push(ballNumber);
    
    io.emit('ball_drawn', { number: ballNumber });
  }, 3500); // Draw standard intermediate balls every 3.5 seconds
}

function handleGameTerminatingVictory(winnerName, winningCard) {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  gameLoopState = "waiting";
  countdownTimer = 15; // Set a 15s intermission for players before starting a new round
}

// --- SOCKET CONNECTIONS ---
let activePlayersInLobby = {};

io.on('connection', (socket) => {
  console.log(`⚡ Player Connected: ${socket.id}`);

  socket.on('join_lobby', (data) => {
    activePlayersInLobby[socket.id] = {
      username: data.username || "Anonymous Player",
      joinedAt: new Date()
    };
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);
  });

  socket.on('claim_bingo', (data) => {
    console.log(`🏆 BINGO Claimed by: ${data.username} on Card: #${data.cardNum}`);
    handleGameTerminatingVictory(data.username, data.cardNum);
    io.emit('opponent_victory', {
      winnerName: data.username,
      cardNum: data.cardNum
    });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Player Disconnected: ${socket.id}`);
    delete activePlayersInLobby[socket.id];
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Fast Bingo backend is running on port ${PORT}`);
});