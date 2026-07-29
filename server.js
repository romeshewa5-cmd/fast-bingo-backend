require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const {
  genCard,
  cardHasWinningLine,
  generateRoundId,
  drawRandomBall,
  computePayout,
} = require('./gameLogic');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL || "https://rsmobdnuyxqyynxtjkyi.supabase.co";
const supabaseKey = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dummy-key-for-initialization";
const supabase = createClient(supabaseUrl, supabaseKey);

// Economy and Timer Constants
const CARD_PRICE = Number(process.env.CARD_PRICE) || 10;
const PAYOUT_PERCENTAGE = Number(process.env.PAYOUT_PERCENTAGE) || 0.8;
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START) || 2;
const INITIAL_WAIT_SECONDS = Number(process.env.INITIAL_WAIT_SECONDS) || 40;
const RECHECK_WAIT_SECONDS = Number(process.env.RECHECK_WAIT_SECONDS) || 40; // Fixed: Loops back to 40 seconds
const POST_ROUND_PAUSE_SECONDS = Number(process.env.POST_ROUND_PAUSE_SECONDS) || 15;
const MIN_WITHDRAWAL_AMOUNT = Number(process.env.MIN_WITHDRAWAL_AMOUNT) || 100; // Minimum 100 ETB withdrawal

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Memory fallbacks for coupons, deposit requests, and reference IDs if Supabase table is absent
const inMemoryDeposits = [];
const inMemoryCoupons = [
  { code: 'BINGO20', bonus_amount: 20, max_uses: 1000, used_count: 0, is_active: true, expiry_date: '2030-01-01' },
  { code: 'FREEPLAY', bonus_amount: 10, max_uses: 500, used_count: 0, is_active: true, expiry_date: '2030-01-01' },
];
const couponRedemptions = new Set(); // format: "player_id:coupon_code"
const submittedReferenceIds = new Set();

// Helper to sanitize player balances
function sanitizePlayer(p) {
  if (!p) return null;
  const main = Number(p.main_balance ?? p.balance ?? 0);
  const play = Number(p.play_balance ?? 0);
  const total = main + play;
  const refCount = Number(p.referrals_count ?? p.referral_count ?? 0);
  const refEarned = Number(p.referral_earnings ?? (refCount * 5) ?? 0);
  return {
    ...p,
    main_balance: main,
    play_balance: play,
    balance: total,
    referrals_count: refCount,
    referral_earnings: refEarned,
  };
}

// Transaction Logging
async function logTransaction({ player_id, type, amount, game_id = null, balance_after = null, notes = null }) {
  try {
    await supabase.from('transactions').insert([{
      player_id, type, amount, game_id, balance_after, notes,
    }]);
  } catch (err) {
    console.error("Ledger transaction log failed:", err.message, { player_id, type, amount });
  }
}

// Balance helper with Dual Wallet support
async function creditPlayerBalances(player_id, { mainAdd = 0, playAdd = 0, type, game_id = null, notes = null }) {
  const { data: player, error: fetchErr } = await supabase
    .from('players').select('*').eq('player_id', player_id).single();
  if (fetchErr || !player) throw fetchErr || new Error(`Player ${player_id} not found while crediting.`);

  const curMain = Number(player.main_balance ?? player.balance ?? 0);
  const curPlay = Number(player.play_balance ?? 0);

  const newMain = Math.max(0, curMain + mainAdd);
  const newPlay = Math.max(0, curPlay + playAdd);
  const newTotal = newMain + newPlay;

  const updatePayload = {
    main_balance: newMain,
    play_balance: newPlay,
    balance: newTotal,
  };

  const { error: updateErr } = await supabase.from('players').update(updatePayload).eq('player_id', player_id);
  if (updateErr) {
    // Fallback if schema does not have main_balance/play_balance columns yet
    await supabase.from('players').update({ balance: newTotal }).eq('player_id', player_id);
  }

  const netAmount = mainAdd + playAdd;
  await logTransaction({ player_id, type, amount: netAmount, game_id, balance_after: newTotal, notes });
  return { main_balance: newMain, play_balance: newPlay, balance: newTotal };
}

