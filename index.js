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

// --- API ROUTES ---

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

// 3. Sync Player Profile/Balances
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

// 4. Update Balance (Fixed property reading to accommodate 'id' or 'player_id')
app.post('/api/player/update-balance', async (req, res) => {
  const { id, player_id, balance } = req.body;
  const targetId = player_id || id;
  try {
    const { data, error } = await supabase
      .from('players')
      .update({ balance })
      .eq('player_id', targetId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Join Game Session
app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought } = req.body;
  try {
    const { data, error } = await supabase
      .from('game_participants')
      .insert([{ 
        player_id, 
        game_id, 
        purchased_cards: cards_bought, 
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


// --- SERVER AUTHORITATIVE BINGO CORE LOOP ---
let globalGameState = "waiting"; 
let timeRemaining = 40;
let currentActiveGameRoundId = Math.floor(100000 + Math.random() * 900000).toString();
let ballPool = [];
let drawnBallsHistory = [];
let gameBallInterval = null;

// Populate initial available balls array (1 to 75)
function resetBallPool() {
  ballPool = [];
  drawnBallsHistory = [];
  for (let i = 1; i <= 75; i++) ballPool.push(i);
}
resetBallPool();

// Central 1-second room timer ticker
setInterval(() => {
  if (globalGameState === "waiting") {
    timeRemaining--;
    if (timeRemaining <= 0) {
      // Transition to active gaming match
      globalGameState = "playing";
      timeRemaining = 120; // fallback max duration limits
      resetBallPool();
      startBallDrawingSequence();
    }
  }
  
  // Emitting the exact event schema and channel expected by client UI
  io.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining: timeRemaining
  });
}, 1000);

function startBallDrawingSequence() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  
  gameBallInterval = setInterval(() => {
    if (globalGameState !== "playing" || ballPool.length === 0) {
      clearInterval(gameBallInterval);
      return;
    }
    
    // Draw random number from pool
    const randomIndex = Math.floor(Math.random() * ballPool.length);
    const drawnNumber = ballPool.splice(randomIndex, 1)[0];
    drawnBallsHistory.push(drawnNumber);
    
    // Broadcast newly called number to room
    io.emit('ball_drawn', {
      number: drawnNumber,
      pool: drawnBallsHistory
    });
  }, 3000); // Calls a new number every 3 seconds
}

function handleMatchOver(winnerName, cardNum) {
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = 15; // Give players time to view modal before starting next registration cycle
  io.emit('opponent_victory', { winnerName, cardNum });
  currentActiveGameRoundId = Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket) => {
  socket.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining: timeRemaining
  });

  // Handle incoming manual/auto validation check requests
  socket.on('claim_bingo', (data) => {
    if (globalGameState === "playing") {
      handleMatchOver(data.username || "Anonymous Player", data.cardNum);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`⚡ Fast Bingo backend engine optimized and running on port ${PORT}`);
});