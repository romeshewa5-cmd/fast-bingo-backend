require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-secret", "X-Requested-With"]
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'dist')));

// ============ SUPABASE (only if REALLY configured) ============
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_KEY || "";
// FIX: the old code used a "dummy-key-for-initialization" fallback. That created a
// client that silently failed on EVERY query, so nothing was ever persisted.
const SUPABASE_ENABLED = !!(supabaseUrl && supabaseKey && !supabaseKey.includes('dummy'));

let supabase = null;
if (SUPABASE_ENABLED) {
  try { supabase = createClient(supabaseUrl, supabaseKey); }
  catch (e) { console.log("Supabase init error:", e.message); supabase = null; }
}
console.log("📦 Supabase:", supabase ? "ENABLED" : "DISABLED (using local file persistence)");

// ============ CONSTANTS ============
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOW_UNVERIFIED_INITDATA = String(process.env.ALLOW_UNVERIFIED_INITDATA || 'false') === 'true';
const CARD_PRICE = Number(process.env.CARD_PRICE) || 10;
const PAYOUT_PERCENTAGE = Number(process.env.PAYOUT_PERCENTAGE) || 0.8;
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START) || 2;
const INITIAL_WAIT_SECONDS = Number(process.env.INITIAL_WAIT_SECONDS) || 40;
const RECHECK_WAIT_SECONDS = Number(process.env.RECHECK_WAIT_SECONDS) || 40;
const POST_ROUND_PAUSE_SECONDS = Number(process.env.POST_ROUND_PAUSE_SECONDS) || 15;
const MIN_WITHDRAWAL_AMOUNT = Number(process.env.MIN_WITHDRAWAL_AMOUNT) || 100;
const SIGNUP_BONUS = 10;
const TG_GROUP_BONUS = 10;

// ============ LOCAL PERSISTENCE (survives restarts) ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const PHONES_FILE = path.join(DATA_DIR, 'phones.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const inMemoryPlayers = new Map();        // player_id -> player
const inMemoryPhoneToId = new Map();      // phone -> player_id
const inMemoryTgToId = new Map();         // telegram_id -> player_id
const tgPhoneBook = new Map();            // telegram_id -> real phone shared with the bot

function loadDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    (raw || []).forEach(p => {
      inMemoryPlayers.set(p.player_id, p);
      if (p.phone_number) inMemoryPhoneToId.set(String(p.phone_number), p.player_id);
      if (p.telegram_id) inMemoryTgToId.set(String(p.telegram_id), p.player_id);
    });
    console.log(`💾 Loaded ${inMemoryPlayers.size} players from disk`);
  } catch (e) {}
  try {
    const raw = JSON.parse(fs.readFileSync(PHONES_FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([k, v]) => tgPhoneBook.set(String(k), v));
  } catch (e) {}
}
let flushTimer = null;
function flushDisk() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(Array.from(inMemoryPlayers.values()))); } catch (e) {}
    try { fs.writeFileSync(PHONES_FILE, JSON.stringify(Object.fromEntries(tgPhoneBook))); } catch (e) {}
  }, 400);
}
loadDisk();

const inMemoryDeposits = [];
const inMemoryCoupons = [
  { code: 'BINGO20', bonus_amount: 20, max_uses: 1000, used_count: 0, is_active: true },
  { code: 'FREEPLAY', bonus_amount: 10, max_uses: 500, used_count: 0, is_active: true },
];
const couponRedemptions = new Set();
const submittedReferenceIds = new Set();

// Round participants kept in memory so the game works WITHOUT supabase.
// gameId -> Map(player_id -> { purchased_cards, cards, username })
const roundParticipants = new Map();
function participantsOf(gameId) {
  if (!roundParticipants.has(gameId)) roundParticipants.set(gameId, new Map());
  return roundParticipants.get(gameId);
}