// Admin Auth Middleware
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_SECRET || '';
  if (!expected) {
    // Accept default dev secret if ADMIN_SECRET not set
    const provided = String(req.headers['x-admin-secret'] || '');
    if (provided === 'admin' || provided === '123456' || provided === 'fastbingo') return next();
  }
  const provided = String(req.headers['x-admin-secret'] || '');
  if (expected && provided !== expected) {
    return res.status(401).json({ error: "Unauthorized admin access." });
  }
  next();
}

// --- API ROUTES ---

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/health-check', async (req, res) => {
  try {
    const { error } = await supabase.from('players').select('count', { count: 'exact', head: true });
    if (error) throw error;
    res.json({ status: "online", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "online", database: "disconnected", error: err.message });
  }
});

// Registration with 20 Birr Signup Bonus to Play Wallet
app.post('/api/register', async (req, res) => {
  const { username, phone_number, referrer_id } = req.body;
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
      return res.json({ isNew: false, user: sanitizePlayer(player) });
    } else {
      // New User Registration: 20 Birr Signup Bonus to Play Wallet!
      const initialPayload = {
        username,
        phone_number,
        main_balance: 0,
        play_balance: 20, // 20 Birr Bonus!
        balance: 20,
        referred_by: referrer_id || null,
        referrals_count: 0,
        referral_earnings: 0
      };

      let newPlayer = null;
      try {
        const { data, error: insertError } = await supabase
          .from('players')
          .insert([initialPayload])
          .select()
          .single();
        if (insertError) throw insertError;
        newPlayer = data;
      } catch (insertErr) {
        // Fallback for older table schema without extra columns
        const { data, error: fbError } = await supabase
          .from('players')
          .insert([{ username, phone_number, balance: 20 }])
          .select()
          .single();
        if (fbError) throw fbError;
        newPlayer = { ...data, main_balance: 0, play_balance: 20, balance: 20 };
      }

      await logTransaction({
        player_id: newPlayer.player_id,
        type: 'signup_bonus',
        amount: 20,
        balance_after: 20,
        notes: '20 Birr Registration Bonus credited to Play Wallet'
      });

      // Handle Referrer Reward if referrer_id exists
      if (referrer_id && String(referrer_id).trim()) {
        const cleanRefId = String(referrer_id).trim();
        try {
          const { data: refPlayer } = await supabase
            .from('players')
            .select('*')
            .eq('player_id', cleanRefId)
            .single();

          if (refPlayer && refPlayer.player_id !== newPlayer.player_id) {
            const currentRefCount = Number(refPlayer.referrals_count ?? refPlayer.referral_count ?? 0) + 1;
            const currentRefEarn = Number(refPlayer.referral_earnings ?? 0) + 5;

            // Give +5 ETB to referrer Play Wallet
            await creditPlayerBalances(refPlayer.player_id, {
              playAdd: 5,
              type: 'referral_bonus',
              notes: `5 ETB referral reward for inviting ${username}`
            });

            // Safely update referrer stats
            try {
              await supabase
                .from('players')
                .update({
                  referrals_count: currentRefCount,
                  referral_earnings: currentRefEarn
                })
                .eq('player_id', refPlayer.player_id);
            } catch (uErr) {
              // Ignore if column doesn't exist
            }

            // Milestone bonus: 100 ETB for reaching 10 referrals (or multiples of 10)
            if (currentRefCount % 10 === 0) {
              await creditPlayerBalances(refPlayer.player_id, {
                playAdd: 100,
                type: 'referral_milestone_bonus',
                notes: `🎉 100 ETB Milestone bonus for inviting ${currentRefCount} players!`
              });
            }
          }
        } catch (refErr) {
          console.error("Referral processing error:", refErr.message);
        }
      }

      return res.json({ isNew: true, user: sanitizePlayer(newPlayer) });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check Active Game Re-entry Status with Defensive Metadata Schema Fallback
app.get('/api/games/check-active/:player_id/:game_id', async (req, res) => {
  try {
    const { player_id, game_id } = req.params;

    let data = null;
    try {
      const { data: resData, error } = await supabase
        .from('game_participants')
        .select('*')
        .eq('player_id', player_id)
        .eq('game_id', game_id)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw error;
      data = resData;
    } catch (err) {
      // Fallback if metadata column query fails
      data = null;
    }

    if (data) {
      let cardsList = [117];
      if (data.metadata && data.metadata.cards) {
        cardsList = data.metadata.cards;
      } else if (data.purchased_cards === 2) {
        cardsList = [117, 118];
      }
      return res.json({
        registered: true,
        cards_bought: data.purchased_cards || 1,
        is_winner: !!data.is_winner,
        cards_list: cardsList
      });
    } else {
      return res.json({ registered: false });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch Single Player Profile
app.get('/api/player/:id', async (req, res) => {
  try {
    const { data: player, error } = await supabase
      .from('players')
      .select('*')
      .eq('player_id', req.params.id)
      .single();

    if (error && error.code === 'PGRST116') {
      return res.status(404).json({ error: "Player not found" });
    }
    if (error) throw error;
    if (!player) return res.status(404).json({ error: "Player not found" });

    res.json(sanitizePlayer(player));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Taken Cards Query with Schema Safeguard
app.get('/api/games/taken-cards/:game_id', async (req, res) => {
  try {
    const taken = new Set();
    try {
      const { data, error } = await supabase
        .from('game_participants')
        .select('*')
        .eq('game_id', req.params.game_id);
      if (!error && data) {
        data.forEach(row => {
          const cards = (row.metadata && row.metadata.cards) || [];
          cards.forEach(c => taken.add(Number(c)));
        });
      }
    } catch (e) {
      // Safe fallback
    }
    res.json({ taken: Array.from(taken) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Game Join & Entry Fee Deduction (Deducts Play Wallet first, then Main Wallet)
app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought, cards_list } = req.body;
  if (!player_id || !game_id || !cards_bought) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  const numCards = Number(cards_bought);
  if (!Number.isInteger(numCards) || numCards < 1 || numCards > 2) {
    return res.status(400).json({ success: false, error: "Invalid cards_bought." });
  }
  const requestedCards = Array.from(new Set((cards_list && cards_list.length ? cards_list : [117]).map(Number)));
  const cost = CARD_PRICE * numCards;

  try {
    if (game_id === currentActiveGameRoundId && globalGameState !== "waiting") {
      return res.status(400).json({ success: false, error: "round_not_open" });
    }

    const { data: playerRow, error: playerErr } = await supabase
      .from('players')
      .select('*')
      .eq('player_id', player_id)
      .single();
    if (playerErr || !playerRow) throw playerErr || new Error("Player not found.");

    if (playerRow.is_banned) {
      return res.status(403).json({ success: false, error: "banned" });
    }

    const player = sanitizePlayer(playerRow);
    if (player.balance < cost) {
      return res.status(400).json({ success: false, error: "insufficient_balance" });
    }

    // Check existing registration
    try {
      const { data: existing } = await supabase
        .from('game_participants')
        .select('player_id')
        .eq('player_id', player_id)
        .eq('game_id', game_id)
        .maybeSingle();
      if (existing) {
        return res.status(400).json({ success: false, error: "already_registered" });
      }
    } catch (e) {}

    // Deduct cost: Play Wallet first, then Main Wallet
    let deductPlay = Math.min(player.play_balance, cost);
    let deductMain = cost - deductPlay;

    let newPlay = player.play_balance - deductPlay;
    let newMain = player.main_balance - deductMain;
    let newTotal = newMain + newPlay;

    // Update Player Balances in DB
    try {
      await supabase
        .from('players')
        .update({ main_balance: newMain, play_balance: newPlay, balance: newTotal })
        .eq('player_id', player_id);
    } catch (upErr) {
      await supabase.from('players').update({ balance: newTotal }).eq('player_id', player_id);
    }

    // Insert Participant Record with Safe Schema Fallback
    let participantData = null;
    try {
      const { data, error } = await supabase
        .from('game_participants')
        .insert([{
          player_id,
          game_id,
          purchased_cards: numCards,
          is_winner: false,
          metadata: { cards: requestedCards }
        }])
        .select()
        .single();
      if (error && (error.message.includes('metadata') || error.code === 'PGRST204')) {
        throw error; // trigger catch fallback
      }
      participantData = data;
    } catch (pErr) {
      // Schema fallback without metadata column
      const { data: fbData, error: fbErr } = await supabase
        .from('game_participants')
        .insert([{
          player_id,
          game_id,
          purchased_cards: numCards,
          is_winner: false
        }])
        .select()
        .single();
      if (fbErr) {
        // Rollback balance update
        await supabase.from('players').update({ balance: player.balance }).eq('player_id', player_id);
        throw fbErr;
      }
      participantData = fbData;
    }

    await logTransaction({
      player_id,
      type: 'entry_fee',
      amount: -cost,
      game_id,
      balance_after: newTotal,
      notes: `${numCards} card(s) entry fee (${deductPlay} ETB Play Wallet, ${deductMain} ETB Main Wallet)`
    });

    res.json({
      success: true,
      participant: participantData,
      main_balance: newMain,
      play_balance: newPlay,
      balance: newTotal
    });
  } catch (err) {
    console.error("games/create failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Player History
app.get('/api/history/:player_id', async (req, res) => {
  try {
    const { player_id } = req.params;
    if (!player_id || player_id === 'undefined' || player_id === 'null') {
      return res.status(200).json([]);
    }
    const { data, error } = await supabase
      .from('game_participants')
      .select('game_id, purchased_cards, is_winner')
      .eq('player_id', player_id);

    if (error) throw error;
    return res.status(200).json(data || []);
  } catch (catchErr) {
    return res.status(200).json([]);
  }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('players')
      .select('username, balance')
      .order('balance', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(200).json([]);
  }
});

// Deposit Request Endpoint (with Duplicate Reference Safeguard)
app.post('/api/wallet/deposit-request', async (req, res) => {
  const { player_id, method, amount, reference_id } = req.body;
  const amt = Number(amount);
  if (!player_id || !amt || amt <= 0 || !reference_id || !method) {
    return res.status(400).json({ success: false, error: "Missing required deposit details." });
  }

  const cleanRef = String(reference_id).trim().toUpperCase();
  const isDuplicate = submittedReferenceIds.has(cleanRef);
  submittedReferenceIds.add(cleanRef);

  const depositRecord = {
    id: Date.now(),
    player_id,
    method,
    amount: amt,
    reference_id: cleanRef,
    is_duplicate: isDuplicate,
    status: 'pending',
    requested_at: new Date().toISOString()
  };

  try {
    const { data, error } = await supabase
      .from('deposit_requests')
      .insert([depositRecord])
      .select().single();
    if (error) throw error;
    res.json({ success: true, request: data, is_duplicate: isDuplicate });
  } catch (err) {
    // Memory fallback if DB table not present
    inMemoryDeposits.unshift(depositRecord);
    res.json({ success: true, request: depositRecord, is_duplicate: isDuplicate });
  }
});

// Redeem Coupon Endpoint
app.post('/api/wallet/redeem-coupon', async (req, res) => {
  const { player_id, coupon_code } = req.body;
  if (!player_id || !coupon_code) {
    return res.status(400).json({ success: false, error: "Player ID and Coupon Code are required." });
  }

  const code = String(coupon_code).trim().toUpperCase();
  const key = `${player_id}:${code}`;

  if (couponRedemptions.has(key)) {
    return res.status(400).json({ success: false, error: "You have already redeemed this coupon code." });
  }

  // Find coupon
  let coupon = inMemoryCoupons.find(c => c.code === code && c.is_active);
  if (!coupon) {
    try {
      const { data } = await supabase.from('coupons').select('*').eq('code', code).eq('is_active', true).single();
      coupon = data;
    } catch (e) {}
  }

  if (!coupon) {
    return res.status(404).json({ success: false, error: "Invalid or expired coupon code." });
  }

  if (coupon.used_count >= coupon.max_uses) {
    return res.status(400).json({ success: false, error: "Coupon usage limit reached." });
  }

  // Record redemption and credit Play Wallet
  couponRedemptions.add(key);
  coupon.used_count += 1;

  try {
    const updated = await creditPlayerBalances(player_id, {
      playAdd: coupon.bonus_amount,
      type: 'coupon_bonus',
      notes: `Redeemed coupon ${code} (+${coupon.bonus_amount} ETB Play Wallet)`
    });
    res.json({ success: true, coupon_amount: coupon.bonus_amount, balances: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Withdrawal Request (Min 100 ETB, holds Main Wallet balance)
app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { player_id, method, account_number, account_name, amount } = req.body;
  const amt = Number(amount);
  if (!player_id || !amt || amt < MIN_WITHDRAWAL_AMOUNT) {
    return res.status(400).json({ success: false, error: `Minimum withdrawal amount is ${MIN_WITHDRAWAL_AMOUNT} ETB.` });
  }
  if (!method || !account_number) {
    return res.status(400).json({ success: false, error: "Payment method and account number are required." });
  }

  try {
    const { data: playerRow, error: pErr } = await supabase
      .from('players').select('*').eq('player_id', player_id).single();
    if (pErr || !playerRow) throw pErr || new Error("Player not found.");
    if (playerRow.is_banned) return res.status(403).json({ success: false, error: "banned" });

    const player = sanitizePlayer(playerRow);
    if (player.main_balance < amt) {
      return res.status(400).json({ success: false, error: "insufficient_main_balance", message: "Only Main Wallet balance (withdrawable) can be withdrawn." });
    }

    // Hold amount from Main Wallet immediately
    const updated = await creditPlayerBalances(player_id, {
      mainAdd: -amt,
      type: 'withdrawal_hold',
      notes: `Withdrawal request pending admin approval (${method}: ${account_number})`
    });

    const requestPayload = {
      player_id,
      amount: amt,
      method,
      account_number,
      account_name: account_name || '',
      status: 'pending',
      requested_at: new Date().toISOString()
    };

    let request = null;
    try {
      const { data, error: insertErr } = await supabase
        .from('withdrawal_requests')
        .insert([requestPayload])
        .select().single();
      if (insertErr) throw insertErr;
      request = data;
    } catch (dbErr) {
      request = { id: Date.now(), ...requestPayload };
    }

    res.json({ success: true, balances: updated, request });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch Player Withdrawals
app.get('/api/wallet/withdrawals/:player_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('player_id', req.params.player_id)
      .order('requested_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ADMIN API ROUTES ---

app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const pot = await getRoundPot(currentActiveGameRoundId);
    let participantCount = 0;
    try {
      const { count } = await supabase
        .from('game_participants')
        .select('*', { count: 'exact', head: true })
        .eq('game_id', currentActiveGameRoundId);
      participantCount = count || 0;
    } catch (e) {}

    res.json({
      state: globalGameState,
      game_id: currentActiveGameRoundId,
      timeRemaining,
      drawnBallsHistory,
      pot,
      potentialPayout: computePayout(pot, PAYOUT_PERCENTAGE),
      participantCount,
      minPlayersToStart: MIN_PLAYERS_TO_START,
      cardPrice: CARD_PRICE,
      payoutPercentage: PAYOUT_PERCENTAGE,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('deposit_requests').select('*').order('requested_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.json(inMemoryDeposits);
  }
});

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const reqId = req.params.id;
  try {
    let depositReq = inMemoryDeposits.find(d => String(d.id) === String(reqId));
    if (!depositReq) {
      const { data } = await supabase.from('deposit_requests').select('*').eq('id', reqId).single();
      depositReq = data;
    }
    if (!depositReq) return res.status(404).json({ error: "Deposit request not found." });

    // Approve Deposit: Add amount to Main Wallet + 10% bonus to Play Wallet!
    const amt = Number(depositReq.amount);
    const bonus = Math.floor(amt * 0.10); // 10% Deposit Bonus

    const updated = await creditPlayerBalances(depositReq.player_id, {
      mainAdd: amt,
      playAdd: bonus,
      type: 'deposit_approved',
      notes: `Approved deposit ${amt} ETB (+${bonus} ETB 10% Play Wallet Bonus)`
    });

    depositReq.status = 'approved';
    try {
      await supabase.from('deposit_requests').update({ status: 'approved' }).eq('id', reqId);
    } catch (e) {}

    res.json({ success: true, balances: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const reqId = req.params.id;
  try {
    let depositReq = inMemoryDeposits.find(d => String(d.id) === String(reqId));
    if (depositReq) depositReq.status = 'rejected';
    try {
      await supabase.from('deposit_requests').update({ status: 'rejected' }).eq('id', reqId);
    } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('withdrawal_requests').select('*').order('requested_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/admin/withdrawals/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { data: reqRow, error: fetchErr } = await supabase
      .from('withdrawal_requests').select('*').eq('id', req.params.id).single();
    if (fetchErr || !reqRow) throw fetchErr || new Error("Request not found.");

    await supabase.from('withdrawal_requests').update({
      status: 'approved', resolved_at: new Date().toISOString()
    }).eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/withdrawals/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { data: reqRow, error: fetchErr } = await supabase
      .from('withdrawal_requests').select('*').eq('id', req.params.id).single();
    if (fetchErr || !reqRow) throw fetchErr || new Error("Request not found.");

    // Refund held amount to Main Wallet
    const updated = await creditPlayerBalances(reqRow.player_id, {
      mainAdd: Number(reqRow.amount),
      type: 'withdrawal_rejected_refund',
      notes: `Rejected withdrawal #${reqRow.id} - ${reqRow.amount} ETB refunded to Main Wallet`
    });

    await supabase.from('withdrawal_requests').update({
      status: 'rejected', resolved_at: new Date().toISOString()
    }).eq('id', req.params.id);

    res.json({ success: true, balances: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/coupons/create', requireAdmin, (req, res) => {
  const { code, bonus_amount, max_uses, expiry_date } = req.body;
  if (!code || !bonus_amount) {
    return res.status(400).json({ error: "Code and bonus amount required." });
  }
  const cleanCode = String(code).trim().toUpperCase();
  const coupon = {
    code: cleanCode,
    bonus_amount: Number(bonus_amount),
    max_uses: Number(max_uses || 100),
    used_count: 0,
    is_active: true,
    expiry_date: expiry_date || '2030-01-01'
  };
  inMemoryCoupons.unshift(coupon);
  res.json({ success: true, coupon });
});

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  res.json(inMemoryCoupons);
});

app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('players').select('*').limit(200);
    if (error) throw error;
    const sanitized = (data || []).map(sanitizePlayer);
    res.json(sanitized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/players/:id/ban', requireAdmin, async (req, res) => {
  try {
    await supabase.from('players').update({ is_banned: true }).eq('player_id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/players/:id/unban', requireAdmin, async (req, res) => {
  try {
    await supabase.from('players').update({ is_banned: false }).eq('player_id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/credit-player', requireAdmin, async (req, res) => {
  const { player_id, amount, wallet_type, notes } = req.body;
  const amt = Number(amount);
  if (!player_id || !amt) return res.status(400).json({ error: "player_id and amount required." });
  try {
    const isPlay = wallet_type === 'play';
    const updated = await creditPlayerBalances(player_id, {
      mainAdd: isPlay ? 0 : amt,
      playAdd: isPlay ? amt : 0,
      type: 'admin_credit',
      notes: notes || `Admin manual credit to ${isPlay ? 'Play' : 'Main'} Wallet`
    });
    res.json({ success: true, balances: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GAME LOOP & WINNER SPLIT LOGIC ---

let globalGameState = "waiting";
let timeRemaining = INITIAL_WAIT_SECONDS;
let currentActiveGameRoundId = null;
let currentRoundPot = 0;
let ballPool = [];
let drawnBallsHistory = [];
let gameBallInterval = null;
let tickBusy = false;
let currentRoundWinners = []; // Tracks simultaneous winners for split payouts

function resetBallPool() {
  ballPool = [];
  drawnBallsHistory = [];
  currentRoundWinners = [];
  for (let i = 1; i <= 75; i++) ballPool.push(i);
}

async function getRoundPot(game_id) {
  try {
    const { data, error } = await supabase
      .from('game_participants')
      .select('purchased_cards')
      .eq('game_id', game_id);
    if (error || !data) return 0;
    const totalCards = data.reduce((sum, row) => sum + (Number(row.purchased_cards) || 0), 0);
    return totalCards * CARD_PRICE;
  } catch (err) {
    return 0;
  }
}

async function startNewRound() {
  currentActiveGameRoundId = generateRoundId();
  globalGameState = "waiting";
  timeRemaining = INITIAL_WAIT_SECONDS; // 40 Seconds Loop Countdown!
  currentRoundPot = 0;
  drawnBallsHistory = [];
  currentRoundWinners = [];
  try {
    await supabase.from('rounds').insert([{ game_id: currentActiveGameRoundId, state: 'waiting' }]);
  } catch (err) {}
}

function startBallDrawingSequence() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  gameBallInterval = setInterval(() => {
    if (globalGameState !== "playing") {
      clearInterval(gameBallInterval);
      return;
    }
    if (ballPool.length === 0) {
      clearInterval(gameBallInterval);
      globalGameState = "waiting";
      timeRemaining = POST_ROUND_PAUSE_SECONDS;
      io.emit('opponent_victory', { winnerName: "No one (All Numbers Called)", cardNum: "N/A", winnerPlayerId: null, isSplit: false });
      startNewRound();
      return;
    }
    const drawnNumber = drawRandomBall(ballPool);
    ballPool = ballPool.filter(n => n !== drawnNumber);
    drawnBallsHistory.push(drawnNumber);

    io.emit('ball_drawn', {
      number: drawnNumber,
      pool: drawnBallsHistory
    });
  }, 3000);
}

// Multi-Winner Split Resolution
async function resolveRoundWinners() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = POST_ROUND_PAUSE_SECONDS;

  const winnerCount = currentRoundWinners.length;
  if (winnerCount === 0) {
    await startNewRound();
    return;
  }

  const totalPayout = computePayout(currentRoundPot, PAYOUT_PERCENTAGE);
  const payoutPerWinner = Math.floor(totalPayout / winnerCount);

  for (const winner of currentRoundWinners) {
    try {
      await creditPlayerBalances(winner.player_id, {
        mainAdd: payoutPerWinner, // Winnings added to withdrawable Main Wallet!
        type: 'payout',
        game_id: currentActiveGameRoundId,
        notes: `Bingo Win on Card #${winner.cardNum}${winnerCount > 1 ? ` (Split ${winnerCount} ways)` : ''}`
      });
      await supabase.from('game_participants')
        .update({ is_winner: true })
        .eq('game_id', currentActiveGameRoundId)
        .eq('player_id', winner.player_id);
    } catch (err) {
      console.error("Error crediting winner:", err);
    }
  }

  const winnerNames = currentRoundWinners.map(w => w.username).join(', ');
  const primaryWinner = currentRoundWinners[0];

  io.emit('opponent_victory', {
    winnerName: winnerNames,
    cardNum: primaryWinner.cardNum,
    winnerPlayerId: primaryWinner.player_id,
    payoutAmount: payoutPerWinner,
    isSplit: winnerCount > 1,
    splitCount: winnerCount
  });

  await startNewRound();
}

// Global 1-second Tick Loop
setInterval(async () => {
  if (tickBusy || !currentActiveGameRoundId) return;
  tickBusy = true;
  try {
    if (globalGameState === "waiting") {
      timeRemaining--;
      if (timeRemaining <= 0) {
        let participantCount = 0;
        try {
          const { count } = await supabase
            .from('game_participants')
            .select('*', { count: 'exact', head: true })
            .eq('game_id', currentActiveGameRoundId);
          participantCount = count || 0;
        } catch (e) {}

        if (participantCount < MIN_PLAYERS_TO_START) {
          // Re-check countdown loops back to 40 seconds!
          timeRemaining = RECHECK_WAIT_SECONDS;
        } else {
          globalGameState = "playing";
          resetBallPool();
          currentRoundPot = await getRoundPot(currentActiveGameRoundId);
          startBallDrawingSequence();
        }
      }
    }

    let liveParticipantCount = 0;
    try {
      const { count } = await supabase
        .from('game_participants')
        .select('*', { count: 'exact', head: true })
        .eq('game_id', currentActiveGameRoundId);
      liveParticipantCount = count || 0;
    } catch (e) {}

    io.emit('room_tick', {
      gameId: currentActiveGameRoundId,
      state: globalGameState,
      timeRemaining,
      drawnHistory: drawnBallsHistory,
      participantCount: liveParticipantCount,
      minPlayersToStart: MIN_PLAYERS_TO_START,
    });
  } catch (err) {
    console.error("Game loop error:", err.message);
  } finally {
    tickBusy = false;
  }
}, 1000);

// Socket.io Handlers
io.on('connection', (socket) => {
  socket.emit('room_tick', {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining,
    drawnHistory: drawnBallsHistory,
    minPlayersToStart: MIN_PLAYERS_TO_START,
  });

  socket.on('claim_bingo', async (data) => {
    if (globalGameState !== "playing") return;
    const { player_id, cardNum } = data || {};
    if (!player_id || !cardNum) return;

    // Check if player already registered in winners list
    if (currentRoundWinners.some(w => w.player_id === player_id)) return;

    try {
      // Validate card winning pattern (Rows, Cols, Diagonals, 4 Corners)
      if (!cardHasWinningLine(Number(cardNum), drawnBallsHistory)) return;

      const { data: playerRow } = await supabase
        .from('players').select('*').eq('player_id', player_id).single();
      if (!playerRow || playerRow.is_banned) return;

      currentRoundWinners.push({
        player_id,
        username: playerRow.username || `Player_${player_id.substring(0, 4)}`,
        cardNum
      });

      // Wait a brief moment to collect simultaneous claims (split payouts)
      setTimeout(() => {
        resolveRoundWinners();
      }, 500);

    } catch (err) {
      console.error("Bingo claim error:", err.message);
    }
  });
});

async function bootServer() {
  if (process.env.NODE_ENV !== "production") {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa'
      });
      app.use(vite.middlewares);
    } catch (err) {
      console.error("Vite middleware load error, falling back to static dist:", err);
      const distPath = path.join(__dirname, 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  startNewRound();
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`⚡ Fast Bingo server running on port ${PORT}`);
  });
}

bootServer();
