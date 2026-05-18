/**
 * Astro Exchange — Public API
 * Run alongside the bot: node api.js
 */

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");
const https   = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

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

const DATA_DIR = process.env.DATA_DIR || "./";

function load(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
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
//  DISCORD REST helper
// ─────────────────────────────────────────────
function discordRequest(method, urlPath, body) {
  const token = process.env.DISCORD_BOT_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN;
  if (!token) return Promise.resolve(null);

  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : "";
    const req = https.request({
      hostname: "discord.com",
      path: `/api/v10${urlPath}`,
      method,
      headers: {
        "Authorization": `Bot ${token}`,
        "Content-Type": "application/json",
        ...(bodyStr && { "Content-Length": Buffer.byteLength(bodyStr) }),
      },
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Manda embed nel canale logs quando arriva un nuovo ordine
async function notifyDiscordNewOrder(order) {
  const channelId = process.env.DISCORD_LOG_CHANNEL_ID;
  if (!channelId) return null;

  const labels = { weekly: "7 giorni", monthly: "30 giorni", lifetime: "Lifetime" };

  const msg = await discordRequest("POST", `/channels/${channelId}/messages`, {
    embeds: [{
      title: "🛒 Nuovo ordine slot dal sito",
      color: 0x5FB3C4,
      fields: [
        { name: "📦 Categoria",  value: `**${order.tier}**`,                    inline: true },
        { name: "⏱ Durata",     value: labels[order.duration] || order.duration, inline: true },
        { name: "💶 Importo",    value: `€${order.amountEur}`,                  inline: true },
        { name: "👤 Discord",    value: order.discord || "*Non inserito*",       inline: true },
        { name: "🔑 Indirizzo LTC", value: `\`${order.address}\``,              inline: false },
        { name: "🆔 Order ID",   value: `\`${order.orderId}\``,                 inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "Astro Exchange · In attesa di pagamento" },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "✅ Attiva Slot",  custom_id: `activate_slot_${order.orderId}` },
        { type: 2, style: 4, label: "❌ Annulla",      custom_id: `cancel_slot_${order.orderId}` },
      ],
    }],
  });

  return msg?.id || null;
}

// Aggiorna il messaggio quando il pagamento è confermato
async function notifyDiscordPaid(order) {
  const channelId = process.env.DISCORD_LOG_CHANNEL_ID;
  if (!channelId) return;

  const labels = { weekly: "7 giorni", monthly: "30 giorni", lifetime: "Lifetime" };

  // Manda nuovo messaggio di conferma pagamento
  await discordRequest("POST", `/channels/${channelId}/messages`, {
    embeds: [{
      title: "✅ Pagamento ricevuto — attiva lo slot!",
      color: 0x4ade80,
      fields: [
        { name: "📦 Categoria",  value: `**${order.tier}**`,                    inline: true },
        { name: "⏱ Durata",     value: labels[order.duration] || order.duration, inline: true },
        { name: "💶 Importo",    value: `€${order.amountEur}`,                  inline: true },
        { name: "👤 Discord",    value: order.discord || "*Non inserito*",       inline: true },
        { name: "🆔 Order ID",   value: `\`${order.orderId}\``,                 inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "Astro Exchange · Pagamento confermato on-chain" },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "✅ Attiva Slot", custom_id: `activate_slot_${order.orderId}` },
      ],
    }],
  });

  // Modifica il messaggio originale per disabilitare i bottoni
  if (order.discordMsgId) {
    await discordRequest("PATCH", `/channels/${channelId}/messages/${order.discordMsgId}`, {
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: "✅ Pagato", custom_id: `activate_slot_${order.orderId}`, disabled: true },
          { type: 2, style: 4, label: "❌ Annulla", custom_id: `cancel_slot_${order.orderId}`, disabled: true },
        ],
      }],
    });
  }
}

// ─────────────────────────────────────────────
//  GET /api/stats
// ─────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const slots       = load("slots.json");
  const mmSessions  = load("mm_sessions.json");
  const escrowCount = load("escrow_trade_count.json");
  const userTx      = load("user_transactions.json");
  const pending     = load("pending_payments.json");

  res.json({
    activeSlots:     Object.keys(slots).length,
    completedMM:     Object.values(mmSessions).filter(s => s.status === "completed").length,
    totalEscrow:     escrowCount.count || 0,
    totalUserTrades: Object.values(userTx).reduce((n, arr) => n + arr.length, 0),
    pendingPayments: Object.keys(pending).length,
  });
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
    try { return res.json(JSON.parse(fs.readFileSync(priceFile, "utf8"))); } catch {}
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
//  SLOT ORDERS
// ─────────────────────────────────────────────
const SLOT_PRICES = {
  First:  { weekly: 5, monthly: 15, lifetime: 40 },
  Second: { weekly: 3, monthly: 9,  lifetime: 27 },
  Third:  { weekly: 2, monthly: 6,  lifetime: 18 },
};

