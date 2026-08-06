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
// .trim() matters: pasting into Render's env UI very often leaves a trailing
// space or newline, which silently breaks the HMAC (token is the HMAC key).
const BOT_TOKEN = (process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ALLOW_UNVERIFIED_INITDATA = String(process.env.ALLOW_UNVERIFIED_INITDATA || 'false') === 'true';
// Your FRONTEND service URL (the page users see), not this backend.
// Must be https. Used for the in-bot web_app buttons.
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
// Bonus group: link users tap, and the numeric/@ id used to VERIFY membership.
// Auto-fix common paste mistakes so a small typo doesn't silently disable things.
let TG_GROUP_LINK = (process.env.TG_GROUP_LINK || '').trim();
if (TG_GROUP_LINK && !/^https?:\/\//i.test(TG_GROUP_LINK)) {
  // "t.me/Fast_bingo_game" -> "https://t.me/Fast_bingo_game"
  TG_GROUP_LINK = 'https://' + TG_GROUP_LINK.replace(/^\/+/, '');
  console.warn("⚠️ TG_GROUP_LINK had no scheme - corrected to", TG_GROUP_LINK);
}

let TG_GROUP_ID = (process.env.TG_GROUP_ID || '').trim();
if (/^\d+$/.test(TG_GROUP_ID)) {
  // Supergroup ids are NEGATIVE and start with -100. A bare "1003849071574"
  // is a "-100..." id with the sign (and sometimes the 100) stripped on paste.
  TG_GROUP_ID = TG_GROUP_ID.startsWith('100') ? '-' + TG_GROUP_ID : '-100' + TG_GROUP_ID;
  console.warn("⚠️ TG_GROUP_ID looked positive - corrected to", TG_GROUP_ID);
}
const TG_GROUP_ID_OK = !TG_GROUP_ID || /^(-100\d+|@[\w]+)$/.test(TG_GROUP_ID);
const BOT_USERNAME_ENV = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
const SUPPORT_CONTACT = (process.env.SUPPORT_CONTACT || '@YourSupport').trim();
// Auto-promo: posts a recurring ad into the group with a Play button.
const PROMO_CHAT_ID = (process.env.PROMO_CHAT_ID || process.env.TG_GROUP_ID || '').trim();
const PROMO_IMAGE_URL = (process.env.PROMO_IMAGE_URL || '').trim();
const PROMO_INTERVAL_MIN = Number(process.env.PROMO_INTERVAL_MIN) || 120;
const PROMO_ENABLED = String(process.env.PROMO_ENABLED || 'false') === 'true';
const PROMO_DELETE_PREVIOUS = String(process.env.PROMO_DELETE_PREVIOUS || 'true') === 'true';
const ADMIN_ID = (process.env.ADMIN_ID || '').trim();          // your telegram id
const TELEBIRR_NUMBER = (process.env.TELEBIRR_NUMBER || '').trim();
const CBE_NUMBER = (process.env.CBE_NUMBER || '').trim();
const MIN_DEPOSIT_AMOUNT = Number(process.env.MIN_DEPOSIT_AMOUNT) || 50;
// First-deposit bonus: 100% matched, capped so one big deposit can't drain the
// float. Every later deposit falls back to DEPOSIT_BONUS_PCT.
// Guard against a bad env value. Number('abc') is NaN, and NaN silently
// poisons the bonus maths (Math.floor(amount * NaN) = NaN). Also accept "100"
// meaning 100% rather than a 100x multiplier.
let _fdb = Number(process.env.FIRST_DEPOSIT_BONUS_PCT);
if (!Number.isFinite(_fdb) || _fdb < 0) _fdb = 1.0;
if (_fdb > 5) _fdb = _fdb / 100;          // someone typed 100 instead of 1.0
const FIRST_DEPOSIT_BONUS_PCT = _fdb;
const FIRST_DEPOSIT_BONUS_CAP = Number(process.env.FIRST_DEPOSIT_BONUS_CAP) || 200;
// Withdrawal gates - stop bonus money being cashed out without real play.
const MIN_DEPOSIT_BEFORE_WITHDRAW = Number(process.env.MIN_DEPOSIT_BEFORE_WITHDRAW) || 50;
const MIN_GAMES_BEFORE_WITHDRAW = Number(process.env.MIN_GAMES_BEFORE_WITHDRAW) || 5;
const WITHDRAW_KEEP_BALANCE = Number(process.env.WITHDRAW_KEEP_BALANCE) || 50;
const CARD_PRICE = Number(process.env.CARD_PRICE) || 10;
const PAYOUT_PERCENTAGE = Number(process.env.PAYOUT_PERCENTAGE) || 0.8;
// House keeps a flat fee per card; the rest goes to the winner(s).
// 10 ETB card - 2 ETB house = 8 ETB per card into the prize pool.
const HOUSE_FEE_PER_CARD = Number(process.env.HOUSE_FEE_PER_CARD) || 2;
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START) || 2;
const INITIAL_WAIT_SECONDS = Number(process.env.INITIAL_WAIT_SECONDS) || 40;
const RECHECK_WAIT_SECONDS = Number(process.env.RECHECK_WAIT_SECONDS) || 40;
const POST_ROUND_PAUSE_SECONDS = Number(process.env.POST_ROUND_PAUSE_SECONDS) || 15;
const WINNER_DISPLAY_SECONDS = Number(process.env.WINNER_DISPLAY_SECONDS) || 5;
// How many balls of grace a player gets to hit BINGO after their pattern
// completes. 1 = must claim while the completing ball is still showing.
const BINGO_GRACE_BALLS = Number(process.env.BINGO_GRACE_BALLS) || 1;
const MIN_WITHDRAWAL_AMOUNT = Number(process.env.MIN_WITHDRAWAL_AMOUNT) || 100;
const SIGNUP_BONUS = 10;
const REFERRAL_BONUS = Number(process.env.REFERRAL_BONUS) || 5;
const MAX_CARDS_PER_PLAYER = Number(process.env.MAX_CARDS_PER_PLAYER) || 2;
// House cartelas: keep early rounds alive so a lone player isn't stuck in an
// empty lobby. Disabled automatically once real players show up.
const HOUSE_ENABLED = String(process.env.HOUSE_ENABLED || 'true') === 'true';
const HOUSE_NAMES = (process.env.HOUSE_NAMES || 'Abel,Samson,Tebarek')
  .split(',').map(x => x.trim()).filter(Boolean);
const HOUSE_MIN_REAL_PLAYERS = Number(process.env.HOUSE_MIN_REAL_PLAYERS) || 4;
const TG_GROUP_BONUS = 10;

// ============ LOCAL PERSISTENCE (survives restarts) ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');
const PHONES_FILE = path.join(DATA_DIR, 'phones.json');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

const statsCache = new Map();    // player_id -> { deposited, games, deposits }
// receipt ref -> { player_id, status, at }. Must be declared before loadDisk()
// runs, or the restore silently throws on the temporal dead zone.
const usedReceipts = new Map();
const loginTokens = new Map();   // token -> { tid, created }
const tidToToken = new Map();    // tid   -> token
const inMemoryPlayers = new Map();        // player_id -> player
const inMemoryPhoneToId = new Map();      // phone -> player_id
const inMemoryTgToId = new Map();         // telegram_id -> player_id
const tgPhoneBook = new Map();            // telegram_id -> real phone shared with the bot

function loadDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    (raw || []).forEach(p => {
      // Legacy "p_<ts>_<rand>" ids can never be written to a UUID column.
      if (p.player_id && !UUID_RE.test(p.player_id)) {
        const old = p.player_id;
        p.player_id = crypto.randomUUID();
        console.log(`\u267b\ufe0f migrated legacy player id ${old} -> ${p.player_id}`);
      }
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
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([k, v]) => statsCache.set(k, v));
  } catch (e) {}
  try {
    const raw = JSON.parse(fs.readFileSync(RECEIPTS_FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([k, v]) => usedReceipts.set(k, v));
    console.log(`\ud83e\uddfe Loaded ${usedReceipts.size} used receipt refs`);
  } catch (e) {}
  try {
    const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    Object.entries(raw || {}).forEach(([tok, tid]) => {
      loginTokens.set(tok, { tid: String(tid), created: 0 });
      tidToToken.set(String(tid), tok);
    });
  } catch (e) {}
}
let flushTimer = null;
function flushDisk() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { fs.writeFileSync(PLAYERS_FILE, JSON.stringify(Array.from(inMemoryPlayers.values()))); } catch (e) {}
    try { fs.writeFileSync(PHONES_FILE, JSON.stringify(Object.fromEntries(tgPhoneBook))); } catch (e) {}
    try {
      const t = {};
      loginTokens.forEach((v, k) => { t[k] = v.tid; });
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(t));
    } catch (e) {}
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(Object.fromEntries(statsCache))); } catch (e) {}
    try { fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(Object.fromEntries(usedReceipts))); } catch (e) {}
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
let warnedNoMetadata = false;
const roundRowsCreated = new Set();
// telegram_id -> referrer player_id, captured from "/start ref_<id>" and used
// when the contact is finally shared (which is when the account is created).
const pendingReferrers = new Map();
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
  if (!initData) { console.warn("🔐 initData missing/empty"); return null; }

  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) {
    console.warn("🔐 initData has no hash. Keys:", Object.keys(data).join(','));
    return null;
  }

  if (BOT_TOKEN) {
    const checkString = Object.keys(data)
      .filter(k => k !== 'hash' && k !== 'signature')
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

    if (calc !== hash) {
      console.warn("🔐 initData HMAC MISMATCH");
      console.warn("   token length:", BOT_TOKEN.length, "id part:", BOT_TOKEN.split(':')[0]);
      console.warn("   fields:", Object.keys(data).sort().join(','));
      console.warn("   auth_date:", data.auth_date,
        data.auth_date ? `(age ${Math.round(Date.now()/1000 - Number(data.auth_date))}s)` : '');
      if (!ALLOW_UNVERIFIED_INITDATA) return null;
      console.warn("   ⚠️ accepted anyway (ALLOW_UNVERIFIED_INITDATA=true) - DEV ONLY");
    }
  } else if (!ALLOW_UNVERIFIED_INITDATA) {
    console.warn("⚠️ BOT_TOKEN not set - cannot verify initData");
    return null;
  }

  try {
    const user = JSON.parse(data.user || '{}');
    if (!user.id) { console.warn("🔐 initData has no user.id"); return null; }
    return { user, start_param: data.start_param || '' };
  } catch (e) {
    console.warn("🔐 initData user JSON parse failed:", e.message);
    return null;
  }
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
      const { data, error } = await supabase.from('players').select('*').eq('telegram_id', tid).maybeSingle();
      if (error) console.error("❌ supabase read (telegram_id):", error.message);
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
    const { data, error } = await supabase.from('players')
      .upsert([playerObj], { onConflict: 'player_id' }).select().maybeSingle();
    if (error) {
      // Was silent before - a schema mismatch here meant NOTHING persisted and
      // every app open looked like a brand new user.
      console.error("❌ SUPABASE SAVE FAILED:", error.message, "|", error.details || '', "|", error.hint || '');
      console.error("   player keys:", Object.keys(playerObj).join(','));
      return playerObj;
    }
    if (data) cachePlayer(data);
    return data || playerObj;
  } catch (err) {
    console.error("❌ SUPABASE SAVE THREW:", err.message);
  }
  return playerObj;
}

async function logTransaction({ player_id, type, amount, game_id, balance_after, notes }) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('transactions')
      .insert([{ player_id, type, amount, game_id, balance_after, notes }]);
    if (error) console.error("\u274c transactions insert failed:", error.message);
  } catch (err) { console.error("\u274c transactions insert threw:", err.message); }
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

// Pull the transaction/receipt number out of a pasted confirmation SMS.
// Telebirr refs look like "CJ12AB34CD", CBE like "FT25123456789" - generally a
// run of 8+ alphanumerics containing at least one digit. Falls back to a hash
// of the whole message so an identical paste is still caught.
function extractReceiptRef(sms) {
  const text = String(sms || '').toUpperCase();
  const candidates = text.match(/\b[A-Z0-9]{8,}\b/g) || [];
  const withDigit = candidates.filter(c => /\d/.test(c));
  // Longest match is usually the transaction id rather than a phone number.
  withDigit.sort((a, b) => b.length - a.length);
  if (withDigit.length) return withDigit[0];
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  return 'H' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16).toUpperCase();
}

// Lifetime totals used by the withdrawal gates.
// In-memory mirror of the lifetime stats, so the withdrawal gates still work
// if Supabase is unavailable. Without this a DB blip would lock every player
// out of withdrawing (getPlayerStats would return zeros = "never deposited").
function bumpStats(player_id, patch) {
  const cur = statsCache.get(player_id) || { deposited: 0, games: 0, deposits: 0 };
  cur.deposited += patch.deposited || 0;
  cur.games += patch.games || 0;
  cur.deposits += patch.deposits || 0;
  statsCache.set(player_id, cur);
  flushDisk();
}

