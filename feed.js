/**
 * feed.js — helper usato dal bot per loggare eventi al live feed
 *
 * Uso nel bot:
 *   const { pushEvent } = require("./feed");
 *   await pushEvent("order", "New order", "€9.99", "LTC");
 */

const http  = require("http");
const https = require("https");

const API_URL     = process.env.API_URL     || "http://localhost:3000";
const FEED_SECRET = process.env.FEED_SECRET || "change-me-in-production";

/**
 * @param {"order"|"escrow"|"mm"|"slot"|"exchange"} type
 * @param {string} label   Short public description
 * @param {string} [amount]  e.g. "€9.99" or "0.05 LTC"
 * @param {string} [method]  e.g. "LTC", "PayPal"
 * @param {object} [meta]    Any extra public data
 */
function pushEvent(type, label, amount, method, meta) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type, label, amount, method, meta });
    const url  = new URL("/api/feed", API_URL);
    const lib  = url.protocol === "https:" ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-feed-secret":  FEED_SECRET,
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });

    req.on("error", () => resolve(false)); // never crash the bot
    req.write(body);
    req.end();
  });
}

/**
 * Writes the current LTC price to ltc_price_cache.json
 * so the API can serve it without hitting CoinGecko again.
 */
const fs   = require("fs");
const path = require("path");

function cacheLtcPrice(eur, usd) {
  const DATA_DIR = process.env.DATA_DIR || "./";
  const p = path.join(DATA_DIR, "ltc_price_cache.json");
  try {
    fs.writeFileSync(p, JSON.stringify({ eur, usd, updatedAt: Date.now() }, null, 2));
  } catch {}
}

module.exports = { pushEvent, cacheLtcPrice };