// ============ TELEGRAM initData VALIDATION ============
function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}
function verifyInitData(initData) {
  if (!initData) return null;
  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return null;

  if (BOT_TOKEN) {
    const checkString = Object.keys(data)
      .filter(k => k !== 'hash' && k !== 'signature')
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
    if (calc !== hash && !ALLOW_UNVERIFIED_INITDATA) return null;
  } else if (!ALLOW_UNVERIFIED_INITDATA) {
    console.warn("⚠️ BOT_TOKEN not set - cannot verify initData");
    return null;
  }

  try {
    const user = JSON.parse(data.user || '{}');
    if (!user.id) return null;
    return { user, start_param: data.start_param || '' };
  } catch (e) { return null; }
}

function sanitizePlayer(p) {
  if (!p) return null;
  const main = Number(p.main_balance ?? p.balance ?? 0);
  const play = Number(p.play_balance ?? 0);
  return {
    ...p,
    main_balance: main,
    play_balance: play,
    balance: main + play,
    referrals_count: Number(p.referrals_count ?? 0),
    referral_earnings: Number(p.referral_earnings ?? 0),
  };
}

async function findPlayerByTelegramId(telegram_id) {
  if (!telegram_id) return null;
  const tid = String(telegram_id);
  if (supabase) {
    try {
      const { data } = await supabase.from('players').select('*').eq('telegram_id', tid).maybeSingle();
      if (data) { cachePlayer(data); return data; }
    } catch (e) {}
  }
  const pid = inMemoryTgToId.get(tid);
  return pid ? inMemoryPlayers.get(pid) || null : null;
}
async function findPlayerByPhone(phone_number) {
  if (!phone_number) return null;
  if (supabase) {
    try {
      const { data } = await supabase.from('players').select('*').eq('phone_number', phone_number).maybeSingle();
      if (data) { cachePlayer(data); return data; }
    } catch (e) {}
  }
  const pId = inMemoryPhoneToId.get(String(phone_number));
  return pId ? inMemoryPlayers.get(pId) || null : null;
}
async function findPlayerById(player_id) {
  if (!player_id) return null;
  if (supabase) {
    try {
      const { data } = await supabase.from('players').select('*').eq('player_id', player_id).maybeSingle();
      if (data) { cachePlayer(data); return data; }
    } catch (e) {}
  }
  return inMemoryPlayers.get(player_id) || null;
}
function cachePlayer(p) {
  if (!p || !p.player_id) return;
  inMemoryPlayers.set(p.player_id, p);
  if (p.phone_number) inMemoryPhoneToId.set(String(p.phone_number), p.player_id);
  if (p.telegram_id) inMemoryTgToId.set(String(p.telegram_id), p.player_id);
  flushDisk();
}
async function savePlayer(playerObj) {
  if (!playerObj || !playerObj.player_id) return playerObj;
  cachePlayer(playerObj);
  if (!supabase) return playerObj;
  try {
    const { data } = await supabase.from('players').upsert([playerObj], { onConflict: 'player_id' }).select().maybeSingle();
    if (data) cachePlayer(data);
    return data || playerObj;
  } catch (err) {}
  return playerObj;
}

async function logTransaction({ player_id, type, amount, game_id, balance_after, notes }) {
  if (!supabase) return;
  try {
    await supabase.from('transactions').insert([{ player_id, type, amount, game_id, balance_after, notes }]);
  } catch (err) {}
}

