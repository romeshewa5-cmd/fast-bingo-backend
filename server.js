require('dotenv').config(); // Load variables from your .env file
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js'); // Import Supabase Client

const app = express();

// Middleware 
app.use(express.json());
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST"]
}));

// Initialize Supabase Connection
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

// 1. NEW HEALTH CHECK ENDPOINT (Fixes your frontend's "offline mode" trigger)
app.get('/api/health-check', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ status: "offline", error: "Supabase client not initialized" });
  }

  try {
    // Attempt a lightweight test query. Replace 'players' with any table name you actually have in Supabase.
    const { data, error } = await supabase.from('players').select('id').limit(1);
    
    if (error) throw error;

    res.json({ status: "online", database: "connected" });
  } catch (err) {
    console.error("Database connection failed:", err.message);
    res.status(500).json({ status: "offline", error: err.message });
  }
});

// Landing Page
app.get('/', (req, res) => {
  res.send('<h1>Fast Bingo Server is Up and Running!</h1>');
});

// Real-Time Game Coordination State[cite: 5]
let activePlayersInLobby = {};[cite: 5]

io.on('connection', (socket) => {[cite: 5]
  console.log(`⚡ Player Connected: ${socket.id}`);[cite: 5]

  socket.on('join_lobby', (data) => {[cite: 5]
    activePlayersInLobby[socket.id] = {[cite: 5]
      username: data.username || "Anonymous Player",[cite: 5]
      joinedAt: new Date()[cite: 5]
    };[cite: 5]
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);[cite: 5]
  });[cite: 5]

  socket.on('claim_bingo', (data) => {[cite: 5]
    console.log(`🏆 BINGO Claimed by: ${data.username} on Card: #${data.cardNum}`);[cite: 5]
    socket.broadcast.emit('player_won_broadcast', {[cite: 5]
      winner: data.username,[cite: 5]
      cardNum: data.cardNum,[cite: 5]
      amount: data.amount[cite: 5]
    });[cite: 5]
  });[cite: 5]

  socket.on('disconnect', () => {[cite: 5]
    console.log(`❌ Player Disconnected: ${socket.id}`);[cite: 5]
    delete activePlayersInLobby[socket.id];[cite: 5]
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);[cite: 5]
  });[cite: 5]
});[cite: 5]

const PORT = process.env.PORT || 3000;[cite: 5]
server.listen(PORT, () => {[cite: 5]
  console.log(`🚀 Fast Bingo backend is running on port ${PORT}`);[cite: 5]
});[cite: 5]