async function getPlayerStats(player_id) {
  const cached = statsCache.get(player_id) || { deposited: 0, games: 0, deposits: 0 };
  if (!supabase) return { ...cached };
  try {
    const { data, error } = await supabase.from('transactions')
      .select('type, amount').eq('player_id', player_id).limit(5000);
    if (error) { console.error('stats read:', error.message); return { ...cached }; }
    const out = { deposited: 0, games: 0, deposits: 0 };
    (data || []).forEach(t => {
      if (t.type === 'deposit') { out.deposited += Number(t.amount) || 0; out.deposits++; }
      else if (t.type === 'entry_fee') out.games++;
    });
    // Trust whichever source has seen more - never less than the cache.
    return {
      deposited: Math.max(out.deposited, cached.deposited),
      games: Math.max(out.games, cached.games),
      deposits: Math.max(out.deposits, cached.deposits)
    };
  } catch (e) {
    console.error('stats threw:', e.message);
    return { ...cached };
  }
}

// Shared rule for both the bot wizard and the web API.
// Returns { ok } or { ok:false, reason, need }.
async function checkWithdrawEligibility(player_id, amount, mainBalanceAfter) {
  const st = await getPlayerStats(player_id);

  if (st.deposited < MIN_DEPOSIT_BEFORE_WITHDRAW) {
    return { ok: false, reason: 'need_deposit',
             need: MIN_DEPOSIT_BEFORE_WITHDRAW - st.deposited, stats: st };
  }
  // Either enough games played, OR enough left behind in the wallet.
  const playedEnough = st.games >= MIN_GAMES_BEFORE_WITHDRAW;
  const keepsEnough = mainBalanceAfter >= WITHDRAW_KEEP_BALANCE;
  if (!playedEnough && !keepsEnough) {
    return { ok: false, reason: 'need_games',
             need: MIN_GAMES_BEFORE_WITHDRAW - st.games, stats: st };
  }
  return { ok: true, stats: st };
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

app.post('/api/auth/token', async (req, res) => {
  const { token } = req.body || {};
  const tid = verifyLoginToken(token);
  if (!tid) {
    console.warn("\u26d4 token login rejected (bad/stale signature)");
    return res.status(401).json({ error: 'invalid_token' });
  }
  const player = await findPlayerByTelegramId(tid);
  if (!player) {
    console.warn("\u26d4 token login: no player for telegram_id", tid);
    return res.status(404).json({ error: 'player_not_found', telegram_id: tid });
  }
  console.log("\ud83d\udd11 token login:", tid, player.player_id);
  res.json({ isNew: false, user: sanitizePlayer(player) });
});

// Shows whether Telegram is actually delivering updates to THIS server.
app.get('/api/debug/webhook', async (req, res) => {
  const out = { updates_received: webhookHits, last_update_at: lastWebhookAt || null };
  if (BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
      out.telegram = (await r.json()).result || null;
    } catch (e) { out.telegram_error = e.message; }
  }
  res.json(out);
});

// Bump this whenever server.js changes, so /api/health proves which build is live.
const BUILD_ID = 'receipt-dedupe-2026-08-06';

