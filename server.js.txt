const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

// Allow your Telegram Web App or local frontend to safely connect to this server
app.use(cors({
  origin: "*", // Allows any website to connect. Perfect for testing!
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// A simple landing page to test if your server is running
app.get('/', (req, res) => {
  res.send('<h1>Dil Bingo Server is Up and Running!</h1>');
});

// Real-Time Game Coordination State
let activePlayersInLobby = {};

io.on('connection', (socket) => {
  console.log(`⚡ Player Connected: ${socket.id}`);

  // 1. Listen for when a player joins the card selection lobby
  socket.on('join_lobby', (data) => {
    activePlayersInLobby[socket.id] = {
      username: data.username || "Anonymous Player",
      joinedAt: new Date()
    };
    
    // Broadcast the updated count of active players to everyone in the lobby
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);
  });

  // 2. Listen for when a player triggers a Bingo claim
  socket.on('claim_bingo', (data) => {
    console.log(`🏆 BINGO Claimed by: ${data.username} on Card: #${data.cardNum}`);

    // Broadcast a custom popup event to all other connected players
    socket.broadcast.emit('player_won_broadcast', {
      winner: data.username,
      cardNum: data.cardNum,
      amount: data.amount
    });
  });

  // 3. Handle player disconnection
  socket.on('disconnect', () => {
    console.log(`❌ Player Disconnected: ${socket.id}`);
    delete activePlayersInLobby[socket.id];
    
    // Update lobby count for remaining active connections
    io.emit('lobby_count_update', Object.keys(activePlayersInLobby).length);
  });
});

// Listen on the port assigned by Render, or fallback to local port 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Dil Bingo backend is running on port ${PORT}`);
});