function bcGet(urlPath) {
  return new Promise((resolve) => {
    https.get(`https://api.blockcypher.com/v1/ltc/main${urlPath}`, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    }).on("error", () => resolve({}));
  });
}

function loadOrders() {
  const p = path.join(DATA_DIR, "pending_slot_orders.json");
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

function saveOrders(orders) {
  fs.writeFileSync(path.join(DATA_DIR, "pending_slot_orders.json"), JSON.stringify(orders, null, 2));
}

// POST /api/slot-order
app.post("/api/slot-order", async (req, res) => {
  const { tier, duration, discord } = req.body;
  const tierPrices = SLOT_PRICES[tier];
  if (!tierPrices || tierPrices[duration] === undefined)
    return res.status(400).json({ error: "Invalid tier or duration" });

  let address, wif;
  try {
    const litecore = require("litecore-lib");
    const pk = new litecore.PrivateKey();
    address = pk.toAddress().toString();
    wif = pk.toWIF();
  } catch(e) {
    return res.status(500).json({ error: "Address generation failed: " + e.message });
  }

  const orderId   = `slot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const amountEur = tierPrices[duration];

  const order = {
    orderId, tier, duration,
    discord: (discord || "").slice(0, 100),
    amountEur, address, wif,
    status: "pending",
    createdAt: Date.now(),
    discordMsgId: null,
  };

  const orders = loadOrders();
  orders[orderId] = order;
  saveOrders(orders);

  // Notifica Discord
  const msgId = await notifyDiscordNewOrder(order);
  if (msgId) {
    orders[orderId].discordMsgId = msgId;
    saveOrders(orders);
  }

  res.json({ orderId, address, amountEur, tier, duration });
});

// GET /api/slot-order/:id
app.get("/api/slot-order/:id", async (req, res) => {
  const orders = loadOrders();
  const order  = orders[req.params.id];
  if (!order) return res.status(404).json({ error: "Not found" });

  if (order.status === "pending") {
    const bc = await bcGet(`/addrs/${order.address}/balance`);
    if ((bc.total_received || 0) > 0) {
      orders[order.orderId].status = "paid";
      saveOrders(orders);
      order.status = "paid";
      try { require("./feed").pushEvent("slot", `New slot purchase: ${order.tier} ${order.duration}`, `€${order.amountEur}`, "LTC"); } catch {}
      notifyDiscordPaid(order);
    }
  }

  const { wif, ...safe } = order;
  res.json(safe);
});

// ─────────────────────────────────────────────
//  CASINO — BLACKJACK WEB
// ─────────────────────────────────────────────
const webBJGames = {};

function _shoe(n=6){
  const suits=['♠','♥','♦','♣'],ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'],s=[];
  for(let d=0;d<n;d++)for(const st of suits)for(const r of ranks)s.push({r,s:st});
  for(let i=s.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[s[i],s[j]]=[s[j],s[i]];}
  return s;
}
function _cv(c){if(c.r==='A')return 11;if(['J','Q','K'].includes(c.r))return 10;return parseInt(c.r);}
function _hv(h){let v=0,a=0;for(const c of h){v+=_cv(c);if(c.r==='A')a++;}while(v>21&&a>0){v-=10;a--;}return v;}
function _bj(h){return h.length===2&&_hv(h)===21;}
function _split(h){return h.length===2&&_cv(h[0])===_cv(h[1]);}

function _results(game){
  const res=[];
  const dv=_hv(game.dealerHand),dbj=_bj(game.dealerHand);
  for(let i=0;i<game.playerHands.length;i++){
    const hand=game.playerHands[i];
    const lbl=game.playerHands.length>1?`Mano ${i+1}`:'Risultato';
    const pv=_hv(hand.cards),pbj=_bj(hand.cards);
    if(hand.surrendered){res.push({label:`${lbl}: Resa`,profit:-Math.floor(hand.bet/2),icon:'🏳️'});continue;}
    if(pv>21)res.push({label:`${lbl}: Bust`,profit:-hand.bet,icon:'💥'});
    else if(pbj&&!dbj)res.push({label:`${lbl}: Blackjack! (3:2)`,profit:Math.floor(hand.bet*1.5),icon:'🃏'});
    else if(pbj&&dbj)res.push({label:`${lbl}: Pareggio (entrambi BJ)`,profit:0,icon:'🤝'});
    else if(dbj)res.push({label:`${lbl}: Blackjack dealer`,profit:-hand.bet,icon:'😞'});
    else if(dv>21)res.push({label:`${lbl}: Bust dealer!`,profit:hand.bet,icon:'🎉'});
    else if(pv>dv)res.push({label:`${lbl}: Vinci!`,profit:hand.bet,icon:'✅'});
    else if(pv<dv)res.push({label:`${lbl}: Perdi`,profit:-hand.bet,icon:'❌'});
    else res.push({label:`${lbl}: Pareggio`,profit:0,icon:'🤝'});
  }
  if(game.insuranceBet>0){
    if(dbj)res.push({label:'Assicurazione Win (2:1)',profit:game.insuranceBet*2,icon:'🛡️'});
    else res.push({label:'Assicurazione Persa',profit:-game.insuranceBet,icon:'🛡️'});
  }
  return res;
}

function _applyResults(game,stats){
  const results=_results(game);
  let profit=0;
  for(const r of results){
    profit+=r.profit;
    if(r.profit>0)stats.totalWon=(stats.totalWon||0)+r.profit;
    else if(r.profit<0)stats.totalLost=(stats.totalLost||0)+Math.abs(r.profit);
  }
  stats.balance=(stats.balance||0)+profit;
  stats.gamesPlayed=(stats.gamesPlayed||0)+1;
  if(profit>0){stats.blackjackStreak=(stats.blackjackStreak||0)+1;if(profit>(stats.biggestWin||0))stats.biggestWin=profit;}
  else if(profit<0){stats.blackjackStreak=0;}
  delete webBJGames[game.userId];
  return{results,profit};
}

function _serGame(game,revealDealer=false){
  return{
    dealerHand: revealDealer ? game.dealerHand : [null,...game.dealerHand.slice(1)],
    playerHands: game.playerHands,
    currentHandIndex: game.currentHandIndex,
    insuranceBet: game.insuranceBet,
    phase: game.phase,
  };
}

function _advanceOrDealer(game,allData,stats){
  game.currentHandIndex++;
  if(game.currentHandIndex<game.playerHands.length){
    return{ok:true,game:_serGame(game,false),balance:stats.balance};
  }
  while(_hv(game.dealerHand)<17){
    if(game.shoe.length<60)game.shoe.push(..._shoe(6));
    game.dealerHand.push(game.shoe.pop());
  }
  game.phase='result';
  const{results,profit}=_applyResults(game,stats);
  allData[game.userId]=stats;
  return{ok:true,game:_serGame(game,true),balance:stats.balance,results,profit};
}

function _ltcPrice(){
  const p=path.join(DATA_DIR,'ltc_price_cache.json');
  if(fs.existsSync(p)){try{return JSON.parse(fs.readFileSync(p,'utf8')).eur||85;}catch{}}
  return 85;
}

// GET /api/casino/balance/:userId
app.get('/api/casino/balance/:userId',(req,res)=>{
  const data=load('user_balances.json');
  const u=data[req.params.userId]||{balance:0};
  const ltcEur=_ltcPrice();
  res.json({eur:u.balance||0,ltc:ltcEur>0?((u.balance||0)/ltcEur):0,gamesPlayed:u.gamesPlayed||0,totalWon:u.totalWon||0,totalLost:u.totalLost||0,streak:u.blackjackStreak||0,biggestWin:u.biggestWin||0});
});

// POST /api/casino/bj/deal
app.post('/api/casino/bj/deal',(req,res)=>{
  const{userId,bet}=req.body;
  if(!userId||!bet||bet<1)return res.status(400).json({error:'Parametri non validi'});
  const data=load('user_balances.json');
  if(!data[userId])data[userId]={balance:0};
  const stats=data[userId];
  const betInt=Math.round(bet);
  if((stats.balance||0)<betInt)return res.status(400).json({error:'Saldo insufficiente'});
  stats.balance=(stats.balance||0)-betInt;
  stats.totalWagered=(stats.totalWagered||0)+betInt;
  const shoe=_shoe(6);
  const dealerHand=[shoe.pop(),shoe.pop()];
  const playerHands=[{cards:[shoe.pop(),shoe.pop()],bet:betInt,surrendered:false,doubled:false}];
  const game={userId,shoe,dealerHand,playerHands,currentHandIndex:0,insuranceBet:0,phase:'playing',createdAt:Date.now()};
  webBJGames[userId]=game;
  save('user_balances.json',data);
  const needsInsurance=dealerHand[0].r==='A';
  const playerBJ=_bj(playerHands[0].cards);
  let result=null;
  if(playerBJ){
    const{results,profit}=_applyResults(game,stats);
    save('user_balances.json',data);
    result={results,profit};
  }
  res.json({ok:true,game:_serGame(game,playerBJ),needsInsurance:needsInsurance&&!playerBJ,playerBlackjack:playerBJ,dealerBlackjack:playerBJ?_bj(dealerHand):null,balance:stats.balance,...(result||{})});
});

// POST /api/casino/bj/action
app.post('/api/casino/bj/action',(req,res)=>{
  const{userId,action}=req.body;
  const game=webBJGames[userId];
  if(!game)return res.status(400).json({error:'Nessun gioco attivo'});
  const data=load('user_balances.json');
  const stats=data[userId]||{balance:0};
  const hand=game.playerHands[game.currentHandIndex];

  if(action==='insurance'){
    const cost=Math.floor(hand.bet/2);
    if((stats.balance||0)<cost)return res.status(400).json({error:'Saldo insufficiente per assicurazione'});
    stats.balance=(stats.balance||0)-cost;
    game.insuranceBet=cost;
    save('user_balances.json',data);
    return res.json({ok:true,game:_serGame(game,false),balance:stats.balance});
  }
  if(action==='no_insurance'){
    return res.json({ok:true,game:_serGame(game,false),balance:stats.balance});
  }
  if(action==='hit'){
    if(game.shoe.length<60)game.shoe.push(..._shoe(6));
    hand.cards.push(game.shoe.pop());
    const val=_hv(hand.cards);
    if(val>=21){const r=_advanceOrDealer(game,data,stats);save('user_balances.json',data);return res.json(r);}
    return res.json({ok:true,game:_serGame(game,false),balance:stats.balance});
  }
  if(action==='stand'){
    const r=_advanceOrDealer(game,data,stats);save('user_balances.json',data);return res.json(r);
  }
  if(action==='double'){
    if((stats.balance||0)<hand.bet)return res.status(400).json({error:'Saldo insufficiente per raddoppio'});
    stats.balance=(stats.balance||0)-hand.bet;
    stats.totalWagered=(stats.totalWagered||0)+hand.bet;
    hand.bet*=2;hand.doubled=true;
    if(game.shoe.length<60)game.shoe.push(..._shoe(6));
    hand.cards.push(game.shoe.pop());
    save('user_balances.json',data);
    const r=_advanceOrDealer(game,data,stats);save('user_balances.json',data);return res.json(r);
  }
  if(action==='split'){
    if(!_split(hand.cards)||game.playerHands.length>=4)return res.status(400).json({error:'Split non disponibile'});
    if((stats.balance||0)<hand.bet)return res.status(400).json({error:'Saldo insufficiente per split'});
    stats.balance=(stats.balance||0)-hand.bet;
    stats.totalWagered=(stats.totalWagered||0)+hand.bet;
    if(game.shoe.length<60)game.shoe.push(..._shoe(6));
    const newHand={cards:[hand.cards.pop(),game.shoe.pop()],bet:hand.bet,surrendered:false,doubled:false};
    hand.cards.push(game.shoe.pop());
    game.playerHands.splice(game.currentHandIndex+1,0,newHand);
    save('user_balances.json',data);
    return res.json({ok:true,game:_serGame(game,false),balance:stats.balance});
  }
  if(action==='surrender'){
    hand.surrendered=true;
    const r=_advanceOrDealer(game,data,stats);save('user_balances.json',data);return res.json(r);
  }
  return res.status(400).json({error:'Azione non valida'});
});

// ─────────────────────────────────────────────
//  Health check
// ─────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => console.log(`[API] Astro Exchange API running on port ${PORT}`));

module.exports = app;