// Public config so the webapp can build a correct referral link.
app.get('/api/config', (req, res) => {
  res.json({
    bot_username: BOT_USERNAME_ENV || null,
    referral_bonus: REFERRAL_BONUS,
    card_price: CARD_PRICE,
    house_fee: HOUSE_FEE_PER_CARD,
    min_withdrawal: MIN_WITHDRAWAL_AMOUNT,
    min_deposit_before_withdraw: MIN_DEPOSIT_BEFORE_WITHDRAW,
    min_games_before_withdraw: MIN_GAMES_BEFORE_WITHDRAW,
    withdraw_keep_balance: WITHDRAW_KEEP_BALANCE,
    first_deposit_bonus_pct: FIRST_DEPOSIT_BONUS_PCT,
    first_deposit_bonus_cap: FIRST_DEPOSIT_BONUS_CAP
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    build: BUILD_ID,
    timestamp: new Date().toISOString(),
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining,
    participants: participantsOf(currentActiveGameRoundId).size,
    players: inMemoryPlayers.size,
    supabase: !!supabase,
    // Diagnostics - never exposes the token itself, only whether it arrived.
    bot_token_present: !!BOT_TOKEN,
    bot_token_length: BOT_TOKEN ? BOT_TOKEN.length : 0,
    bot_token_looks_valid: /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN || ''),
    env_keys_seen: Object.keys(process.env).filter(k =>
      /BOT|TELEGRAM|SUPABASE|ADMIN/i.test(k)).sort()
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

    player = await createPlayer({ username, phone_number: knownPhone, telegram_id, referrer_id: referrer_id || pendingReferrers.get(telegram_id) || cleanRef(verified.start_param) });
    await payReferrer(player);
    pendingReferrers.delete(telegram_id);
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
  let phone = tgPhoneBook.get(tid) || null;
  if (!phone) {
    // Cache is empty after a redeploy - the database still knows.
    const existing = await findPlayerByTelegramId(tid);
    if (existing && existing.phone_number) {
      phone = existing.phone_number;
      tgPhoneBook.set(tid, phone);
      flushDisk();
    }
  }
  if (!phone) return res.json({ has_phone: false });

  let player = await findPlayerByTelegramId(tid);
  if (!player) {
    const username = verified.user.username
      || [verified.user.first_name, verified.user.last_name].filter(Boolean).join(' ')
      || `tg_${tid}`;
    player = await createPlayer({
      username, phone_number: phone, telegram_id: tid,
      referrer_id: (req.body || {}).referrer_id || pendingReferrers.get(tid) || cleanRef(verified.start_param)
    });
    await payReferrer(player);
    pendingReferrers.delete(tid);
    return res.json({ has_phone: true, isNew: true, user: sanitizePlayer(player) });
  }
  if (!player.phone_number) player = await savePlayer({ ...player, phone_number: phone });
  res.json({ has_phone: true, isNew: false, user: sanitizePlayer(player) });
});

// Credit the inviter when their invitee completes registration.
function cleanRef(v) {
  if (!v) return null;
  const t = String(v).trim();
  return t.startsWith('ref_') ? t.slice(4) : t;
}

async function payReferrer(newPlayer) {
  try {
    const refId = newPlayer && newPlayer.referred_by;
    if (!refId) return;
    if (String(refId) === String(newPlayer.player_id)) return;   // no self-referral
    const referrer = await findPlayerById(refId);
    if (!referrer) { console.warn("\u26a0\ufe0f referrer not found:", refId); return; }

    const balances = await creditPlayerBalances(referrer.player_id, {
      playAdd: REFERRAL_BONUS,
      type: 'referral_bonus',
      notes: `Referred ${newPlayer.username || 'a friend'}`
    });
    await savePlayer({
      ...referrer,
      ...(balances || {}),
      referrals_count: Number(referrer.referrals_count || 0) + 1,
      referral_earnings: Number(referrer.referral_earnings || 0) + REFERRAL_BONUS
    });
    console.log(`\ud83e\udd1d referral paid: ${referrer.username} +${REFERRAL_BONUS} ETB`);

    if (referrer.telegram_id) {
      await tgSend(referrer.telegram_id, T.refEarned
        .replace('{name}', newPlayer.username || 'A friend')
        .replace('{bonus}', String(REFERRAL_BONUS)));
    }
  } catch (e) { console.error("\u274c payReferrer failed:", e.message); }
}

async function createPlayer({ username, phone_number, telegram_id, referrer_id }) {
  const existingByPhone = await findPlayerByPhone(phone_number);
  if (existingByPhone) {
    return await savePlayer({ ...existingByPhone, telegram_id: telegram_id || existingByPhone.telegram_id, username });
  }
  // players.player_id is a UUID column in Supabase - a "p_<ts>_<rand>" string
  // is rejected with: invalid input syntax for type uuid.
  const playerId = crypto.randomUUID();
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
const seenUpdateIds = new Set();

// ---- LOGIN TOKENS -------------------------------------------------------
// Some Telegram clients open Mini Apps without populating initData. A token
// minted server-side and delivered ONLY into that user's private chat is a
// safe fallback: unguessable, and bound to a single telegram_id.
function mintLoginToken(tid) {
  // DERIVED, not stored. Render wipes the filesystem on every deploy, so any
  // token kept on disk died with the next release and every Play button in
  // every chat started returning 401. An HMAC of the telegram id keyed by the
  // bot token is stable across restarts, unguessable without the bot token,
  // and needs no storage at all.
  tid = String(tid);
  const sig = crypto.createHmac('sha256', BOT_TOKEN || 'fastbingo-fallback-secret')
    .update('tgauth:' + tid).digest('hex').slice(0, 32);
  return tid + '.' + sig;
}

function verifyLoginToken(token) {
  if (!token) return null;
  const str = String(token);
  const dot = str.lastIndexOf('.');
  if (dot > 0) {
    const tid = str.slice(0, dot);
    if (/^\d+$/.test(tid) && mintLoginToken(tid) === str) return tid;
  }
  // Legacy random tokens minted before this change (in memory only).
  const rec = loginTokens.get(str);
  return rec ? rec.tid : null;
}

function playUrl(tid) {
  const base = WEBAPP_URL.replace(/\/+$/, '');
  return base + '/?tgauth=' + mintLoginToken(tid);
}
let webhookHits = 0;
let lastWebhookAt = null;

// ============ AMHARIC BOT COPY ============
const T = {
  welcome:
    "🎉 እንኳን ወደ ፋስት ቢንጎ በደህና መጡ!\n\n" +
    "መለያዎን ለማረጋገጥ የስልክ ቁጥርዎን ያካፍሉ።\n" +
    "ወዲያውኑ 10 ብር የምዝገባ ቦነስ ያገኛሉ!",
  askPhone: "📱 የስልክ ቁጥሬን አጋራለሁ",
  intro:
    "🎉 እንኳን ወደ ፋስት ቢንጎ በደህና መጡ!\n" +
    "(Welcome to Fast Bingo!)\n\n" +
    "🎮 ይጫወቱ እና ትልቅ ገንዘብ ያሸንፉ!\n\n" +
    "🎁 <b>ሲመዘገቡ 20 ብር ቦነስ</b>\n" +
    "   • 10 ብር የምዝገባ ቦነስ\n" +
    "   • 10 ብር የግሩፕ ቦነስ\n\n" +
    "🤝 <b>ጓደኛ ሲጋብዙ 5 ብር</b> ለእያንዳንዱ ጓደኛ!\n\n" +
    "ለመጀመር የስልክ ቁጥርዎን ያጋሩ 👇",
  phoneOk: "✅ ስልክ ቁጥርዎ ተረጋግጧል!\n🎁 10 ብር የምዝገባ ቦነስ ተከፍሎታል።",
  groupOffer:
    "🎁 ተጨማሪ 10 ብር ቦነስ ይፈልጋሉ?\n\n" +
    "የቦነስ ህግ:\n" +
    "1️⃣ የቴሌግራም ግሩፓችንን ይቀላቀሉ\n" +
    "2️⃣ ከዚያ «ቦነስ አረጋግጥ» የሚለውን ይጫኑ\n" +
    "3️⃣ 10 ብር ወዲያውኑ ይገባል\n\n" +
    "⚠️ ክፍያ ለመቀበል በግሩፑ ውስጥ መቆየት አለብዎት።\n" +
    "አጠቃላይ ቦነስ: <b>{total} ብር</b>",
  btnJoinGroup: "✈️ ግሩፑን ተቀላቀል",
  btnVerifyGroup: "✅ ቦነስ አረጋግጥ",
  btnSkip: "⏭ አሁን አልፈልግም",
  groupNotJoined:
    "❌ ገና አልተቀላቀሉም። እባክዎ መጀመሪያ ግሩፑን ይቀላቀሉ፣ ከዚያ እንደገና «ቦነስ አረጋግጥ» ይጫኑ።",
  groupOk: "🎉 ተረጋግጧል! +10 ብር ቦነስ ተከፍሎታል።\n💰 ጠቅላላ ሂሳብ: <b>{total} ብር</b>",
  alreadyClaimed: "ℹ️ የግሩፕ ቦነስዎን ቀድሞ ወስደዋል።",
  menuTitle:
    "🎉 እንኳን ወደ ፋስት ቢንጎ በደህና መጡ!\n" +
    "(Welcome to Fast Bingo!) 🎉\n\n" +
    "እባክዎ ከታች ካሉት አማራጮች ውስጥ ይምረጡ:",
  openApp: "🎮 መተግበሪያውን ለመክፈት ከታች ይጫኑ።",
  depAsk: "💳 ገንዘብ ማስገባት\n\nምን ያህል ማስገባት ይፈልጋሉ? (ዝቅተኛ {min} ብር)\n\nመጠኑን በቁጥር ይጻፉ:",
  depMin: "❌ ዝቅተኛው {min} ብር ነው። እንደገና ይሞክሩ:",
  depBadNum: "❌ ትክክለኛ ቁጥር ያስገቡ:",
  depMethod: "የ<b>{amt} ብር</b> ክፍያ መንገድ ይምረጡ:",
  depInstr:
    "💰 <b>{method}</b>\n\n💳 መጠን: <b>{amt} ብር</b>\n🏦 ሂሳብ ቁጥር: <code>{acct}</code>\n\n" +
    "<b>ደረጃዎች:</b>\n1. ከላይ ወዳለው ሂሳብ {amt} ብር ይላኩ\n2. የማረጋገጫ ኤስኤምኤስ ይደርስዎታል\n" +
    "3. ያንን ኤስኤምኤስ ኮፒ አድርገው እዚህ ይለጥፉ\n\nኤስኤምኤሱን አሁን ይለጥፉ:",
  depDuplicate:
    "🚫 <b>ይህ ደረሰኝ ቀድሞ ገብቷል!</b>\n\n" +
    "የግብይት ቁጥር: <code>{ref}</code>\n\n" +
    "አንድ ደረሰኝ አንድ ጊዜ ብቻ ነው የሚያገለግለው።\n" +
    "እባክዎ አዲስ ክፍያ ፈጽመው አዲሱን ኤስኤምኤስ ይለጥፉ።\n\n" +
    "⚠️ ተደጋጋሚ ሙከራ መለያዎ እንዲታገድ ያደርጋል።",
  depDone: "✅ <b>ጥያቄዎ ደርሶናል!</b>\n\nመጠን: <b>{amt} ብር</b>\nሁኔታ: ⏳ በመጠባበቅ ላይ\n\nከተረጋገጠ በኋላ ወደ ሂሳብዎ ይገባል።",
  depApproved: "✅ <b>ተቀባይነት አግኝቷል!</b>\n\nመጠን: <b>{amt} ብር</b>\nአዲስ ቀሪ ሂሳብ: <b>{bal} ብር</b>\n\nመልካም ጨዋታ! 🎮",
  depRejected: "❌ <b>ተቀባይነት አላገኘም</b>\n\nመጠን: <b>{amt} ብር</b>\n\nለበለጠ መረጃ ድጋፍን ያግኙ።",
  wdAsk: "📤 ገንዘብ ማውጣት\n\n💰 የሚወጣ ቀሪ ሂሳብ: <b>{bal} ብር</b>\nዝቅተኛ: {min} ብር\n\nመጠኑን ይጻፉ:",
  wdMin: "❌ ዝቅተኛው {min} ብር ነው:",
  wdNoFunds: "❌ በቂ ሂሳብ የለዎትም። የሚወጣ: {bal} ብር\n\n(የቦነስ ገንዘብ ማውጣት አይቻልም)",
  wdPhone: "የቴሌብር ስልክ ቁጥርዎን ያስገቡ:",
  wdNeedDeposit:
    "🔒 <b>ገንዘብ ማውጣት አይቻልም</b>\n\n" +
    "የቦነስ ገንዘብ ለማውጣት መጀመሪያ ቢያንስ <b>{min} ብር</b> ማስገባት አለብዎት።\n\n" +
    "እስካሁን ያስገቡት: <b>{done} ብር</b>\n" +
    "የቀረው: <b>{need} ብር</b>\n\n" +
    "🏦 «Add Funds» ተጭነው ገንዘብ ያስገቡ።",
  wdNeedGames:
    "🔒 <b>ገንዘብ ማውጣት አይቻልም</b>\n\n" +
    "ለማውጣት ከሚከተሉት አንዱን ማሟላት አለብዎት፦\n\n" +
    "1️⃣ ቢያንስ <b>{minGames} ጨዋታ</b> መጫወት\n" +
    "   የተጫወቱት: <b>{games}</b> (የቀረው {need})\n\n" +
    "2️⃣ ወይም ከወጪ በኋላ ቢያንስ <b>{keep} ብር</b> በሂሳብዎ ማስቀረት\n\n" +
    "🎮 ጥቂት ጨዋታ ተጫውተው እንደገና ይሞክሩ።",
  wdDone: "✅ <b>ጥያቄዎ ገብቷል!</b>\n\nመጠን: <b>{amt} ብር</b>\nስልክ: {phone}\n\nበ1-2 ሰዓት ውስጥ ይላካል።",
  txnsEmpty: "ገና ምንም ግብይት የለም።",
  notifyDepositPending:
    "🧾 <b>የገቢ ጥያቄ ደርሶናል</b>\n\n💰 መጠን: <b>{amt} ብር</b>\n🏦 መንገድ: {method}\n⏳ ሁኔታ: በመጠባበቅ ላይ\n\nከተረጋገጠ በኋላ ወዲያውኑ እናሳውቅዎታለን።",
  notifyWithdrawPending:
    "🧾 <b>የወጪ ጥያቄ ደርሶናል</b>\n\n💰 መጠን: <b>{amt} ብር</b>\n📱 ወደ: {acct}\n⏳ ሁኔታ: በመጠባበቅ ላይ\n💵 ቀሪ ሂሳብ: <b>{bal} ብር</b>\n\nበ1-2 ሰዓት ውስጥ ይላካል።",
  notifyCoupon:
    "🎟 <b>ኩፖን ተቀብለዋል!</b>\n\n🎁 ቦነስ: <b>+{amt} ብር</b>\n💵 ጠቅላላ ሂሳብ: <b>{bal} ብር</b>",
  txnsTitle: "📋 <b>የመጨረሻዎቹ ግብይቶች</b>\n\n",
  cancelled: "ተሰርዟል።",
  btnCancel: "❌ ተመለስ",
  deposit: "🏦 ገንዘብ ለማስገባት\n\nበቴሌብር ወይም በባንክ ከከፈሉ በኋላ የክፍያ ደረሰኝ ቁጥሩን በመተግበሪያው ውስጥ ያስገቡ።",
  withdraw: "💵 ገንዘብ ለማውጣት\n\nዝቅተኛ የማውጫ መጠን 100 ብር ነው። ከዋና ሂሳብዎ ብቻ ማውጣት ይችላሉ።",
  balance: "💰 የእርስዎ ሂሳብ\n\n🏦 ዋና: <b>{main} ብር</b>\n🎁 ቦነስ: <b>{play} ብር</b>\n────────\n💵 ድምር: <b>{total} ብር</b>",
  notRegistered: "⚠️ እባክዎ መጀመሪያ /start ይጫኑ።",
  howTo:
    "📜 እንዴት እንደሚጫወቱ\n\n" +
    "1️⃣ ካርቴላ (ቁጥር) ይምረጡ\n" +
    "2️⃣ የመግቢያ ክፍያ 10 ብር ነው\n" +
    "3️⃣ ኳሶች ሲወጡ ቁጥሮችዎን ምልክት ያድርጉ\n" +
    "4️⃣ መስመር ወይም ማዕዘን ሲሞሉ\n" +
    "5️⃣ ቢንጎ! የሚለውን ይጫኑ እና ያሸንፉ\n\n" +
    "🏆 አሸናፊው ጠቅላላውን ደራሽ ይወስዳል።",
  support: "🎧 እገዛ ይፈልጋሉ?\nበአድሚን ያግኙን: {support}",
  referral:
    "🤝 <b>ጓደኞችዎን ይጋብዙ እና ያትርፉ!</b>\n\n" +
    "ለእያንዳንዱ የሚጋብዙት ጓደኛ <b>{bonus} ብር</b> ያገኛሉ።\n" +
    "ጓደኛዎ ሲመዘገብ ወዲያውኑ ወደ ሂሳብዎ ይገባል።\n\n" +
    "👥 እስካሁን የጋበዙት: <b>{count}</b>\n" +
    "💰 ያገኙት: <b>{earned} ብር</b>\n\n" +
    "የእርስዎ ሊንክ (ኮፒ አድርገው ያጋሩ):\n{link}",
  refEarned: "🎉 <b>የሪፈራል ቦነስ!</b>\n\n{name} በእርስዎ ሊንክ ተመዝግቧል።\n💰 <b>+{bonus} ብር</b> ወደ ሂሳብዎ ገብቷል!",
};

function mainMenuKeyboard(forTid) {
  // Reply keyboard under the message box. "Play Game" is a web_app button so it
  // passes signed initData; a plain url button would NOT.
  return {
    keyboard: [
      [{ text: "🎮 Play Game (ክፈት)", web_app: { url: playUrl(forTid) } }],
      [{ text: "🏦 Add Funds (ገንዘብ አስገባ)" }, { text: "💵 Cash Out (ወጪ)" }],
      [{ text: "📊 My Balance (ቀሪ ሂሳብ)" }, { text: "🤝 Refer & Earn (ጋብዝ)" }],
      [{ text: "📋 Transactions (ግብይቶች)" }, { text: "📜 How to Play (መመሪያ)" }],
      [{ text: "🎧 Support (እገዛ)" }]
    ],
    resize_keyboard: true
  };
}

function groupOfferKeyboard() {
  const rows = [];
  if (/^https?:\/\//.test(TG_GROUP_LINK)) {
    rows.push([{ text: T.btnJoinGroup, url: TG_GROUP_LINK }]);
  }
  rows.push([{ text: T.btnVerifyGroup, callback_data: "verify_group" }]);
  rows.push([{ text: T.btnSkip, callback_data: "skip_group" }]);
  return { inline_keyboard: rows };
}

// Is the user actually a member of the bonus group?
async function isGroupMember(tid) {
  if (!TG_GROUP_ID) return null; // unknown - not configured
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(TG_GROUP_ID)}&user_id=${tid}`
    );
    const d = await r.json();
    if (!d.ok) {
      // Loud, because the fallback is to PAY the bonus unverified.
      console.error("❌ getChatMember FAILED:", d.error_code, d.description);
      console.error("   chat_id used:", TG_GROUP_ID, "| user:", tid);
      if (/chat not found/i.test(d.description || '')) {
        console.error("   -> wrong TG_GROUP_ID, or the bot was never added to the group.");
      }
      if (/not enough rights|member list is inaccessible/i.test(d.description || '')) {
        console.error("   -> the bot must be an ADMINISTRATOR in the group.");
      }
      return null;
    }
    const status = d.result.status;
    console.log("👥 getChatMember", tid, "->", status);
    return ['creator', 'administrator', 'member', 'restricted'].includes(status);
  } catch (e) {
    console.warn("getChatMember error:", e.message);
    return null;
  }
}

async function sendGroupOffer(chat_id, player) {
  const sp = sanitizePlayer(player);
  await tgSend(
    chat_id,
    T.groupOffer.replace('{total}', String(sp.balance + TG_GROUP_BONUS)),
    groupOfferKeyboard()
  );
}

async function finishOnboarding(chat_id, tid) {
  await tgSend(chat_id, T.menuTitle, mainMenuKeyboard(tid));
}

app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  webhookHits++;
  lastWebhookAt = new Date().toISOString();
  try {
    console.log("📨 update:", JSON.stringify(req.body).slice(0, 300));
    // Telegram retries an update until it gets a 200. On a cold Render instance
    // the first replies are slow, so the same contact arrived 9 times.
    const uid = req.body?.update_id;
    if (uid != null) {
      if (seenUpdateIds.has(uid)) return;
      seenUpdateIds.add(uid);
      if (seenUpdateIds.size > 1000) {
        Array.from(seenUpdateIds).slice(0, 500).forEach(x => seenUpdateIds.delete(x));
      }
    }

    if (req.body?.callback_query) return handleCallback(req.body.callback_query);

    const msg = req.body?.message;
    if (!msg) return;
    const from = msg.from || {};
    const tid = String(from.id);
    const chatId = msg.chat.id;
    const username = from.username || [from.first_name, from.last_name].filter(Boolean).join(' ') || `tg_${tid}`;

    // ---- STEP 1: contact shared ----
    if (msg.contact && String(msg.contact.user_id) === tid) {
      let phone = String(msg.contact.phone_number || '').replace(/\s/g, '');
      if (phone && !phone.startsWith('+')) phone = '+' + phone;
      tgPhoneBook.set(tid, phone);
      flushDisk();
      console.log("\ud83d\udcde Contact stored for", tid, phone);

      let player = await findPlayerByTelegramId(tid);
      const wasNew = !player;
      if (!player) {
        player = await createPlayer({
          username, phone_number: phone, telegram_id: tid,
          referrer_id: pendingReferrers.get(tid) || null
        });
      } else if (!player.phone_number) {
        player = await savePlayer({ ...player, phone_number: phone });
      }
      if (wasNew) await payReferrer(player);
      pendingReferrers.delete(tid);

      await tgSend(chatId, T.phoneOk, { remove_keyboard: true });

      // ---- STEP 2: group bonus offer ----
      if (player.tg_bonus_claimed) await finishOnboarding(chatId, tid);
      else await sendGroupOffer(chatId, player);
      return;
    }

    const text = (msg.text || '').trim();

    // Setup helper: post /id in ANY chat (including your group) and the bot
    // replies with that chat's numeric id. Safe to leave in - it only echoes
    // the id of the chat it's already in.
    if (text.startsWith('/id')) {
      await tgSend(chatId,
        `Chat ID: <code>${chatId}</code>\nType: ${msg.chat.type}\nTitle: ${msg.chat.title || '-'}`);
      console.log("🆔 /id ->", chatId, msg.chat.type, msg.chat.title || '');
      return;
    }

    // /play - give a returning player a fresh Play button, no re-registration.
    if (text === '/play' || text === '/menu') {
      const p = await findPlayerByTelegramId(tid);
      if (!p || !p.phone_number) {
        await tgSend(chatId, T.intro, {
          keyboard: [[{ text: T.askPhone, request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        });
        return;
      }
      await finishOnboarding(chatId, tid);
      return;
    }

    if (text.startsWith('/start')) {
      // "/start ref_<player_id>" - capture who invited this user.
      const payload = text.split(/\s+/)[1] || '';
      if (payload.startsWith('ref_')) {
        const refId = payload.slice(4);
        if (refId) {
          pendingReferrers.set(tid, refId);
          console.log("\ud83e\udd1d referral captured:", tid, "invited by", refId);
        }
      }

      const player = await findPlayerByTelegramId(tid);
      // Only ask for a contact when there is genuinely no account, or the
      // account has no phone. tgPhoneBook lives in memory + a disk file that
      // Render wipes on every deploy, so it must never gate a returning player.
      if (!player || !player.phone_number) {
        await tgSend(chatId, T.intro, {
          keyboard: [[{ text: T.askPhone, request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true
        });
        return;
      }
      // Re-seed the cache from the database after a restart.
      if (!tgPhoneBook.has(tid)) { tgPhoneBook.set(tid, player.phone_number); flushDisk(); }
      if (!player.tg_bonus_claimed) { await sendGroupOffer(chatId, player); return; }
      await finishOnboarding(chatId, tid);
      return;
    }

    // ---- ADMIN COMMANDS ----
    // /promo answers even for non-admins so the failure is never silent.
    if (text === '/promo' || text === '/promotest') {
      if (!ADMIN_ID) {
        await tgSend(chatId, "\u26a0\ufe0f ADMIN_ID is not set on the server.\nYour Telegram ID: <code>" + tid + "</code>");
        return;
      }
      if (String(tid) !== String(ADMIN_ID)) {
        await tgSend(chatId,
          "\u26d4 Not authorised.\nYour ID: <code>" + tid + "</code>\nADMIN_ID on server: <code>" + ADMIN_ID + "</code>\n\nThese must match exactly.");
        return;
      }
      if (!PROMO_CHAT_ID) { await tgSend(chatId, "\u26a0\ufe0f PROMO_CHAT_ID not set."); return; }
      if (!BOT_USERNAME_ENV) { await tgSend(chatId, "\u26a0\ufe0f BOT_USERNAME not set - promo button cannot be built."); return; }
      const r = await postPromo();
      await tgSend(chatId, r && r.ok
        ? `\ud83d\udce2 Posted to ${PROMO_CHAT_ID}`
        : `\u274c Post failed: ${(r && r.error) || 'unknown'}\n\nIs the bot an ADMIN in ${PROMO_CHAT_ID}?`);
      return;
    }

    if (ADMIN_ID && String(tid) === String(ADMIN_ID)) {
      const m = text.match(/^\/(approve|reject)_(\d+)$/);
      if (m) { await handleAdminDeposit(chatId, m[1], Number(m[2])); return; }
      if (text === '/pending') { await listPending(chatId); return; }
    }

    // ---- ACTIVE WIZARD? ----
    const convPlayer = await findPlayerByTelegramId(tid);
    if (convPlayer && await handleConversation(chatId, tid, text, convPlayer)) return;

    // ---- MENU BUTTONS ----
    await handleMenuText(chatId, tid, text);
  } catch (e) { console.error("webhook error", e.message); }
});


// ---- BOT CONVERSATION STATE (deposit / withdraw wizards) ----
const convState = new Map();   // tid -> { step, data }
function setConv(tid, step, data) { convState.set(String(tid), { step, data: data || {} }); }
function getConv(tid) { return convState.get(String(tid)) || null; }
function clearConv(tid) { convState.delete(String(tid)); }

const pendingDeposits = new Map();  // id -> record
const pendingWithdrawals = new Map();  // id -> record (mirror, so the admin
// page still lists bot-side requests when Supabase rejects the insert)
let withdrawalSeq = (Date.now() % 100000) + 500000;
let depositSeq = Date.now() % 100000;

function cancelKb() { return { keyboard: [[{ text: T.btnCancel }]], resize_keyboard: true }; }

async function notifyAdmin(text) {
  if (!ADMIN_ID) { console.warn("⚠️ ADMIN_ID not set - cannot notify admin"); return; }
  await tgSend(ADMIN_ID, text);
}

// Returns true if the message was consumed by an active wizard.
async function handleConversation(chatId, tid, text, player) {
  const st = getConv(tid);
  if (!st) return false;

  if (text === T.btnCancel || text === '/cancel') {
    clearConv(tid);
    await tgSend(chatId, T.cancelled, mainMenuKeyboard(tid));
    return true;
  }

  const sp = sanitizePlayer(player);

  // ----- DEPOSIT -----
  if (st.step === 'dep_amount') {
    const amt = Number(String(text).replace(/[^\d.]/g, ''));
    if (!amt || isNaN(amt)) { await tgSend(chatId, T.depBadNum); return true; }
    if (amt < MIN_DEPOSIT_AMOUNT) {
      await tgSend(chatId, T.depMin.replace('{min}', String(MIN_DEPOSIT_AMOUNT)));
      return true;
    }
    setConv(tid, 'dep_method', { amount: amt });
    const rows = [];
    if (TELEBIRR_NUMBER) rows.push([{ text: "📱 TeleBirr", callback_data: "dep_telebirr" }]);
    if (CBE_NUMBER) rows.push([{ text: "🏦 CBE Birr", callback_data: "dep_cbe" }]);
    rows.push([{ text: T.btnCancel, callback_data: "dep_cancel" }]);
    await tgSend(chatId, T.depMethod.replace('{amt}', String(amt)), { inline_keyboard: rows });
    return true;
  }

  if (st.step === 'dep_sms') {
    const { amount, method } = st.data;

    // REJECT A REUSED RECEIPT. Without this the same Telebirr SMS could be
    // pasted repeatedly and credited every time.
    const receiptRef = extractReceiptRef(text);
    if (receiptRef && usedReceipts.has(receiptRef)) {
      const prev = usedReceipts.get(receiptRef);
      clearConv(tid);
      console.warn(`\ud83d\udea8 duplicate receipt ${receiptRef} from ${player.player_id} (first used by ${prev.player_id})`);
      await tgSend(chatId, T.depDuplicate.replace('{ref}', receiptRef), mainMenuKeyboard(tid));
      await notifyAdmin(
        `\ud83d\udea8 <b>DUPLICATE RECEIPT BLOCKED</b>\n\n` +
        `User: ${player.username} (<code>${tid}</code>)\n` +
        `Ref: <code>${receiptRef}</code>\n` +
        `Originally used by: <code>${prev.player_id}</code>\n` +
        `Claimed amount: ${amount} ETB`);
      return true;
    }

    const id = ++depositSeq;
    const rec = {
      id, player_id: player.player_id, telegram_id: String(tid), chat_id: chatId,
      amount, method, sms: String(text).slice(0, 800),
      receipt_ref: receiptRef,
      status: 'pending', created_at: new Date().toISOString()
    };
    pendingDeposits.set(id, rec);
    if (receiptRef) {
      usedReceipts.set(receiptRef, {
        player_id: player.player_id, status: 'pending', at: rec.created_at
      });
      flushDisk();
    }
    if (supabase) {
      try {
        const { error } = await supabase.from('deposit_requests').insert([{
          player_id: rec.player_id, method, amount,
          reference_id: receiptRef || String(id),
          status: 'pending', requested_at: rec.created_at
        }]);
        // Was a silent catch: the bot kept its own copy so it looked fine,
        // while the admin page (which reads Supabase) saw nothing.
        if (error) console.error("\u274c deposit_requests insert failed:", error.message,
          "|", error.details || '', "|", error.hint || '');
        else rec.synced = true;
      } catch (e) { console.error("\u274c deposit_requests insert threw:", e.message); }
    }
    clearConv(tid);
    await tgSend(chatId, T.depDone.replace('{amt}', String(amount)), mainMenuKeyboard(tid));
    await notifyAdmin(
      `🔔 <b>New Deposit</b>\n\nUser: ${player.username}\nTG: <code>${tid}</code>\n` +
      `Amount: <b>${amount} ETB</b>\nMethod: ${method}\n` +
      `Receipt: <code>${receiptRef || 'not detected'}</code>\nRef: <code>${id}</code>\n\n` +
      `SMS:\n<code>${String(text).slice(0, 400)}</code>\n\n` +
      `✅ /approve_${id}\n❌ /reject_${id}`);
    return true;
  }

  // ----- WITHDRAW -----
  if (st.step === 'wd_amount') {
    const amt = Number(String(text).replace(/[^\d.]/g, ''));
    if (!amt || isNaN(amt)) { await tgSend(chatId, T.depBadNum); return true; }
    if (amt < MIN_WITHDRAWAL_AMOUNT) {
      await tgSend(chatId, T.wdMin.replace('{min}', String(MIN_WITHDRAWAL_AMOUNT)));
      return true;
    }
    if (amt > sp.main_balance) {
      await tgSend(chatId, T.wdNoFunds.replace('{bal}', String(sp.main_balance)));
      return true;
    }
    setConv(tid, 'wd_phone', { amount: amt });
    await tgSend(chatId, T.wdPhone, cancelKb());
    return true;
  }

  if (st.step === 'wd_phone') {
    const { amount } = st.data;
    const phone = String(text).trim();
    const fresh = await findPlayerById(player.player_id);
    const fsp = sanitizePlayer(fresh);
    if (amount > fsp.main_balance) {
      clearConv(tid);
      await tgSend(chatId, T.wdNoFunds.replace('{bal}', String(fsp.main_balance)), mainMenuKeyboard(tid));
      return true;
    }

    // Bonus money can't leave until the player has deposited and played.
    const gate = await checkWithdrawEligibility(
      player.player_id, amount, fsp.main_balance - amount);
    if (!gate.ok) {
      clearConv(tid);
      const msg = gate.reason === 'need_deposit'
        ? T.wdNeedDeposit
            .replace('{min}', String(MIN_DEPOSIT_BEFORE_WITHDRAW))
            .replace('{done}', String(gate.stats.deposited))
            .replace('{need}', String(gate.need))
        : T.wdNeedGames
            .replace('{minGames}', String(MIN_GAMES_BEFORE_WITHDRAW))
            .replace('{games}', String(gate.stats.games))
            .replace('{need}', String(gate.need))
            .replace('{keep}', String(WITHDRAW_KEEP_BALANCE));
      await tgSend(chatId, msg, mainMenuKeyboard(tid));
      return true;
    }
    const balances = await creditPlayerBalances(player.player_id, {
      mainAdd: -amount, type: 'withdrawal', notes: `Withdraw to ${phone}`
    });
    const wdRec = {
      id: ++withdrawalSeq, player_id: player.player_id, amount,
      method: 'Telebirr', account_number: phone, account_name: player.username || '',
      status: 'pending', requested_at: new Date().toISOString(),
      telegram_id: String(tid), chat_id: chatId
    };
    pendingWithdrawals.set(wdRec.id, wdRec);

    if (supabase) {
      try {
        const { error } = await supabase.from('withdrawal_requests').insert([{
          player_id: player.player_id, amount, method: 'Telebirr', account_number: phone,
          account_name: player.username || '', status: 'pending', requested_at: wdRec.requested_at
        }]);
        if (error) console.error("\u274c withdrawal_requests insert failed:", error.message,
          "|", error.details || '', "|", error.hint || '');
        else wdRec.synced = true;
      } catch (e) { console.error("\u274c withdrawal_requests insert threw:", e.message); }
    }
    clearConv(tid);
    await tgSend(chatId, T.wdDone.replace('{amt}', String(amount)).replace('{phone}', phone), mainMenuKeyboard(tid));
    await notifyAdmin(
      `🔔 <b>Withdrawal</b>\n\nUser: ${player.username}\nTG: <code>${tid}</code>\n` +
      `Amount: <b>${amount} ETB</b>\nPhone: <code>${phone}</code>\n` +
      `Remaining: ${balances ? balances.balance : '?'} ETB`);
    return true;
  }

  return false;
}

async function sendTransactions(chatId, player) {
  let rows = [];
  if (supabase) {
    try {
      const { data } = await supabase.from('transactions')
        .select('type, amount, notes, created_at')
        .eq('player_id', player.player_id)
        .order('created_at', { ascending: false }).limit(10);
      rows = data || [];
    } catch (e) {}
  }
  if (!rows.length) { await tgSend(chatId, T.txnsEmpty); return; }
  let out = T.txnsTitle;
  for (const t of rows) {
    const amt = Number(t.amount) || 0;
    out += `${amt >= 0 ? '⬆️' : '⬇️'} <b>${Math.abs(amt)} ETB</b> — ${t.notes || t.type}\n`;
  }
  await tgSend(chatId, out);
}

async function handleMenuText(chatId, tid, text) {
  if (!text) return;
  const player = await findPlayerByTelegramId(tid);
  if (!player) { await tgSend(chatId, T.notRegistered); return; }
  const sp = sanitizePlayer(player);

  if (text.includes('My Balance') || text.includes('\u1240\u122a \u1202\u1233\u1265') || text === '/balance') {
    await tgSend(chatId, T.balance
      .replace('{main}', String(sp.main_balance))
      .replace('{play}', String(sp.play_balance))
      .replace('{total}', String(sp.balance)));
  } else if (text.includes('Add Funds') || text.includes('\u1308\u1295\u12d8\u1265') || text === '/deposit') {
    setConv(tid, 'dep_amount', {});
    await tgSend(chatId, T.depAsk.replace('{min}', String(MIN_DEPOSIT_AMOUNT)), cancelKb());
  } else if (text.includes('Cash Out') || text.includes('\u12c8\u132a') || text === '/withdraw') {
    setConv(tid, 'wd_amount', {});
    await tgSend(chatId, T.wdAsk
      .replace('{bal}', String(sp.main_balance))
      .replace('{min}', String(MIN_WITHDRAWAL_AMOUNT)), cancelKb());
  } else if (text.includes('Transactions') || text.includes('\u130d\u1265\u12ed\u1276\u127d') || text === '/transactions') {
    await sendTransactions(chatId, player);
  } else if (text.includes('Refer') || text.includes('\u130b\u1265\u12dd') || text === '/refer') {
    const link = BOT_USERNAME_ENV
      ? `https://t.me/${BOT_USERNAME_ENV}?start=ref_${player.player_id}`
      : `${WEBAPP_URL}?ref=${player.player_id}`;
    await tgSend(chatId, T.referral
      .replace('{link}', link)
      .replace('{bonus}', String(REFERRAL_BONUS))
      .replace('{count}', String(sp.referrals_count || 0))
      .replace('{earned}', String(sp.referral_earnings || 0)));
  } else if (text.includes('How to Play') || text.includes('\u1218\u1218\u122a\u12eb') || text === '/help') {
    await tgSend(chatId, T.howTo);
  } else if (text.includes('Support') || text.includes('\u12a5\u1308\u12db')) {
    await tgSend(chatId, T.support.replace('{support}', SUPPORT_CONTACT));
  }
}

