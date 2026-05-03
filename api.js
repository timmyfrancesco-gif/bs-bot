/**
 * Astro Exchange — Public API
 * Run alongside the bot: node api.js
 * The bot writes to JSON files; this server reads them and exposes safe,
 * anonymised data to the website.
 *
 * Start: node api.js
 * Default port: 3000  (set PORT env var to override)
 */

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS: allow your GitHub Pages domain (and localhost for dev) ──
const ALLOWED_ORIGINS = [
  "https://timmyfrancesco-gif.github.io",
  "http://localhost",
  "http://127.0.0.1",
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  }
}));

app.use(express.json());

// ── DATA DIR (same as bot) ──
const DATA_DIR = process.env.DATA_DIR || "./";

function load(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// ── HELPERS ──
function maskEmail(email = "") {
  const at = email.indexOf("@");
  if (at > 2) return email[0] + "****" + email[at - 1] + email.slice(at);
  if (at > 0) return email[0] + "****" + email.slice(at);
  return "****";
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

// ─────────────────────────────────────────────
//  GET /api/stats
//  High-level counters shown in the hero section
// ─────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const slots        = load("slots.json");
  const mmSessions   = load("mm_sessions.json");
  const escrowCount  = load("escrow_trade_count.json");
  const userTx       = load("user_transactions.json");
  const liveStock    = load("livestock.json");
  const pending      = load("pending_payments.json");

  const activeSlots      = Object.keys(slots).length;
  const completedMM      = Object.values(mmSessions).filter(s => s.status === "completed").length;
  const totalEscrow      = escrowCount.count || 0;
  const totalUserTrades  = Object.values(userTx).reduce((n, arr) => n + arr.length, 0);
  const pendingPayments  = Object.keys(pending).length;

  res.json({
    activeSlots,
    completedMM,
    totalEscrow,
    totalUserTrades,
    pendingPayments,
  });
});

// ─────────────────────────────────────────────
//  GET /api/feed?limit=20
//  Recent activity feed (anonymised)
// ─────────────────────────────────────────────
app.get("/api/feed", (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit) || 20, 50);
  const events  = load("live_feed.json");   // written by bot (see below)
  const list    = Array.isArray(events.items) ? events.items : [];

  res.json({ items: list.slice(0, limit) });
});

// ─────────────────────────────────────────────
//  POST /api/feed  (called by the bot internally)
//  Accepts a new event and prepends it to live_feed.json
//  Protected by a simple shared secret.
// ─────────────────────────────────────────────
const FEED_SECRET = process.env.FEED_SECRET || "change-me-in-production";

app.post("/api/feed", (req, res) => {
  if (req.headers["x-feed-secret"] !== FEED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, label, amount, method, meta } = req.body;
  if (!type || !label) return res.status(400).json({ error: "type and label required" });

  const feedPath = path.join(DATA_DIR, "live_feed.json");
  let data = { items: [] };
  if (fs.existsSync(feedPath)) {
    try { data = JSON.parse(fs.readFileSync(feedPath, "utf8")); } catch {}
  }
  if (!Array.isArray(data.items)) data.items = [];

  data.items.unshift({
    id:     Date.now(),
    type,          // "order" | "escrow" | "mm" | "slot" | "exchange"
    label,         // short description
    amount: amount || null,
    method: method || null,
    meta:   meta   || null,
    ts:     Date.now(),
  });

  // Keep at most 200 events
  data.items = data.items.slice(0, 200);
  fs.writeFileSync(feedPath, JSON.stringify(data, null, 2));

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  GET /api/ltc
//  Cached LTC price (read from shared file)
// ─────────────────────────────────────────────
app.get("/api/ltc", (req, res) => {
  const priceFile = path.join(DATA_DIR, "ltc_price_cache.json");
  if (fs.existsSync(priceFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(priceFile, "utf8"));
      return res.json(data);
    } catch {}
  }
  res.json({ eur: null, usd: null, updatedAt: null });
});

// ─────────────────────────────────────────────
//  GET /api/slots
//  Active slot count and category breakdown
// ─────────────────────────────────────────────
app.get("/api/slots", (req, res) => {
  const slots = load("slots.json");
  const breakdown = { First: 0, Second: 0, Third: 0 };
  Object.values(slots).forEach(s => {
    if (breakdown[s.category] !== undefined) breakdown[s.category]++;
  });
  res.json({ total: Object.keys(slots).length, breakdown });
});

// ─────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[API] Astro Exchange API running on port ${PORT}`);
});

module.exports = app;
