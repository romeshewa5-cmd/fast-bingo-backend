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

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- API ROUTES ALIGNED TO YOUR SCHEMA ---

// 1. Health Check
app.get('/api/health-check', async (req, res) => {
  try {
    const { error } = await supabase.from('players').select('count', { count: 'exact', head: true });
    if (error) throw error;
    res.json({ status: "online", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "online", database: "disconnected", error: err.message });
  }
});

// 2. Player Registration / Authentication
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
      // Matches your schema columns exactly
      const { data: newPlayer, error: insertError } = await supabase
        .from('players')
        .insert([{ 
          username, 
          phone_number, 
          balance: 10 // Aligned to your single balance column
        }])
        .select()
        .single();

      if (insertError) throw insertError;
      return res.json({ isNew: true, user: newPlayer });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Sync Player Profile/Balances
app.get('/api/player/:id', async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('player_id', req.params.id) // Using your schema's player_id
      .single();

    if (error) throw error;
    res.json(player);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Update Balance
app.post('/api/player/update-balance', async (req, res) => {
  const { player_id, balance } = req.body;
  try {
    const { data, error } = await supabase
      .from('players')
      .update({ balance })
      .eq('player_id', player_id)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Join Game Session (Log Cards Purchase)
app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought } = req.body;
  try {
    // Aligned to your game_participants table
    const { data, error } = await supabase
      .from('game_participants')
      .insert([{ 
        player_id, 
        game_id, 
        purchased_cards: cards_bought, // Maps to your jsonb field
        is_winner: false 
      }]);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Update Winner Status
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

// --- MULTIPLAYER ROOM LOOP ---
let globalGameState = "waiting"; 
let timeRemaining = 40;
let connectedPlayersCount = 0;

setInterval(() => {
  timeRemaining--;
  if (timeRemaining <= 0) {
    if (globalGameState === "waiting") {
      globalGameState = "playing";
      timeRemaining = 120;
      io.emit('game_started');
    } else {
      globalGameState = "waiting";
      timeRemaining = 40;
      io.emit('game_reset');
    }
  }
  io.emit('state_tick', {
    gameState: globalGameState,
    timeRemaining: timeRemaining,
    activePlayers: connectedPlayersCount
  });
}, 1000);

io.on('connection', (socket) => {
  connectedPlayersCount++;
  socket.emit('state_tick', {
    gameState: globalGameState,
    timeRemaining: timeRemaining,
    activePlayers: connectedPlayersCount
  });
  socket.on('disconnect', () => {
    connectedPlayersCount = Math.max(0, connectedPlayersCount - 1);
  });
});

httpServer.listen(PORT, () => {
  console.log(`⚡ Fast Bingo backend engine optimized and running on port ${PORT}`);
});