async function handleAdminDeposit(chatId, action, id) {
  const rec = pendingDeposits.get(id);
  if (!rec) { await tgSend(chatId, `❌ Deposit #${id} not found.`); return; }
  if (rec.status !== 'pending') { await tgSend(chatId, `⚠️ #${id} already ${rec.status}.`); return; }

  if (action === 'approve') {
    const balances = await creditPlayerBalances(rec.player_id, {
      mainAdd: rec.amount, type: 'deposit', notes: `Deposit ${rec.method} #${id}`
    });
    rec.status = 'approved';
    if (supabase) {
      try { await supabase.from('deposit_requests').update({ status: 'approved' }).eq('reference_id', String(id)); } catch (e) {}
    }
    await tgSend(rec.chat_id, T.depApproved
      .replace('{amt}', String(rec.amount))
      .replace('{bal}', String(balances ? balances.balance : rec.amount)));
    await tgSend(chatId, `✅ Approved #${id} — ${rec.amount} ETB credited.`);
  } else {
    rec.status = 'rejected';
    if (supabase) {
      try { await supabase.from('deposit_requests').update({ status: 'rejected' }).eq('reference_id', String(id)); } catch (e) {}
    }
    await tgSend(rec.chat_id, T.depRejected.replace('{amt}', String(rec.amount)));
    await tgSend(chatId, `❌ Rejected #${id}.`);
  }
}

