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

app.get('/api/health-check', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ status: "offline", error: "Supabase client not initialized" });
  }
  try {
    const { data, error } = await supabase.from('players').select('id').limit(1);
    if (error) throw error;
    res.json({ status: "online", database: "connected" });
  } catch (err) {
    console.error("Database connection failed:", err.message);
    res.status(500).json({ status: "offline", error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('<h1>Fast Bingo Server is Up and Running!</h1>');
});

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
    socket.broadcast.emit('player_won_broadcast', {
      winner: data.username,
      cardNum: data.cardNum,
      amount: data.amount
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