async function creditPlayerBalances(player_id, { mainAdd = 0, playAdd = 0, type, game_id, notes }) {
  let player = await findPlayerById(player_id);
  if (!player) return null; // FIX: never silently invent a player
  const curMain = Number(player.main_balance ?? player.balance ?? 0);
  const curPlay = Number(player.play_balance ?? 0);
  const newMain = Math.max(0, curMain + mainAdd);
  const newPlay = Math.max(0, curPlay + playAdd);
  const updated = { ...player, main_balance: newMain, play_balance: newPlay, balance: newMain + newPlay };
  await savePlayer(updated);
  await logTransaction({ player_id, type, amount: mainAdd + playAdd, game_id, balance_after: updated.balance, notes });
  return { main_balance: newMain, play_balance: newPlay, balance: newMain + newPlay };
}

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET || '';
  const provided = req.headers['x-admin-secret'] || '';
  if (secret ? provided === secret : ['admin', '123456', 'fastbingo'].includes(provided)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ============================================================
//                        API ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining,
    participants: participantsOf(currentActiveGameRoundId).size,
    players: inMemoryPlayers.size,
    supabase: !!supabase
  });
});
app.get('/api/health-check', (req, res) => res.json({ status: 'online', timestamp: new Date().toISOString() }));

/**
 * MAIN AUTH ENDPOINT.
 * The webapp sends Telegram.WebApp.initData. We verify the HMAC, take the REAL
 * telegram id / username from it, and look the player up BY TELEGRAM ID.
 * -> Re-opening the webapp always returns the same account (no more re-register).
 * -> Username is always the real Telegram username.
 * -> Phone comes from the bot's contact-share (phonebook), never invented.
 */
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { initData, referrer_id } = req.body || {};
    const verified = verifyInitData(initData);
    if (!verified) return res.status(401).json({ error: 'invalid_init_data' });

    const tgUser = verified.user;
    const telegram_id = String(tgUser.id);
    const username = tgUser.username
      || [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ')
      || `tg_${telegram_id}`;
    const knownPhone = tgPhoneBook.get(telegram_id) || null;

    let player = await findPlayerByTelegramId(telegram_id);

    if (player) {
      const patch = { ...player, username };
      if (knownPhone && player.phone_number !== knownPhone) patch.phone_number = knownPhone;
      player = await savePlayer(patch);
      return res.json({
        isNew: false,
        needs_phone: !patch.phone_number,
        user: sanitizePlayer(player)
      });
    }

    if (!knownPhone) {
      // Not registered yet and the bot has no phone for this user.
      return res.json({ isNew: true, needs_phone: true, telegram_id, username, user: null });
    }

    player = await createPlayer({ username, phone_number: knownPhone, telegram_id, referrer_id: referrer_id || verified.start_param });
    res.json({ isNew: true, needs_phone: false, user: sanitizePlayer(player) });
  } catch (err) {
    console.error("❌ auth error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Poll this while the user is sharing the contact with the bot
app.post('/api/auth/phone-status', async (req, res) => {
  const verified = verifyInitData((req.body || {}).initData);
  if (!verified) return res.status(401).json({ error: 'invalid_init_data' });
  const tid = String(verified.user.id);
  const phone = tgPhoneBook.get(tid) || null;
  if (!phone) return res.json({ has_phone: false });

  let player = await findPlayerByTelegramId(tid);
  if (!player) {
    const username = verified.user.username
      || [verified.user.first_name, verified.user.last_name].filter(Boolean).join(' ')
      || `tg_${tid}`;
    player = await createPlayer({
      username, phone_number: phone, telegram_id: tid,
      referrer_id: (req.body || {}).referrer_id || verified.start_param
    });
    return res.json({ has_phone: true, isNew: true, user: sanitizePlayer(player) });
  }
  if (!player.phone_number) player = await savePlayer({ ...player, phone_number: phone });
  res.json({ has_phone: true, isNew: false, user: sanitizePlayer(player) });
});

async function createPlayer({ username, phone_number, telegram_id, referrer_id }) {
  const existingByPhone = await findPlayerByPhone(phone_number);
  if (existingByPhone) {
    return await savePlayer({ ...existingByPhone, telegram_id: telegram_id || existingByPhone.telegram_id, username });
  }
  const playerId = `p_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const newPlayer = {
    player_id: playerId,
    username,
    phone_number,
    telegram_id: telegram_id ? String(telegram_id) : null,
    main_balance: 0,
    play_balance: SIGNUP_BONUS,
    balance: SIGNUP_BONUS,
    referred_by: referrer_id || null,
    referrals_count: 0,
    referral_earnings: 0,
    tg_bonus_claimed: false,
    tg_group_joined: false,
    created_at: new Date().toISOString()
  };
  const saved = await savePlayer(newPlayer);
  await logTransaction({ player_id: saved.player_id, type: 'signup_bonus', amount: SIGNUP_BONUS, balance_after: SIGNUP_BONUS, notes: 'Signup bonus' });
  console.log("✅ New player:", saved.player_id, username, phone_number);
  return saved;
}

/**
 * Telegram BOT WEBHOOK.
 * Point your bot webhook here: https://<your-domain>/api/telegram/webhook
 * When the user taps the "Share phone number" keyboard button, Telegram sends a
 * message with `contact` -> that's the ONLY reliable way to get a real phone.
 */
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (!msg) return;
    const from = msg.from || {};
    const tid = String(from.id);

    if (msg.contact && String(msg.contact.user_id) === tid) {
      let phone = String(msg.contact.phone_number || '').replace(/\s/g, '');
      if (phone && !phone.startsWith('+')) phone = '+' + phone;
      tgPhoneBook.set(tid, phone);
      flushDisk();
      console.log("📞 Contact stored for", tid, phone);

      const username = from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || `tg_${tid}`;
      let player = await findPlayerByTelegramId(tid);
      if (!player) await createPlayer({ username, phone_number: phone, telegram_id: tid });
      else if (!player.phone_number) await savePlayer({ ...player, phone_number: phone });

      await tgSend(msg.chat.id, "✅ Phone verified! Open the app and start playing.", {
        remove_keyboard: true
      });
    } else if (msg.text && msg.text.startsWith('/start')) {
      if (tgPhoneBook.has(tid)) {
        await tgSend(msg.chat.id, "🎮 You're verified. Tap the menu button to play Fast Bingo!");
      } else {
        await tgSend(msg.chat.id, "👋 Welcome to Fast Bingo!\nShare your phone number to create your account.", {
          keyboard: [[{ text: "📱 Share my phone number", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        });
      }
    }
  } catch (e) { console.error("webhook error", e.message); }
});

async function tgSend(chat_id, text, reply_markup) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, reply_markup })
    });
  } catch (e) {}
}

// Legacy register endpoint (kept for compatibility, now telegram-id aware)
app.post('/api/register', async (req, res) => {
  const { username, phone_number, referrer_id, telegram_id } = req.body;
  if (!username || !phone_number) return res.status(400).json({ error: "Username and phone required" });
  try {
    let player = telegram_id ? await findPlayerByTelegramId(telegram_id) : null;
    if (!player) player = await findPlayerByPhone(phone_number);
    if (player) return res.json({ isNew: false, user: sanitizePlayer(player) });
    const created = await createPlayer({ username, phone_number, telegram_id, referrer_id });
    res.json({ isNew: true, user: sanitizePlayer(created) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim-telegram-bonus', async (req, res) => {
  const { player_id, claimed_tg_group } = req.body;
  if (!player_id) return res.status(400).json({ error: "Player ID required" });
  try {
    const player = await findPlayerById(player_id);
    if (!player) return res.status(404).json({ error: "Player not found" });
    if (player.tg_bonus_claimed) return res.json({ success: true, claimed: true, user: sanitizePlayer(player) });

    const bonusAmount = claimed_tg_group === true ? TG_GROUP_BONUS : 0;
    const balances = await creditPlayerBalances(player_id, {
      playAdd: bonusAmount,
      type: claimed_tg_group ? 'telegram_group_bonus' : 'signup_complete',
      notes: claimed_tg_group ? 'TG Group bonus' : 'Signup complete'
    }) || {};
    const updated = await savePlayer({ ...player, ...balances, tg_bonus_claimed: true, tg_group_joined: claimed_tg_group === true });
    res.json({ success: true, user: sanitizePlayer(updated), bonus_credited: bonusAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/player/:id', async (req, res) => {
  try {
    const player = await findPlayerById(req.params.id);
    if (!player) return res.status(404).json({ error: "Player not found" });
    res.json(sanitizePlayer(player));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/games/check-active/:player_id/:game_id', async (req, res) => {
  const { player_id, game_id } = req.params;
  const p = participantsOf(game_id).get(player_id);
  if (p) return res.json({ registered: true, cards_bought: p.purchased_cards, cards_list: p.cards });
  if (supabase) {
    try {
      const { data } = await supabase.from('game_participants').select('*').eq('player_id', player_id).eq('game_id', game_id).maybeSingle();
      if (data) {
        const cards = data.metadata?.cards || [];
        return res.json({ registered: true, cards_bought: data.purchased_cards || 1, cards_list: cards });
      }
    } catch (e) {}
  }
  res.json({ registered: false });
});

app.get('/api/games/taken-cards/:game_id', async (req, res) => {
  const taken = new Set();
  participantsOf(req.params.game_id).forEach(p => (p.cards || []).forEach(c => taken.add(Number(c))));
  if (supabase) {
    try {
      const { data } = await supabase.from('game_participants').select('*').eq('game_id', req.params.game_id);
      if (data) data.forEach(r => (r.metadata?.cards || []).forEach(c => taken.add(Number(c))));
    } catch (e) {}
  }
  res.json({ taken: Array.from(taken) });
});

app.post('/api/games/create', async (req, res) => {
  const { player_id, game_id, cards_bought, cards_list } = req.body;
  console.log("🎮 Game create:", player_id, game_id, cards_bought);

  if (!player_id || !game_id || !cards_bought) {
    return res.status(400).json({ success: false, error: "missing_fields" });
  }
  try {
    if (game_id !== currentActiveGameRoundId) {
      return res.status(400).json({ success: false, error: "round_expired", game_id: currentActiveGameRoundId });
    }
    if (globalGameState !== "waiting") {
      return res.status(400).json({ success: false, error: "round_not_open" });
    }

    const player = await findPlayerById(player_id);
    if (!player) return res.status(404).json({ success: false, error: "player_not_found" });
    if (player.is_banned) return res.status(403).json({ success: false, error: "banned" });

    const parts = participantsOf(game_id);
    if (parts.has(player_id)) return res.status(400).json({ success: false, error: "already_registered" });

    const wanted = (cards_list && cards_list.length ? cards_list : [117]).map(Number);
    const taken = new Set();
    parts.forEach(p => (p.cards || []).forEach(c => taken.add(Number(c))));
    if (wanted.some(c => taken.has(c))) {
      return res.status(400).json({ success: false, error: "card_taken" });
    }

    const sp = sanitizePlayer(player);
    const cost = CARD_PRICE * Number(cards_bought);
    if (sp.balance < cost) return res.status(400).json({ success: false, error: "insufficient_balance" });

    const deductPlay = Math.min(sp.play_balance, cost);
    const deductMain = cost - deductPlay;
    const balances = await creditPlayerBalances(player_id, {
      mainAdd: -deductMain, playAdd: -deductPlay,
      type: 'entry_fee', game_id, notes: `${cards_bought} cards`
    });
    if (!balances) return res.status(404).json({ success: false, error: "player_not_found" });

    parts.set(player_id, {
      purchased_cards: Number(cards_bought),
      cards: wanted,
      username: player.username || 'Player'
    });

    if (supabase) {
      try {
        await supabase.from('game_participants').insert([{
          player_id, game_id, purchased_cards: Number(cards_bought), is_winner: false, metadata: { cards: wanted }
        }]);
      } catch (e) {}
    }

    broadcastTick();
    console.log(`✅ Joined round ${game_id}: ${parts.size} participant(s)`);
    res.json({ success: true, ...balances });
  } catch (err) {
    console.error("❌ Game create error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history/:player_id', async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data } = await supabase.from('game_participants').select('game_id, purchased_cards, is_winner').eq('player_id', req.params.player_id);
    res.json(data || []);
  } catch (err) { res.json([]); }
});

app.get('/api/leaderboard', async (req, res) => {
  if (supabase) {
    try {
      const { data } = await supabase.from('players').select('username, balance').order('balance', { ascending: false }).limit(10);
      if (data) return res.json(data);
    } catch (err) {}
  }
  const list = Array.from(inMemoryPlayers.values()).map(sanitizePlayer)
    .sort((a, b) => b.balance - a.balance).slice(0, 10)
    .map(p => ({ username: p.username, balance: p.balance }));
  res.json(list);
});

app.post('/api/wallet/deposit-request', async (req, res) => {
  const { player_id, method, amount, reference_id } = req.body;
  if (!player_id || !amount || !reference_id) return res.status(400).json({ success: false, error: "Missing fields" });
  const cleanRef = String(reference_id).toUpperCase();
  if (submittedReferenceIds.has(cleanRef)) return res.status(400).json({ success: false, error: "duplicate_reference" });
  submittedReferenceIds.add(cleanRef);
  const record = { id: Date.now(), player_id, method: method || 'Telebirr', amount: Number(amount), reference_id: cleanRef, status: 'pending', requested_at: new Date().toISOString() };
  inMemoryDeposits.push(record);
  if (supabase) { try { await supabase.from('deposit_requests').insert([record]); } catch (e) {} }
  res.json({ success: true, request: record });
});

app.post('/api/wallet/redeem-coupon', async (req, res) => {
  const { player_id, coupon_code } = req.body;
  if (!player_id || !coupon_code) return res.status(400).json({ success: false, error: "Missing fields" });
  const code = String(coupon_code).toUpperCase();
  const key = `${player_id}:${code}`;
  if (couponRedemptions.has(key)) return res.status(400).json({ success: false, error: "Already redeemed" });
  const coupon = inMemoryCoupons.find(c => c.code === code && c.is_active);
  if (!coupon) return res.status(404).json({ success: false, error: "Invalid coupon" });
  const balances = await creditPlayerBalances(player_id, { playAdd: coupon.bonus_amount, type: 'coupon', notes: `Coupon ${code}` });
  if (!balances) return res.status(404).json({ success: false, error: "Player not found" });
  couponRedemptions.add(key);
  coupon.used_count++;
  res.json({ success: true, coupon_amount: coupon.bonus_amount, balances });
});

app.post('/api/wallet/withdraw-request', async (req, res) => {
  const { player_id, method, account_number, account_name, amount } = req.body;
  if (!player_id || !amount || Number(amount) < MIN_WITHDRAWAL_AMOUNT) {
    return res.status(400).json({ success: false, error: `Min ${MIN_WITHDRAWAL_AMOUNT} ETB` });
  }
  try {
    const player = await findPlayerById(player_id);
    if (!player) return res.status(404).json({ success: false, error: "Player not found" });
    const sp = sanitizePlayer(player);
    if (sp.main_balance < Number(amount)) return res.status(400).json({ success: false, error: "Insufficient main balance" });
    const balances = await creditPlayerBalances(player_id, { mainAdd: -Number(amount), type: 'withdrawal', notes: `Withdraw ${amount}` });
    if (supabase) {
      try {
        await supabase.from('withdrawal_requests').insert([{
          player_id, amount: Number(amount), method: method || 'Telebirr', account_number: account_number || '',
          account_name: account_name || '', status: 'pending', requested_at: new Date().toISOString()
        }]);
      } catch (e) {}
    }
    res.json({ success: true, balances });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/wallet/withdrawals/:player_id', async (req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data } = await supabase.from('withdrawal_requests').select('*').eq('player_id', req.params.player_id).order('requested_at', { ascending: false });
    res.json(data || []);
  } catch (err) { res.json([]); }
});

// ============ ADMIN ============
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.json({ state: globalGameState, game_id: currentActiveGameRoundId, timeRemaining, participants: participantsOf(currentActiveGameRoundId).size, players: inMemoryPlayers.size });
});
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  res.json(Array.from(inMemoryPlayers.values()).map(sanitizePlayer));
});
app.post('/api/admin/players/:id/ban', requireAdmin, async (req, res) => {
  const p = await findPlayerById(req.params.id);
  if (p) await savePlayer({ ...p, is_banned: true });
  res.json({ success: true });
});
app.post('/api/admin/players/:id/unban', requireAdmin, async (req, res) => {
  const p = await findPlayerById(req.params.id);
  if (p) await savePlayer({ ...p, is_banned: false });
  res.json({ success: true });
});
app.post('/api/admin/credit-player', requireAdmin, async (req, res) => {
  const { player_id, amount, wallet_type } = req.body;
  if (!player_id || !amount) return res.status(400).json({ error: "Missing fields" });
  const isPlay = wallet_type === 'play';
  const balances = await creditPlayerBalances(player_id, {
    mainAdd: isPlay ? 0 : Number(amount),
    playAdd: isPlay ? Number(amount) : 0,
    type: 'admin_credit', notes: 'Admin credit'
  });
  if (!balances) return res.status(404).json({ error: "Player not found" });
  res.json({ success: true, balances });
});

// ============ SPA CATCH-ALL (MUST BE LAST) ============
// FIX: this used to be registered BEFORE every API route.
// Works on both Express 4 and Express 5 (Express 5 rejects the bare '*' path).
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (!err) return;
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err2) => {
      if (err2) res.status(200).send('Fast Bingo API Running');
    });
  });
});

// ============================================================
//                        GAME LOOP
// ============================================================
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ["GET", "POST"], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  serveClient: true
});

let globalGameState = "waiting";
let timeRemaining = INITIAL_WAIT_SECONDS;
let currentActiveGameRoundId = null;
let currentRoundPot = 0;
let ballPool = [];
let drawnBallsHistory = [];
let gameBallInterval = null;
let currentRoundWinners = [];

function tickPayload() {
  return {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining,
    drawnHistory: drawnBallsHistory,
    participantCount: participantsOf(currentActiveGameRoundId).size,
    minPlayersToStart: MIN_PLAYERS_TO_START,
    serverTime: Date.now()
  };
}
function broadcastTick() { io.emit('room_tick', tickPayload()); }

function resetBallPool() {
  ballPool = [];
  drawnBallsHistory = [];
  currentRoundWinners = [];
  for (let i = 1; i <= 75; i++) ballPool.push(i);
}

function startNewRound() {
  if (currentActiveGameRoundId) roundParticipants.delete(currentActiveGameRoundId);
  currentActiveGameRoundId = generateRoundId();
  globalGameState = "waiting";
  timeRemaining = INITIAL_WAIT_SECONDS;
  currentRoundPot = 0;
  drawnBallsHistory = [];
  currentRoundWinners = [];
  participantsOf(currentActiveGameRoundId);
  console.log("🆕 New round:", currentActiveGameRoundId);
  if (supabase) {
    supabase.from('rounds').insert([{ game_id: currentActiveGameRoundId, state: 'waiting' }]).then(() => {}, () => {});
  }
  io.emit('new_round', tickPayload());
  broadcastTick();
}

function startBallDrawing() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  gameBallInterval = setInterval(() => {
    if (globalGameState !== "playing") { clearInterval(gameBallInterval); return; }
    if (ballPool.length === 0) {
      clearInterval(gameBallInterval);
      io.emit('opponent_victory', { winnerName: "No Winner", cardNum: "N/A", winnerPlayerId: null });
      startNewRound();
      return;
    }
    const num = drawRandomBall(ballPool);
    ballPool = ballPool.filter(n => n !== num);
    drawnBallsHistory.push(num);
    io.emit('ball_drawn', { number: num, pool: drawnBallsHistory });
  }, 3000);
}

async function resolveRoundWinners() {
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = POST_ROUND_PAUSE_SECONDS;

  if (currentRoundWinners.length === 0) { startNewRound(); return; }

  const payout = Math.floor((currentRoundPot * PAYOUT_PERCENTAGE) / currentRoundWinners.length);
  for (const winner of currentRoundWinners) {
    await creditPlayerBalances(winner.player_id, { mainAdd: payout, type: 'payout', game_id: currentActiveGameRoundId, notes: `Bingo! Card #${winner.cardNum}` });
    if (supabase) {
      try {
        await supabase.from('game_participants').update({ is_winner: true })
          .eq('game_id', currentActiveGameRoundId).eq('player_id', winner.player_id);
      } catch (e) {}
    }
  }
  io.emit('opponent_victory', {
    winnerName: currentRoundWinners.map(w => w.username).join(', '),
    cardNum: currentRoundWinners[0].cardNum,
    winnerPlayerId: currentRoundWinners[0].player_id,
    payoutAmount: payout,
    isSplit: currentRoundWinners.length > 1
  });
  startNewRound();
}

// FIX: the tick is now fully synchronous + always emits, so the countdown
// can never stall on a slow/failing database call.
setInterval(() => {
  try {
    if (!currentActiveGameRoundId) { startNewRound(); return; }

    if (globalGameState === "waiting") {
      timeRemaining--;
      if (timeRemaining <= 0) {
        const count = participantsOf(currentActiveGameRoundId).size;
        if (count < MIN_PLAYERS_TO_START) {
          console.log(`⏳ Players: ${count}/${MIN_PLAYERS_TO_START}, restarting wait...`);
          timeRemaining = RECHECK_WAIT_SECONDS;
        } else {
          console.log(`🎮 Starting game with ${count} players!`);
          globalGameState = "playing";
          resetBallPool();
          currentRoundPot = Array.from(participantsOf(currentActiveGameRoundId).values())
            .reduce((s, p) => s + (Number(p.purchased_cards) || 0), 0) * CARD_PRICE;
          io.emit('game_started', tickPayload());
          startBallDrawing();
        }
      }
    }
    broadcastTick();
  } catch (err) {
    console.error("Tick error:", err.message);
  }
}, 1000);

io.on('connection', (socket) => {
  console.log("🔌 Client connected:", socket.id);
  socket.emit('room_tick', tickPayload());

  socket.on('request_tick', () => socket.emit('room_tick', tickPayload()));

  socket.on('sync_player_profile', async (data) => {
    if (data?.player_id) {
      const existing = await findPlayerById(data.player_id);
      if (existing) await savePlayer({ ...existing, username: data.username || existing.username });
    }
  });

  socket.on('claim_bingo', async (data) => {
    if (globalGameState !== "playing") return;
    const { player_id, cardNum } = data || {};
    if (!player_id || !cardNum) return;
    if (currentRoundWinners.some(w => w.player_id === player_id)) return;

    const part = participantsOf(currentActiveGameRoundId).get(player_id);
    if (!part || !(part.cards || []).map(Number).includes(Number(cardNum))) return;
    if (!cardHasWinningLine(Number(cardNum), drawnBallsHistory)) return;

    const player = await findPlayerById(player_id);
    if (!player || player.is_banned) return;

    currentRoundWinners.push({ player_id, username: player.username || 'Player', cardNum });
    console.log("🏆 Bingo:", player.username, "Card #", cardNum);
    setTimeout(() => resolveRoundWinners(), 500);
  });

  socket.on('disconnect', () => console.log("🔌 Client disconnected:", socket.id));
});

startNewRound();
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Fast Bingo running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Card=${CARD_PRICE}ETB, MinPlayers=${MIN_PLAYERS_TO_START}, Wait=${INITIAL_WAIT_SECONDS}s`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? 'set' : 'MISSING (initData cannot be verified!)'}`);
});