async function listPending(chatId) {
  const list = Array.from(pendingDeposits.values()).filter(d => d.status === 'pending');
  if (!list.length) { await tgSend(chatId, "No pending deposits."); return; }
  let out = "📋 <b>Pending Deposits</b>\n\n";
  for (const d of list) {
    out += `<code>${d.id}</code> — ${d.amount} ETB — ${d.method}\n/approve_${d.id}  /reject_${d.id}\n\n`;
  }
  await tgSend(chatId, out);
}

async function handleCallback(cb) {
  const tid = String(cb.from.id);
  const chatId = cb.message?.chat?.id;
  const data = cb.data || '';

  const answer = async (text, alert) => {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: text || '', show_alert: !!alert })
      });
    } catch (e) {}
  };

  if (data.startsWith('dep_')) {
    const st = getConv(tid);
    if (data === 'dep_cancel') {
      clearConv(tid); await answer('');
      await tgSend(chatId, T.cancelled, mainMenuKeyboard(tid));
      return;
    }
    if (!st || st.step !== 'dep_method') { await answer(''); return; }
    const isTb = data === 'dep_telebirr';
    const method = isTb ? 'TeleBirr' : 'CBE Birr';
    const acct = isTb ? TELEBIRR_NUMBER : CBE_NUMBER;
    setConv(tid, 'dep_sms', { amount: st.data.amount, method });
    await answer('');
    await tgSend(chatId, T.depInstr
      .replace(/{method}/g, method)
      .replace(/{amt}/g, String(st.data.amount))
      .replace('{acct}', acct));
    return;
  }

  if (data === 'skip_group') {
    await answer('');
    await finishOnboarding(chatId, tid);
    return;
  }

  if (data === 'verify_group') {
    const player = await findPlayerByTelegramId(tid);
    if (!player) { await answer(T.notRegistered, true); return; }

    if (player.tg_bonus_claimed) {
      await answer('');
      await tgSend(chatId, T.alreadyClaimed);
      await finishOnboarding(chatId, tid);
      return;
    }

    const member = await isGroupMember(tid);
    // Fail CLOSED: only pay when membership is positively confirmed. `null`
    // means the check itself failed (bot not admin / wrong id) - paying then
    // would let anyone claim the bonus without joining.
    if (member !== true && TG_GROUP_ID) {
      await answer('');
      await tgSend(chatId, T.groupNotJoined, groupOfferKeyboard());
      return;
    }

    const balances = await creditPlayerBalances(player.player_id, {
      playAdd: TG_GROUP_BONUS,
      type: 'telegram_group_bonus',
      notes: 'TG group bonus (bot)'
    });
    await savePlayer({ ...player, ...(balances || {}), tg_bonus_claimed: true, tg_group_joined: true });

    await answer('+10 ETB \u2705');
    await tgSend(chatId, T.groupOk.replace('{total}', String(balances ? balances.balance : TG_GROUP_BONUS)));
    await finishOnboarding(chatId, tid);
  }
}

// ============ AUTO PROMO POST ============
// Rotating Amharic ad copy so the group doesn't see the same text every time.
const PROMO_MESSAGES = [
  // 1 — welcome / signup bonus
  () => `🎉 <b>እንኳን ወደ ፋስት ቢንጎ በደህና መጡ!</b> 🎉\n\n` +
    `🎁 <b>ለአዲስ ተጫዋቾች 20 ብር ቦነስ!</b>\n` +
    `• 10 ብር የምዝገባ ቦነስ\n` +
    `• 10 ብር የግሩፕ ቦነስ\n\n` +
    `🤝 <b>ጓደኞችዎን ይጋብዙ እና ያትርፉ!</b>\n` +
    `ለእያንዳንዱ ጓደኛ ${REFERRAL_BONUS} ብር\n\n` +
    `🎮 የካርቴላ ዋጋ: <b>${CARD_PRICE} ብር</b>\n` +
    `⚡ ፈጣን ክፍያ • በቴሌብር እና በሲቢኢ\n\n` +
    `👇 አሁኑኑ ይጫወቱ!`,

  // 2 — teaser: who wins today?
  () => `📢 <b>ዛሬ የሚያሸንፈው ማን ይሆን?</b> 👀\n\n` +
    `🎯 ምናልባት ቀጣዩ አሸናፊ እርስዎ ሊሆኑ ይችላሉ!\n\n` +
    `💥 ካርቴላዎን ይምረጡ፣ በጨዋታው ይሳተፉ እና\n` +
    `የማሸነፍ እድልዎን ይሞክሩ።\n\n` +
    `🏆 ብዙ ሰዎች እያሸነፉ ነው…\n` +
    `ቀጣዩ ስም የእርስዎ እንዲሆን ምን ያውቃሉ?\n\n` +
    `🚀 አሁኑኑ ፋስት ቢንጎ ይግቡ፣ እድልዎን ይሞክሩ!`,

  // 3 — luck / don't miss out
  () => `🔥 <b>እድል አይጠብቅም!</b> 🍀\n\n` +
    `🎯 ዛሬ የፋስት ቢንጎ ጨዋታዎችን እንዳያመልጥዎ!\n\n` +
    `🤩 አንድ ካርቴላ ብቻ የዛሬን ቀን ወደ\n` +
    `አሸናፊነት ሊቀይር ይችላል!\n\n` +
    `💸 ይጫወቱ • 🏆 ያሸንፉ • 💰 ሽልማትዎን ይውሰዱ!\n\n` +
    `🚀 አሁኑኑ ይቀላቀሉ እና እድልዎን ይሞክሩ!`,

  // 4 — game features (no payout-percentage claim)
  () => `⚡ <b>ፋስት ቢንጎ — ፈጣን እና ቀላል!</b> ⚡\n\n` +
    `⏱ በየ 3 ሰከንዱ አዲስ ቁጥር\n` +
    `🤖 አውቶማቲክ ማርክ ማድረጊያ\n` +
    `🔢 በአንድ ዙር እስከ 2 ካርቴላ\n` +
    `💸 ፈጣን ክፍያ — በቴሌብር እና በሲቢኢ\n` +
    `📱 ከቴሌግራም ሳይወጡ ይጫወቱ\n\n` +
    `🎁 አዲስ ተጫዋች ከሆኑ <b>20 ብር ቦነስ</b> ይጠብቅዎታል!\n\n` +
    `👇 አሁኑኑ ይመዝገቡ!`,

  // 5 — winners hype
  () => `🏆 <b>የማሸነፍ ቀን ነው!</b> 🎉\n\n` +
    `🎯 ወደ ፋስት ቢንጎ ይግቡ፣ የሚወዱትን ካርቴላ\n` +
    `ይምረጡ እና የማሸነፍ እድልዎን ያሳድጉ!\n\n` +
    `💰 ትንሽ ተጫውተው ትልቅ ሽልማት ማሸነፍ ይችላሉ!\n\n` +
    `⏰ ጨዋታዎች በመጀመር ላይ ናቸው፣\n` +
    `እንዳያመልጥዎ አሁኑኑ ይግቡ! 🚀\n\n` +
    `🎰 ፋስት ቢንጎ — ይጫወቱ፣ ይዝናኑ፣ ያሸንፉ! 🍀`,

  // 6 — refer & earn
  () => `🤝 <b>ጓደኛ ጋብዘው ${REFERRAL_BONUS} ብር ያግኙ!</b> 💰\n\n` +
    `📲 የእርስዎን ሊንክ ለጓደኞችዎ ይላኩ\n` +
    `✅ ጓደኛዎ ሲመዘገብ ወዲያውኑ ${REFERRAL_BONUS} ብር ወደ ሂሳብዎ\n` +
    `♾ የጋበዙት ቁጥር ገደብ የለውም!\n\n` +
    `💡 10 ጓደኛ = <b>${REFERRAL_BONUS * 10} ብር</b>\n\n` +
    `👇 ቦቱን ከፍተው «🤝 Refer & Earn» ይጫኑ`,

  // 7 — evening / prime time
  () => `🌙 <b>የምሽት ጨዋታ ተጀምሯል!</b> 🎲\n\n` +
    `🔥 አሁን ተጫዋቾች እየገቡ ነው —\n` +
    `ደራሹ እየጨመረ ነው!\n\n` +
    `🎯 ካርቴላዎን ይያዙ እና ይቀላቀሉ\n` +
    `💸 አሸናፊው ወዲያውኑ ይከፈለዋል\n\n` +
    `⏳ ቀጣዩ ዙር ሊጀምር ነው — አይዘግዩ!`,
];

let promoIndex = 0;
let lastPromoMessageId = null;

async function tgDeleteMessage(chat_id, message_id) {
  if (!BOT_TOKEN || !message_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, message_id })
    });
  } catch (e) {}
}

