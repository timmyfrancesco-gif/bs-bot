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
const https   = require("https");

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

  res.json({ activeSlots, completedMM, totalEscrow, totalUserTrades, pendingPayments });
});

// ─────────────────────────────────────────────
//  GET /api/feed?limit=20
// ─────────────────────────────────────────────
app.get("/api/feed", (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
  const events = load("live_feed.json");
  const list   = Array.isArray(events.items) ? events.items : [];
  res.json({ items: list.slice(0, limit) });
});

// ─────────────────────────────────────────────
//  POST /api/feed  (bot → api, protected)
// ─────────────────────────────────────────────
const FEED_SECRET = process.env.FEED_SECRET || "change-me-in-production";

app.post("/api/feed", (req, res) => {
  if (req.headers["x-feed-secret"] !== FEED_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const { type, label, amount, method, meta } = req.body;
  if (!type || !label) return res.status(400).json({ error: "type and label required" });

  const feedPath = path.join(DATA_DIR, "live_feed.json");
  let data = { items: [] };
  if (fs.existsSync(feedPath)) {
    try { data = JSON.parse(fs.readFileSync(feedPath, "utf8")); } catch {}
  }
  if (!Array.isArray(data.items)) data.items = [];

  data.items.unshift({
    id: Date.now(), type, label,
    amount: amount || null,
    method: method || null,
    meta:   meta   || null,
    ts: Date.now(),
  });
  data.items = data.items.slice(0, 200);
  fs.writeFileSync(feedPath, JSON.stringify(data, null, 2));
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  GET /api/ltc
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
//  SLOT ORDERS — website payment flow
// ─────────────────────────────────────────────
const SLOT_PRICES = {
  First:  { weekly: 5, monthly: 15, lifetime: 40 },
  Second: { weekly: 3, monthly: 9,  lifetime: 27 },
  Third:  { weekly: 2, monthly: 6,  lifetime: 18 },
};

function bcGet(urlPath) {
  return new Promise((resolve) => {
    https.get(`https://api.blockcypher.com/v1/ltc/main${urlPath}`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    }).on('error', () => resolve({}));
  });
}

// POST /api/slot-order  — create a new slot payment order
app.post("/api/slot-order", (req, res) => {
  const { tier, duration, discord } = req.body;
  const tierPrices = SLOT_PRICES[tier];
  if (!tierPrices || tierPrices[duration] === undefined)
    return res.status(400).json({ error: "Invalid tier or duration" });

  let address, wif;
  try {
    const litecore = require('litecore-lib');
    const pk = new litecore.PrivateKey();
    address = pk.toAddress().toString();
    wif = pk.toWIF();
  } catch(e) {
    return res.status(500).json({ error: "Address generation failed: " + e.message });
  }

  const orderId  = `slot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const amountEur = tierPrices[duration];
  const ordersPath = path.join(DATA_DIR, "pending_slot_orders.json");
  let orders = {};
  if (fs.existsSync(ordersPath)) {
    try { orders = JSON.parse(fs.readFileSync(ordersPath, "utf8")); } catch {}
  }
  orders[orderId] = {
    orderId, tier, duration,
    discord: (discord || "").slice(0, 100),
    amountEur, address, wif,
    status: "pending",
    createdAt: Date.now(),
  };
  fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
  res.json({ orderId, address, amountEur, tier, duration });
});

// GET /api/slot-order/:id  — check payment status (polls BlockCypher)
app.get("/api/slot-order/:id", async (req, res) => {
  const ordersPath = path.join(DATA_DIR, "pending_slot_orders.json");
  let orders = {};
  if (fs.existsSync(ordersPath)) {
    try { orders = JSON.parse(fs.readFileSync(ordersPath, "utf8")); } catch {}
  }
  const order = orders[req.params.id];
  if (!order) return res.status(404).json({ error: "Not found" });

  if (order.status === "pending") {
    const bc = await bcGet(`/addrs/${order.address}/balance`);
    if ((bc.total_received || 0) > 0) {
      orders[order.orderId].status = "paid";
      fs.writeFileSync(ordersPath, JSON.stringify(orders, null, 2));
      order.status = "paid";
      try {
        const { pushEvent } = require('./feed');
        pushEvent("slot", `New slot purchase: ${order.tier} ${order.duration}`, `€${order.amountEur}`, "LTC");
      } catch {}
    }
  }

  const { wif, ...safe } = order;
  res.json(safe);
});

// ─────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[API] Astro Exchange API running on port ${PORT}`);
});

module.exports = app;
