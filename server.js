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
    // Critical Guard: Stop loops immediately if the state changes due to a win
    if (gameLoopState !== "playing" || availableBalls.length === 0) {
      clearInterval(gameIntervalLoop);
      return;
    }
    const randomIndex = Math.floor(Math.random() * availableBalls.length);
    const ballNumber = availableBalls.splice(randomIndex, 1)[0];
    pulledNumbersPool.push(ballNumber);
    
    io.emit('ball_drawn', { number: ballNumber });

    if (supabase && currentActiveGameId) {
      await supabase.from('games').update({ drawn_numbers: pulledNumbersPool }).eq('game_id', currentActiveGameId);
    }
  }, 3500); 
}

function handleGameTerminatingVictory() {
  if (gameIntervalLoop) clearInterval(gameIntervalLoop);
  gameLoopState = "waiting";
  countdownTimer = 12; // Gives 7 seconds for animation + 5 seconds buffer for next round
}

io.on('connection', (socket) => {
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
});