async function postPromo() {
  if (!BOT_TOKEN || !PROMO_CHAT_ID) return { ok: false, error: 'missing BOT_TOKEN or PROMO_CHAT_ID' };
  if (!BOT_USERNAME_ENV) {
    console.warn("\u26a0\ufe0f promo skipped - BOT_USERNAME not set");
    return { ok: false, error: 'BOT_USERNAME not set' };
  }

  const text = PROMO_MESSAGES[promoIndex % PROMO_MESSAGES.length]();
  promoIndex++;

  // Deep link so the bot's /start runs (a plain webapp link can't register).
  const startUrl = `https://t.me/${BOT_USERNAME_ENV}?start=promo`;
  const reply_markup = {
    inline_keyboard: [[{ text: "\ud83c\udfae \u12a0\u1201\u1295 \u12ed\u132b\u12c8\u1271 (Play Now)", url: startUrl }]]
  };

  try {
    const usephoto = /^https?:\/\//.test(PROMO_IMAGE_URL);
    const endpoint = usephoto ? 'sendPhoto' : 'sendMessage';
    const body = usephoto
      ? { chat_id: PROMO_CHAT_ID, photo: PROMO_IMAGE_URL, caption: text, parse_mode: 'HTML', reply_markup }
      : { chat_id: PROMO_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };

    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!d.ok) {
      console.warn("\u274c promo post failed:", d.description);
      return { ok: false, error: d.description };
    }
    // Remove the previous ad so the group isn't flooded with old copies.
    if (PROMO_DELETE_PREVIOUS && lastPromoMessageId) {
      await tgDeleteMessage(PROMO_CHAT_ID, lastPromoMessageId);
    }
    lastPromoMessageId = d.result.message_id;
    console.log(`\ud83d\udce2 promo posted to ${PROMO_CHAT_ID} (msg ${lastPromoMessageId})`);
    return { ok: true, message_id: lastPromoMessageId };
  } catch (e) {
    console.warn("\u274c promo error:", e.message);
    return { ok: false, error: e.message };
  }
}

// Send a message to a player by player_id (looks up their telegram_id).
async function notifyPlayer(player_id, text) {
  try {
    const p = await findPlayerById(player_id);
    if (p && p.telegram_id) await tgSend(p.telegram_id, text);
  } catch (e) { console.warn('notifyPlayer failed:', e.message); }
}

async function tgSend(chat_id, text, reply_markup) {
  if (!BOT_TOKEN) return;
  // Telegram rejects the whole message if a web_app button has no valid https
  // url, so drop those buttons rather than lose the message entirely.
  const needsWebApp = reply_markup && (reply_markup.inline_keyboard ||
    (reply_markup.keyboard || []).some(row => row.some(b => b.web_app)));
  if (needsWebApp && !/^https:\/\//.test(WEBAPP_URL)) {
    console.warn("⚠️ WEBAPP_URL not set/invalid - sending without Play button");
    reply_markup = undefined;
    text += "\n\n(⚠️ WEBAPP_URL not configured)";
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, reply_markup, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const d = await r.json();
    if (!d.ok) console.warn("tgSend failed:", d.description);
  } catch (e) { console.warn("tgSend error:", e.message); }
}

// Legacy register endpoint (kept for compatibility, now telegram-id aware)
app.post('/api/register', async (req, res) => {
  const { username, phone_number, referrer_id, telegram_id } = req.body;
  if (!username || !phone_number) return res.status(400).json({ error: "Username and phone required" });
  try {
    let player = telegram_id ? await findPlayerByTelegramId(telegram_id) : null;
    if (!player) player = await findPlayerByPhone(phone_number);
    if (player) return res.json({ isNew: false, user: sanitizePlayer(player) });
    const created = await createPlayer({ username, phone_number, telegram_id, referrer_id: cleanRef(referrer_id) });
    await payReferrer(created);
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
    if (wanted.length > MAX_CARDS_PER_PLAYER) {
      return res.status(400).json({ success: false, error: "too_many_cards" });
    }
    if (new Set(wanted).size !== wanted.length) {
      return res.status(400).json({ success: false, error: "duplicate_cards" });
    }
    if (Number(cards_bought) !== wanted.length) {
      return res.status(400).json({ success: false, error: "card_count_mismatch" });
    }

    const taken = new Set();
    parts.forEach(p => (p.cards || []).forEach(c => taken.add(Number(c))));
    if (wanted.some(c => taken.has(c))) {
      return res.status(400).json({ success: false, error: "card_taken" });
    }

    const sp = sanitizePlayer(player);
    const cost = CARD_PRICE * Number(cards_bought);
    if (sp.balance < cost) return res.status(400).json({ success: false, error: "insufficient_balance" });

    // RESERVE SYNCHRONOUSLY. Everything above is sync, so nothing can interleave
    // before this line. Previously the await below let rapid double-taps each
    // pass the has() check and get charged separately.
    parts.set(player_id, {
      purchased_cards: Number(cards_bought),
      cards: wanted,
      username: player.username || 'Player',
      pending: true
    });

    const deductPlay = Math.min(sp.play_balance, cost);
    const deductMain = cost - deductPlay;
    const balances = await creditPlayerBalances(player_id, {
      mainAdd: -deductMain, playAdd: -deductPlay,
      type: 'entry_fee', game_id, notes: `${cards_bought} cards`
    });
    if (!balances) {
      parts.delete(player_id);   // roll the reservation back
      return res.status(404).json({ success: false, error: "player_not_found" });
    }

    parts.set(player_id, {
      purchased_cards: Number(cards_bought),
      cards: wanted,
      username: player.username || 'Player'
    });

    if (supabase) {
      try {
        const roundReady = await ensureRoundRow(game_id);
        if (!roundReady) {
          // The round is still valid in memory - the player keeps their card
          // and their money. We just can't mirror it to Supabase this time.
          console.warn("\u26a0\ufe0f skipping game_participants insert - rounds row unavailable");
          throw { skip: true };
        }
        const base = { player_id, game_id, purchased_cards: Number(cards_bought), is_winner: false };
        let { error } = await supabase.from('game_participants')
          .insert([{ ...base, metadata: { cards: wanted } }]);
        // Not every deployment has the optional `metadata` (jsonb) column.
        // Fall back to the base row so the round still records correctly.
        if (error && /metadata/i.test(error.message || '')) {
          if (!warnedNoMetadata) {
            warnedNoMetadata = true;
            console.warn("\u26a0\ufe0f game_participants has no 'metadata' column - saving without card numbers.");
            console.warn("   Add it in Supabase for cross-restart reconnect:");
            console.warn("   ALTER TABLE game_participants ADD COLUMN metadata jsonb;");
          }
          ({ error } = await supabase.from('game_participants').insert([base]));
        }
        if (error) console.error("\u274c game_participants insert failed:", error.message);
      } catch (e) {
        if (!e || !e.skip) console.error("\u274c game_participants insert threw:", e && e.message);
      }
    }

    bumpStats(player_id, { games: 1 });

    // Seed house cartelas immediately so the waiting lobby already looks busy.
    addHousePlayers();

    broadcastTick();
    console.log(`✅ Joined round ${game_id}: ${parts.size} participant(s)`);
    res.json({ success: true, ...balances });
  } catch (err) {
    console.error("❌ Game create error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/history/:player_id', async (req, res) => {
  const pid = req.params.player_id;
  if (!supabase) return res.json([]);
  const items = [];
  try {
    // transactions carries everything: entry fees, payouts, bonuses, deposits.
    const { data: txns, error } = await supabase.from('transactions')
      .select('type, amount, game_id, balance_after, notes, created_at')
      .eq('player_id', pid).order('created_at', { ascending: false }).limit(60);
    if (error) console.error("\u274c history transactions:", error.message);
    (txns || []).forEach(t => {
      const amt = Number(t.amount) || 0;
      let kind = 'wallet', label = t.notes || t.type;
      if (t.type === 'entry_fee') { kind = 'game'; label = 'You played'; }
      else if (t.type === 'payout') { kind = 'game'; label = 'You won'; }
      else if (t.type === 'deposit') label = 'Deposit';
      else if (t.type === 'withdrawal') label = 'Withdrawal';
      else if (String(t.type).includes('bonus')) label = 'Bonus';
      items.push({
        kind, type: t.type, label, amount: amt, game_id: t.game_id || null,
        balance_after: t.balance_after ?? null, at: t.created_at, status: 'success'
      });
    });
  } catch (e) { console.error("\u274c history threw:", e.message); }

  // Pending money movements aren't in transactions until approved.
  try {
    const { data: deps } = await supabase.from('deposit_requests')
      .select('amount, method, status, requested_at').eq('player_id', pid)
      .order('requested_at', { ascending: false }).limit(20);
    (deps || []).filter(d => d.status === 'pending').forEach(d => items.push({
      kind: 'wallet', type: 'deposit', label: 'Deposit', amount: Number(d.amount) || 0,
      method: d.method, status: d.status, at: d.requested_at
    }));
  } catch (e) {}
  try {
    const { data: wds } = await supabase.from('withdrawal_requests')
      .select('amount, method, status, requested_at').eq('player_id', pid)
      .order('requested_at', { ascending: false }).limit(20);
    (wds || []).forEach(w => items.push({
      kind: 'wallet', type: 'withdrawal', label: 'Withdrawal',
      amount: -(Number(w.amount) || 0), method: w.method, status: w.status, at: w.requested_at
    }));
  } catch (e) {}

  items.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  res.json(items.slice(0, 60));
});

app.get('/api/leaderboard', async (req, res) => {
  // Ranked by WINS in the period, not by wallet size - a rich player who never
  // plays shouldn't top the board.
  const period = String(req.query.period || 'daily');
  const since = new Date();
  if (period === 'weekly') since.setDate(since.getDate() - 7);
  else since.setHours(0, 0, 0, 0);

  if (!supabase) return res.json([]);
  try {
    const { data, error } = await supabase.from('transactions')
      .select('player_id, amount, created_at')
      .eq('type', 'payout')
      .gte('created_at', since.toISOString())
      .limit(2000);
    if (error) { console.error('leaderboard:', error.message); return res.json([]); }

    const tally = {};
    (data || []).forEach(t => {
      const k = t.player_id;
      if (!tally[k]) tally[k] = { wins: 0, won: 0 };
      tally[k].wins++;
      tally[k].won += Number(t.amount) || 0;
    });

    const ids = Object.keys(tally);
    if (!ids.length) return res.json([]);

    const names = {};
    try {
      const { data: ps } = await supabase.from('players')
        .select('player_id, username').in('player_id', ids);
      (ps || []).forEach(p => { names[p.player_id] = p.username; });
    } catch (e) {}

    const list = ids.map(id => ({
      player_id: id,
      username: names[id] || inMemoryPlayers.get(id)?.username || 'Player',
      wins: tally[id].wins,
      won: tally[id].won
    })).sort((a, b) => b.wins - a.wins || b.won - a.won).slice(0, 10);

    res.json(list);
  } catch (err) {
    console.error('leaderboard threw:', err.message);
    res.json([]);
  }
});

app.post('/api/wallet/deposit-request', async (req, res) => {
  const { player_id, method, amount, reference_id } = req.body;
  if (!player_id || !amount || !reference_id) return res.status(400).json({ success: false, error: "Missing fields" });
  const cleanRef = String(reference_id).toUpperCase();
  if (submittedReferenceIds.has(cleanRef)) return res.status(400).json({ success: false, error: "duplicate_reference" });
  submittedReferenceIds.add(cleanRef);
  const record = { id: Date.now(), player_id, method: method || 'Telebirr', amount: Number(amount), reference_id: cleanRef, status: 'pending', requested_at: new Date().toISOString() };
  inMemoryDeposits.push(record);
  if (supabase) {
    try {
      const { error } = await supabase.from('deposit_requests').insert([record]);
      if (error) console.error("\u274c deposit_requests (app) insert failed:", error.message);
    } catch (e) { console.error("\u274c deposit_requests (app) threw:", e.message); }
  }
  pendingDeposits.set(record.id, { ...record, created_at: record.requested_at });
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
  await notifyPlayer(player_id, T.notifyCoupon
    .replace('{amt}', String(coupon.bonus_amount))
    .replace('{bal}', String(balances ? balances.balance : '?')));
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

    const gate = await checkWithdrawEligibility(
      player_id, Number(amount), sp.main_balance - Number(amount));
    if (!gate.ok) {
      return res.status(400).json({
        success: false,
        error: gate.reason,
        need: gate.need,
        stats: gate.stats,
        limits: {
          min_deposit: MIN_DEPOSIT_BEFORE_WITHDRAW,
          min_games: MIN_GAMES_BEFORE_WITHDRAW,
          keep_balance: WITHDRAW_KEEP_BALANCE
        }
      });
    }
    const balances = await creditPlayerBalances(player_id, { mainAdd: -Number(amount), type: 'withdrawal', notes: `Withdraw ${amount}` });
    if (supabase) {
      try {
        const { error } = await supabase.from('withdrawal_requests').insert([{
          player_id, amount: Number(amount), method: method || 'Telebirr', account_number: account_number || '',
          account_name: account_name || '', status: 'pending', requested_at: new Date().toISOString()
        }]);
        if (error) console.error("\u274c withdrawal_requests (app) insert failed:", error.message);
      } catch (e) { console.error("\u274c withdrawal_requests (app) threw:", e.message); }
    }
    await notifyPlayer(player_id, T.notifyWithdrawPending
      .replace('{amt}', String(amount))
      .replace('{acct}', account_number || '-')
      .replace('{bal}', String(balances ? balances.balance : '?')));
    await notifyAdmin(`\ud83d\udd14 <b>New Withdrawal (app)</b>\nPlayer: <code>${player_id}</code>\nAmount: <b>${amount} ETB</b>\nTo: <code>${account_number || '-'}</code>`);

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
  const parts = participantsOf(currentActiveGameRoundId);
  const totalCards = Array.from(parts.values())
    .reduce((n, p) => n + (Number(p.purchased_cards) || 0), 0);
  const pot = totalCards * (CARD_PRICE - HOUSE_FEE_PER_CARD);
  res.json({
    state: globalGameState,
    game_id: currentActiveGameRoundId,
    timeRemaining,
    participants: parts.size,
    participantCount: parts.size,
    minPlayersToStart: MIN_PLAYERS_TO_START,
    totalCards,
    pot,
    potentialPayout: pot,
    players: inMemoryPlayers.size
  });
});
app.get('/api/admin/players', requireAdmin, async (req, res) => {
  const q = String(req.query.search || '').trim().toLowerCase();
  let list = [];
  if (supabase) {
    try {
      const { data, error } = await supabase.from('players').select('*').limit(500);
      if (error) console.error("admin players read:", error.message);
      if (data) data.forEach(p => cachePlayer(p));
    } catch (e) {}
  }
  list = Array.from(inMemoryPlayers.values()).map(sanitizePlayer);
  if (q) {
    list = list.filter(p =>
      String(p.username || '').toLowerCase().includes(q) ||
      String(p.phone_number || '').toLowerCase().includes(q) ||
      String(p.player_id || '').toLowerCase().includes(q) ||
      String(p.telegram_id || '').toLowerCase().includes(q));
  }
  list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  res.json(list.slice(0, 200));
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
// ---------- DEPOSITS ----------
app.get('/api/admin/deposits', requireAdmin, async (req, res) => {
  const seen = new Map();
  // In-memory first (bot flow), then DB rows.
  pendingDeposits.forEach(d => seen.set(String(d.id), {
    id: d.id, player_id: d.player_id, method: d.method, amount: d.amount,
    reference_id: d.receipt_ref || (d.sms ? String(d.sms).slice(0, 60) : String(d.id)),
    sms: d.sms,
    status: d.status, requested_at: d.created_at
  }));
  if (supabase) {
    try {
      const { data } = await supabase.from('deposit_requests').select('*')
        .order('requested_at', { ascending: false }).limit(200);
      (data || []).forEach(d => {
        const key = String(d.reference_id || d.id);
        if (!seen.has(key)) seen.set(key, d);
      });
    } catch (e) {}
  }
  const list = Array.from(seen.values());
  // Flag reference numbers submitted more than once.
  const counts = {};
  list.forEach(d => { const r = String(d.reference_id || ''); counts[r] = (counts[r] || 0) + 1; });
  list.forEach(d => { d.is_duplicate = counts[String(d.reference_id || '')] > 1; });
  list.sort((a, b) => new Date(b.requested_at || 0) - new Date(a.requested_at || 0));
  res.json(list);
});

const DEPOSIT_BONUS_PCT = Number(process.env.DEPOSIT_BONUS_PCT ?? 0.10);

app.post('/api/admin/deposits/:id/approve', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const rec = pendingDeposits.get(Number(id)) || pendingDeposits.get(id);
  let player_id = rec?.player_id, amount = rec?.amount, method = rec?.method;

  if (!rec && supabase) {
    try {
      const { data } = await supabase.from('deposit_requests').select('*')
        .or(`reference_id.eq.${id},id.eq.${id}`).maybeSingle();
      if (data) { player_id = data.player_id; amount = Number(data.amount); method = data.method; }
    } catch (e) {}
  }
  if (!player_id || !amount) return res.status(404).json({ error: 'Deposit not found' });
  if (rec && rec.status !== 'pending') return res.status(400).json({ error: `Already ${rec.status}` });

  // First deposit gets the matched bonus (capped); later ones the normal rate.
  const stats = await getPlayerStats(player_id);
  const isFirst = stats.deposits === 0;
  const bonus = isFirst
    ? Math.min(Math.floor(amount * FIRST_DEPOSIT_BONUS_PCT), FIRST_DEPOSIT_BONUS_CAP)
    : Math.floor(amount * DEPOSIT_BONUS_PCT);
  console.log(`\ud83d\udcb0 deposit ${amount} | ${isFirst ? 'FIRST' : 'repeat'} | bonus ${bonus}`);
  const balances = await creditPlayerBalances(player_id, {
    mainAdd: amount, playAdd: bonus, type: 'deposit',
    notes: `Deposit ${method || ''} #${id}${bonus ? ` (+${bonus} ${isFirst ? 'first-deposit ' : ''}bonus)` : ''}`
  });
  if (!balances) return res.status(404).json({ error: 'Player not found' });

  bumpStats(player_id, { deposited: amount, deposits: 1 });
  if (rec) {
    rec.status = 'approved';
    if (rec.receipt_ref) {
      usedReceipts.set(rec.receipt_ref, { player_id, status: 'approved', at: new Date().toISOString() });
      flushDisk();
    }
  }
  if (supabase) {
    try { await supabase.from('deposit_requests').update({ status: 'approved' })
      .or(`reference_id.eq.${id},id.eq.${id}`); } catch (e) {}
  }
  if (rec?.chat_id) {
    await tgSend(rec.chat_id, T.depApproved
      .replace('{amt}', String(amount)).replace('{bal}', String(balances.balance)));
  }
  console.log(`\u2705 admin approved deposit #${id}: +${amount} (+${bonus} bonus)`);
  res.json({ success: true, balances, bonus });
});

app.post('/api/admin/deposits/:id/reject', requireAdmin, async (req, res) => {
  const id = req.params.id;
  const rec = pendingDeposits.get(Number(id)) || pendingDeposits.get(id);
  if (rec) {
    rec.status = 'rejected';
    // Free the receipt so a genuine re-submission isn't blocked forever.
    if (rec.receipt_ref) { usedReceipts.delete(rec.receipt_ref); flushDisk(); }
  }
  if (supabase) {
    try { await supabase.from('deposit_requests').update({ status: 'rejected' })
      .or(`reference_id.eq.${id},id.eq.${id}`); } catch (e) {}
  }
  if (rec?.chat_id) await tgSend(rec.chat_id, T.depRejected.replace('{amt}', String(rec.amount)));
  res.json({ success: true });
});

// ---------- WITHDRAWALS ----------
app.get('/api/admin/withdrawals', requireAdmin, async (req, res) => {
  const seen = new Map();
  // In-memory first, so bot-side requests appear even if Supabase rejected them.
  pendingWithdrawals.forEach(w => seen.set(String(w.id), w));
  if (supabase) {
    try {
      const { data, error } = await supabase.from('withdrawal_requests').select('*')
        .order('requested_at', { ascending: false }).limit(200);
      if (error) console.error("admin withdrawals:", error.message);
      (data || []).forEach(w => seen.set(String(w.id), w));
    } catch (e) { console.error("admin withdrawals threw:", e.message); }
  }
  const list = Array.from(seen.values())
    .sort((a, b) => new Date(b.requested_at || 0) - new Date(a.requested_at || 0));
  res.json(list);
});

app.post('/api/admin/withdrawals/:id/:action', requireAdmin, async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Bad action' });
  if (!supabase) return res.status(400).json({ error: 'Supabase required' });

  try {
    const { data: w } = await supabase.from('withdrawal_requests').select('*').eq('id', id).maybeSingle();
    if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: `Already ${w.status}` });

    if (action === 'reject') {
      // The amount was debited when requested - give it back.
      await creditPlayerBalances(w.player_id, {
        mainAdd: Number(w.amount), type: 'withdrawal_refund',
        notes: `Withdrawal #${id} rejected - refunded`
      });
    }
    await supabase.from('withdrawal_requests')
      .update({ status: action === 'approve' ? 'approved' : 'rejected' }).eq('id', id);
    const memW = pendingWithdrawals.get(Number(id)) || pendingWithdrawals.get(id);
    if (memW) memW.status = action === 'approve' ? 'approved' : 'rejected';

    const player = await findPlayerById(w.player_id);
    if (player?.telegram_id) {
      await tgSend(player.telegram_id, action === 'approve'
        ? `\u2705 <b>ወጪ ተከናውኗል!</b>\n\n\u1218\u1320\u1295: <b>${w.amount} \u1265\u122d</b>\n\u1230\u120d\u12ad: ${w.account_number || ''}`
        : `\u274c <b>የወጪ ጥያቄ ተቀባይነት አላገኘም</b>\n\n${w.amount} \u1265\u122d \u12c8\u12f0 \u1202\u1233\u1265\u12ce \u1270\u1218\u120d\u1230\u12cd\u1363\u12a0\u120d\u1362`);
    }
    console.log(`\u2705 admin ${action}d withdrawal #${id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- COUPONS ----------
app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  res.json(inMemoryCoupons.filter(c => c.is_active));
});

app.post('/api/admin/coupons/create', requireAdmin, (req, res) => {
  const { code, bonus_amount, max_uses } = req.body || {};
  if (!code || !bonus_amount) return res.status(400).json({ error: 'code and bonus_amount required' });
  const upper = String(code).toUpperCase().trim();
  if (inMemoryCoupons.some(c => c.code === upper)) {
    return res.status(400).json({ error: 'Coupon code already exists' });
  }
  const coupon = {
    code: upper, bonus_amount: Number(bonus_amount),
    max_uses: Number(max_uses) || 100, used_count: 0, is_active: true
  };
  inMemoryCoupons.push(coupon);
  console.log("\ud83c\udf9f\ufe0f coupon created:", upper, bonus_amount, "ETB");
  res.json({ success: true, coupon });
});

// ---------- TRANSACTIONS ----------
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  if (!supabase) return res.json([]);
  try {
    const { data, error } = await supabase.from('transactions').select('*')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) console.error("admin transactions:", error.message);
    res.json(data || []);
  } catch (e) { res.json([]); }
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

/**
 * TESTING ONLY - wipe a player so you can re-run onboarding from scratch.
 * Clears: Supabase row, in-memory caches, disk file, and the bot phonebook
 * (the phonebook matters - without clearing it the bot skips the phone step).
 *
 *   curl -X POST https://<backend>/api/admin/reset-player \
 *     -H "Content-Type: application/json" \
 *     -H "x-admin-secret: <ADMIN_SECRET>" \
 *     -d '{"telegram_id":"384714105"}'
 */
app.post('/api/admin/reset-player', requireAdmin, async (req, res) => {
  const { telegram_id, phone_number, player_id } = req.body || {};
  if (!telegram_id && !phone_number && !player_id) {
    return res.status(400).json({ error: "Provide telegram_id, phone_number or player_id" });
  }

  let player = null;
  if (player_id) player = await findPlayerById(player_id);
  if (!player && telegram_id) player = await findPlayerByTelegramId(telegram_id);
  if (!player && phone_number) player = await findPlayerByPhone(phone_number);

  const removed = { supabase: false, memory: false, phonebook: false };
  const tid = String(telegram_id || player?.telegram_id || '');

  if (player) {
    if (supabase) {
      try {
        await supabase.from('game_participants').delete().eq('player_id', player.player_id);
        await supabase.from('transactions').delete().eq('player_id', player.player_id);
        const { error } = await supabase.from('players').delete().eq('player_id', player.player_id);
        removed.supabase = !error;
        if (error) console.warn("reset: supabase delete failed:", error.message);
      } catch (e) { console.warn("reset: supabase error:", e.message); }
    }
    inMemoryPlayers.delete(player.player_id);
    if (player.phone_number) inMemoryPhoneToId.delete(String(player.phone_number));
    if (player.telegram_id) inMemoryTgToId.delete(String(player.telegram_id));
    roundParticipants.forEach(m => m.delete(player.player_id));
    removed.memory = true;
  }

  if (tid && tgPhoneBook.has(tid)) { tgPhoneBook.delete(tid); removed.phonebook = true; }
  if (phone_number) {
    for (const [k, v] of tgPhoneBook.entries()) {
      if (v === phone_number) { tgPhoneBook.delete(k); removed.phonebook = true; }
    }
  }
  flushDisk();

  console.log("🧹 Reset player:", player ? player.player_id : '(none)', JSON.stringify(removed));
  res.json({ success: true, found: !!player, player_id: player?.player_id || null, removed });
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
let resolveTimer = null;

function tickPayload() {
  const parts = participantsOf(currentActiveGameRoundId);
  const totalCards = Array.from(parts.values())
    .reduce((s, p) => s + (Number(p.purchased_cards) || 0), 0);
  return {
    gameId: currentActiveGameRoundId,
    state: globalGameState,
    timeRemaining,
    drawnHistory: drawnBallsHistory,
    participantCount: parts.size,
    totalCards,
    // Live prize pool so the client can render "Derash" without guessing.
    derash: totalCards * (CARD_PRICE - HOUSE_FEE_PER_CARD),
    cardPrice: CARD_PRICE,
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

// Returns TRUE only when the parent row is known to exist. The caller must
// skip the game_participants insert otherwise, or Postgres rejects it with
// "violates foreign key constraint game_participants_game_id_fkey".
async function ensureRoundRow(gameId) {
  if (!supabase || !gameId) return false;
  if (roundRowsCreated.has(gameId)) return true;
  try {
    const { error } = await supabase.from('rounds')
      .upsert([{ game_id: gameId, state: 'waiting' }], { onConflict: 'game_id' });
    if (!error) { roundRowsCreated.add(gameId); return true; }

    console.error("\u274c rounds upsert failed:", error.message);
    // Most likely cause: no UNIQUE constraint on rounds.game_id, so upsert
    // can't dedupe. Fall back to a plain insert, then verify.
    try {
      await supabase.from('rounds').insert([{ game_id: gameId, state: 'waiting' }]);
    } catch (e) {}
    const { data } = await supabase.from('rounds')
      .select('game_id').eq('game_id', gameId).maybeSingle();
    if (data) { roundRowsCreated.add(gameId); return true; }
    return false;
  } catch (e) {
    console.error("\u274c rounds upsert threw:", e.message);
    return false;
  }
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
  // Create the parent row immediately - game_participants has a FK to rounds,
  // so inserting a participant before this exists throws
  // "violates foreign key constraint game_participants_game_id_fkey".
  ensureRoundRow(currentActiveGameRoundId);
  io.emit('new_round', tickPayload());
  broadcastTick();
}

// Fill a thin lobby with house cartelas so the round feels alive. They pay no
// entry fee (so they add nothing to the pot) and are removed each round.
function addHousePlayers() {
  if (!HOUSE_ENABLED) return;
  const parts = participantsOf(currentActiveGameRoundId);
  const realCount = Array.from(parts.values()).filter(p => !p.is_house).length;

  // Enough humans turned up - pull the house cartelas back out so real players
  // never compete against them unnecessarily.
  if (realCount >= HOUSE_MIN_REAL_PLAYERS) {
    let removed = 0;
    for (const [k, v] of Array.from(parts.entries())) {
      if (v.is_house) { parts.delete(k); removed++; }
    }
    if (removed) console.log(`\ud83e\udd16 removed ${removed} house cartelas (${realCount} real players)`);
    return;
  }

  // Already seeded for this round - don't add a second set.
  if (Array.from(parts.values()).some(p => p.is_house)) return;

  if (realCount < 1) return;   // nobody real yet, nothing to dress up

  const taken = new Set();
  parts.forEach(p => (p.cards || []).forEach(c => taken.add(Number(c))));

  HOUSE_NAMES.forEach((name, i) => {
    let card = 0, tries = 0;
    do { card = 1 + Math.floor(Math.random() * 150); tries++; }
    while (taken.has(card) && tries < 300);
    if (taken.has(card)) return;
    taken.add(card);
    parts.set(`house_${i}_${currentActiveGameRoundId}`, {
      purchased_cards: 1,
      cards: [card],
      username: name,
      is_house: true
    });
  });
  console.log(`\ud83e\udd16 house cartelas: ${HOUSE_NAMES.join(', ')} (real players: ${realCount})`);
}

// A house cartela completing a line ends the round like any other win, but no
// money is paid out - there's no account behind it.
function checkHouseBingo() {
  const parts = participantsOf(currentActiveGameRoundId);
  for (const [pid, p] of parts.entries()) {
    if (!p.is_house) continue;
    if (currentRoundWinners.some(w => w.player_id === pid)) continue;
    for (const c of (p.cards || [])) {
      if (winningLineCells(Number(c), drawnBallsHistory).length) {
        currentRoundWinners.push({
          player_id: pid, username: p.username, cardNum: c, is_house: true
        });
        console.log(`\ud83e\udd16 house bingo: ${p.username} card #${c}`);
        if (!resolveTimer) {
          resolveTimer = setTimeout(() => { resolveTimer = null; resolveRoundWinners(); }, 1200);
        }
        return;
      }
    }
  }
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
    checkHouseBingo();
  }, 3000);
}

// Returns the [col,row] pairs of the first completed line, for highlighting.
function winningLineCells(cardNum, drawn) {
  try {
    const c = genCard(cardNum);
    const hit = (col, row) => c[col][row] === 0 || drawn.includes(c[col][row]);
    for (let r = 0; r < 5; r++) {
      if ([0,1,2,3,4].every(i => hit(i, r))) return [0,1,2,3,4].map(i => [i, r]);
    }
    for (let col = 0; col < 5; col++) {
      if ([0,1,2,3,4].every(i => hit(col, i))) return [0,1,2,3,4].map(i => [col, i]);
    }
    if ([0,1,2,3,4].every(i => hit(i, i))) return [0,1,2,3,4].map(i => [i, i]);
    if ([0,1,2,3,4].every(i => hit(4 - i, i))) return [0,1,2,3,4].map(i => [4 - i, i]);
    if (hit(0,0) && hit(4,0) && hit(0,4) && hit(4,4)) return [[0,0],[4,0],[0,4],[4,4]];
  } catch (e) {}
  return [];
}

// Index into drawnHistory of the ball that COMPLETED the winning pattern.
function patternCompletedAtIndex(cardNum, drawn) {
  for (let i = 0; i < drawn.length; i++) {
    if (winningLineCells(cardNum, drawn.slice(0, i + 1)).length) return i;
  }
  return -1;
}

async function resolveRoundWinners() {
  if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null; }
  if (gameBallInterval) clearInterval(gameBallInterval);
  globalGameState = "waiting";
  timeRemaining = POST_ROUND_PAUSE_SECONDS;

  if (currentRoundWinners.length === 0) { startNewRound(); return; }

  const payout = Math.floor(currentRoundPot / currentRoundWinners.length);
  const paid = {};
  for (const winner of currentRoundWinners) {
    if (winner.is_house) continue;   // no account, no payout
    const bal = await creditPlayerBalances(winner.player_id, { mainAdd: payout, type: 'payout', game_id: currentActiveGameRoundId, notes: `Bingo! Card #${winner.cardNum}` });
    if (bal) paid[winner.player_id] = bal;
    if (supabase) {
      try {
        await supabase.from('game_participants').update({ is_winner: true })
          .eq('game_id', currentActiveGameRoundId).eq('player_id', winner.player_id);
      } catch (e) {}
    }
  }
  const houseWon = currentRoundWinners.every(w => w.is_house);
  io.emit('opponent_victory', {
    houseWon,
    winnerName: currentRoundWinners.map(w => w.username).join(', '),
    cardNum: currentRoundWinners[0].cardNum,
    winnerPlayerId: currentRoundWinners[0].player_id,
    payoutAmount: payout,
    isSplit: currentRoundWinners.length > 1,
    drawnHistory: drawnBallsHistory,
    winningCells: winningLineCells(Number(currentRoundWinners[0].cardNum), drawnBallsHistory),
    displaySeconds: WINNER_DISPLAY_SECONDS,
    // Authoritative post-payout balances, so the winner's wallet updates on the
    // spot instead of only after re-opening the app.
    balances: paid
  });

  // Hold the winning cartela on screen before the next countdown starts.
  await new Promise(r => setTimeout(r, WINNER_DISPLAY_SECONDS * 1000));
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
        // House cartelas are added BEFORE this check so a single real player
        // can start a round (the lobby should never look empty).
        addHousePlayers();
        const count = participantsOf(currentActiveGameRoundId).size;
        const realCount = Array.from(participantsOf(currentActiveGameRoundId).values())
          .filter(p => !p.is_house).length;
        if (realCount < 1 || count < MIN_PLAYERS_TO_START) {
          console.log(`⏳ Players: ${count}/${MIN_PLAYERS_TO_START}, restarting wait...`);
          timeRemaining = RECHECK_WAIT_SECONDS;
        } else {
          console.log(`🎮 Starting game with ${participantsOf(currentActiveGameRoundId).size} players!`);
          globalGameState = "playing";
          resetBallPool();
          // Pot INCLUDES house cartelas so the derash looks full. The house
          // funds the difference when a real player wins - see HOUSE_NOTE.
          const totalCards = Array.from(participantsOf(currentActiveGameRoundId).values())
            .reduce((s, p) => s + (Number(p.purchased_cards) || 0), 0);
          currentRoundPot = totalCards * (CARD_PRICE - HOUSE_FEE_PER_CARD);
          console.log(`💰 Pot: ${totalCards} cards x ${CARD_PRICE - HOUSE_FEE_PER_CARD} = ${currentRoundPot} ETB`);
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
    const { player_id, cardNum } = data || {};
    const reject = (why) => {
      console.log("\u26d4 bingo claim rejected:", why, player_id || '?', 'card', cardNum || '?');
      socket.emit('bingo_rejected', { reason: why });
    };
    if (globalGameState !== "playing") return reject('round_not_playing');
    if (!player_id || !cardNum) return reject('missing_fields');
    if (currentRoundWinners.some(w => w.player_id === player_id)) return;

    const part = participantsOf(currentActiveGameRoundId).get(player_id);
    if (!part) return reject('not_in_round');
    if (!(part.cards || []).map(Number).includes(Number(cardNum))) return reject('card_not_yours');
    // Use the shared pattern check so client and server always agree.
    if (!winningLineCells(Number(cardNum), drawnBallsHistory).length) return reject('no_winning_line');

    // The pattern must have completed on one of the last BINGO_GRACE_BALLS.
    // Claiming long after the number passed is a miss, by design.
    const completedAt = patternCompletedAtIndex(Number(cardNum), drawnBallsHistory);
    if (completedAt >= 0) {
      const ballsSince = drawnBallsHistory.length - 1 - completedAt;
      if (ballsSince >= BINGO_GRACE_BALLS) {
        console.log(`\u23f0 missed bingo: card ${cardNum} completed ${ballsSince} balls ago`);
        socket.emit('bingo_missed', { cardNum, ballsSince });
        return;
      }
    }

    const player = await findPlayerById(player_id);
    if (!player || player.is_banned) return reject('player_invalid');

    currentRoundWinners.push({ player_id, username: player.username || 'Player', cardNum });
    console.log("🏆 Bingo:", player.username, "Card #", cardNum);
    // Wait briefly so simultaneous claims all land and split the pot evenly,
    // instead of the first packet to arrive taking everything.
    if (!resolveTimer) {
      resolveTimer = setTimeout(() => { resolveTimer = null; resolveRoundWinners(); }, 1200);
    }
  });

  socket.on('disconnect', () => console.log("🔌 Client disconnected:", socket.id));
});

startNewRound();
// ---- KEEP-ALIVE (free-tier stopgap only) ----------------------------------
// Render free web services spin down after ~15 min without INBOUND traffic.
// A self-ping creates that traffic. This is a band-aid, not a fix: it burns
// the 750 free instance-hours/month (a single always-on service needs ~730),
// and it cannot help if the service is already asleep. Use a paid instance
// for real players.
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').trim();
const KEEPALIVE = String(process.env.KEEPALIVE || 'true') === 'true';

if (SELF_URL && KEEPALIVE) {
  setInterval(async () => {
    try {
      const r = await fetch(`${SELF_URL}/api/health-check`);
      if (!r.ok) console.warn('keep-alive non-200:', r.status);
    } catch (e) {
      console.warn('keep-alive failed:', e.message);
    }
  }, 10 * 60 * 1000);   // every 10 min, comfortably inside the 15 min window
  console.log(`💓 keep-alive pinging ${SELF_URL} every 10 min`);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Fast Bingo running on http://0.0.0.0:${PORT}`);
  console.log(`📊 Card=${CARD_PRICE}ETB, MinPlayers=${MIN_PLAYERS_TO_START}, Wait=${INITIAL_WAIT_SECONDS}s`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? 'set' : 'MISSING (initData cannot be verified!)'}`);
  console.log(`🔗 WEBAPP_URL: ${WEBAPP_URL || 'NOT SET (in-bot Play button disabled)'}`);
  console.log(`👥 TG_GROUP_ID: ${TG_GROUP_ID || 'NOT SET (group membership cannot be verified - bonus pays without joining!)'}`);
  if (TG_GROUP_ID && !TG_GROUP_ID_OK) {
    console.warn(`   ⚠️ TG_GROUP_ID "${TG_GROUP_ID}" does not look like a supergroup id (-100...) or @username`);
  }
  console.log(`✈️ TG_GROUP_LINK: ${TG_GROUP_LINK || 'NOT SET'}`);
  console.log(`👤 ADMIN_ID: ${ADMIN_ID || 'NOT SET - /promo and /approve will not work'}`);
  console.log(`🖼️ PROMO_IMAGE_URL: ${PROMO_IMAGE_URL || '(none - text-only posts)'}`);

  if (PROMO_ENABLED && PROMO_CHAT_ID) {
    console.log(`📢 Auto-promo ON: every ${PROMO_INTERVAL_MIN} min to ${PROMO_CHAT_ID}`);
    setTimeout(postPromo, 30 * 1000);
    setInterval(postPromo, PROMO_INTERVAL_MIN * 60 * 1000);
  } else {
    console.log(`📢 Auto-promo OFF (PROMO_ENABLED=${process.env.PROMO_ENABLED || 'unset'}, PROMO_CHAT_ID=${PROMO_CHAT_ID || 'unset'})`);
  }
});
