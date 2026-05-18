require('./api');
const {
    Client, GatewayIntentBits, EmbedBuilder,
    ActionRowBuilder, StringSelectMenuBuilder,
    ButtonBuilder, ButtonStyle, ChannelType,
    PermissionFlagsBits, AttachmentBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    REST, Routes, SlashCommandBuilder
} = require('discord.js');

const fs = require("fs");
const path = require("path");
const https = require("https");
const axios = require('axios'); 
const discordTranscripts = require('discord-html-transcripts');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ================= PERSISTENT DATA DIRECTORY =================
const DATA_DIR = process.env.DATA_DIR || "./";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ================= CONFIGURATION =================
const CONFIG = {
    TOKEN: process.env.TOKEN || 'IL_TUO_TOKEN_QUI',
    PREFIX: ",",
    STAFF_ROLE_ID: "1425886820792537148",
    SLOT_OWNER_ROLE_ID: "1425886828837339228",
    TICKET_CATEGORY_ID: "1430879265984872519",
    LOG_CHANNEL_ID: "1430879290165301309",
    GLOBAL_LOG_CHANNEL_ID: "1494736441274536063",
    MY_LTC_ADDRESS: "LfKPg2Vuuu6aTYuWCXNcQG2pCDMreee8VE",
    OWNER_BTC_ADDRESS: "bc1qe0hqg6xrjly23xf9333636w2aaf3pqcd986k0g",
    OWNER_ETH_ADDRESS: "0xE690bf64c8bF00819182B0F4dbcAD43400E63884",
    OWNER_SOL_ADDRESS: "3wY6yDYqyyiU3Ae1eVLBGCQqKqheT947A9kN3C6PqXKZ",
    // NEW
    OWNER_ID: "1425584269794742382",
    VOUCH_CHANNEL_ID: "1430879275007086663",
    JOIN_LOG_CHANNEL_ID: "1430879269596303421",
    LEAVE_LOG_CHANNEL_ID: "1430879285786185759",
    SCAMMER_CHANNEL_ID: "1430879291880640603",
    LTC_LOOKUP_CHANNEL_ID: "1494437866057498836",
    PING_LOG_CHANNEL_ID: "1430879291087913075",
    ON_HOLD_ROLE_ID: "1425886825599471779",
    EXCHANGER_WALLET_LOG_CHANNEL_ID: "1430879287728148631",
    TRADE_LOG_CHANNEL_ID: "1498727663463043154",
    STAFF_EXCHANGE_ROLE_ID: "1425886824932573304",
    MANUAL_LTC_PRICE: 85.0, 
    SELLAUTH_API_KEY: "5715833|4BUnW4eIVsaHIkxU25owZ3KhfbZzuI7y9RGObglX0e3d7cfa",
    SHOP_ID: "160754",
    BASE_SHOP_URL: "https://easybst.mysellauth.com",
    BLOCKCYPHER_TOKEN: "2ff11db108af4737aba219f7ca1d9284", 
    SLOT_CATEGORIES: {
        "First": "1430879261543108732",
        "Second": "1430879262864445450",
        "Third": "1430879263707365376"
    },
    PRICES: { 
        "First_Weekly": 5, "First_Monthly": 15, "First_Lifetime": 40,
        "Second_Weekly": 3, "Second_Monthly": 9, "Second_Lifetime": 27,
        "Third_Weekly": 2, "Third_Monthly": 6, "Third_Lifetime": 18
    }
};

const PING_DEFAULTS = {
    "First_Weekly": { ev: 2, hr: 2 }, "First_Monthly": { ev: 2, hr: 3 }, "First_Lifetime": { ev: 3, hr: 3 },
    "Second_Weekly": { ev: 1, hr: 2 }, "Second_Monthly": { ev: 2, hr: 2 }, "Second_Lifetime": { ev: 3, hr: 3 },
    "Third_Weekly": { ev: 0, hr: 2 }, "Third_Monthly": { ev: 2, hr: 1 }, "Third_Lifetime": { ev: 3, hr: 3 }
};

const sellAuthAPI = axios.create({
    baseURL: `https://api.sellauth.com/v1/shops/${CONFIG.SHOP_ID}`,
    headers: { 'Authorization': `Bearer ${CONFIG.SELLAUTH_API_KEY}`, 'Content-Type': 'application/json' }
});

// ================= DATA MANAGEMENT =================
function load(p) {
    const full = path.join(DATA_DIR, p);
    if (!fs.existsSync(full)) { fs.writeFileSync(full, JSON.stringify({})); return {}; }
    try { return JSON.parse(fs.readFileSync(full)); } catch(e) { return {}; }
}
function save(p, d) { fs.writeFileSync(path.join(DATA_DIR, p), JSON.stringify(d, null, 2)); }

let ltcData = load("./ltc.json");
let globalConfig = load("./config.json");
let slots = load("./slots.json");
let pingConfig = load("./pings.json");
let pendingPayments = load("./pending_payments.json");
let liveStockConfig = load("./livestock.json");
let tempWallets = load("./temp_wallets.json");
let userTransactions = load("./user_transactions.json");
let mmSessions = load("./mm_sessions.json");
let ticketTypes = load("./ticket_types.json");
let exchangerWallets = load("./exchanger_wallets.json");
let escrowSessions = load("./escrow_sessions.json"); // threadId -> session data
let escrowTradeCount = load("./escrow_trade_count.json");
if (!escrowTradeCount.count) { escrowTradeCount.count = 0; save("./escrow_trade_count.json", escrowTradeCount); }
let exchangeRequests = load("./exchange_requests.json"); // messageId -> { userId, sendMethod, receiveMethod, ... }
let exchangeFees = load("./exchange_fees.json"); // fee configuration
// Initialize default fees if not set
if (!exchangeFees.paypalToCrypto) {
    exchangeFees = {
        paypalToCrypto: [
            { max: 10, fee: 0.5, type: "fixed" },
            { min: 10, max: 25, fee: 5, type: "percent" },
            { min: 25, max: 50, fee: 4.5, type: "percent" },
            { min: 50, fee: 4, type: "percent" }
        ],
        cryptoToCrypto: [
            { max: 25, fee: 5, type: "percent" },
            { min: 25, max: 50, fee: 3, type: "percent" },
            { min: 50, fee: 2, type: "percent" }
        ],
        cryptoToPaypal: [
            { fee: 0, type: "percent" }
        ]
    };
    save("./exchange_fees.json", exchangeFees);
}
let userBalances = load("./user_balances.json"); // userId -> { balance: EUR }
let activeGames = {}; // in-memory: userId -> { game, deck, playerHand, dealerHand, bet, ... }
let lastOrderCheck = Date.now();
let processedOrderIds = load("./processed_orders.json");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const sessions = new Map();
let cachedLtcPrice = CONFIG.MANUAL_LTC_PRICE; // EUR
let cachedLtcUsd = CONFIG.MANUAL_LTC_PRICE * 1.08;  // USD — updated by getLTC

// ================= HELPER CALCOLATRICE =================
function getCalcRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("calc_1").setLabel("1").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_2").setLabel("2").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_3").setLabel("3").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_back").setLabel("\u2AF8").setStyle(ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("calc_4").setLabel("4").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_5").setLabel("5").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_6").setLabel("6").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_clear").setLabel("C").setStyle(ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("calc_7").setLabel("7").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_8").setLabel("8").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_9").setLabel("9").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_dot").setLabel(".").setStyle(ButtonStyle.Primary)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("calc_0").setLabel("0").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("calc_confirm").setLabel("Conferma \u2705").setStyle(ButtonStyle.Success)
        )
    ];
}

// ================= BLOCKCYPHER API =================
async function generateLtcAddress() {
    try {
        const res = await axios.post(`https://api.blockcypher.com/v1/ltc/main/addrs?token=${CONFIG.BLOCKCYPHER_TOKEN}`);
        return {
            address: res.data.address,
            privateKey: res.data.private, 
            wif: res.data.wif
        };
    } catch (e) {
        console.error("Error generating BlockCypher wallet:", e.response ? e.response.data : e.message);
        return null;
    }
}

const litecore = require('litecore-lib');

async function transferLTC(fromAddress, toAddress) {
    try {
        const wallet = tempWallets[fromAddress];
        if (!wallet || !wallet.wif) return false;

        const privateKey = litecore.PrivateKey.fromWIF(wallet.wif);

        const utxoRes = await axios.get(
            `https://api.blockcypher.com/v1/ltc/main/addrs/${fromAddress}?unspentOnly=true&includeScript=true&token=${CONFIG.BLOCKCYPHER_TOKEN}`
        );

        let utxos = [];
        if (utxoRes.data.txrefs) utxos = utxos.concat(utxoRes.data.txrefs);
        if (utxoRes.data.unconfirmed_txrefs) utxos = utxos.concat(utxoRes.data.unconfirmed_txrefs);

        if (!utxos.length) return false;

        const inputs = utxos.map(u => ({
            txId: u.tx_hash,
            outputIndex: u.tx_output_n,
            address: fromAddress,
            script: u.script,
            satoshis: u.value
        }));

        const total = inputs.reduce((sum, i) => sum + i.satoshis, 0);
        const fee = 10000;
        const sendAmount = total - fee;

        if (sendAmount <= 0) return false;

        const tx = new litecore.Transaction()
            .from(inputs)
            .to(toAddress, sendAmount)
            .fee(fee)
            .sign(privateKey);

        const rawTx = tx.serialize();

        await axios.post(
            `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${CONFIG.BLOCKCYPHER_TOKEN}`,
            { tx: rawTx.toString() }
        );

        return true;
    } catch (e) {
        console.error("transferLTC error:", e.response?.data || e.message);
        return false;
    }
}

// ================= ESCROW IDENT EMBED UPDATER =================
async function updateIdentEmbed(int, session, threadId) {
    const thread = int.guild.channels.cache.get(threadId);
    if (!thread || !session.identMsgId) return;
    const cryptoLabels = { LTC:"LTC", SOL:"SOL", ETH:"ETH", BTC:"BTC", USDT_SOL:"USDT" };
    const crypto = cryptoLabels[session.crypto] || session.crypto;
    const senderName = session.senderId
        ? (await int.guild.members.fetch(session.senderId).catch(() => null))?.user.username || "none"
        : "none";
    const receiverName = session.receiverId
        ? (await int.guild.members.fetch(session.receiverId).catch(() => null))?.user.username || "none"
        : "none";
    const embed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setDescription(
            `\n# User Identification\n` +
            `Sender: Providing the ${crypto} to the bot\n` +
            `Receiver: Receiving the ${crypto} after the trade is completed\n\n` +
            `**Sender**\n\`${senderName}\`\n` +
            `**Receiver**\n\`${receiverName}\``
        );
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`escrow_role_sender_${threadId}`).setLabel("I am the Sender").setEmoji("📤").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`escrow_role_receiver_${threadId}`).setLabel("I am the Receiver").setEmoji("📥").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`escrow_reset_${threadId}`).setLabel("Reset").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`escrow_cancel_${threadId}`).setLabel("Cancel Trade").setStyle(ButtonStyle.Danger)
    );
    const identMsg = await thread.messages.fetch(session.identMsgId).catch(() => null);
    if (identMsg) await identMsg.edit({ embeds: [embed], components: [row1, row2] }).catch(() => {});
}

// ================= CASINO HELPER: ANSI CARD RENDERER =================
const BJ_SUITS = ['♠','♥','♦','♣'];
const BJ_RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function renderCard(card, faceDown = false) {
    const R = '[0m';
    if (faceDown) {
        const C = '[34;1m';
        return [`${C}╔═════╗${R}`,`${C}║░ ░ ░║${R}`,`${C}║░ ░ ░║${R}`,`${C}║░ ░ ░║${R}`,`${C}╚═════╝${R}`];
    }
    const isRed = card.suit === '♥' || card.suit === '♦';
    const C = isRed ? '[1;31;47m' : '[1;30;47m';
    const r = card.rank.length === 2 ? card.rank : card.rank + ' ';
    const rr = card.rank.length === 2 ? card.rank : ' ' + card.rank;
    return [
        `${C}╔═════╗${R}`,
        `${C}║${r}   ║${R}`,
        `${C}║  ${card.suit}  ║${R}`,
        `${C}║   ${rr}║${R}`,
        `${C}╚═════╝${R}`,
    ];
}

function renderHand(hand, hideFirst = false) {
    if (!hand || hand.length === 0) return '```ansi\n[37m(nessuna carta)[0m\n```';
    const cards = hand.map((card, i) => renderCard(card, i === 0 && hideFirst));
    const rows = Array.from({length: 5}, (_, row) => cards.map(c => c[row]).join('  '));
    return '```ansi\n' + rows.join('\n') + '\n```';
}

function buildCasinoMenu(userId) {
    const stats = userBalances[userId] || { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0 };
    const eur = (stats.balance || 0);
    const ltc = cachedLtcPrice > 0 ? (eur / cachedLtcPrice).toFixed(4) : '0.0000';
    const streak = stats.blackjackStreak || 0;
    const net = ((stats.totalWon || 0) - (stats.totalLost || 0));

    const desc = [
        '```ansi',
        '[33;1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━[0m',
        `[37;1m  Ł [33;1m${ltc} LTC[0m   [37;1m│[0m   [32;1m${eur.toFixed(2)} €[0m`,
        '[33;1m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━[0m',
        '',
        '[37;1m  GIOCHI DISPONIBILI[0m',
        '[32;1m  ♠ Blackjack         ✅ DISPONIBILE[0m',
        '[30;1m  🎲 Dice             🔒 Presto[0m',
        '[30;1m  💣 Mines            🔒 Presto[0m',
        '[30;1m  🎱 Keno             🔒 Presto[0m',
        '[30;1m  📈 Limbo            🔒 Presto[0m',
        '[30;1m  🔮 Plinko           🔒 Presto[0m',
        '',
        '[37;1m  LE TUE STATISTICHE[0m',
        `  Partite: [33m${stats.gamesPlayed || 0}[0m   Netto: [${net >= 0 ? '32' : '31'}m${net >= 0 ? '+' : ''}${net.toFixed(2)}€[0m${streak > 1 ? `   🔥 Streak: [33m${streak}[0m` : ''}`,
        '```',
    ].join('\n');

    const embed = new EmbedBuilder()
        .setColor(0x1a1a2e)
        .setTitle('🎰  ASTRO  CASINO')
        .setDescription(desc)
        .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png')
        .setFooter({ text: 'Astro Casino • Gioca responsabilmente' });

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('game_blackjack_start').setLabel('Blackjack').setEmoji('♠').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('casino_soon_dice').setLabel('Dice').setEmoji('🎲').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('casino_soon_mines').setLabel('Mines').setEmoji('💣').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('casino_soon_keno').setLabel('Keno').setEmoji('🎱').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('casino_soon_limbo').setLabel('Limbo').setEmoji('📈').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('casino_soon_plinko').setLabel('Plinko').setEmoji('🔮').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('game_recharge').setLabel('Ricarica').setEmoji('💰').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('game_release_funds').setLabel('Preleva').setEmoji('💸').setStyle(ButtonStyle.Secondary),
    );

    return { embed, components: [row1, row2] };
}

// ================= BLACKJACK GAME HELPERS (6-Deck Casino) =================
function createShoe(numDecks = 6) {
    const shoe = [];
    for (let d = 0; d < numDecks; d++)
        for (const suit of BJ_SUITS)
            for (const rank of BJ_RANKS)
                shoe.push({ rank, suit });
    for (let i = shoe.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
    }
    return shoe;
}
function bjCardValue(card) {
    if (card.rank === 'A') return 11;
    if (['J','Q','K'].includes(card.rank)) return 10;
    return parseInt(card.rank);
}
function bjHandValue(hand) {
    let value = 0, aces = 0;
    for (const card of hand) { value += bjCardValue(card); if (card.rank === 'A') aces++; }
    while (value > 21 && aces > 0) { value -= 10; aces--; }
    return value;
}
function isSoftHand(hand) {
    let value = 0, aces = 0;
    for (const c of hand) { value += bjCardValue(c); if (c.rank === 'A') aces++; }
    return aces > 0 && value <= 21;
}
function bjIsBlackjack(hand) { return hand.length === 2 && bjHandValue(hand) === 21; }
function bjCanSplit(hand) { return hand.length === 2 && bjCardValue(hand[0]) === bjCardValue(hand[1]); }
function handStatusBJ(hand) {
    const v = bjHandValue(hand);
    if (v > 21) return '💥 BUST';
    if (bjIsBlackjack(hand)) return '🃏 BLACKJACK!';
    if (v === 21) return '21 ✅';
    if (isSoftHand(hand)) return `Soft ${v}`;
    return `${v}`;
}
function dealerShouldHit(hand) { return bjHandValue(hand) < 17; }
async function playDealerHandBJ(game) {
    while (dealerShouldHit(game.dealerHand)) {
        if (game.shoe.length < 60) game.shoe.push(...createShoe(6));
        game.dealerHand.push(game.shoe.pop());
    }
}
function buildBJEmbed(game, userId, phase = 'playing') {
    const stats = userBalances[userId] || { balance: 0 };
    const eur = stats.balance || 0;
    const ltc = cachedLtcPrice > 0 ? (eur / cachedLtcPrice).toFixed(4) : '0.0000';
    let color = 0x1a5c36;
    if (phase === 'result') {
        const results = getBJResults(game);
        const profit = results.reduce((s, r) => s + r.profit, 0);
        color = profit > 0 ? 0x4ade80 : profit < 0 ? 0xf87171 : 0xfacc15;
    }

    const dealerStatus = phase === 'result' ? handStatusBJ(game.dealerHand) : '?';
    const dealerCardsAnsi = phase === 'result'
        ? renderHand(game.dealerHand, false)
        : renderHand(game.dealerHand, true);

    let desc = '';

    // Header bar with balance
    desc += '```ansi\n';
    desc += `[33;1m♠ ASTRO CASINO — BLACKJACK ♥[0m\n`;
    desc += `[37;1mSaldo: Ł ${ltc}  │  ${eur.toFixed(2)} €[0m`;
    if ((stats.blackjackStreak || 0) > 1) desc += `   [33;1m🔥 Streak x${stats.blackjackStreak}[0m`;
    desc += '\n```\n';

    desc += `**🏦 DEALER** — \`${dealerStatus}\`\n${dealerCardsAnsi}\n`;

    for (let i = 0; i < game.playerHands.length; i++) {
        const hand = game.playerHands[i];
        const isCurrent = i === game.currentHandIndex && phase === 'playing';
        let label = game.playerHands.length > 1 ? `MANO ${i+1}` : 'LA TUA MANO';
        if (isCurrent) label = `▶ ${label}`;
        if (hand.surrendered) label += ' *(resa)*';
        if (hand.doubled) label += ' *(raddoppio)*';
        const val = handStatusBJ(hand.cards);
        desc += `**🎴 ${label}** — \`${val}\`  💰 \`${hand.bet}€\`\n${renderHand(hand.cards)}\n`;
    }

    if (phase === 'result') {
        const results = getBJResults(game);
        desc += '```ansi\n[37;1m  RISULTATO[0m\n';
        for (const r of results) {
            const col = r.profit > 0 ? '[32;1m' : r.profit < 0 ? '[31;1m' : '[33;1m';
            desc += `  ${r.icon}  ${col}${r.label}   ${r.profit > 0 ? '+' : ''}${r.profit}€[0m\n`;
        }
        desc += '```\n';
    }

    if (game.insuranceBet > 0) desc += `🛡️ Assicurazione: \`${game.insuranceBet}€\`\n`;

    return new EmbedBuilder()
        .setColor(color)
        .setTitle('♠♥ Blackjack — Astro Casino ♦♣')
        .setDescription(desc)
        .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png')
        .setFooter({ text: 'Astro Casino • 6 Mazzi • Dealer fermo su 17 • BJ paga 3:2' });
}

function buildDealingEmbed(userId, step, game) {
    const stats = userBalances[userId] || { balance: 0 };
    const eur = stats.balance || 0;
    const ltc = cachedLtcPrice > 0 ? (eur / cachedLtcPrice).toFixed(4) : '0.0000';

    let desc = '```ansi\n';
    desc += `[33;1m♠ ASTRO CASINO — BLACKJACK ♥[0m\n`;
    desc += `[37;1mSaldo: Ł ${ltc}  │  ${eur.toFixed(2)} €[0m\n\`\`\`\n`;

    if (step === 0) {
        desc += '**🏦 DEALER**\n' + renderHand([]) + '\n';
        desc += '**🎴 LA TUA MANO**\n' + renderHand([]) + '\n';
        desc += '*Distribuzione in corso...*';
    } else if (step === 1) {
        desc += '**🏦 DEALER**\n' + renderHand([game.dealerHand[0]], true) + '\n';
        desc += '**🎴 LA TUA MANO**\n' + renderHand([game.playerHands[0].cards[0]]) + '\n';
        desc += '*Distribuzione...*';
    } else if (step === 2) {
        desc += '**🏦 DEALER**\n' + renderHand(game.dealerHand, true) + '\n';
        desc += '**🎴 LA TUA MANO**\n' + renderHand(game.playerHands[0].cards) + '\n';
    }

    return new EmbedBuilder().setColor(0x1a5c36).setTitle('♠♥ Blackjack — Astro Casino ♦♣').setDescription(desc)
        .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png')
        .setFooter({ text: 'Astro Casino • 6 Mazzi • Dealer fermo su 17 • BJ paga 3:2' });
}

function getBJResults(game) {
    const results = [];
    const dealerVal = bjHandValue(game.dealerHand);
    const dealerBJ = bjIsBlackjack(game.dealerHand);
    for (let i = 0; i < game.playerHands.length; i++) {
        const hand = game.playerHands[i];
        const label = game.playerHands.length > 1 ? `Mano ${i+1}` : 'Risultato';
        const playerVal = bjHandValue(hand.cards);
        const playerBJ = bjIsBlackjack(hand.cards);
        if (hand.surrendered) { results.push({ label: `${label}: Resa`, profit: -Math.floor(hand.bet/2), icon: '🏳️' }); continue; }
        if (playerVal > 21) results.push({ label: `${label}: Bust`, profit: -hand.bet, icon: '💥' });
        else if (playerBJ && !dealerBJ) results.push({ label: `${label}: Blackjack! (3:2)`, profit: Math.floor(hand.bet*1.5), icon: '🃏' });
        else if (playerBJ && dealerBJ) results.push({ label: `${label}: Pareggio (entrambi BJ)`, profit: 0, icon: '🤝' });
        else if (dealerBJ) results.push({ label: `${label}: Blackjack dealer`, profit: -hand.bet, icon: '😞' });
        else if (dealerVal > 21) results.push({ label: `${label}: Bust dealer!`, profit: hand.bet, icon: '🎉' });
        else if (playerVal > dealerVal) results.push({ label: `${label}: Vinci!`, profit: hand.bet, icon: '✅' });
        else if (playerVal < dealerVal) results.push({ label: `${label}: Perdi`, profit: -hand.bet, icon: '❌' });
        else results.push({ label: `${label}: Pareggio`, profit: 0, icon: '🤝' });
    }
    if (game.insuranceBet > 0) {
        if (dealerBJ) results.push({ label: 'Assicurazione Win! (2:1)', profit: game.insuranceBet * 2, icon: '🛡️' });
        else results.push({ label: 'Assicurazione Persa', profit: -game.insuranceBet, icon: '🛡️' });
    }
    return results;
}
function applyBJResults(game, userId) {
    if (!userBalances[userId]) userBalances[userId] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0, blackjackStreak: 0, biggestWin: 0 };
    const stats = userBalances[userId];
    const results = getBJResults(game);
    let totalProfit = 0;
    for (const r of results) {
        totalProfit += r.profit;
        if (r.profit > 0) stats.totalWon = (stats.totalWon||0) + r.profit;
        else if (r.profit < 0) stats.totalLost = (stats.totalLost||0) + Math.abs(r.profit);
    }
    stats.balance = (stats.balance||0) + totalProfit;
    stats.gamesPlayed = (stats.gamesPlayed||0) + 1;
    if (totalProfit > 0) {
        stats.blackjackStreak = (stats.blackjackStreak||0) + 1;
        if (totalProfit > (stats.biggestWin||0)) stats.biggestWin = totalProfit;
    } else if (totalProfit < 0) { stats.blackjackStreak = 0; }
    save('./user_balances.json', userBalances);
    return totalProfit;
}
function getBJActionButtons(game) {
    const hand = game.playerHands[game.currentHandIndex];
    const stats = userBalances[game.userId] || { balance: 0 };
    const canDouble = hand.cards.length === 2 && stats.balance >= hand.bet;
    const canSplitNow = bjCanSplit(hand.cards) && game.playerHands.length < 4 && stats.balance >= hand.bet;
    const canSurrender = hand.cards.length === 2 && game.playerHands.length === 1 && !game.playerHands[0].doubled;
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bj_hit').setLabel('Hit').setEmoji('🎯').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('bj_stand').setLabel('Stand').setEmoji('✋').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('bj_double').setLabel('Double').setEmoji('⬆️').setStyle(ButtonStyle.Secondary).setDisabled(!canDouble),
    );
    const extra = [];
    if (canSplitNow) extra.push(new ButtonBuilder().setCustomId('bj_split').setLabel('Split').setEmoji('✂️').setStyle(ButtonStyle.Secondary));
    if (canSurrender) extra.push(new ButtonBuilder().setCustomId('bj_surrender').setLabel('Resa').setEmoji('🏳️').setStyle(ButtonStyle.Danger));
    extra.push(new ButtonBuilder().setCustomId('game_back_menu').setLabel('Menu').setStyle(ButtonStyle.Secondary));
    if (extra.length > 0) return [row1, new ActionRowBuilder().addComponents(...extra)];
    return [row1];
}
async function bjAdvanceOrDealer(game, int) {
    game.currentHandIndex++;
    if (game.currentHandIndex < game.playerHands.length) {
        return int.editReply({ embeds: [buildBJEmbed(game, game.userId, 'playing')], components: getBJActionButtons(game) });
    }
    // Dealer plays — show "dealer drawing" animation
    const dealerDrawEmbed = new EmbedBuilder().setColor(0x1a5c36).setTitle('♠♥ Blackjack — Astro Casino ♦♣')
        .setDescription('```ansi\n[33;1m♠ Il dealer pesca...[0m\n```')
        .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png');
    await int.editReply({ embeds: [dealerDrawEmbed], components: [] });
    await new Promise(r => setTimeout(r, 900));

    await playDealerHandBJ(game);
    game.phase = 'result';
    applyBJResults(game, game.userId);
    delete activeGames[game.userId];
    const embed = buildBJEmbed(game, game.userId, 'result');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('bj_new_game').setLabel('Gioca ancora').setEmoji('🔄').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('game_back_menu').setLabel('Casino').setEmoji('🎰').setStyle(ButtonStyle.Secondary)
    );
    return int.editReply({ embeds: [embed], components: [row] });
}

// ================= SEND LTC HELPER (with change address) =================
// sendAll=false: send exact amountSatoshis, change goes back to fromAddress
// sendAll=true:  send everything minus fee to toAddress
async function sendLTC(wif, fromAddress, toAddress, amountSatoshis, sendAll = false) {
    const FEE = 10000; // 0.0001 LTC in satoshis — safe network fee
    const privateKey = litecore.PrivateKey.fromWIF(wif);

    const utxoRes = await axios.get(
        `https://api.blockcypher.com/v1/ltc/main/addrs/${fromAddress}?unspentOnly=true&includeScript=true&token=${CONFIG.BLOCKCYPHER_TOKEN}`
    );
    let utxos = [];
    if (utxoRes.data.txrefs) utxos = utxos.concat(utxoRes.data.txrefs);
    if (utxoRes.data.unconfirmed_txrefs) utxos = utxos.concat(utxoRes.data.unconfirmed_txrefs);
    if (!utxos.length) throw new Error("No UTXOs available (balance is 0 or unconfirmed).");

    const inputs = utxos.map(u => ({
        txId: u.tx_hash,
        outputIndex: u.tx_output_n,
        address: fromAddress,
        script: u.script,
        satoshis: u.value
    }));
    const totalSatoshis = inputs.reduce((s, i) => s + i.satoshis, 0);

    let tx;
    if (sendAll) {
        // Send everything minus fee
        const sendAmount = totalSatoshis - FEE;
        if (sendAmount <= 0) throw new Error(`Balance too low to cover fee. Available: ${totalSatoshis} satoshis.`);
        tx = new litecore.Transaction()
            .from(inputs)
            .to(toAddress, sendAmount)
            .fee(FEE)
            .sign(privateKey);
    } else {
        // Send exact amount, change back to sender
        if (amountSatoshis + FEE > totalSatoshis) {
            throw new Error(`Insufficient balance. Available: \`${(totalSatoshis/100000000).toFixed(8)} LTC\``);
        }
        tx = new litecore.Transaction()
            .from(inputs)
            .to(toAddress, amountSatoshis)
            .change(fromAddress)   // ← THIS is what was missing — change goes back to sender
            .fee(FEE)
            .sign(privateKey);
    }

    const pushRes = await axios.post(
        `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${CONFIG.BLOCKCYPHER_TOKEN}`,
        { tx: tx.serialize().toString() }
    );
    const txHash = pushRes.data?.tx?.hash || pushRes.data?.hash || "unknown";
    const sentAmount = sendAll ? (totalSatoshis - FEE) : amountSatoshis;
    return { txHash, sentSatoshis: sentAmount, feeSatoshis: FEE };
}

// ================= TRADE LOG EMBED =================
async function sendTradeEmbed(guild, senderUserId, receiverUserId, amountLtc, txHash) {
    const tradeCh = guild.channels.cache.get(CONFIG.TRADE_LOG_CHANNEL_ID);
    if (!tradeCh) return;

    const amountUsd = (amountLtc * cachedLtcUsd).toFixed(2);
    const txUrl = `https://live.blockcypher.com/ltc/tx/${txHash}/`;

    const embed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setDescription(
            `\n**<:ltc:1497994881262682173> Litecoin trade completed**\n\n` +
            `**Sender**\n<@${senderUserId}>\n` +
            `**Receiver**\n<@${receiverUserId}>\n` +
            `**Amount**\n\`$${amountUsd}\`\n` +
            `**Transaction ID**\n[${txHash}](${txUrl})`
        )
        .setTimestamp();

    await tradeCh.send({ embeds: [embed] }).catch(() => {});
}

// ================= NOTIFY ALL STAFF IN DM =================
async function notifyStaffPayment(guild, channelId, userId, amountLtc, ticketType) {
    const staffMembers = guild.members.cache.filter(m => m.roles.cache.has(CONFIG.STAFF_ROLE_ID) && !m.user.bot);
    const notifEmbed = new EmbedBuilder()
        .setColor("#00FF00")
        .setTitle("\uD83D\uDCB0 Payment Received!")
        .setDescription(
            `<@${userId}> just completed their payment in <#${channelId}>.\n\n` +
            `**Amount:** \`${amountLtc} LTC\`\n` +
            `**Ticket Type:** \`${ticketType}\`\n\n` +
            `Please head to the ticket to proceed.`
        )
        .setTimestamp();
    for (const [, member] of staffMembers) {
        await member.send({ embeds: [notifEmbed] }).catch(() => {});
    }
}

// ================= NEW: SEND RECORDING EMBED =================
async function sendRecordingEmbed(channel, payerId, ticketType) {
    const recordEmbed = new EmbedBuilder()
        .setColor("#FFA500")
        .setTitle("\uD83C\uDFA5 Record the Entire Process")
        .setDescription(
            `<@${payerId}>, your payment has been confirmed!\n\n` +
            `**You must record the full process:**\n` +
            `\u2022 Before receiving the product\n` +
            `\u2022 Until you confirm/collect it\n\n` +
            `Once you have verified and received the product, press **Confirm Receipt** below.\n` +
            `\u26A0\uFE0F Not recording may result in no support in case of issues.`
        )
        .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`confirm_delivery_${channel.id}_${payerId}_${ticketType}`)
            .setLabel("\u2705 Confirm Receipt")
            .setStyle(ButtonStyle.Success)
    );
    await channel.send({ content: `<@${payerId}>`, embeds: [recordEmbed], components: [row] });
}

// ================= SELLAUTH LOGIC =================

async function checkNewSales() {
    try {
        // Fetch invoices \u2014 real structure: { current_page, total, data: [...] }
        const res = await sellAuthAPI.get("/invoices");
        const raw = res.data;
        let orders = [];
        if (raw && Array.isArray(raw.data)) orders = raw.data;
        else if (Array.isArray(raw)) orders = raw;
        if (!orders.length) return;

        // Total number of ALL orders ever (from pagination metadata)
        const totalOrderCount = raw.total || raw.total_count || raw.count || orders.length;

        // First boot: mark all existing as processed to avoid spamming old orders
        const isFirstBoot = Object.keys(processedOrderIds).length === 0;
        if (isFirstBoot) {
            for (const order of orders) {
                processedOrderIdsString([order.id)] = true;
            }
            save("./processed_orders.json", processedOrderIds);
            console.log("[SellAuth] First boot: marked " + orders.length + " existing invoices as processed.");
            return;
        }

        for (const order of orders) {
            const oid = String(order.id);
            if (processedOrderIds[oid]) continue;
            if (order.status !== "completed") continue;

            processedOrderIds[oid] = true;
            save("./processed_orders.json", processedOrderIds);

            const globalLogCh = client.channels.cache.get(CONFIG.GLOBAL_LOG_CHANNEL_ID);
            if (!globalLogCh) { console.error("[SellAuth] Log channel not found"); continue; }

            // Email: mask as [t****r@gmail.com](mailto:t****r@gmail.com)
            const email = order.email || "[unknown@unknown.com](mailto:unknown@unknown.com)";
            let maskedEmail = email;
            const atIdx = email.indexOf("@");
            if (atIdx > 2) maskedEmail = email[0] + "****" + email[atIdx - 1] + email.slice(atIdx);
            else if (atIdx > 0) maskedEmail = email[0] + "****" + email.slice(atIdx);

            // Product info from items[0].product
            const item = order.items && order.items[0] ? order.items[0] : null;
            const productName = (item && item.product && item.product.name)
                ? item.product.name : "Unknown Product";
            const productSlug = (item && item.product && item.product.slug)
                ? item.product.slug : "";
            const productUrl = productSlug
                ? CONFIG.BASE_SHOP_URL + "/product/" + productSlug
                : CONFIG.BASE_SHOP_URL;

            // Quantity from items[0].quantity
            const quantity = (item && item.quantity) ? item.quantity : 1;

            // Price
            const price = parseFloat(order.price || 0).toFixed(2);
            const currency = (order.currency || "EUR").toUpperCase();

            // Gateway: plain string "LTC" or "PayPal", or object in payment_method.name
            const gatewayStr = (
                typeof order.gateway === "string" ? order.gateway :
                (order.payment_method && order.payment_method.name) ? order.payment_method.name : ""
            ).toLowerCase();
            const isPaypal = gatewayStr.includes("paypal");
            const methodEmoji = isPaypal ? "<:paypal:1430879297362464848>" : "<:ltc:1430879299652812872>";
            const methodLabel = isPaypal ? "PayPal" : "LTC";

            // Build embed
            const orderEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("ORDER COMPLETED #" + totalOrderCount)
                .setDescription("[**" + productName + "**](" + productUrl + ")")
                .addFields(
                    {
                        name: "<:box:1496249522353995948>  | Quantity",
                        value: "`" + quantity + "`",
                        inline: true
                    },
                    {
                        name: "<:mon:1496249604415684730> | Total Price:",
                        value: "`" + price + " " + currency + "`",
                        inline: true
                    },
                    {
                        name: methodEmoji + "  | Method:",
                        value: "`" + methodLabel + "`",
                        inline: true
                    },
                    {
                        name: "<:Whitebear:1430879306254647349>  | User Info:",
                        value: "`" + maskedEmail + "`",
                        inline: false
                    }
                )
                .setTimestamp();

            await globalLogCh.send({ embeds: [orderEmbed] }).catch(e => console.error("[SellAuth] Send error:", e.message));

            // Save to user transactions
            if (!userTransactions[email]) userTransactions[email] = [];
            userTransactions[email].push({
                type: "SellAuth",
                amount: price + " " + currency,
                detail: productName,
                date: Date.now()
            });
            save("./user_transactions.json", userTransactions);
            console.log("[SellAuth] Order #" + totalOrderCount + " sent \u2014 " + productName);
        }

        lastOrderCheck = Date.now();
    } catch (e) {
        console.error("[SellAuth] checkNewSales error:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}
async function updateLiveStock() {
    if (!liveStockConfig.channelId) return;
    const channel = client.channels.cache.get(liveStockConfig.channelId);
    if (!channel) return;

    try {
        const res = await sellAuthAPI.get("/products");
        const raw = res.data;
        const products = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);

        if (!products.length) {
            console.log("[LiveStock] No products returned from API.");
            return;
        }

        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("LIVESTOCK")
            .setFooter({ text: "Astro Exchange • Updates every 15 seconds" })
            .setTimestamp();

        // Build description as product list (embed description supports markdown links)
        let desc = "";
        for (const p of products) {
            let totalStock = 0;
            if (p.variants && p.variants.length > 0) {
                p.variants.forEach(v => { totalStock += (v.stock || 0); });
            } else {
                totalStock = p.stock || 0;
            }

            const displayPrice = (p.price !== null && p.price !== undefined)
                ? p.price
                : (p.variants && p.variants[0] ? p.variants[0].price : "0.00");

            const slug = p.slug || "";
            const directLink = slug
                ? `${CONFIG.BASE_SHOP_URL}/product/${slug}`
                : `${CONFIG.BASE_SHOP_URL}`;

            const isNitro = p.name && p.name.toLowerCase().includes("nitro");
            const isBoost = p.name && p.name.toLowerCase().includes("boost");
            const prefix = isNitro ? "<a:nb:1496551004500529304> " : isBoost ? "<a:srvbost:1497239285605204049> " : "";

            desc +=
                `${prefix}**${[p.name}**](${directLink})\n` +
                `> <:box:1496249522353995948> : \`${totalStock}\`\n` +
                `> <:mon:1496249604415684730> : \`${displayPrice} EUR\`\n` +
                `>  : \`Instant Delivery\`\n\n`;
        }

        // Embed description max 4096 chars
        if (desc.length > 4096) desc = desc.slice(0, 4093) + "...";
        embed.setDescription(desc);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Visit Shop")
                .setURL(`${CONFIG.BASE_SHOP_URL}/#products`)
                .setStyle(ButtonStyle.Link)
        );

        if (liveStockConfig.lastMsgId) {
            const existingMsg = await channel.messages.fetch(liveStockConfig.lastMsgId).catch(() => null);
            if (existingMsg) {
                // If the existing message has no embeds (old text message), delete it and send fresh
                if (!existingMsg.embeds || existingMsg.embeds.length === 0) {
                    await existingMsg.delete().catch(() => {});
                    liveStockConfig.lastMsgId = null;
                } else {
                    await existingMsg.edit({ content: "", embeds: [embed], components: [row] }).catch(() => {});
                    return;
                }
            } else {
                liveStockConfig.lastMsgId = null;
            }
        }

        const sent = await channel.send({ embeds: [embed], components: [row] });
        liveStockConfig.lastMsgId = sent.id;
        save("./livestock.json", liveStockConfig);
        console.log("[LiveStock] Embed sent:", sent.id);
    } catch (e) {
        console.error("Error updating livestock:", e.message, e.stack?.split("\n")[1] || "");
    }
}

// ================= CRYPTO API & AUTO UPDATE =================

async function getLTC() {
    // Try multiple sources in order — first success wins
    const sources = [
        // 1. CoinGecko (EUR)
        async () => {
            const res = await fetch(
                "https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur",
                { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
            );
            if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
            const d = await res.json();
            const val = d?.litecoin?.eur;
            if (!val || val <= 0) throw new Error("CoinGecko invalid value");
            return val;
        },
        // 2. Binance (LTCEUR)
        async () => {
            const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=LTCEUR");
            if (!res.ok) throw new Error(`Binance ${res.status}`);
            const d = await res.json();
            const val = parseFloat(d?.price);
            if (!val || val <= 0) throw new Error("Binance invalid value");
            return val;
        },
        // 3. Kraken (LTCEUR)
        async () => {
            const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=LTCEUR");
            if (!res.ok) throw new Error(`Kraken ${res.status}`);
            const d = await res.json();
            const val = parseFloat(Object.values(d?.result || {})[0]?.c?.[0]);
            if (!val || val <= 0) throw new Error("Kraken invalid value");
            return val;
        }
    ];

    for (const source of sources) {
        try {
            const val = await source();
            cachedLtcPrice = val;
            // Also fetch USD price
            try {
                const usdRes = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT");
                const usdData = await usdRes.json();
                const usdVal = parseFloat(usdData?.price);
                if (usdVal > 0) cachedLtcUsd = usdVal;
            } catch(e) { cachedLtcUsd = val * 1.08; } // fallback
            console.log(`[LTC] Price updated: ${val.toFixed(2)} EUR / $${cachedLtcUsd.toFixed(2)} USD`);
            return val;
        } catch(e) {
            console.error(`[LTC] Source failed: ${e.message}`);
        }
    }

    // All failed — keep existing cached price
    console.error(`[LTC] All sources failed, keeping cached: ${cachedLtcPrice} EUR`);
    return cachedLtcPrice;
}

async function checkPayments(specificUserId = null) {
    const targets = specificUserId ? { [specificUserId]: pendingPayments[specificUserId] } : pendingPayments;
    for (const [userId, payData] of Object.entries(targets)) {
        if (!payData) continue;
        if (payData.completed) continue;
        try {
            const balUrl = `https://api.blockcypher.com/v1/ltc/main/addrs/${payData.address}/balance?token=${CONFIG.BLOCKCYPHER_TOKEN}`;
            const balRes = await fetch(balUrl);
            const data = await balRes.json();
            const confirmedBalance = data.total_received / 100000000;

            if (tempWallets[payData.address]) {
                tempWallets[payData.address].balance = confirmedBalance;
                save("./temp_wallets.json", tempWallets);
            }

            if (confirmedBalance >= payData.amountLtc) {
                payData.completed = true;
                save("./pending_payments.json", pendingPayments);

                const success = await transferLTC(
                    payData.address,
                    CONFIG.MY_LTC_ADDRESS
                );
                
                if (success) {
                    delete tempWallets[payData.address];
                    save("./temp_wallets.json", tempWallets);
                }

                if (!userTransactions[userId]) userTransactions[userId] = [];
                userTransactions[userId].push({ type: "Slot Purchase", amount: `${payData.amountLtc} LTC`, detail: `${payData.category} - ${payData.duration}`, date: Date.now() });
                save("./user_transactions.json", userTransactions);

                const guild = client.guilds.cache.first();
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    if (!Object.values(slots).some(s => s.ownerId === member.id)) {
                        await createSlot(member, payData.category, payData.duration, payData.ovEv, payData.ovHr);
                    }
                    const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
                    if (logCh) logCh.send(`\u2705 Payment confirmed for <@${userId}>. Slot ${payData.category} created.`);
                    // NEW: notify staff + recording embed
                    if (payData.ticketChannelId) {
                        await notifyStaffPayment(guild, payData.ticketChannelId, userId, payData.amountLtc, "slot");
                        const ticketCh = guild.channels.cache.get(payData.ticketChannelId);
                        if (ticketCh) await sendRecordingEmbed(ticketCh, userId, "slot");
                    }
                }
                
                delete pendingPayments[userId];
                save("./pending_payments.json", pendingPayments);
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// ================= MM PAYMENT CHECK =================
async function checkMMPayments() {
    for (const [sessionId, mmData] of Object.entries(mmSessions)) {
        if (!mmData || mmData.status !== 'awaiting_payment') continue;
        try {
            const balUrl = `https://api.blockcypher.com/v1/ltc/main/addrs/${mmData.escrowAddress}/balance?token=${CONFIG.BLOCKCYPHER_TOKEN}`;
            const balRes = await fetch(balUrl);
            const data = await balRes.json();
            const confirmedBalance = data.total_received / 100000000;

            if (confirmedBalance >= mmData.totalAmountLtc) {
                mmData.status = 'payment_confirmed';
                save("./mm_sessions.json", mmSessions);

                const guild = client.guilds.cache.first();
                const channel = guild.channels.cache.get(mmData.channelId);
                if (channel) {
                    const confirmEmbed = new EmbedBuilder()
                        .setColor("#00FF00")
                        .setTitle("\u2705 Payment Confirmed - Auto MM")
                        .setDescription(`Payment of \`${mmData.totalAmountLtc} LTC\` received!\n\n**Seller** (<@${mmData.sellerId}>): send the product to the buyer now.\n**Buyer** (<@${mmData.buyerId}>): confirm reception once received.`)
                        .addFields(
                            { name: "Product", value: mmData.productDescription, inline: true },
                            { name: "Total Amount", value: `${mmData.totalAmountLtc} LTC`, inline: true }
                        );
                    
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`mm_confirm_received_${sessionId}`).setLabel("\u2705 Ho Ricevuto il Product").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`mm_report_issue_${sessionId}`).setLabel("\u26A0\uFE0F Report Issue").setStyle(ButtonStyle.Danger)
                    );

                    await channel.send({ 
                        content: `<@${mmData.buyerId}> <@${mmData.sellerId}>`, 
                        embeds: [confirmEmbed], 
                        components: [row] 
                    });
                }
            }
        } catch (e) { }
    }
}

setInterval(updateLiveStock, 15000);
setInterval(checkNewSales, 30000);
setInterval(async () => {
    await getLTC();
    await checkPayments();
    await checkMMPayments();
}, 60000);

// ================= LTC PRICE CHANNEL UPDATER =================
const LTC_PRICE_CHANNEL_ID = "1499082218545615121";
let ltcPriceOneHourAgo = null;

async function updateLtcPriceChannel() {
    try {
        await getLTC(); // refresh price
        const guild = client.guilds.cache.first();
        if (!guild) return;
        const ch = guild.channels.cache.get(LTC_PRICE_CHANNEL_ID);
        if (!ch) return;

        const price = cachedLtcPrice;

        // Track price from 1 hour ago for % change
        if (ltcPriceOneHourAgo === null) ltcPriceOneHourAgo = price;
        const pctChange = ((price - ltcPriceOneHourAgo) / ltcPriceOneHourAgo * 100).toFixed(1);
        const pctStr = parseFloat(pctChange) >= 0 ? `+${pctChange}%` : `${pctChange}%`;

        const priceStr = price.toFixed(2);
        const newName = `LTC-${priceStr}€•${pctStr}`;

        await ch.setName(newName).catch(e => console.error("[LTC Price] setName error:", e.message));
        console.log(`[LTC Price] Updated: ${newName}`);
    } catch(e) {
        console.error("[LTC Price Channel] Error:", e.message);
    }
}

// Update price reference every hour
setInterval(() => { ltcPriceOneHourAgo = cachedLtcPrice; }, 3600000);

// Resilient loop — never stops even after Discord rate limits
function startLtcPriceLoop() {
    updateLtcPriceChannel().catch(() => {});
    setTimeout(startLtcPriceLoop, 30000);
}

client.once("ready", async () => {
    await getLTC();
    startLtcPriceLoop();
    console.log(`Bot online: ${client.user?.tag}`);

    // ===== MIDNIGHT PING RESET (Italian time = UTC+2 in summer, UTC+1 in winter) =====
    function scheduleMidnightReset() {
        const now = new Date();
        // Get current time in Italy (Europe/Rome)
        const italyOffset = (() => {
            // DST: last Sunday of March to last Sunday of October = UTC+2, otherwise UTC+1
            const month = now.getUTCMonth() + 1;
            const day = now.getUTCDate();
            const dow = now.getUTCDay();
            // Approximate DST check
            if (month > 3 && month < 10) return 2;
            if (month === 3 && day >= 25 && dow === 0) return 2;
            if (month === 10 && day < 25) return 2;
            if (month === 10 && day >= 25 && dow > 0) return 2;
            return 1;
        })();

        const italyNow = new Date(now.getTime() + italyOffset * 3600 * 1000);
        // Next midnight Italy time
        const nextMidnight = new Date(italyNow);
        nextMidnight.setUTCHours(24 - italyOffset, 0, 0, 0); // midnight Italy = (24-offset):00 UTC

        const msUntilMidnight = nextMidnight.getTime() - now.getTime();

        setTimeout(async () => {
            try {
                const guild = client.guilds.cache.first();
                if (!guild) return;

                // Reset ALL slot owner pings
                for (const [channelId, slotData] of Object.entries(slots)) {
                    const priceKey = `${slotData.category}_${slotData.duration}`;
                    const defaultPings = PING_DEFAULTS[priceKey] || { ev: 0, hr: 0 };
                    const configPings = pingConfig[slotData.category]?.[slotData.duration] || { everyone: 0, here: 0 };
                    slots[channelId].pingsLeft = {
                        everyone: defaultPings.ev || configPings.everyone || 0,
                        here: defaultPings.hr || configPings.here || 0
                    };
                }
                save("./slots.json", slots);

                // Send message in ping log channel
                const pingLogCh = guild.channels.cache.get(CONFIG.PING_LOG_CHANNEL_ID);
                if (pingLogCh) {
                    await pingLogCh.send(`<@&${CONFIG.SLOT_OWNER_ROLE_ID}> All pings have been reset!`);
                }

                console.log("[Midnight] Slot pings reset for all owners.");
            } catch (e) {
                console.error("[Midnight] Error resetting pings:", e.message);
            }

            // Schedule next day
            scheduleMidnightReset();
        }, msUntilMidnight);

        const h = Math.floor(msUntilMidnight / 3600000);
        const m = Math.floor((msUntilMidnight % 3600000) / 60000);
        console.log(`[Midnight] Next ping reset in ${h}h ${m}m`);
    }

    scheduleMidnightReset();

    // ================= SLASH COMMAND REGISTRATION =================
    const slashCommands = [
        new SlashCommandBuilder().setName("help").setDescription("Show user commands"),
        new SlashCommandBuilder().setName("ltc").setDescription("Convert EUR to LTC and show your address")
            .addNumberOption(o => o.setName("amount").setDescription("Amount in EUR").setRequired(true)),
        new SlashCommandBuilder().setName("setltc").setDescription("Save your LTC address")
            .addStringOption(o => o.setName("address").setDescription("Your LTC address").setRequired(true)),
        new SlashCommandBuilder().setName("helpstaff").setDescription("Show all staff commands"),
        new SlashCommandBuilder().setName("slot").setDescription("Create a slot for a user")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
            .addStringOption(o => o.setName("duration").setDescription("Duration").setRequired(true).addChoices({ name:"Weekly",value:"W"},{ name:"Monthly",value:"M"},{ name:"Lifetime",value:"L"}))
            .addStringOption(o => o.setName("category").setDescription("Category").setRequired(true).addChoices({ name:"First",value:"1"},{ name:"Second",value:"2"},{ name:"Third",value:"3"}))
            .addStringOption(o => o.setName("method").setDescription("Method").setRequired(true).addChoices({ name:"LTC",value:"LTC"},{ name:"Manual",value:"MANUAL"}))
            .addNumberOption(o => o.setName("price").setDescription("Custom price EUR").setRequired(false))
            .addIntegerOption(o => o.setName("everyone").setDescription("@everyone pings").setRequired(false))
            .addIntegerOption(o => o.setName("here").setDescription("@here pings").setRequired(false)),
        new SlashCommandBuilder().setName("cslot").setDescription("Manually create a slot without payment")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
            .addStringOption(o => o.setName("duration").setDescription("Duration").setRequired(true).addChoices({ name:"Weekly",value:"W"},{ name:"Monthly",value:"M"},{ name:"Lifetime",value:"L"}))
            .addStringOption(o => o.setName("category").setDescription("Category").setRequired(true).addChoices({ name:"First",value:"1"},{ name:"Second",value:"2"},{ name:"Third",value:"3"}))
            .addIntegerOption(o => o.setName("everyone").setDescription("@everyone pings").setRequired(false))
            .addIntegerOption(o => o.setName("here").setDescription("@here pings").setRequired(false)),
        new SlashCommandBuilder().setName("revoke").setDescription("Revoke a user's slot")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
        new SlashCommandBuilder().setName("hold").setDescription("Put a slot on hold")
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
            .addUserOption(o => o.setName("user").setDescription("Slot owner if outside slot channel").setRequired(false)),
        new SlashCommandBuilder().setName("unhold").setDescription("Remove a slot from hold")
            .addUserOption(o => o.setName("user").setDescription("Slot owner if outside slot channel").setRequired(false)),
        new SlashCommandBuilder().setName("nuke").setDescription("Nuke the current channel"),
        new SlashCommandBuilder().setName("do").setDescription("Generate LTC payment in open ticket")
            .addNumberOption(o => o.setName("price").setDescription("Custom price EUR").setRequired(false)),
        new SlashCommandBuilder().setName("complete").setDescription("Force-complete payment and create slot")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(false)),
        new SlashCommandBuilder().setName("vouch").setDescription("Generate vouch for ticket user"),
        new SlashCommandBuilder().setName("info").setDescription("View user slot and transaction history")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
        new SlashCommandBuilder().setName("setup").setDescription("Post the main ticket panel"),
        new SlashCommandBuilder().setName("setupmm").setDescription("Post the Auto Middleman (MM) panel"),
        new SlashCommandBuilder().setName("setupexchange").setDescription("Post the Exchange panel for currency/crypto swaps"),
        new SlashCommandBuilder().setName("setupslot").setDescription("Configure pings for a slot tier")
            .addStringOption(o => o.setName("category").setDescription("Category").setRequired(true).addChoices({ name:"First",value:"1"},{ name:"Second",value:"2"},{ name:"Third",value:"3"}))
            .addStringOption(o => o.setName("duration").setDescription("Duration").setRequired(true).addChoices({ name:"Weekly",value:"W"},{ name:"Monthly",value:"M"},{ name:"Lifetime",value:"L"}))
            .addIntegerOption(o => o.setName("everyone").setDescription("@everyone pings").setRequired(true))
            .addIntegerOption(o => o.setName("here").setDescription("@here pings").setRequired(true)),
        new SlashCommandBuilder().setName("dash").setDescription("Full SellAuth dashboard"),
        new SlashCommandBuilder().setName("stock").setDescription("View shop stock with IDs"),
        new SlashCommandBuilder().setName("restock").setDescription("Add stock to a product or variant")
            .addStringOption(o => o.setName("id").setDescription("Product/Variant ID").setRequired(true))
            .addStringOption(o => o.setName("items").setDescription("Items to add").setRequired(true)),
        new SlashCommandBuilder().setName("livestock").setDescription("Set the live stock channel")
            .addChannelOption(o => o.setName("channel").setDescription("Channel to post stock in").setRequired(false)),
        new SlashCommandBuilder().setName("deleteproduct").setDescription("Delete a SellAuth product")
            .addStringOption(o => o.setName("id").setDescription("Product ID").setRequired(true)),
        new SlashCommandBuilder().setName("dashboard").setDescription("View temporary LTC wallets"),
        new SlashCommandBuilder().setName("adduser").setDescription("Add second user to MM session")
            .addStringOption(o => o.setName("id").setDescription("User ID").setRequired(true)),
        new SlashCommandBuilder().setName("tx").setDescription("Track a LTC transaction in real time")
            .addStringOption(o => o.setName("txid").setDescription("LTC transaction ID").setRequired(true)),
        new SlashCommandBuilder().setName("txid").setDescription("View a SellAuth order by ID")
            .addStringOption(o => o.setName("orderid").setDescription("SellAuth order ID").setRequired(true)),
        new SlashCommandBuilder().setName("ltcinfo").setDescription("View LTC address info and last 10 transactions")
            .addStringOption(o => o.setName("address").setDescription("LTC address").setRequired(true)),
        new SlashCommandBuilder().setName("testall").setDescription("Run diagnostics on all bot systems"),
        new SlashCommandBuilder().setName("testorder").setDescription("Debug: show raw fields of last SellAuth order"),
        new SlashCommandBuilder().setName("ban").setDescription("Ban a user")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
            .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
        new SlashCommandBuilder().setName("unban").setDescription("Unban a user by ID")
            .addStringOption(o => o.setName("id").setDescription("User ID").setRequired(true)),
        new SlashCommandBuilder().setName("mute").setDescription("Timeout a user")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
            .addIntegerOption(o => o.setName("minutes").setDescription("Duration in minutes").setRequired(true)),
        new SlashCommandBuilder().setName("kick").setDescription("Kick a user")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
        new SlashCommandBuilder().setName("createltc").setDescription("Create a personal LTC address (Staff Exchange only)"),
        new SlashCommandBuilder().setName("send").setDescription("Send LTC from your exchanger address")
            .addStringOption(o => o.setName("address").setDescription("Destination LTC address").setRequired(true))
            .addStringOption(o => o.setName("amount").setDescription("Amount in LTC (e.g. 0.5) or EUR (e.g. 10€)").setRequired(true)),
        new SlashCommandBuilder().setName("sendall").setDescription("Send ALL available LTC from your exchanger address to a destination")
            .addStringOption(o => o.setName("address").setDescription("Destination LTC address").setRequired(true)),
        new SlashCommandBuilder().setName("myltc").setDescription("Show your exchanger wallet info, balance and last 5 transactions"),
        new SlashCommandBuilder().setName("minigames").setDescription("Play casino minigames (Blackjack)"),
        new SlashCommandBuilder().setName("deleteallchannels").setDescription("Delete ALL channels in a category")
            .addStringOption(o => o.setName("category_id").setDescription("Category ID").setRequired(true)),
        new SlashCommandBuilder().setName("purgeallchannels").setDescription("Delete ALL messages in every channel of a category")
            .addStringOption(o => o.setName("category_id").setDescription("Category ID").setRequired(true)),
        new SlashCommandBuilder().setName("join").setDescription("Add a member to the Staff Exchange role")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
        new SlashCommandBuilder().setName("unjoin").setDescription("Remove a member from the Staff Exchange role")
            .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true)),
    ].map(cmd => cmd.toJSON());

    try {
        const rest = new REST({ version: "10" }).setToken(CONFIG.TOKEN);
        const guild = client.guilds.cache.first();
        if (guild) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashCommands });
            console.log(` Registered ${slashCommands.length} slash commands in: ${guild.name}`);
        }
    } catch(e) {
        console.error(" Slash command registration failed:", e.message);
    }
});

// ================= HOLD DATA =================
let holdData = load("./hold_data.json"); // channelId -> { userId, messageId, reason }

// ================= JOIN / LEAVE LOGS =================
client.on("guildMemberAdd", async member => {
    const ch = member.guild.channels.cache.get(CONFIG.JOIN_LOG_CHANNEL_ID);
    if (!ch) return;
    const createdTs = Math.floor(member.user.createdTimestamp / 1000);
    const accountAge = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));
    const bans = await member.guild.bans.fetch().catch(() => null);
    const wasBanned = bans ? bans.has(member.id) : false;
    const joinEmbed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setTitle(" Member Joined")
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
            { name: " User", value: `<@${member.id}>\n\`${member.user.tag}\``, inline: true },
            { name: " ID", value: `\`${member.id}\``, inline: true },
            { name: " Account Created", value: `<t:${createdTs}:F>\n<t:${createdTs}:R>`, inline: false },
            { name: " Account Age", value: `\`${accountAge} days\``, inline: true },
            { name: " Members", value: `\`${member.guild.memberCount}\``, inline: true },
            { name: " Previously Banned", value: wasBanned ? "`Yes`" : "`No`", inline: true }
        )
        .setTimestamp()
        .setFooter({ text: "Astro Exchange | Join Log" });
    await ch.send({ embeds: [joinEmbed] }).catch(() => {});
});

client.on("guildMemberRemove", async member => {
    const ch = member.guild.channels.cache.get(CONFIG.LEAVE_LOG_CHANNEL_ID);
    if (!ch) return;
    await ch.send(` <@${member.id}> **${member.user.tag}** has left the server.`).catch(() => {});
});

// ================= ESCROW THREAD MENTION WATCHER =================
client.on("messageCreate", async msg => {
    if (msg.author.bot) return;
    const session = escrowSessions[msg.channel.id];
    if (!session) return; // not an escrow thread

    // Only act on the first user mention in the thread (not the creator)
    const mentioned = msg.mentions.users.first();
    if (!mentioned || mentioned.bot) return;
    if (mentioned.id === session.creatorId) return; // creator pinging themselves

    // Only trigger once per unique user added
    if (!session.addedUsers) session.addedUsers = [];
    if (session.addedUsers.includes(mentioned.id)) return;
    session.addedUsers.push(mentioned.id);

    // Add to thread
    await msg.channel.members.add(mentioned.id).catch(() => {});

    // Determine role display names
    const cryptoLabels = { LTC:"LTC", SOL:"SOL", ETH:"ETH", BTC:"BTC", USDT_SOL:"USDT" };
    const crypto = cryptoLabels[session.crypto] || session.crypto;

    const senderName = session.senderId
        ? (await msg.guild.members.fetch(session.senderId).catch(() => null))?.user.username || "none"
        : "none";
    const receiverName = session.receiverId
        ? (await msg.guild.members.fetch(session.receiverId).catch(() => null))?.user.username || "none"
        : "none";

    const identEmbed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setDescription(
            `\n# User Identification\n` +
            `Sender: Providing the ${crypto} to the bot\n` +
            `Receiver: Receiving the ${crypto} after the trade is completed\n\n` +
            `**Sender**\n\`${senderName}\`\n` +
            `**Receiver**\n\`${receiverName}\``
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`escrow_role_sender_${msg.channel.id}`)
            .setLabel("I am the Sender")
            .setEmoji("📤")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`escrow_role_receiver_${msg.channel.id}`)
            .setLabel("I am the Receiver")
            .setEmoji("📥")
            .setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`escrow_reset_${msg.channel.id}`)
            .setLabel("Reset")
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(`escrow_cancel_${msg.channel.id}`)
            .setLabel("Cancel Trade")
            .setStyle(ButtonStyle.Danger)
    );

    const identMsg = await msg.channel.send({ embeds: [identEmbed], components: [row1, row2] });
    session.identMsgId = identMsg.id;
    escrowSessions[msg.channel.id] = session;
    save("./escrow_sessions.json", escrowSessions);
});

// ================= LTC ADDRESS LOOKUP CHANNEL =================
client.on("messageCreate", async msg => {
    if (msg.channel.id !== CONFIG.LTC_LOOKUP_CHANNEL_ID) return;
    if (msg.author.bot) return;

    //  Currency conversion: "23.45$ to €" or "100 EUR to BTC" etc 
    const convMatch = msg.content.match(/^([\d.,]+)\s*([a-zA-Z$€£¥₿]+)\s+(?:to|in|=)\s*([a-zA-Z$€£¥₿]+)$/i);
    if (convMatch) {
        const amount = parseFloat(convMatch[1].replace(",", "."));
        const fromRaw = convMatch[2].trim();
        const toRaw = convMatch[3].trim();

        // Normalize symbol → CoinGecko ID or fiat code
        const symbolMap = {
            "$": "usd", "€": "eur", "£": "gbp", "¥": "jpy", "₿": "btc",
            "usd": "usd", "eur": "eur", "gbp": "gbp", "jpy": "jpy", "chf": "chf",
            "cad": "cad", "aud": "aud", "nok": "nok", "sek": "sek", "dkk": "dkk",
            "btc": "btc", "eth": "eth", "ltc": "ltc", "usdt": "usdt", "bnb": "bnb",
            "sol": "sol", "xrp": "xrp", "doge": "doge", "ada": "ada", "dot": "dot",
            "matic": "matic", "avax": "avax", "link": "link", "uni": "uni", "atom": "atom",
            "trx": "trx", "xlm": "xlm", "bch": "bch", "etc": "etc", "near": "near"
        };

        // CoinGecko IDs for crypto
        const geckoIds = {
            "btc": "bitcoin", "eth": "ethereum", "ltc": "litecoin", "usdt": "tether",
            "bnb": "binancecoin", "sol": "solana", "xrp": "ripple", "doge": "dogecoin",
            "ada": "cardano", "dot": "polkadot", "matic": "matic-network", "avax": "avalanche-2",
            "link": "chainlink", "uni": "uniswap", "atom": "cosmos", "trx": "tron",
            "xlm": "stellar", "bch": "bitcoin-cash", "etc": "ethereum-classic", "near": "near"
        };

        const fromKey = symbolMap[fromRaw.toLowerCase()] || fromRaw.toLowerCase();
        const toKey = symbolMap[toRaw.toLowerCase()] || toRaw.toLowerCase();

        const fiats = ["usd","eur","gbp","jpy","chf","cad","aud","nok","sek","dkk"];
        const isFiat = k => fiats.includes(k);

        try {
            let rate = null;

            // Build CoinGecko request
            // We need: (fromKey in USD or EUR) → convert
            // Strategy: get both in a common base (USD), then divide
            const ids = [];
            if (!isFiat(fromKey)) ids.push(geckoIds[fromKey] || fromKey);
            if (!isFiat(toKey)) ids.push(geckoIds[toKey] || toKey);

            const vsCurrencies = [...new Set([
                isFiat(fromKey) ? fromKey : "usd",
                isFiat(toKey) ? toKey : "usd"
            ])].join(",");

            const allIds = [...new Set(ids)].join(",") || "bitcoin"; // fallback
            const url = ids.length > 0
                ? `https://api.coingecko.com/api/v3/simple/price?ids=${allIds}&vs_currencies=${vsCurrencies},usd,eur`
                : `https://api.exchangerate-api.com/v4/latest/${fromKey.toUpperCase()}`;

            let fromUsd, toUsd;

            if (ids.length === 0) {
                // Both are fiat — use exchangerate-api
                const res = await fetch(`https://api.exchangerate-api.com/v4/latest/${fromKey.toUpperCase()}`);
                const data = await res.json();
                const toRate = data?.rates?.[toKey.toUpperCase()];
                if (!toRate) throw new Error("Rate not found");
                rate = toRate;
            } else {
                const res = await fetch(
                    `https://api.coingecko.com/api/v3/simple/price?ids=${allIds}&vs_currencies=usd,eur,gbp,jpy,chf,cad,aud`,
                    { headers: { "Accept": "application/json" } }
                );
                const data = await res.json();

                const getUsdPrice = (key) => {
                    if (isFiat(key)) {
                        // Convert fiat to USD using EUR/USD ≈ 1.08 as base
                        const fiatToUsd = { usd:1, eur:1.08, gbp:1.27, jpy:0.0067, chf:1.11, cad:0.74, aud:0.65 };
                        return fiatToUsd[key] || 1;
                    }
                    const id = geckoIds[key] || key;
                    return data[id]?.usd || null;
                };

                fromUsd = getUsdPrice(fromKey);
                toUsd = getUsdPrice(toKey);
                if (!fromUsd || !toUsd) throw new Error("Price not found");
                rate = fromUsd / toUsd;
            }

            const result = amount * rate;

            // Format: show 6 decimals for crypto, 4 for fiat
            const decimals = (!isFiat(toKey)) ? 8 : 4;
            const fmt = n => n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

            const fromDisplay = fromRaw.toUpperCase().replace("$","USD").replace("€","EUR").replace("£","GBP");
            const toDisplay = toRaw.toUpperCase().replace("$","USD").replace("€","EUR").replace("£","GBP");

            const convEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setDescription(`<:tick:1498488241912021124> **${amount.toLocaleString("en-US")} ${fromDisplay}** = **${fmt(result)} ${toDisplay}**`);

            return await msg.channel.send({ embeds: [convEmbed] });
        } catch(e) {
            return await msg.channel.send({ content: ` Couldn't convert **${fromRaw.toUpperCase()}** → **${toRaw.toUpperCase()}**. Check the symbols and try again.` }).then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
        }
    }

    // Match a LTC address: starts with L or M, 26-34 chars, base58
    const ltcAddrMatch = msg.content.match(/\b([LM][a-km-zA-HJ-NP-Z1-9]{25,33})\b/);
    if (!ltcAddrMatch) return;

    const address = ltcAddrMatch[1];

    // Verify address and fetch data from BlockCypher
    try {
        const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=1&token=${CONFIG.BLOCKCYPHER_TOKEN}`);
        const data = await res.json();

        // If BlockCypher returns an error, address is invalid
        if (data.error) return;

        // Use real-time USD price
        let ltcUsd = cachedLtcUsd;
        try {
            const priceRes = await fetch(
                "https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT",
                { headers: { "Accept": "application/json" } }
            );
            const priceData = await priceRes.json();
            const val = parseFloat(priceData?.price);
            if (val > 0) ltcUsd = val;
        } catch(e) { /* keep cachedLtcUsd */ }
        const balance = (data.balance || 0) / 100000000;
        const totalReceived = (data.total_received || 0) / 100000000;
        const totalSent = (data.total_sent || 0) / 100000000;
        const txCount = data.n_tx || 0;

        const balanceUsd = (balance * ltcUsd).toFixed(2);
        const receivedUsd = (totalReceived * ltcUsd).toFixed(2);
        const sentUsd = (totalSent * ltcUsd).toFixed(2);

        // Last transaction timestamp
        let lastTxText = "No transactions";
        const allRefs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])];
        if (allRefs.length > 0) {
            // Sort by confirmed/received time descending
            allRefs.sort((a, b) => new Date(b.confirmed || b.received || 0) - new Date(a.confirmed || a.received || 0));
            const lastTx = allRefs[0];
            const lastTxDate = lastTx.confirmed || lastTx.received;
            if (lastTxDate) {
                const ts = Math.floor(new Date(lastTxDate).getTime() / 1000);
                lastTxText = `<t:${ts}:D> at <t:${ts}:t>` + `\n<t:${ts}:R>`;
            }
        }

        const lookupEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setAuthor({ name: "Litecoin Address", iconURL: "https://cryptologos.cc/logos/litecoin-ltc-logo.png" })
            .addFields(
                { name: "Address", value: `\`${address}\``, inline: false },
                { name: "Balance", value: `${balance.toFixed(8)} LTC ($${balanceUsd})`, inline: true },
                { name: "Transactions", value: `${txCount}`, inline: true },
                { name: "Total Sent", value: `${totalSent.toFixed(8)} LTC ($${sentUsd})`, inline: false },
                { name: "Total Received", value: `${totalReceived.toFixed(8)} LTC ($${receivedUsd})`, inline: false },
                { name: "Last Transaction", value: lastTxText, inline: false }
            )
            .setFooter({ text: `Astro Exchange • Requested by ${msg.author.tag}`, iconURL: msg.author.displayAvatarURL({ dynamic: true }) })
            .setTimestamp();

        await msg.channel.send({ embeds: [lookupEmbed] });
    } catch(e) {
        console.error("[LTC Lookup] Error:", e.message);
    }
});

// ================= SCAMMER CHANNEL WATCHER =================
client.on("messageCreate", async msg => {
    if (msg.channel.id !== CONFIG.SCAMMER_CHANNEL_ID) return;
    if (msg.author.bot && msg.author.id === msg.client.user?.id) return;
    // Extract all user IDs from the message
    const idMatches = msg.content.match(/\b(\d{17,19})\b/g);
    if (!idMatches) return;
    const guild = msg.guild;
    const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
    for (const scammerId of idMatches) {
        const scamMember = await guild.members.fetch(scammerId).catch(() => null);
        if (!scamMember) continue;
        // In server \u2192 log it
        if (logCh) {
            const warnEmbed = new EmbedBuilder()
                .setColor("#FF0000")
                .setTitle("\uD83D\uDEA8 Scammer Detected In Server")
                .setDescription(`A reported scammer is currently in the server!`)
                .addFields(
                    { name: "\uD83D\uDC64 User", value: `<@${scammerId}> (${scamMember.user.tag})`, inline: true },
                    { name: "\uD83C\uDD94 ID", value: `\`${scammerId}\``, inline: true }
                )
                .setTimestamp();
            await logCh.send({ embeds: [warnEmbed] }).catch(() => {});
        }
        // Is a slot owner \u2192 put slot on hold
        const slotEntry = Object.entries(slots).find(([, d]) => d.ownerId === scammerId);
        if (slotEntry) {
            const [slotChannelId, slotD] = slotEntry;
            const slotCh = guild.channels.cache.get(slotChannelId);
            if (slotCh) {
                // Remove send permission
                await slotCh.permissionOverwrites.edit(scammerId, { SendMessages: false }).catch(() => {});
                // Add on hold role
                await scamMember.roles.add(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
                const holdEmbed = new EmbedBuilder()
                    .setColor("#FF0000")
                    .setTitle("\uD83D\uDD12 Slot On Hold")
                    .setDescription(
                        `<@${scammerId}>, your slot has been placed on hold.

` +
                        `**Reason:** Reported as scammer

` +
                        `Please open a ticket to discuss this with staff.`
                    )
                    .setTimestamp();
                const holdMsg = await slotCh.send({ embeds: [holdEmbed] }).catch(() => null);
                if (holdMsg) {
                    holdData[slotChannelId] = { userId: scammerId, messageId: holdMsg.id, reason: "Reported as scammer" };
                    save("./hold_data.json", holdData);
                }
            }
        }
    }
});

// ================= HELPER FUNCTIONS =================
async function createSlot(member, categoryName, duration, overrideEv = null, overrideHr = null) {
    const catId = CONFIG.SLOT_CATEGORIES[categoryName] || CONFIG.TICKET_CATEGORY_ID;
    const now = new Date();
    let expiry = new Date();
    
    if (duration === "Weekly") expiry.setDate(now.getDate() + 7);
    else if (duration === "Monthly") expiry.setDate(now.getDate() + 30);
    else expiry = "Never";

    const channel = await member.guild.channels.create({
        name: `${member.user?.username || 'user'}`,
        parent: catId,
        permissionOverwrites: 
            { id: [member.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ]
    });

    const configPings = pingConfig[categoryName]?.[duration] || { everyone: 0, here: 0 };
    const pings = {
        everyone: (overrideEv !== null && overrideEv !== undefined) ? parseInt(overrideEv) : configPings.everyone,
        here: (overrideHr !== null && overrideHr !== undefined) ? parseInt(overrideHr) : configPings.here
    };
    
    const formatDateLong = (date) => {
        return date.toLocaleString('en-US', { 
            month: 'long', 
            day: 'numeric', 
            year: 'numeric', 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
        });
    };

    let permText = "";
    if (pings.here > 0) permText += `\`${pings.here}x @here pings\`\n`;
    if (pings.everyone > 0) permText += `\`${pings.everyone}x @everyone pings\`\n`;
    if (!permText) permText = "No specific pings allowed.";

    const infoEmbed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setAuthor({ name: "Slot Details:" })
        .setTitle(`${duration} Slot`)
        .setThumbnail(member.user?.displayAvatarURL({ dynamic: true }))
        .setDescription(
            `Purchase date: \`${formatDateLong(now)}\`\n` +
            `Duration: **${duration}**\n\n\n` +
            `**Permissions:**\n` +
            `${permText}\n` +
            `<a:zz1:1430879311086358538> **MUST** follow the [slot rules](https://discordapp.com/channels/1418195263444619266/1430879274247651350) strictly\n` +
            `<a:zz1:1430879311086358538> **Always** accept MM`
        );

    const infoMsg = await channel.send({ content: `<@${member.id}>`, embeds: [infoEmbed] });
    await infoMsg.pin().catch(() => {});

    slots[channel.id] = {
        ownerId: member.id,
        category: categoryName,
        duration: duration,
        created: now.getTime(),
        expiry: expiry === "Never" ? "Never" : expiry.getTime(),
        lastNuke: 0,
        allowedPings: permText,
        pingsLeft: {
            everyone: pings.everyone,
            here: pings.here
        },
        infoEmbed: infoEmbed.toJSON()
    };
    save("./slots.json", slots);

    await member.roles.add(CONFIG.SLOT_OWNER_ROLE_ID).catch(() => {});

    const dmEmbed = new EmbedBuilder()
        .setColor("#5FB3C4")
        .setTitle(`Slot Created | https://discord.com/channels/${member.guild.id}/${channel.id}`)
        .setDescription(`Details:\n**\u2022 Name:** \`${member.user?.username || 'User'}\`\n**\u2022 Duration:** \`${duration} Slot\`\n**\u2022 Purchased On:** \`${formatDateLong(now)}\`\n**\u2022 Expiry Date:** \`${expiry === "Never" ? "Never" : formatDateLong(expiry)}\`\n**\u2022 Category:** \`${categoryName} Category\``)
        .setFooter({ text: "Astro Exchange | Thanks for choosing us" });

    const dmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel("Slot Rules")
            .setURL(`https://discord.com/channels/${member.guild.id}/1430879274247651350`)
            .setStyle(ButtonStyle.Link)
    );

    await member.send({ embeds: [dmEmbed], components: [dmRow] }).catch(() => {});
}

// ================= MESSAGE COMMANDS =================
client.on("messageCreate", async msg => {
    if (!msg.guild || msg.author.bot) return;

    const slotData = slots[msg.channel.id];
    if (slotData && slotData.ownerId === msg.author.id) {
        const hasEveryone = msg.content.includes("@everyone");
        const hasHere = msg.content.includes("@here");
        if (hasEveryone || hasHere) {
            let usedPing = false;
            let currentLeft = 0;
            if (hasEveryone) {
                if (slotData.pingsLeft.everyone > 0) {
                    slotData.pingsLeft.everyone--;
                    currentLeft = slotData.pingsLeft.everyone;
                    usedPing = true;
                }
            } else if (hasHere) {
                if (slotData.pingsLeft.here > 0) {
                    slotData.pingsLeft.here--;
                    currentLeft = slotData.pingsLeft.here;
                    usedPing = true;
                }
            }
            if (usedPing) {
                save("./slots.json", slots);
                // If pings hit 0, notify in the ping log channel
                if (currentLeft === 0) {
                    const pingLogCh = msg.guild.channels.cache.get(CONFIG.PING_LOG_CHANNEL_ID);
                    if (pingLogCh) await pingLogCh.send(`<@${msg.author.id}>, all pings have been reset!`).catch(() => {});
                }
                return msg.reply(`Ping detected, use <#1430879272809009152> to stay safe! <@${msg.author.id}> has x${currentLeft} ping(s) left.`);
            } else {
                // Overping: auto hold
                await msg.delete().catch(() => {});
                // Remove send permission
                await msg.channel.permissionOverwrites.edit(msg.author.id, { SendMessages: false }).catch(() => {});
                // Add on hold role
                const overMember = msg.guild.members.cache.get(msg.author.id);
                if (overMember) await overMember.roles.add(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
                const holdEmbed = new EmbedBuilder()
                    .setColor("#FF0000")
                    .setTitle("\uD83D\uDD12 Slot On Hold")
                    .setDescription(
                        `<@${msg.author.id}>, your slot has been placed on hold.

` +
                        `**Reason:** Overping

` +
                        `Please open a ticket to discuss this with staff.`
                    )
                    .setTimestamp();
                const holdMsg = await msg.channel.send({ embeds: [holdEmbed] }).catch(() => null);
                if (holdMsg) {
                    holdData[msg.channel.id] = { userId: msg.author.id, messageId: holdMsg.id, reason: "Overping" };
                    save("./hold_data.json", holdData);
                }
                return;
            }
        }
    }

    if (msg.mentions.members.some(m => m.roles.cache.has(CONFIG.STAFF_ROLE_ID))) {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) {
            await msg.member.timeout(5 * 60 * 1000).catch(() => {});
            return msg.reply("\uD83D\uDEAB No staff ping. 5m Timeout applied.");
        }
    }

    // NEW: Guard vouch channel - delete anything not starting with +rep
    if (msg.channel.id === CONFIG.VOUCH_CHANNEL_ID && !msg.content.startsWith("+rep")) {
        await msg.delete().catch(() => {});
        return;
    }
    // NEW: +rep posted outside vouch channel: delete
    if (msg.content.startsWith("+rep") && msg.channel.id !== CONFIG.VOUCH_CHANNEL_ID) {
        await msg.delete().catch(() => {});
        return;
    }

    if (!msg.content.startsWith(CONFIG.PREFIX)) return;
    const args = msg.content.slice(CONFIG.PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // ================= SETUPEXCHANGE COMMAND (CURRENCY/CRYPTO EXCHANGE) =================
    if (cmd === "setupexchange") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        msg.delete().catch(() => {});

        const exchangeEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setDescription(
                `# Welcome to Astro Exchange Panel\n` +
                `**Before creating ticket, make sure to check <#1430879271659900949>**\n\n` +
                `**Security & Safety**\n` +
                `• All deals are handled inside tickets only\n` +
                `• Each exchanger has a security limit.\n` +
                `• Deals exceeding it require a middleman.\n\n` +
                `**Important Reminders**\n` +
                `• Do not rush during exchanges\n` +
                `• No Third-Party Payments\n` +
                `• We do not cover transaction fees.\n\n` +
                `**Current Fees:**\n` +
                `**PayPal → Crypto**\n` +
                `• <10€: 0.50€ fixed\n` +
                `• 10-25€: 5%\n` +
                `• 25-50€: 4.5%\n` +
                `• 50€+: 4%\n\n` +
                `**Crypto → Crypto**\n` +
                `• <25€: 5%\n` +
                `• 25-50€: 3%\n` +
                `• 50€+: 2%\n\n` +
                `**Crypto → PayPal**\n` +
                `• 0% (no fee)`
            )
            .setFooter({ text: "Astro Exchange | Swap Service" })
            .setTimestamp();

        const startRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("exchange_start")
                .setLabel("Start Exchange")
                .setStyle(ButtonStyle.Secondary)
        );

        await msg.channel.send({ embeds: [exchangeEmbed], components: [startRow] });
        return;
    }

    // ================= SETFEES COMMAND =================
    if (cmd === "setfees") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return msg.reply("❌ Admin only.");
        
        const feeEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Exchange Fees Configuration")
            .setDescription(
                `**Current Fees:**\n\n` +
                `**PayPal → Crypto**\n` +
                exchangeFees.paypalToCrypto.map(f => {
                    let range = "";
                    if (f.max && !f.min) range = `<${f.max}€`;
                    else if (f.min && !f.max) range = `${f.min}€+`;
                    else if (f.min && f.max) range = `${f.min}-${f.max}€`;
                    return `• ${range}: ${f.type === "fixed" ? f.fee + "€ fixed" : f.fee + "%"}`;
                }).join("\n") + "\n\n" +
                `**Crypto → Crypto**\n` +
                exchangeFees.cryptoToCrypto.map(f => {
                    let range = "";
                    if (f.max && !f.min) range = `<${f.max}€`;
                    else if (f.min && !f.max) range = `${f.min}€+`;
                    else if (f.min && f.max) range = `${f.min}-${f.max}€`;
                    return `• ${range}: ${f.fee}%`;
                }).join("\n") + "\n\n" +
                `**Crypto → PayPal**\n` +
                `• ${exchangeFees.cryptoToPaypal[0].fee}%\n\n` +
                `To edit, use staff panel or contact developer.`
            )
            .setFooter({ text: "Astro Exchange | Fee Configuration" });

        return msg.channel.send({ embeds: [feeEmbed] });
    }

    // ================= SETUPESCROW COMMAND =================
    if (cmd === "setupescrow") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        msg.delete().catch(() => {});

        const escrowEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setDescription(
                `# Astro Escrow\n` +
                `An escrow service acts as a secure intermediary to ensure trust between trading partners. During a transaction, the process follows these steps:\n` +
                `• **Securing Funds:** The buyer deposits the payment into the escrow account.\n` +
                `• **Product Delivery:** The seller provides the goods or services to the buyer.\n` +
                `• **Final Settlement:** After the buyer confirms successful receipt, the funds are released to the seller.\n\n` +
                `# Service Fees\n` +
                `We charge a flat fee of 0.25% per transaction. Please note that blockchain network fees are separate and are not included in this service rate.\n\n` +
                `# How are fees calculated?\n` +
                `Our automated system identifies the incoming amount as soon as it reaches the designated address. The total fee consists of:\n` +
                `1.    The **0.25%** service charge.\n` +
                `2.    The applicable blockchain network fees.\n` +
                `These costs are automatically deducted from the total deal amount at the final stage when funds are released to the receiver.`
            );

        const cryptoRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("escrow_select_crypto")
                .setPlaceholder("Select the cryptocurrency")
                .addOptions([
                    { label: "LTC - Litecoin Network",    value: "LTC",      emoji: "<:ltc:1497994881262682173>" },
                    { label: "SOL - Solana Network",       value: "SOL",      emoji: "<:Solana:1498488264233844766>" },
                    { label: "ETH - Ethereum Network",     value: "ETH",      emoji: "<:eth:1498724198280073296>" },
                    { label: "BTC - Bitcoin Network",      value: "BTC",      emoji: "<:BTC:1498724194618314966>" },
                    { label: "USDT SOL - Solana Network",  value: "USDT_SOL", emoji: "<:USDT:1498724196367204484>" },
                ])
        );

        await msg.channel.send({ embeds: [escrowEmbed], components: [cryptoRow] });
        return;
    }

    // ================= SETUPEXCHANGE COMMAND =================
    if (cmd === "setupmm") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        msg.delete().catch(() => {});
        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83E\uDD1D Auto Middleman Service")
            .setDescription(
                "Welcome to the **Auto Middleman** service!\n\n" +
                "Our system guarantees secure transactions between buyer and seller.\n\n" +
                "**How it works:**\n" +
                "\u2022 The bot acts as a secure intermediary\n" +
                "\u2022 Funds are held in escrow\n" +
                "\u2022 The product is released only after confirmation\n\n" +
                "**Fee:** `5%` of the total transaction\n" +
                "*(2.5% from buyer + 2.5% from seller)*\n\n" +
                "Click the button below to start an MM session."
            )
            .setFooter({ text: "Astro Exchange | Auto MM System" })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("start_mm")
                .setLabel("\uD83E\uDD1D Start MM")
                .setStyle(ButtonStyle.Success)
        );

        return msg.channel.send({ embeds: [embed], components: [row] });
    }

    // ================= ADDUSER COMMAND FOR MM =================
    if (cmd === "adduser") {
        const mmChannelData = Object.entries(mmSessions).find(([id, d]) => d.channelId === msg.channel.id && d.status === 'waiting_second_user');
        if (!mmChannelData) return;

        const [sessionId, mmData] = mmChannelData;
        if (mmData.creatorId !== msg.author.id && !msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) {
            return msg.reply("\u274C Only the session creator can add users.");
        }

        const targetId = args[0];
        if (!targetId) return msg.reply("\u274C Usage: `,adduser [user ID]`");

        const target = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!target) return msg.reply("\u274C User not found.");
        if (target.id === mmData.creatorId) return msg.reply("\u274C You cannot add yourself.");

        await msg.channel.permissionOverwrites.edit(target.id, {
            ViewChannel: true,
            SendMessages: true
        }).catch(() => {});

        mmData.secondUserId = target.id;
        mmData.status = 'selecting_roles';
        save("./mm_sessions.json", mmSessions);

        const roleEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83E\uDD1D Role Selection - Auto MM")
            .setDescription(
                `<@${mmData.creatorId}> and <@${target.id}>, benvenuti!\n\n` +
                "Both of you must select your role in this transaction.\n" +
                "**Each person must click their own role:**"
            );

        const roleRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mm_role_buyer_${sessionId}`).setLabel("\uD83D\uDED2 I am the Buyer").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`mm_role_seller_${sessionId}`).setLabel("\uD83D\uDCB0 I am the Seller").setStyle(ButtonStyle.Secondary)
        );

        return msg.channel.send({ content: `<@${mmData.creatorId}> <@${target.id}>`, embeds: [roleEmbed], components: [roleRow] });
    }

    // ================= DO COMMAND (NEW: supports optional price + all ticket types) =================
    if (cmd === "do") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const customPrice = args[0] ? parseFloat(args[0]) : null;
        const msgs = await msg.channel.messages.fetch({ limit: 50 });
        const tType = ticketTypes[msg.channel.id] || "slot";
        const ticketMsg = msgs.find(m => m.embeds.length > 0 && (
            m.embeds[0].title === "Buy Slot Ticket" ||
            m.embeds[0].title === "Product Purchase Ticket"
        ));
        if (!ticketMsg) return msg.reply("\u274C No valid ticket found in this channel.");
        
        const desc = ticketMsg.embeds[0].description;
        const userIdMatch = desc.match(/\*\*User ID:\*\*\n`(\d+)`/);
        if (!userIdMatch) return msg.reply("\u274C Missing or invalid ticket data.");
        
        const targetId = userIdMatch[1];
        if (tType === "slot" && Object.values(slots).some(s => s.ownerId === targetId)) {
            return msg.reply(`\u274C <@${targetId}> ha gi\u00E0 uno slot attivo! Limite massimo: 1 slot a persona.`);
        }
        
        const target = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!target) return msg.reply("\u274C User not found.");
        
        let catName = "First", durName = "Weekly", priceEur = customPrice || 10;
        if (tType === "slot" || ticketMsg.embeds[0].title === "Buy Slot Ticket") {
            const catMatch = desc.match(/\*\*Selected Category:\*\*\n(First|Second|Third)/);
            const durMatch = desc.match(/\*\*Duration:\*\*\n(Weekly|Monthly|Lifetime)/);
            if (catMatch) catName = catMatch[1];
            if (durMatch) durName = durMatch[1];
            if (!customPrice) priceEur = CONFIG.PRICES[`${catName}_${durName}`] || 10;
        }
        
        const amountLtc = (priceEur / cachedLtcPrice).toFixed(6);
        const wallet = await generateLtcAddress();
        if (!wallet) return msg.reply("\u274C Errore generazione wallet BlockCypher.");
        
        tempWallets[wallet.address] = { ownerId: target.id, balance: 0, createdAt: Date.now(), privateKey: wallet.privateKey, wif: wallet.wif, ticketChannelId: msg.channel.id, ticketType: tType };
        save("./temp_wallets.json", tempWallets);
        
        if (tType === "slot" || ticketMsg.embeds[0].title === "Buy Slot Ticket") {
            const pings = PING_DEFAULTS[`${catName}_${durName}`] || { ev: 0, hr: 0 };
            pendingPayments[target.id] = { address: wallet.address, amountLtc: parseFloat(amountLtc), category: catName, duration: durName, ovEv: pings.ev, ovHr: pings.hr, completed: false, ticketChannelId: msg.channel.id, ticketType: "slot" };
        } else {
            pendingPayments[target.id] = { address: wallet.address, amountLtc: parseFloat(amountLtc), completed: false, ticketChannelId: msg.channel.id, ticketType: tType, priceEur };
        }
        save("./pending_payments.json", pendingPayments);
        
        const payEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Automatic LTC Payment")
            .setDescription(`Payment for <@${target.id}>:\n\n**Address:** \`${wallet.address}\`\n**Amount:** \`${amountLtc}\` LTC\n**Amount (EUR):** \`${priceEur}\u20AC\`\n\nCreating slot automatically upon confirmation.`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copy_addy_${wallet.address}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`copy_amt_${amountLtc}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("check_payment_btn").setLabel("Payment Completed").setStyle(ButtonStyle.Success)
        );
        return msg.reply({ content: `<@${targetId}>`, embeds: [payEmbed], components: [row] });
    }

    // ================= DASH COMMAND (FIXED) =================
    if (cmd === "dash") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const loadingMsg = await msg.reply("⏳ Loading dashboard...");
        try {
            //  Fetch data independently 
            let orders = [], products = [];
            let ordersErr = null, productsErr = null;

            try {
                const r = await sellAuthAPI.get("/orders");
                const d = r.data;
                orders = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
            } catch(e) { ordersErr = e.response ? `${e.response.status}` : e.message; }

            try {
                const r = await sellAuthAPI.get("/products");
                const d = r.data;
                products = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
            } catch(e) { productsErr = e.response ? `${e.response.status}` : e.message; }

            //  Stats 
            let totalRev = 0, completed = 0, pending = 0, refunded = 0;
            orders.forEach(o => {
                const s = (o.status || "").toLowerCase();
                const amount = parseFloat(o.price || o.total || o.amount || 0);
                if (s === "completed" || s === "paid" || s === "delivered") { totalRev += amount; completed++; }
                else if (s === "pending" || s === "processing") pending++;
                else if (s === "refunded" || s === "cancelled") refunded++;
            });

            const inStock = products.filter(p =>
                p.stock === undefined || p.stock === null || p.stock > 0 ||
                (p.variants && p.variants.some(v => v.stock > 0))
            ).length;
            const outOfStock = products.length - inStock;

            //  Top products by order count 
            const productCounts = {};
            orders.forEach(o => {
                const name = o.product_name || o.product?.name || "Unknown";
                productCounts[name] = (productCounts[name] || 0) + 1;
            });
            const topProducts = Object.entries(productCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([name, count], i) => `${["","",""][i]} **${name.slice(0,25)}** — \`${count}\` orders`)
                .join("\n") || "No data.";

            //  Last 10 orders 
            const last10 = [...orders].reverse().slice(0, 10);
            const last10Text = last10.length > 0
                ? last10.map(o => {
                    const s = (o.status || "?").toUpperCase();
                    const icon = s === "COMPLETED" || s === "PAID" ? "" : s === "PENDING" ? "⏳" : s === "REFUNDED" ? "↩" : "";
                    const price = parseFloat(o.price || o.total || 0).toFixed(2);
                    const name = (o.product_name || o.product?.name || "N/A").slice(0, 22);
                    const date = o.created_at ? `<t:${Math.floor(new Date(o.created_at).getTime()/1000)}:d>` : "N/A";
                    return `${icon} **${name}** • \`${price}€\` • ${date}`;
                }).join("\n")
                : "No orders yet.";

            //  Stock overview 
            const stockLines = products.slice(0, 8).map(p => {
                let stock = p.stock ?? (p.variants ? p.variants.reduce((s, v) => s + (v.stock||0), 0) : 0);
                const icon = stock > 0 ? "" : "";
                return `${icon} **${(p.name||"?").slice(0,22)}** — \`${stock}\``;
            }).join("\n") || "No products.";

            //  Build embeds (send 2: overview + orders) 
            const overviewEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" SellAuth Dashboard")
                .setDescription(`\`${CONFIG.BASE_SHOP_URL}\``)
                .addFields(
                    { name: " Products", value: `Total: \`${products.length}\`\nIn Stock: \`${inStock}\`\nOut of Stock: \`${outOfStock}\``, inline: true },
                    { name: " Orders", value: `Total: \`${orders.length}\`\n Completed: \`${completed}\`\n⏳ Pending: \`${pending}\`\n↩ Refunded: \`${refunded}\``, inline: true },
                    { name: " Revenue", value: `Estimated: \`${totalRev.toFixed(2)} EUR\`\nAvg/order: \`${completed > 0 ? (totalRev/completed).toFixed(2) : "0.00"} EUR\``, inline: true },
                    { name: " Top Products", value: topProducts, inline: false },
                    { name: " Stock Overview", value: stockLines, inline: false }
                )
                .setFooter({ text: `Astro Exchange | SellAuth Dashboard${ordersErr ? " |  Orders: "+ordersErr : ""}${productsErr ? " |  Products: "+productsErr : ""}` })
                .setTimestamp();

            const ordersEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Last 10 Orders")
                .setDescription(last10Text)
                .setTimestamp();

            await loadingMsg.edit({ content: "", embeds: [overviewEmbed] });
            await msg.channel.send({ embeds: [ordersEmbed] });

        } catch(e) {
            const detail = e.response ? `${e.response.status} — ${JSON.stringify(e.response.data)}` : e.message;
            console.error("Dash error:", detail);
            await loadingMsg.edit({ content: ` Dashboard error: \`${detail.slice(0, 300)}\`` });
        }
    }

    // ================= VOUCH COMMAND =================
    if (cmd === "vouch") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;

        if (args.length === 0) {
            await msg.delete().catch(() => {});

            // Auto-detect ticket user from embed in this channel
            let targetId = null;
            const recentMsgs = await msg.channel.messages.fetch({ limit: 50 }).catch(() => null);
            if (recentMsgs) {
                const ticketEmbed = recentMsgs.find(m =>
                    m.embeds.length > 0 &&
                    m.embeds[0].description &&
                    m.embeds[0].description.match(/\*\*User ID:\*\*\n`(\d+)`/)
                );
                if (ticketEmbed) {
                    const match = ticketEmbed.embeds[0].description.match(/\*\*User ID:\*\*\n`(\d+)`/);
                    if (match) targetId = match[1];
                }
            }

            // Store context — author ID is always the vouch sender
            sessions.set(`vouch_ctx_${msg.author.id}`, {
                channelId: msg.channel.id,
                guildId: msg.guild.id,
                targetId,             // ticket user (receives the DM with vouch text)
                authorId: msg.author.id  // always used as the vouch ID (+vouch THIS_ID)
            });

            const promptEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Generate Vouch")
                .setDescription(
                    targetId
                        ? `**Customer detected:** <@${targetId}>\nFill in the details below.`
                        : " No customer detected in this channel.\nFill in the details below."
                );
            const vouchRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`open_vouch_modal_${msg.author.id}`)
                    .setLabel(" Fill Vouch Form")
                    .setStyle(ButtonStyle.Primary)
            );

            // Send in channel — visible only to the staff member via ephemeral-like reply
            // We use a normal send but delete it after the modal is submitted or after 2 min
            const prompt = await msg.channel.send({
                content: `<@${msg.author.id}>`,
                embeds: [promptEmbed],
                components: [vouchRow]
            });
            // Store message ID so we can delete it after submit
            sessions.set(`vouch_prompt_${msg.author.id}`, prompt.id);
            setTimeout(() => prompt.delete().catch(() => {}), 120000);
            return;
        }

        // ,vouch with args (exchange or manual)
        const tType = ticketTypes[msg.channel.id] || "product";
        let vouchText = "";
        if (tType === "exchange") {
            const [userId, sent, received, price] = args;
            if (!userId || !sent || !received || !price) return msg.reply(" Usage: `,vouch [user] [sent] [received] [price]`");
            vouchText = `+vouch ${msg.author.id} | ${sent} -> ${received} ${price}€`;
        } else {
            const paymentMethod = args[0];
            const price = args[1];
            const quantity = args[args.length - 1];
            const productName = args.slice(2, args.length - 1).join(" ");
            if (!paymentMethod || !price || !productName || !quantity) {
                return msg.reply(" Usage: `,vouch [method] [price] [product] [qty]`");
            }
            vouchText = `+vouch ${msg.author.id} x${quantity} ${productName} | ${price}€ ${paymentMethod.toUpperCase()}`;
        }
        return msg.reply(` Vouch generated:\n\`\`\`${vouchText}\`\`\``);
    }

    if (cmd === "complete") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;

        const msgs = await msg.channel.messages.fetch({ limit: 50 }).catch(() => null);
        const ticketMsg = msgs ? msgs.find(m => m.embeds.length > 0 && (m.embeds[0].title === "Buy Slot Ticket" || m.embeds[0].title === "Product Purchase Ticket")) : null;

        let targetId = null;
        let catName = "First";
        let durName = "Weekly";

        if (ticketMsg) {
            const desc = ticketMsg.embeds[0].description;
            const userIdMatch = desc.match(/\*\*User ID:\*\*\n`(\d+)`/);
            const catMatch = desc.match(/\*\*Selected Category:\*\*\n(First|Second|Third)/);
            const durMatch = desc.match(/\*\*Duration:\*\*\n(Weekly|Monthly|Lifetime)/);

            if (userIdMatch) targetId = userIdMatch[1];
            if (catMatch) catName = catMatch[1];
            if (durMatch) durName = durMatch[1];
        }

        if (!targetId) {
            const mentioned = msg.mentions.members.first();
            const idArg = args[0];
            if (mentioned) targetId = mentioned.id;
            else if (idArg) targetId = idArg;

            if (!targetId) return msg.reply("\u274C Use inside a ticket or specify user ID (e.g. `,complete @User`).");
            
            const payData = pendingPayments[targetId];
            if (payData) {
                catName = payData.category;
                durName = payData.duration;
            }
        }

        const target = await msg.guild.members.fetch(targetId).catch(() => null);
        if (!target) return msg.reply("\u274C User not found in the server.");

        const payData = pendingPayments[targetId];
        if (payData) {
            payData.completed = true;
            if (tempWallets[payData.address]) {
                delete tempWallets[payData.address];
                save("./temp_wallets.json", tempWallets);
            }
            delete pendingPayments[targetId];
            save("./pending_payments.json", pendingPayments);
        }

        if (!userTransactions[targetId]) userTransactions[targetId] = [];
        userTransactions[targetId].push({ 
            type: "Slot Purchase (Forced)", 
            amount: payData ? `${payData.amountLtc} LTC (Forced)` : `0 EUR (Forced)`, 
            detail: `${catName} - ${durName}`, 
            date: Date.now() 
        });
        save("./user_transactions.json", userTransactions);

        if (!Object.values(slots).some(s => s.ownerId === targetId)) {
            const priceKey = `${catName}_${durName}`;
            const pings = PING_DEFAULTS[priceKey] || { ev: 0, hr: 0 };
            await createSlot(target, catName, durName, pings.ev, pings.hr);
        }

        const logCh = msg.guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
        if (logCh) logCh.send(`\u2705 Slot ${catName} force-completed for <@${targetId}> da ${msg.author.tag}.`);

        if (ticketMsg) {
            await msg.reply(`\u2705 Payment marked as completed for **${target.user?.tag || targetId}**. Slot generated.\nIl ticket verr\u00E0 chiuso automaticamente tra 5 secondi.`);
            setTimeout(() => {
                msg.channel.delete().catch(() => {});
            }, 5000);
        } else {
            return msg.reply(`\u2705 Payment marked as completed for **${target.user?.tag || targetId}**. Slot generated.`);
        }
    }

    if (cmd === "info") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const target = msg.mentions.members.first() || await msg.guild.members.fetch(args[0]).catch(() => null);
        if (!target) return msg.reply("\u274C Please specify a user.");
        
        const userSlotId = Object.keys(slots).find(k => slots[k].ownerId === target.id);
        const slotInfo = userSlotId ? `Yes (<#${userSlotId}>) - ${slots[userSlotId].category} / ${slots[userSlotId].duration}` : "None";
        
        const history = userTransactions[target.id] || [];
        const historyText = history.length > 0 
            ? history.slice(-5).map(t => `\u2022 **${t.type}**: ${t.amount} - ${t.detail} (<t:${Math.floor(t.date/1000)}:d>)`).join("\n")
            : "No transactions recorded.";

        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(`User Info: ${target.user?.username || 'User'}`)
            .addFields(
                { name: "Active Slot", value: slotInfo, inline: false },
                { name: "Last Transactions", value: historyText, inline: false }
            )
            .setThumbnail(target.user?.displayAvatarURL({ dynamic: true }));
        return msg.reply({ embeds: [embed] });
    }

    if (cmd === "dashboard") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        
        let desc = "";
        let totalHeld = 0;
        const addresses = Object.keys(tempWallets);

        if (addresses.length === 0) {
            desc = "No temporary wallets generated at the moment.";
        } else {
            addresses.forEach(addr => {
                const bal = tempWallets[addr].balance || 0;
                totalHeld += bal;
                desc += `**Address:** \`${addr}\`\n**Balance:** \`${bal} LTC\`\n\n`;
            });
        }

        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83C\uDFE6 Temporary Wallet Dashboard")
            .setDescription(`Total in Wallets: **${totalHeld} LTC**\n\n${desc}\n*Note: Automatic withdrawal requires a cryptographic signing library.*`);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("withdraw_all_ltc")
                .setLabel("Withdraw / Transfer Funds")
                .setStyle(ButtonStyle.Success)
                .setEmoji("\uD83D\uDCB8")
        );

        msg.reply({ embeds: [embed], components: addresses.length > 0 ? [row] : [] });
    }

    if (cmd === "stock") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        try {
            const res = await sellAuthAPI.get("/products");
            const products = res.data.data;
            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCE6 Shop Stock (Staff View)")
                .setDescription("Detailed view for staff.")
                .setThumbnail(msg.guild.iconURL());

            products.forEach(p => {
                let variantsList = "";
                if (p.variants && p.variants.length > 0) {
                    p.variants.forEach(v => {
                        variantsList += `\u2022 ${v.name} (ID: \`${v.id}\`): **${v.stock}**\n`;
                    });
                } else {
                    variantsList = `Stock: **${p.stock}**`;
                }

                embed.addFields({ 
                    name: `${p.name} (Base ID: ${p.id})`, 
                    value: `Slug: \`${p.slug}\`\n${variantsList}`, 
                    inline: false 
                });
            });
            msg.reply({ embeds: [embed] }).then(m => setTimeout(() => m.delete().catch(() => {}), 45000));
        } catch (e) { msg.reply("\u274C Error retrieving stock."); }
    }

    if (cmd === "restock") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const prodId = args[0];
        const stockData = args.slice(1).join("\n"); 
        if (!prodId || !stockData) return msg.reply("\u274C Uso: `,restock [ID Product/Variante] [lista prodotti]`");

        try {
            await sellAuthAPI.post(`/products/${prodId}/stock`, { stock: stockData });
            msg.reply(`\u2705 Stock updated for ID: \`${prodId}\``);
        } catch (e) { msg.reply("\u274C Error updating. Check the ID."); }
    }

    if (cmd === "livestock") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const channel = msg.mentions.channels.first() || msg.channel;
        liveStockConfig.channelId = channel.id;
        liveStockConfig.lastMsgId = null;
        save("./livestock.json", liveStockConfig);
        msg.reply(`\u2705 LiveStock channel set to <#${channel.id}>.`);
    }

    // ================= PURGE COMMAND =================
    if (cmd === "purge") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const limit = args[0] ? parseInt(args[0]) : null;
        await msg.delete().catch(() => {});
        try {
            if (limit && limit <= 100) {
                // Fetch and bulk delete up to 100 at once
                const fetched = await msg.channel.messages.fetch({ limit });
                await msg.channel.bulkDelete(fetched, true);
                const notice = await msg.channel.send(`\uD83D\uDDD1\uFE0F Deleted ${fetched.size} messages.`);
                setTimeout(() => notice.delete().catch(() => {}), 3000);
            } else {
                // Delete all: loop fetching 100 at a time until none left
                let deleted = 0;
                let fetched;
                do {
                    fetched = await msg.channel.messages.fetch({ limit: 100 });
                    // bulkDelete only works for messages < 14 days old
                    const recent = fetched.filter(m => Date.now() - m.createdTimestamp < 12 * 24 * 60 * 60 * 1000);
                    if (recent.size > 0) {
                        await msg.channel.bulkDelete(recent, true);
                        deleted += recent.size;
                    }
                    // Delete older ones one by one
                    const old = fetched.filter(m => Date.now() - m.createdTimestamp >= 12 * 24 * 60 * 60 * 1000);
                    for (const [, m] of old) {
                        await m.delete().catch(() => {});
                        deleted++;
                    }
                    await new Promise(r => setTimeout(r, 1000)); // rate limit pause
                } while (fetched.size >= 2);
                const notice = await msg.channel.send(`\uD83D\uDDD1\uFE0F Deleted ${deleted} messages.`);
                setTimeout(() => notice.delete().catch(() => {}), 3000);
            }
        } catch (e) { msg.channel.send("\u274C Error during purge: " + e.message).catch(() => {}); }
    }

    // ================= CHECK COMMAND (SellAuth order details by invoice ID) =================
    if (cmd === "check") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const invoiceId = args[0];
        if (!invoiceId) return msg.reply("\u274C Usage: `,check [invoice ID]`");
        try {
            const res = await sellAuthAPI.get("/invoices/" + invoiceId);
            const o = res.data;
            const item = o.items && o.items[0] ? o.items[0] : null;
            const productName = (item && item.product && item.product.name) ? item.product.name : "N/A";
            const quantity = (item && item.quantity) ? item.quantity : 1;
            const price = parseFloat(o.price || 0).toFixed(2);
            const currency = (o.currency || "EUR").toUpperCase();
            const gatewayStr = typeof o.gateway === "string" ? o.gateway
                : (o.payment_method && o.payment_method.name) ? o.payment_method.name : "N/A";
            const createdAt = o.created_at ? `<t:${Math.floor(new Date(o.created_at).getTime() / 1000)}:F>` : "N/A";
            const completedAt = o.completed_at ? `<t:${Math.floor(new Date(o.completed_at).getTime() / 1000)}:F>` : "N/A";

            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83E\uDDFE Invoice #" + o.id)
                .addFields(
                    { name: "\uD83D\uDCE6 Product", value: "`" + productName + "`", inline: true },
                    { name: "<:box:1496249522353995948> Quantity", value: "`" + quantity + "`", inline: true },
                    { name: "<:mon:1496249604415684730> Price", value: "`" + price + " " + currency + "`", inline: true },
                    { name: "\uD83D\uDCB3 Gateway", value: "`" + gatewayStr + "`", inline: true },
                    { name: "\uD83D\uDCE7 Email", value: "`" + (o.email || "N/A") + "`", inline: true },
                    { name: "\uD83C\uDF0D Country", value: "`" + (o.country_code || "N/A") + "`", inline: true },
                    { name: "\u2705 Status", value: "`" + (o.status || "N/A").toUpperCase() + "`", inline: true },
                    { name: "\uD83D\uDCC5 Created", value: createdAt, inline: true },
                    { name: "\uD83C\uDFC1 Completed", value: completedAt, inline: true },
                    { name: "\uD83C\uDD94 Unique ID", value: "`" + (o.unique_id || o.id) + "`", inline: false }
                )
                .setTimestamp();
            msg.reply({ embeds: [embed] });
        } catch (e) {
            const detail = e.response ? `Status ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message;
            msg.reply("\u274C Invoice not found or API error:\n```" + detail.slice(0, 300) + "```");
        }
    }

    // ================= TX COMMAND (live LTC transaction tracker by txid) =================
    if (cmd === "tx") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const txid = args[0];
        if (!txid) return msg.reply(" Usage: `,tx [LTC txid]`");

        async function fetchTxInfo(id) {
            const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/txs/${id}?token=${CONFIG.BLOCKCYPHER_TOKEN}`);
            return res.json();
        }

        function buildTxEmbed(tx) {
            const confs = tx.confirmations || 0;
            const done = confs >= 6;
            const totalOut = (tx.outputs || []).reduce((s, o) => s + (o.value || 0), 0) / 100000000;
            const fee = tx.fees ? (tx.fees / 100000000).toFixed(8) : "N/A";
            const senders = (tx.inputs || []).flatMap(i => i.addresses || []).slice(0, 3).join("\n") || "N/A";
            const receivers = (tx.outputs || []).flatMap(o => o.addresses || []).slice(0, 3).join("\n") || "N/A";
            const receivedAt = tx.received ? `<t:${Math.floor(new Date(tx.received).getTime()/1000)}:F>` : "N/A";
            const confirmedAt = tx.confirmed ? `<t:${Math.floor(new Date(tx.confirmed).getTime()/1000)}:F>` : "Pending";
            const status = done ? " Confirmed" : confs > 0 ? `⏳ ${confs}/6 confirmations` : " Unconfirmed (mempool)";
            const color = done ? "#00FF00" : confs > 0 ? "#FFA500" : "#5FB3C4";
            const footer = done ? " Transaction confirmed • Astro Exchange" : " Updates every 2 seconds • Astro Exchange";
            return new EmbedBuilder()
                .setColor(color)
                .setTitle(" LTC Transaction Tracker")
                .addFields(
                    { name: " TXID", value: `\`${txid}\``, inline: false },
                    { name: " Status", value: status, inline: true },
                    { name: " Confirmations", value: `\`${confs}\``, inline: true },
                    { name: " Total Sent", value: `\`${totalOut.toFixed(8)} LTC\``, inline: true },
                    { name: " Fee", value: `\`${fee} LTC\``, inline: true },
                    { name: " From", value: `\`${senders.slice(0, 200)}\``, inline: false },
                    { name: " To", value: `\`${receivers.slice(0, 200)}\``, inline: false },
                    { name: " Received", value: receivedAt, inline: true },
                    { name: " Confirmed At", value: confirmedAt, inline: true }
                )
                .setFooter({ text: footer })
                .setTimestamp();
        }

        try {
            const tx = await fetchTxInfo(txid);
            if (tx.error) return msg.reply(` Transaction not found: \`${tx.error}\``);
            const liveMsg = await msg.reply({ embeds: [buildTxEmbed(tx)] });
            if ((tx.confirmations || 0) >= 6) return;
            const interval = setInterval(async () => {
                try {
                    const updated = await fetchTxInfo(txid);
                    await liveMsg.edit({ embeds: [buildTxEmbed(updated)] }).catch(() => {});
                    if ((updated.confirmations || 0) >= 6) clearInterval(interval);
                } catch(e) {}
            }, 2000);
        } catch(e) { msg.reply(` API error: ${e.message}`); }
    }

    // ================= TXID COMMAND (SellAuth order by ID) =================
    if (cmd === "txid") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const orderId = args[0];
        if (!orderId) return msg.reply(" Usage: `,txid [SellAuth order ID]`");
        try {
            const res = await sellAuthAPI.get(`/orders/${orderId}`);
            const o = res.data?.data || res.data;
            if (!o) return msg.reply(" Order not found.");
            const status = (o.status || "unknown").toUpperCase();
            const statusIcon = status === "COMPLETED" || status === "PAID" ? "" : status === "PENDING" ? "⏳" : "";
            const email = o.email || "N/A";
            const atIdx = email.indexOf("@");
            const masked = atIdx > 1 ? email[0] + "****" + email[atIdx-1] + email.slice(atIdx) : email;
            const price = parseFloat(o.price || o.total || 0).toFixed(2);
            const gateway = (o.gateway || o.payment_method || "N/A");
            const date = o.created_at ? `<t:${Math.floor(new Date(o.created_at).getTime()/1000)}:F>` : "N/A";
            const productName = o.product_name || o.product?.name || "N/A";
            const productSlug = o.product_slug || o.product?.slug || "";
            const productUrl = productSlug ? `${CONFIG.BASE_SHOP_URL}/product/${productSlug}` : CONFIG.BASE_SHOP_URL;
            const quantity = o.quantity || o.qty || 1;

            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(` SellAuth Order #${orderId}`)
                .addFields(
                    { name: " Product", value: `[${productName}](${productUrl})`, inline: true },
                    { name: " Quantity", value: `\`${quantity}\``, inline: true },
                    { name: " Status", value: `${statusIcon} \`${status}\``, inline: true },
                    { name: " Price", value: `\`${price} EUR\``, inline: true },
                    { name: " Method", value: `\`${gateway}\``, inline: true },
                    { name: " Email", value: `\`${masked}\``, inline: true },
                    { name: " Date", value: date, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: "Astro Exchange | SellAuth Order" });

            // If completed, show delivered product keys if available
            if ((status === "COMPLETED" || status === "PAID") && o.serials) {
                const keys = Array.isArray(o.serials) ? o.serials.join("\n") : String(o.serials);
                embed.addFields({ name: " Delivered Keys", value: `\`\`\`${keys.slice(0, 900)}\`\`\``, inline: false });
            }
            msg.reply({ embeds: [embed] });
        } catch(e) {
            const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
            msg.reply(` Error: \`${detail.slice(0, 300)}\``);
        }
    }

    // ================= LTCINFO COMMAND =================
    if (cmd === "send") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_EXCHANGE_ROLE_ID)) return msg.reply(" Staff Exchange only.");
        const walletData = exchangerWallets[msg.author.id];
        if (!walletData?.active) return msg.reply(" No wallet found. Use `/createltc` first.");
        const destAddress = args[0];
        const amountRaw = args[1];
        if (!destAddress || !amountRaw) return msg.reply(" Usage: `,send [address] [amount LTC or EUR€]`");
        let amountLtc;
        if (amountRaw.endsWith("€") || amountRaw.toLowerCase().endsWith("eur")) {
            const eur = parseFloat(amountRaw.replace(/[€EUR\s]/gi, ""));
            if (isNaN(eur) || eur <= 0) return msg.reply(" Invalid EUR amount.");
            amountLtc = eur / cachedLtcPrice;
        } else {
            amountLtc = parseFloat(amountRaw);
            if (isNaN(amountLtc) || amountLtc <= 0) return msg.reply(" Invalid LTC amount.");
        }
        try {
            const result = await sendLTC(walletData.wif, walletData.address, destAddress, Math.round(amountLtc * 100000000), false);
            const logCh = msg.guild.channels.cache.get(CONFIG.EXCHANGER_WALLET_LOG_CHANNEL_ID);
            if (logCh) {
                const logEmbed = new EmbedBuilder().setColor("#FFA500").setTitle(" Exchanger Send")
                    .addFields({ name:" Sender",value:`<@${msg.author.id}>`,inline:true },{ name:" From",value:`\`${walletData.address}\``,inline:false },{ name:" To",value:`\`${destAddress}\``,inline:false },{ name:" Amount",value:`\`${(result.sentSatoshis/100000000).toFixed(8)} LTC\``,inline:true },{ name:" TX Hash",value:`\`${result.txHash}\``,inline:false }).setTimestamp();
                await logCh.send({ embeds: [logEmbed] }).catch(() => {});
            }
            const receiverEntry1 = Object.entries(exchangerWallets).find(([,w]) => w.address === destAddress);
            const receiverUserId1 = receiverEntry1 ? receiverEntry1[0] : msg.author.id;
            await sendTradeEmbed(msg.guild, msg.author.id, receiverUserId1, result.sentSatoshis/100000000, result.txHash);
            msg.reply(` Sent \`${(result.sentSatoshis/100000000).toFixed(8)} LTC\` to \`${destAddress}\`\n TX: \`${result.txHash}\``);
        } catch(e) { msg.reply(` Transaction failed: ${e.message.slice(0, 300)}`); }
    }

    if (cmd === "ltcinfo") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const address = args[0];
        if (!address) return msg.reply(" Usage: `,ltcinfo [LTC address]`");
        try {
            const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=10&token=${CONFIG.BLOCKCYPHER_TOKEN}`);
            const data = await res.json();
            if (data.error) return msg.reply(` ${data.error}`);

            const balance = (data.balance || 0) / 100000000;
            const totalReceived = (data.total_received || 0) / 100000000;
            const totalSent = (data.total_sent || 0) / 100000000;
            const txCount = data.n_tx || 0;
            const unconfirmed = (data.unconfirmed_balance || 0) / 100000000;

            // Last 10 transactions
            const txRefs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])].slice(0, 10);
            const txLines = txRefs.length > 0
                ? txRefs.map(t => {
                    const val = (t.value || 0) / 100000000;
                    const sent = t.spent !== undefined ? (t.spent ? "" : "") : "";
                    const conf = t.confirmations || 0;
                    const ts = t.confirmed ? `<t:${Math.floor(new Date(t.confirmed).getTime()/1000)}:d>` : "Pending";
                    return `${sent} \`${val.toFixed(6)} LTC\` • ${conf} conf • ${ts} • \`${t.tx_hash?.slice(0,12)}...\``;
                }).join("\n")
                : "No transactions found.";

            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" LTC Address Info")
                .addFields(
                    { name: " Address", value: `\`${address}\``, inline: false },
                    { name: " Balance", value: `\`${balance.toFixed(8)} LTC\``, inline: true },
                    { name: "⏳ Unconfirmed", value: `\`${unconfirmed.toFixed(8)} LTC\``, inline: true },
                    { name: " Total TXs", value: `\`${txCount}\``, inline: true },
                    { name: " Total Received", value: `\`${totalReceived.toFixed(8)} LTC\``, inline: true },
                    { name: " Total Sent", value: `\`${totalSent.toFixed(8)} LTC\``, inline: true },
                    { name: " Last 10 Transactions", value: txLines.slice(0, 1024), inline: false }
                )
                .setTimestamp()
                .setFooter({ text: "Astro Exchange | BlockCypher LTC" });
            msg.reply({ embeds: [embed] });
        } catch(e) { msg.reply(` API error: ${e.message}`); }
    }


    // ================= TEST COMMAND =================
    if (cmd === "test") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;

        const promptEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(" Test Mode")
            .setDescription("What do you want to test? Reply with a number:")
            .addFields(
                { name: "1⃣", value: "New order notification", inline: true },
                { name: "2⃣", value: "Slot creation embed", inline: true },
                { name: "3⃣", value: "LTC payment request", inline: true },
                { name: "4⃣", value: "LTC trade completed log", inline: true },
                { name: "5⃣", value: "Join log embed", inline: true },
                { name: "6⃣", value: "Vouch DM", inline: true },
                { name: "7⃣", value: "LTC address lookup", inline: true },
                { name: "8⃣", value: "LiveStock embed", inline: true }
            )
            .setFooter({ text: "Reply with the number within 30 seconds" });

        await msg.reply({ embeds: [promptEmbed] });

        const filter = m => m.author.id === msg.author.id && /^[1-8]$/.test(m.content.trim());
        const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 30000 }).catch(() => null);
        if (!collected || !collected.size) return msg.channel.send("⏱ Test cancelled — no response.");

        const choice = collected.first().content.trim();
        await collected.first().delete().catch(() => {});

        const fakeUsers = 
            { id: "392847561029384756", tag: "cosmic.user", username: "cosmicuser" },
            { id: "748392016574839201", tag: "nova_trades", username: "nova_trades" },
            { id: "192837465029384756", tag: "[stellar.exchange", username: "stellarexchange" }
        ];
        const fakeUser = fakeUsers[Math.floor(Math.random() * fakeUsers.length)];
        const fakeProducts = ["Nitro Boost 1 Month", "14x Server Boost", "Nitro Basic 3 Months", "Discord Nitro 1 Year"];
        const fakeProduct = fakeProducts[Math.floor(Math.random() * fakeProducts.length)];
        const fakePrice = (Math.random() * 40 + 3).toFixed(2);
        const fakeLtc = (Math.random() * 0.5 + 0.01).toFixed(6);
        const fakeTxHash = Array.from({length: 64}, () => "0123456789abcdef"[Math.floor(Math.random()*16)]).join("");
        const fakeLtcAddr = "L" + Array.from({length: 33}, () => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(Math.random()*58)]).join("");
        const fakeGateways = ["PayPal", "LTC", "BTC", "USDT"];
        const fakeGateway = fakeGateways[Math.floor(Math.random() * fakeGateways.length)];
        const fakeQty = Math.floor(Math.random() * 5 + 1);
        const now = Date.now();

        if (choice === "1") {
            const gatewayEmoji = { PayPal: "", LTC: "<:ltc:1430879299652812872>", BTC: "₿", USDT: "" };
            const orderEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(`ORDER COMPLETED #${Math.floor(Math.random()*9000+1000)}`)
                .setDescription(
                    `${gatewayEmoji[fakeGateway] || ""} **New Order!**\n\n` +
                    `**Product:** [${fakeProduct}](${CONFIG.BASE_SHOP_URL})\n` +
                    `**Quantity:** \`${fakeQty}\`\n` +
                    `**Price:** \`${fakePrice} EUR\`\n` +
                    `**Method:** ${fakeGateway}\n` +
                    `**Email:** \`[t****r@gmail.com](mailto:t****r@gmail.com)\`\n` +
                    `**Date:** <t:${Math.floor(now/1000)}:F>`
                )
                .setTimestamp();
            await msg.channel.send({ embeds: [orderEmbed] });
        }
        else if (choice === "2") {
            const cats = ["First", "Second", "Third"];
            const durs = ["Weekly", "Monthly", "Lifetime"];
            const cat = cats[Math.floor(Math.random()*3)];
            const dur = durs[Math.floor(Math.random()*3)];
            const expiry = dur === "Lifetime" ? "Never" : `<t:${Math.floor((now + 30*24*3600000)/1000)}:D>`;
            const slotEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("Slot Created!")
                .setDescription(
                    `**• Username:** \`${fakeUser.username}\`\n` +
                    `**• User ID:** \`${fakeUser.id}\`\n\n` +
                    `**• Slot name:** \`${fakeUser.username}\`\n` +
                    `**• Category:** \`${cat} | ${dur}\`\n` +
                    `**• Expiry date:** ${expiry}`
                )
                .setTimestamp();
            const jumpRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel("Jump to Slot").setURL("https://discord.com/channels/1418195263444619266/1430879265984872519").setStyle(ButtonStyle.Link)
            );
            await msg.channel.send({ embeds: [slotEmbed], components: [jumpRow] });
        }
        else if (choice === "3") {
            const payEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Automatic LTC Payment")
                .setDescription(`**Address:** \`${fakeLtcAddr}\`\n**Amount:** \`${fakeLtc} LTC\`\n**EUR:** \`${fakePrice}€\``);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_addy_${fakeLtcAddr}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`copy_amt_${fakeLtc}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("check_payment_btn").setLabel(" Payment Completed").setStyle(ButtonStyle.Success)
            );
            await msg.channel.send({ content: `<@${fakeUser.id}>`, embeds: [payEmbed], components: [row] });
        }
        else if (choice === "4") {
            const tradeEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setDescription(
                    `\n**<:ltc:1497994881262682173> Litecoin trade completed**\n\n` +
                    `**Sender**\n<@${msg.author.id}>\n` +
                    `**Receiver**\n<@${msg.author.id}>\n` +
                    `**Amount**\n\`$${(parseFloat(fakeLtc) * cachedLtcUsd).toFixed(2)}\`\n` +
                    `**Transaction ID**\n[${fakeTxHash}](https://live.blockcypher.com/ltc/tx/${fakeTxHash}/)`
                )
                .setTimestamp();
            await msg.channel.send({ embeds: [tradeEmbed] });
        }
        else if (choice === "5") {
            const createdTs = Math.floor((now - Math.random()*365*24*3600000) / 1000);
            const accountAge = Math.floor((now/1000 - createdTs) / 86400);
            const joinEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Member Joined")
                .setThumbnail(msg.author.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: " User", value: `<@${fakeUser.id}>\n\`${fakeUser.tag}\``, inline: true },
                    { name: " ID", value: `\`${fakeUser.id}\``, inline: true },
                    { name: " Account Created", value: `<t:${createdTs}:F>\n<t:${createdTs}:R>`, inline: false },
                    { name: " Account Age", value: `\`${accountAge} days\``, inline: true },
                    { name: " Members", value: `\`${Math.floor(Math.random()*500+100)}\``, inline: true },
                    { name: " Previously Banned", value: "`No`", inline: true }
                )
                .setTimestamp()
                .setFooter({ text: "Astro Exchange | Join Log" });
            await msg.channel.send({ embeds: [joinEmbed] });
        }
        else if (choice === "6") {
            const vouchText = `+vouch ${msg.author.id} x${fakeQty} ${fakeProduct} | ${fakePrice}€ ${fakeGateway.toUpperCase()}`;
            const vouchEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Your Vouch is Ready!")
                .setDescription(`Here is your vouch, copy and paste it:\n\n\`\`\`${vouchText}\`\`\`\n\nPlease leave it in <#${CONFIG.VOUCH_CHANNEL_ID}>.`);
            await msg.author.send({ embeds: [vouchEmbed] }).catch(() => {});
            await msg.channel.send(` Vouch DM sent to you:\n\`\`\`${vouchText}\`\`\``);
        }
        else if (choice === "7") {
            const fakeBalance = (Math.random() * 2).toFixed(8);
            const fakeSent = (Math.random() * 10).toFixed(8);
            const fakeReceived = (parseFloat(fakeBalance) + parseFloat(fakeSent)).toFixed(8);
            const fakeTxCount = Math.floor(Math.random() * 200 + 5);
            const lastTs = Math.floor((now - Math.random()*7*24*3600000)/1000);
            const ltcUsd = cachedLtcUsd;
            const lookupEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setAuthor({ name: "Litecoin Address", iconURL: "https://cryptologos.cc/logos/litecoin-ltc-logo.png" })
                .addFields(
                    { name: "Address", value: `\`${fakeLtcAddr}\``, inline: false },
                    { name: "Balance", value: `${fakeBalance} LTC ($${(parseFloat(fakeBalance)*ltcUsd).toFixed(2)})`, inline: true },
                    { name: "Transactions", value: `${fakeTxCount}`, inline: true },
                    { name: "Total Sent", value: `${fakeSent} LTC ($${(parseFloat(fakeSent)*ltcUsd).toFixed(2)})`, inline: false },
                    { name: "Total Received", value: `${fakeReceived} LTC ($${(parseFloat(fakeReceived)*ltcUsd).toFixed(2)})`, inline: false },
                    { name: "Last Transaction", value: `<t:${lastTs}:D> at <t:${lastTs}:t>\n<t:${lastTs}:R>`, inline: false }
                )
                .setFooter({ text: `Astro Exchange • Requested by ${msg.author.tag}`, iconURL: msg.author.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            await msg.channel.send({ embeds: [lookupEmbed] });
        }
        else if (choice === "8") {
            const fakeStock = [
                { name: "Nitro Boost 1 Month", stock: Math.floor(Math.random()*50), price: "4.99", slug: "nitrbst1month", nitro: true },
                { name: "14x Server Boost", stock: Math.floor(Math.random()*20), price: "14.99", slug: "14srvrboost", boost: true },
                { name: "Nitro Basic 3 Months", stock: Math.floor(Math.random()*30), price: "8.99", slug: "nitrobasic3m", nitro: true },
                { name: "Discord Nitro 1 Year", stock: Math.floor(Math.random()*10), price: "49.99", slug: "nitro1year", nitro: true }
            ];
            const stockEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("LIVESTOCK")
                .setFooter({ text: "Astro Exchange • Updates every 15 seconds" })
                .setTimestamp();
            let desc = "";
            for (const p of fakeStock) {
                const link = `${CONFIG.BASE_SHOP_URL}/product/${p.slug}`;
                const prefix = p.nitro ? "<a:nb:1496551004500529304> " : p.boost ? "<a:srvbost:1497239285605204049> " : "";
                desc += `${prefix}**${[p.name}**](${link})\n> <:box:1496249522353995948> : \`${p.stock}\`\n> <:mon:1496249604415684730> : \`${p.price} EUR\`\n>  : \`Instant Delivery\`\n\n`;
            }
            stockEmbed.setDescription(desc);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel("Visit Shop").setURL(`${CONFIG.BASE_SHOP_URL}/#products`).setStyle(ButtonStyle.Link)
            );
            await msg.channel.send({ embeds: [stockEmbed], components: [row] });
        }
        return;
    }

    // ================= TESTALL COMMAND =================
    if (cmd === "testall") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const statusMsg = await msg.reply("⏳ Running diagnostics on all systems...");
        const results = [];

        const check = async (name, fn) => {
            try {
                const result = await fn();
                results.push({ name, ok: true, detail: result || "OK" });
            } catch(e) {
                results.push({ name, ok: false, detail: e.response?.data ? JSON.stringify(e.response.data).slice(0, 100) : e.message.slice(0, 100) });
            }
        };

        // 1. SellAuth API - orders
        await check("SellAuth /orders", async () => {
            const r = await sellAuthAPI.get("/orders");
            const d = r.data;
            const orders = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
            return `${orders.length} orders found`;
        });

        // 2. SellAuth API - products
        await check("SellAuth /products", async () => {
            const r = await sellAuthAPI.get("/products");
            const d = r.data;
            const products = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : [];
            return `${products.length} products found`;
        });

        // 3. BlockCypher - LTC price
        await check("LTC Price (CoinGecko)", async () => {
            return `1 LTC = ${cachedLtcPrice} EUR`;
        });

        // 4. BlockCypher - API access
        await check("BlockCypher API", async () => {
            const r = await fetch(`https://api.blockcypher.com/v1/ltc/main?token=${CONFIG.BLOCKCYPHER_TOKEN}`);
            const d = await r.json();
            if (d.error) throw new Error(d.error);
            return `Block height: ${d.height}`;
        });

        // 5. Discord - Log channels
        await check("Log Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Global Log Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.GLOBAL_LOG_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Join Log Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.JOIN_LOG_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Leave Log Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.LEAVE_LOG_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Ping Log Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.PING_LOG_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Scammer Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.SCAMMER_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        await check("Vouch Channel", async () => {
            const ch = msg.guild.channels.cache.get(CONFIG.VOUCH_CHANNEL_ID);
            if (!ch) throw new Error("Channel not found");
            return `#${ch.name}`;
        });

        // 6. Roles
        await check("Staff Role", async () => {
            const r = msg.guild.roles.cache.get(CONFIG.STAFF_ROLE_ID);
            if (!r) throw new Error("Role not found");
            return `@${r.name}`;
        });

        await check("Slot Owner Role", async () => {
            const r = msg.guild.roles.cache.get(CONFIG.SLOT_OWNER_ROLE_ID);
            if (!r) throw new Error("Role not found");
            return `@${r.name}`;
        });

        await check("On Hold Role", async () => {
            const r = msg.guild.roles.cache.get(CONFIG.ON_HOLD_ROLE_ID);
            if (!r) throw new Error("Role not found");
            return `@${r.name}`;
        });

        // 7. LiveStock config
        await check("LiveStock Config", async () => {
            if (!liveStockConfig.channelId) throw new Error("No channel set — run ,livestock first");
            const ch = msg.guild.channels.cache.get(liveStockConfig.channelId);
            if (!ch) throw new Error("Configured channel not found in server");
            return `#${ch.name} (msg: ${liveStockConfig.lastMsgId || "none"})`;
        });

        // 8. Pending payments / slots count
        await check("Pending Payments", async () => {
            return `${Object.keys(pendingPayments).length} pending`;
        });

        await check("Active Slots", async () => {
            return `${Object.keys(slots).length} slots`;
        });

        await check("MM Sessions", async () => {
            return `${Object.keys(mmSessions).length} sessions`;
        });

        // Build result embed
        const passed = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok).length;
        const color = failed === 0 ? "#00FF00" : failed < 3 ? "#FFA500" : "#FF0000";

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(` Bot Diagnostics — ${passed}/${results.length} passed`)
            .setDescription(results.map(r =>
                `${r.ok ? "" : ""} **${r.name}** — ${r.detail}`
            ).join("\n"))
            .setTimestamp()
            .setFooter({ text: "Astro Exchange | testall" });

        await statusMsg.edit({ content: "", embeds: [embed] });
        return;
    }

    if (cmd === "deleteproduct") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const prodId = args[0];
        if (!prodId) return msg.reply(" Usage: `,deleteproduct [ProductID]`");
        try {
            await sellAuthAPI.delete(`/products/${prodId}`);
            msg.reply(`\uD83D\uDDD1\uFE0F Product \`${prodId}\` deleted.`);
        } catch (e) { msg.reply("\u274C Error deleting product."); }
    }

    // ================= TESTORDER COMMAND (debug: shows raw fields of last order) =================
    if (cmd === "testorder") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        try {
            // Try both endpoints
            let orders = [];
            let usedEndpoint = "";
            let rawResponse = null;
            try {
                const res = await sellAuthAPI.get("/invoices");
                rawResponse = res.data;
                usedEndpoint = "/invoices";
                if (Array.isArray(rawResponse)) orders = rawResponse;
                else if (rawResponse && Array.isArray(rawResponse.data)) orders = rawResponse.data;
                else if (rawResponse && rawResponse.data && Array.isArray(rawResponse.data.data)) orders = rawResponse.data.data;
            } catch(e1) {
                try {
                    const res = await sellAuthAPI.get("/orders");
                    rawResponse = res.data;
                    usedEndpoint = "/orders";
                    if (Array.isArray(rawResponse)) orders = rawResponse;
                    else if (rawResponse && Array.isArray(rawResponse.data)) orders = rawResponse.data;
                    else if (rawResponse && rawResponse.data && Array.isArray(rawResponse.data.data)) orders = rawResponse.data.data;
                } catch(e2) {
                    return msg.reply("\u274C Both endpoints failed:\n/invoices: " + e1.message + "\n/orders: " + e2.message);
                }
            }
            // Show raw response structure
            const rawStr = JSON.stringify(rawResponse, null, 2).slice(0, 1500);
            await msg.reply("**Endpoint used:** `" + usedEndpoint + "`\n**Orders found:** `" + orders.length + "`\n**Raw response (truncated):**\n```json\n" + rawStr + "\n```");
            if (!orders.length) return;
            // Show ALL fields of last order
            const last = orders[orders.length - 1];
            const fields = Object.entries(last)
                .map(([k, v]) => "**" + k + ":** `" + JSON.stringify(v).slice(0, 100) + "`")
                .join("\n");
            await msg.channel.send("**Fields of last order:**\n" + fields.slice(0, 1900));
        } catch(e) {
            msg.reply("\u274C Error: " + e.message);
        }
    }
    if (cmd === "help") {
        const banner = new AttachmentBuilder("https://cdn.discordapp.com/attachments/1430879287728148631/1498395062458126346/6DCCD550-4682-477F-AB9C-159B8F40BC19.png", { name: "banner.png" });
        const helpEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setImage("attachment://banner.png")
            .addFields(
                {
                    name: " User Commands",
                    value: "`,ltc [€]` — Convert EUR→LTC & show your address\n`,setltc [addr]` — Save your LTC address (owner only)",
                    inline: false
                },
                {
                    name: " Tickets",
                    value: "Open via the panel in the tickets channel:\n• **Slot Purchase** — buy/renew a slot\n• **Product Purchase** — buy a product\n• **Exchange** — exchange currencies/crypto\n• **MM** — auto middleman service",
                    inline: false
                },
                {
                    name: " Lookup",
                    value: "`,tx [txid]` — Track LTC transaction\n`,ltcinfo [addr]` — LTC address info\n`,ltc [€]` — EUR to LTC converter",
                    inline: false
                },
                {
                    name: "ℹ Staff",
                    value: "Use `,helpstaff` to see all staff commands.",
                    inline: false
                }
            )
            .setFooter({ text: "Astro Exchange • Deletes in 10 seconds" })
            .setTimestamp();
        const helpReply = await msg.reply({ embeds: [helpEmbed] });
        setTimeout(() => {
            helpReply.delete().catch(() => {});
            msg.delete().catch(() => {});
        }, 10000);
        return;
    }

    // ================= SETFEES COMMAND =================
    if (cmd === "setfees") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return msg.reply("❌ Admin only.");
        
        const usage = "❌ Usage: `,setfees [type] [tier] [value]`\n\n" +
            "**Types:** `p2c` (PayPal to Crypto), `c2c` (Crypto to Crypto), `c2p` (Crypto to PayPal)\n" +
            "**P2C Tiers:** `under10`, `10-25`, `25-50`, `over50`\n" +
            "**C2C Tiers:** `under25`, `25-50`, `over50`\n" +
            "**C2P:** just value (e.g., `,setfees c2p 0`)\n\n" +
            "**Examples:**\n" +
            "`,setfees p2c under10 0.5`\n" +
            "`,setfees c2c 25-50 3`\n" +
            "`,setfees c2p 0`";

        const type = args[0];
        const tier = args[1];
        const value = parseFloat(args[2]);

        if (!type) return msg.reply(usage);

        if (type === "c2p") {
            const val = parseFloat(tier); // tier is actually the value for c2p
            if (isNaN(val)) return msg.reply(usage);
            exchangeFees.crypto_to_paypal = val;
            save("./exchange_fees.json", exchangeFees);
            return msg.reply(`✅ Crypto to PayPal fee set to **${val}%**`);
        }

        if (!tier || isNaN(value)) return msg.reply(usage);

        if (type === "p2c") {
            const tierMap = { "under10": "under_10", "10-25": "10_25", "25-50": "25_50", "over50": "over_50" };
            const key = tierMap[tier];
            if (!key) return msg.reply(usage);
            exchangeFees.paypal_to_crypto[key] = value;
            save("./exchange_fees.json", exchangeFees);
            return msg.reply(`✅ PayPal to Crypto **${tier}** fee set to **${value}${tier === "under10" ? "€" : "%"}**`);
        }

        if (type === "c2c") {
            const tierMap = { "under25": "under_25", "25-50": "25_50", "over50": "over_50" };
            const key = tierMap[tier];
            if (!key) return msg.reply(usage);
            exchangeFees.crypto_to_crypto[key] = value;
            save("./exchange_fees.json", exchangeFees);
            return msg.reply(`✅ Crypto to Crypto **${tier}** fee set to **${value}%**`);
        }

        return msg.reply(usage);
    }

    // ================= ADDBALANCE COMMAND =================
    if (cmd === "addbalance") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return msg.reply("❌ Staff only.");
        const target = msg.mentions.users.first();
        const amount = parseFloat(args[1]);
        if (!target || isNaN(amount) || amount <= 0) return msg.reply("❌ Usage: `,addbalance @user [amount in EUR]`");
        
        if (!userBalances[target.id]) userBalances[target.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0 };
        userBalances[target.id].balance += amount;
        save("./user_balances.json", userBalances);
        
        return msg.reply(`✅ Added **${amount.toFixed(2)}€** to <@${target.id}>. New balance: **${userBalances[target.id].balance.toFixed(2)}€**`);
    }

    // ================= INFO COMMAND =================
    if (cmd === "info") {
        if (!userBalances[msg.author.id]) userBalances[msg.author.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0 };
        const stats = userBalances[msg.author.id];
        
        const infoEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Casino Statistics")
            .setThumbnail(msg.author.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: "Current Balance", value: `**${stats.balance.toFixed(2)}€**`, inline: true },
                { name: "Games Played", value: `**${stats.gamesPlayed || 0}**`, inline: true },
                { name: "\u200b", value: "\u200b", inline: true },
                { name: "Total Wagered", value: `${(stats.totalWagered || 0).toFixed(2)}€`, inline: true },
                { name: "Total Won", value: `${(stats.totalWon || 0).toFixed(2)}€`, inline: true },
                { name: "Total Lost", value: `${(stats.totalLost || 0).toFixed(2)}€`, inline: true },
                { name: "Net Profit/Loss", value: `**${((stats.totalWon || 0) - (stats.totalLost || 0)).toFixed(2)}€**`, inline: false }
            )
            .setFooter({ text: "Astro Exchange | Casino Stats" })
            .setTimestamp();
        
        return msg.channel.send({ embeds: [infoEmbed] });
    }

    // ================= TERMS OF SERVICE =================
    if (cmd === "tos") {
        const tosEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Astro Exchange | Terms of Service")
            .setDescription(
                `**By using Astro Exchange services, you agree to the following terms:**\n\n` +
                `# 1. Slot System\n` +
                `• Slots are categorized (First, Second, Third) with Weekly, Monthly, or Lifetime durations.\n` +
                `• Payment via LTC is required before slot activation.\n` +
                `• Slots can be placed on hold for excessive pinging (resets daily at midnight Italian time).\n` +
                `• Staff reserves the right to revoke slots for rule violations.\n\n` +
                `# 2. Ticket & Middleman Services\n` +
                `• Auto Middleman (MM) tickets are available for Slot Purchase, Product Purchase, and Exchange.\n` +
                `• All transactions are logged and monitored.\n` +
                `• Users must provide accurate information — false claims may result in removal.\n` +
                `• Staff decisions on disputes are final.\n\n` +
                `# 3. Escrow System\n` +
                `• Escrow holds buyer funds until delivery is confirmed.\n` +
                `• A **0.25% service fee** is charged on all escrow transactions (plus network fees).\n` +
                `• Supported currencies: LTC, BTC, ETH, SOL, USDT (Solana).\n` +
                `• Buyers must confirm delivery — once confirmed, funds are released and **cannot be reversed**.\n` +
                `• If a dispute arises, the buyer must click "Report Issue" for staff review.\n` +
                `• Staff may release funds to either party based on evidence.\n\n` +
                `# 4. Payment & Pricing\n` +
                `• All payments are processed in cryptocurrency (LTC, BTC, ETH, SOL, USDT).\n` +
                `• Prices are calculated at the time of transaction using live market rates.\n` +
                `• Blockchain network fees are separate and borne by the user.\n` +
                `• Failed or incorrect payments cannot be refunded by Astro Exchange.\n\n` +
                `# 5. SellAuth Integration\n` +
                `• Product stock and orders are synced with our SellAuth shop.\n` +
                `• Orders are fulfilled automatically upon payment confirmation.\n` +
                `• Refunds or exchanges must be requested within 24 hours of purchase.\n` +
                `• Digital products are non-refundable after delivery.\n\n` +
                `# 6. Exchanger Wallet System\n` +
                `• Staff with the "Staff Exchange" role can create personal LTC wallets.\n` +
                `• Wallets are tied to your Discord account and logged for security.\n` +
                `• You are responsible for safeguarding your recovery code.\n` +
                `• Lost recovery codes cannot be recovered by staff.\n` +
                `• All LTC transactions are logged in the trade log channel.\n\n` +
                `# 7. User Conduct\n` +
                `• Scamming, harassment, or fraudulent behavior results in immediate ban.\n` +
                `• Users reported in the scammer channel are auto-held if they own a slot.\n` +
                `• Spam, excessive pinging, or abuse of services may lead to penalties.\n` +
                `• Staff impersonation or phishing attempts are strictly prohibited.\n\n` +
                `# 8. Data & Privacy\n` +
                `• User IDs, transaction data, and wallet addresses are logged for security.\n` +
                `• Join/leave events, transactions, and vouches are recorded.\n` +
                `• Personal information is never shared with third parties.\n` +
                `• Users may request data deletion by contacting staff.\n\n` +
                `# 9. Vouch System\n` +
                `• Vouches are public endorsements of successful trades.\n` +
                `• False or paid vouches are prohibited and result in removal.\n` +
                `• Staff-generated vouches include product, quantity, price, and payment method.\n\n` +
                `# 10. Liability & Disclaimer\n` +
                `• Astro Exchange is a **platform facilitator** — we do not guarantee product quality or seller reliability.\n` +
                `• Cryptocurrency transactions are **irreversible** — double-check all addresses before sending.\n` +
                `• Network delays, blockchain issues, or exchange rate fluctuations are beyond our control.\n` +
                `• Users engage in trades at their own risk.\n\n` +
                `# 11. Service Modifications\n` +
                `• We reserve the right to update fees, features, or terms at any time.\n` +
                `• Major changes will be announced in the server.\n` +
                `• Continued use after updates constitutes acceptance of new terms.\n\n` +
                `# 12. Termination\n` +
                `• Staff may terminate user access for violations without prior notice.\n` +
                `• Banned users forfeit active slots and pending transactions.\n` +
                `• Appeals can be submitted to staff via ticket.\n\n` +
                `**For questions or disputes, open a ticket or contact staff.**\n` +
                `**Last updated:** May 2026`
            )
            .setFooter({ text: "Astro Exchange | Terms of Service" })
            .setTimestamp();

        await msg.channel.send({ embeds: [tosEmbed] });
        return;
    }

    if (cmd === "helpstaff") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const banner = new AttachmentBuilder("https://cdn.discordapp.com/attachments/1430879287728148631/1498395062458126346/6DCCD550-4682-477F-AB9C-159B8F40BC19.png", { name: "banner.png" });
        const staffEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setImage("attachment://banner.png")
            .addFields(
                {
                    name: " Slots",
                    value: "`,slot [@u] [W/M/L] [1/2/3] [LTC/MANUAL] [€] [ev] [hr]` — Create slot\n`,cslot [@u] [W/M/L] [1/2/3] [ev] [hr]` — Manual slot\n`,do [€]` — LTC payment in ticket\n`,complete [@u]` — Force-complete\n`,revoke [@u]` — Revoke slot\n`,hold [reason]` / `,unhold` — Hold/unhold slot\n`,nuke` — Nuke channel\n`,setupslot [1/2/3] [W/M/L] [ev] [hr]` — Configure pings\n`,info [@u]` — User slot & history",
                    inline: false
                },
                {
                    name: " Shop",
                    value: "`,dash` — SellAuth dashboard\n`,stock` — View stock with IDs\n`,restock [ID] [items]` — Add stock\n`,livestock [#ch]` — Set live stock channel\n`,deleteproduct [ID]` — Delete product\n`,dashboard` — Temp LTC wallets\n`,testorder` — Debug last order",
                    inline: false
                },
                {
                    name: " MM & Tickets",
                    value: "`,setup` — Post ticket panel\n`,setupmm` — Post MM panel\n`,adduser [ID]` — Add user to MM\n`,vouch` — Generate vouch",
                    inline: false
                },
                {
                    name: " Lookup",
                    value: "`,tx [txid]` — Track LTC tx (2s updates)\n`,txid [orderid]` — SellAuth order info\n`,ltcinfo [addr]` — LTC address info\n`,testall` — Run full diagnostics",
                    inline: false
                },
                {
                    name: " Moderation",
                    value: "`,ban [@u] [reason]` `,unban [ID]` `,mute [min] [@u]` `,kick [@u]`",
                    inline: false
                },
                {
                    name: " Server",
                    value: "`,addemoji <emoji1> <emoji2>...` — Add emojis to server",
                    inline: false
                }
            )
            .setFooter({ text: "Astro Exchange | Staff Commands" })
            .setTimestamp();
        await msg.reply({ embeds: [staffEmbed] });
        return;
    }

    if (cmd === "slot") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const target = msg.mentions.members.first() || await msg.guild.members.fetch(args[0]).catch(() => null);
        const durShort = args[1]?.toUpperCase();
        const catNum = args[2];
        const method = args[3]?.toUpperCase(); 
        const customPrice = args[4] ? parseFloat(args[4]) : null;
        const ovEv = args[5];
        const ovHr = args[6];
        const catMap = { "1": "First", "2": "Second", "3": "Third" };
        const durMap = { "W": "Weekly", "M": "Monthly", "L": "Lifetime" };
        if (!target || !durMap[durShort] || !catMap[catNum] || !method) {
            return msg.reply("\u274C Usage: `,slot [@user] [W/M/L] [1/2/3] [LTC/MANUAL] [price] [everyone] [here]`");
        }
        
        if (Object.values(slots).some(s => s.ownerId === target.id)) {
            return msg.reply("\u274C User already has an active slot! Max 1 slot per person.");
        }

        if (method === "MANUAL") {
            await createSlot(target, catMap[catNum], durMap[durShort], ovEv, ovHr);
            // Find the slot channel just created
            const slotEntry = Object.entries(slots).find(([, d]) => d.ownerId === target.id);
            const slotChannelId = slotEntry ? slotEntry[0] : null;
            const dur = durMap[durShort];
            const cat = catMap[catNum];
            const expiryTs = slotEntry ? slotEntry[1].expiry : null;
            const expiryStr = expiryTs && expiryTs !== "Never"
                ? `<t:${Math.floor(expiryTs / 1000)}:D>`
                : "Never";
            const createdEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("Slot Created!")
                .setDescription(
                    `**• Username:** \`${target.user?.username || "Unknown"}\`\n` +
                    `**• User ID:** \`${target.id}\`\n\n` +
                    `**• Slot name:** \`${target.user?.username || "Unknown"}\`\n` +
                    `**• Category:** \`${cat}\`\n` +
                    `**• Expiry date:** ${expiryStr}`
                )
                .setTimestamp();
            const jumpRow = slotChannelId ? new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel("Jump to Slot")
                    .setURL(`https://discord.com/channels/${msg.guild.id}/${slotChannelId}`)
                    .setStyle(ButtonStyle.Link)
            ) : null;
            return msg.reply({ embeds: [createdEmbed], components: jumpRow ? [jumpRow] : [] });
        } else if (method === "LTC") {
            const priceEur = customPrice || CONFIG.PRICES[`${catMap[catNum]}_${durMap[durShort]}`] || 10;
            const amountLtc = (priceEur / cachedLtcPrice).toFixed(6);
            
            const wallet = await generateLtcAddress();
            if (!wallet) return msg.reply("\u274C API Error: Cannot generate temporary wallet. Try again later.");
            const newAddress = wallet.address;

            tempWallets[newAddress] = { 
                ownerId: target.id, 
                balance: 0, 
                createdAt: Date.now(),
                privateKey: wallet.privateKey,
                wif: wallet.wif
            };
            save("./temp_wallets.json", tempWallets);

            pendingPayments[target.id] = { address: newAddress, amountLtc: parseFloat(amountLtc), category: catMap[catNum], duration: durMap[durShort], ovEv: ovEv, ovHr: ovHr, completed: false };
            save("./pending_payments.json", pendingPayments);
            
            const payEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("Automatic LTC Payment")
                .setDescription(`Payment for <@${target.id}>:\n\n**Address:** \`${newAddress}\`\n**Amount:** \`${amountLtc}\` LTC\n**Amount (EUR):** \`${priceEur}\`\u20AC\n\nCreating slot automatically upon confirmation.`);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_addy_${newAddress}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`copy_amt_${amountLtc}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("check_payment_btn").setLabel("Payment Completed").setStyle(ButtonStyle.Success)
            );
            return msg.reply({ embeds: [payEmbed], components: [row] });
        }
    }

    if (cmd === "setltc") {
        if (msg.author.id !== CONFIG.OWNER_ID) return msg.reply(" Only the owner can use this command.");
        const address = args[0];
        if (!address) return msg.reply(" Please provide an LTC address.");
        ltcData[msg.author.id] = address;
        save("./ltc.json", ltcData);
        msg.reply(" LTC Address saved successfully.");
    }

    if (cmd === "setupslot") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const catNum = args[0]; 
        const durShort = args[1]?.toUpperCase(); 
        const evPing = args[2];
        const herePing = args[3];
        const catMap = { "1": "First", "2": "Second", "3": "Third" };
        const durMap = { "W": "Weekly", "M": "Monthly", "L": "Lifetime" };
        if (!catMap[catNum] || !durMap[durShort] || isNaN(evPing) || isNaN(herePing)) {
            return msg.reply("\u274C Usage: `,setupslot [1/2/3] [W/M/L] [everyone pings] [here pings]`");
        }
        if (!pingConfig[catMap[catNum]]) pingConfig[catMap[catNum]] = {};
        pingConfig[catMap[catNum]][durMap[durShort]] = { everyone: parseInt(evPing), here: parseInt(herePing) };
        save("./pings.json", pingConfig);
        msg.reply(`\u2705 Configured **${catMap[catNum]}** (${durMap[durShort]}) with **${evPing}** everyone and **${herePing}** here pings.`);
    }

    if (cmd === "cslot") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const target = msg.mentions.members.first() || await msg.guild.members.fetch(args[0]).catch(() => null);
        const durShort = args[1]?.toUpperCase();
        const catNum = args[2];
        const ovEv = args[3];
        const ovHr = args[4];
        const catMap = { "1": "First", "2": "Second", "3": "Third" };
        const durMap = { "W": "Weekly", "M": "Monthly", "L": "Lifetime" };
        if (!target || !durMap[durShort] || !catMap[catNum]) return msg.reply("\u274C Usage: `,cslot [@user] [W/M/L] [1/2/3] [everyone] [here]`");
        
        if (Object.values(slots).some(s => s.ownerId === target.id)) {
            return msg.reply("\u274C User already has an active slot. Max 1 slot per person.");
        }

        await createSlot(target, catMap[catNum], durMap[durShort], ovEv, ovHr);
        const slotEntry2 = Object.entries(slots).find(([, d]) => d.ownerId === target.id);
        const slotChannelId2 = slotEntry2 ? slotEntry2[0] : null;
        const expiryTs2 = slotEntry2 ? slotEntry2[1].expiry : null;
        const expiryStr2 = expiryTs2 && expiryTs2 !== "Never"
            ? `<t:${Math.floor(expiryTs2 / 1000)}:D>`
            : "Never";
        const createdEmbed2 = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Slot Created!")
            .setDescription(
                `**• Username:** \`${target.user?.username || "Unknown"}\`\n` +
                `**• User ID:** \`${target.id}\`\n\n` +
                `**• Slot name:** \`${target.user?.username || "Unknown"}\`\n` +
                `**• Category:** \`${catMap[catNum]}\`\n` +
                `**• Expiry date:** ${expiryStr2}`
            )
            .setTimestamp();
        const jumpRow2 = slotChannelId2 ? new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Jump to Slot")
                .setURL(`https://discord.com/channels/${msg.guild.id}/${slotChannelId2}`)
                .setStyle(ButtonStyle.Link)
        ) : null;
        msg.reply({ embeds: [createdEmbed2], components: jumpRow2 ? [jumpRow2] : [] });
    }

    if (cmd === "ban") {
        if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return;
        const target = msg.mentions.members.first() || await msg.guild.members.fetch(args[0]).catch(() => null);
        if (!target) return msg.reply("\u274C User not found.");
        const reason = args.slice(1).join(" ") || "No reason provided.";
        await target.ban({ reason });
        msg.reply(`\u2705 Banned **${target.user?.tag || 'User'}**.`);
    }

    if (cmd === "unban") {
        if (!msg.member.permissions.has(PermissionFlagsBits.BanMembers)) return;
        const id = args[0];
        if (!id) return msg.reply("\u274C Provide ID.");
        await msg.guild.members.unban(id).then(() => msg.reply("\u2705 Unbanned.")).catch(() => msg.reply("\u274C Error."));
    }

    if (cmd === "mute") {
        if (!msg.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
        const time = parseInt(args[0]);
        const target = msg.mentions.members.first();
        if (isNaN(time) || !target) return msg.reply("\u274C Usage: `,mute [minutos] [user]`");
        await target.timeout(time * 60 * 1000);
        msg.reply(`\u2705 Muted <@${target.id}> for ${time}m.`);
    }

    if (cmd === "kick") {
        if (!msg.member.permissions.has(PermissionFlagsBits.KickMembers)) return;
        const target = msg.mentions.members.first();
        if (!target) return msg.reply("\u274C User not found.");
        await target.kick();
        msg.reply(`\u2705 Kicked **${target.user?.tag || 'User'}**.`);
    }

    // ================= ADDEMOJI COMMAND =================
    if (cmd === "addemoji") {
        if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
            return msg.reply("\u274C You need **Manage Expressions** permission.");
        }
        if (!args.length) return msg.reply("\u274C Usage: `,addemoji <emoji1> <emoji2> ...`");
        const results = [];
        for (const arg of args) {
            // Custom Discord emoji: <:name:id> or <a:name:id>
            const customMatch = arg.match(/^<(a?):([^:]+):(\d+)>$/);
            if (customMatch) {
                const animated = customMatch[1] === "a";
                const emojiName = customMatch[2];
                const emojiId = customMatch[3];
                const ext = animated ? "gif" : "png";
                const url = `https://cdn.discordapp.com/emojis/${emojiId}.${ext}`;
                try {
                    const created = await msg.guild.emojis.create({ attachment: url, name: emojiName });
                    results.push(`\u2705 Added ${created} \`:${created.name}:\``);
                } catch(e) {
                    results.push(`\u274C \`${emojiName}\` \u2014 ${e.message.slice(0, 60)}`);
                }
                continue;
            }
            // Image URL
            if (arg.startsWith("http://") || arg.startsWith("https://")) {
                const idx = args.indexOf(arg);
                const nextArg = args[idx + 1];
                const urlName = (nextArg && !nextArg.startsWith("http") && !nextArg.match(/^</)) ? nextArg : "emoji";
                try {
                    const created = await msg.guild.emojis.create({ attachment: arg, name: urlName });
                    results.push(`\u2705 Added ${created} \`:${created.name}:\``);
                } catch(e) {
                    results.push(`\u274C URL \u2014 ${e.message.slice(0, 60)}`);
                }
                continue;
            }
            results.push(`\u26A0\uFE0F \`${arg}\` \u2014 not recognized (use custom emoji or image URL)`);
        }
        return msg.reply(results.join("\n").slice(0, 2000));
    }


    if (cmd === "revoke") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        const target = msg.mentions.members.first();
        if (!target) return msg.reply("\u274C User not found.");
        const slotEntry = Object.entries(slots).find(([id, data]) => data.ownerId === target.id);
        if (slotEntry) {
            const ch = msg.guild.channels.cache.get(slotEntry[0]);
            if (ch) await ch.delete();
            delete slots[slotEntry[0]];
            save("./slots.json", slots);
        }
        await target.roles.remove(CONFIG.SLOT_OWNER_ROLE_ID).catch(() => {});
        await target.roles.remove(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
        msg.reply("\u2705 Slot revoked.");
    }

    // ================= HOLD COMMAND =================
    if (cmd === "hold") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        let targetId = null;
        let slotChannelId = null;

        // If used inside a slot channel
        if (slots[msg.channel.id]) {
            slotChannelId = msg.channel.id;
            targetId = slots[msg.channel.id].ownerId;
        } else {
            // Used outside: need @mention
            const mentioned = msg.mentions.members.first();
            if (!mentioned) return msg.reply("\u274C Use inside a slot channel or mention the slot owner.");
            const slotEntry = Object.entries(slots).find(([, d]) => d.ownerId === mentioned.id);
            if (!slotEntry) return msg.reply("\u274C This user does not have an active slot.");
            slotChannelId = slotEntry[0];
            targetId = mentioned.id;
        }

        const reason = args.join(" ") || null;
        const slotCh = msg.guild.channels.cache.get(slotChannelId);
        const holdMember = await msg.guild.members.fetch(targetId).catch(() => null);

        if (slotCh) await slotCh.permissionOverwrites.edit(targetId, { SendMessages: false }).catch(() => {});
        if (holdMember) await holdMember.roles.add(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});

        const holdEmbed = new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle("\uD83D\uDD12 Slot On Hold")
            .setDescription(
                `<@${targetId}>, your slot has been placed on hold.\n\n` +
                (reason ? `**Reason:** ${reason}\n\n` : "") +
                `Please open a ticket to discuss this with staff.`
            )
            .setTimestamp();

        const holdMsg = slotCh ? await slotCh.send({ embeds: [holdEmbed] }).catch(() => null) : null;
        if (holdMsg) {
            holdData[slotChannelId] = { userId: targetId, messageId: holdMsg.id, reason: reason || "No reason provided" };
            save("./hold_data.json", holdData);
        }
        msg.reply(`\u2705 Slot of <@${targetId}> is now on hold.`);
    }

    // ================= UNHOLD COMMAND =================
    if (cmd === "unhold") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return;
        let targetId = null;
        let slotChannelId = null;

        if (slots[msg.channel.id]) {
            slotChannelId = msg.channel.id;
            targetId = slots[msg.channel.id].ownerId;
        } else {
            const mentioned = msg.mentions.members.first();
            if (!mentioned) return msg.reply("\u274C Use inside a slot channel or mention the slot owner.");
            const slotEntry = Object.entries(slots).find(([, d]) => d.ownerId === mentioned.id);
            if (!slotEntry) return msg.reply("\u274C This user does not have an active slot.");
            slotChannelId = slotEntry[0];
            targetId = mentioned.id;
        }

        const slotCh = msg.guild.channels.cache.get(slotChannelId);
        const holdMember = await msg.guild.members.fetch(targetId).catch(() => null);

        // Restore send permission
        if (slotCh) await slotCh.permissionOverwrites.edit(targetId, { SendMessages: true }).catch(() => {});
        // Remove on hold role
        if (holdMember) await holdMember.roles.remove(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});

        // Delete the hold embed message
        const hd = holdData[slotChannelId];
        if (hd && slotCh) {
            const holdMsg = await slotCh.messages.fetch(hd.messageId).catch(() => null);
            if (holdMsg) await holdMsg.delete().catch(() => {});
        }
        delete holdData[slotChannelId];
        save("./hold_data.json", holdData);

        msg.reply(`\u2705 Slot of <@${targetId}> is no longer on hold.`);
    }

    if (cmd === "nuke") {
        const isStaff = msg.member.permissions.has(PermissionFlagsBits.ManageChannels);
        const isSlotOwner = msg.member.roles.cache.has(CONFIG.SLOT_OWNER_ROLE_ID);
        const slotData = slots[msg.channel.id];
        if (isStaff && !slotData) {
            const newCh = await msg.channel.clone();
            await msg.channel.delete();
            return newCh.send("\uD83D\uDCA5 **Channel Nuked.**");
        }
        if (isSlotOwner && slotData && slotData.ownerId === msg.author.id) {
            const cooldown = 48 * 60 * 60 * 1000;
            const remaining = (slotData.lastNuke + cooldown) - Date.now();
            if (remaining > 0) return msg.reply(`\u274C Cooldown: wait ${Math.ceil(remaining / (3600000))} hours.`);
            const newCh = await msg.channel.clone();
            await msg.channel.delete();
            const newEmbed = EmbedBuilder.from(slotData.infoEmbed);
            const newMsg = await newCh.send({ content: `<@${slotData.ownerId}>`, embeds: [newEmbed] });
            await newMsg.pin().catch(() => {});
            slots[newCh.id] = { ...slotData, lastNuke: Date.now() };
            delete slots[msg.channel.id];
            save("./slots.json", slots);
        }
    }

    if (cmd === "setup") {
        if (!msg.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        msg.delete().catch(() => {});
        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setDescription(`# Astra Tickets\n\nSelect the type of ticket you would like to open from below\n<:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114> \n<:emoji_125:1430879303695863830> **Buy Slot:**\n\u2022 Purchase a new slot or renew your\ncurrent slot\n<:emoji_125:1430879303695863830> **Product Purchase:**\n\u2022 Buy a specific product (from the owners)\n<:emoji_125:1430879303695863830> **Exchange:**\n\u2022 Exchange currencies or crypto`);
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("ticket_main")
                .setPlaceholder("Select a category")
                .addOptions([
                    { label: "Slot Purchase", value: "slot", emoji: "<:emoji_125:1430879303695863830>" },
                    { label: "Product Purchase", value: "product", emoji: "\uD83D\uDED2" },
                    { label: "Exchange", value: "exchange", emoji: "\uD83D\uDCF1" }
                ])
        );
        msg.channel.send({ embeds: [embed], components: [row] });
    }

    if (cmd === "ltc") {
        const eur = parseFloat(args[0]);
        if (isNaN(eur)) return msg.reply("\u274C Invalid amount.");
        const ltcPrice = cachedLtcPrice;
        const ltcAmt = (eur / ltcPrice).toFixed(6);
        const addy = ltcData[msg.author.id];
        if (!addy) return msg.reply("\u274C Use `,setltc` first.");
        const embed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Litecoin")
            .setDescription(`Your purchase will not be completed if you deposit a lower amount\n**Adress:**\n\`${addy}\`\n**Amount:**\n\`${ltcAmt}\` LTC`);
        const r1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copy_addy_${addy}`).setLabel("Copy Adress").setStyle(ButtonStyle.Primary).setEmoji("<:myst_heart:1430879298083885187>"),
            new ButtonBuilder().setCustomId(`copy_amt_${ltcAmt}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary).setEmoji("<:myst_heart:1430879298083885187>"),
            new ButtonBuilder().setCustomId(`qr_gen_${addy}_${ltcAmt}`).setLabel("QR Code").setStyle(ButtonStyle.Primary).setEmoji("<:myst_heart:1430879298083885187>")
        );
        msg.reply({ embeds: [embed], components: [r1] });
    }
});

// ================= INTERACTION HANDLING =================
client.on("interactionCreate", async int => {
    
    // GESTIONE MODAL DASHBOARD
    if (int.isModalSubmit() && int.customId === "withdraw_modal") {
        const destination = int.fields.getTextInputValue('dest_address');
        await int.reply({ content: `\u26A0\uFE0F Simulated procedure towards \`${destination}\`.\nI fondi si trovano nei wallet generati. Devi usare le chiavi private salvate in \`temp_wallets.json\` per muoverli manualmente usando un wallet come Electrum, finch\u00E9 non implementi una libreria di firma nel codice.`, ephemeral: true });
    }

    // ================= NEW: MODAL PRODUCT PURCHASE FORM =================
    if (int.isModalSubmit() && int.customId === "product_purchase_form") {
        const productName = int.fields.getTextInputValue('pp_product_name');
        const quantity = int.fields.getTextInputValue('pp_quantity');
        const otherInfo = int.fields.getTextInputValue('pp_other_info') || "None";
        const s = sessions.get(int.user.id) || {};
        s.type = "product"; s.productName = productName; s.quantity = quantity; s.otherInfo = otherInfo;
        sessions.set(int.user.id, s);
        const tosEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83D\uDED2 Product Purchase \u2014 Terms of Service")
            .setDescription(
                `**Your order summary:**\n\n` +
                `\uD83D\uDCE6 **Product:** \`${productName}\`\n` +
                `\uD83D\uDD22 **Quantity:** \`${quantity}\`\n` +
                `\u2139\uFE0F **Other Info:** \`${otherInfo}\`\n\n` +
                `**Terms of Service \u2014 please read before proceeding:**\n` +
                `\u2022 You must record the entire delivery process\n` +
                `\u2022 No chargebacks or fraudulent disputes\n` +
                `\u2022 Payment must be made in LTC at the address provided by staff\n` +
                `\u2022 Staff may request proof of payment at any time\n\n` +
                `Press **Accept** to open the ticket, or **Decline** to cancel.`
            )
            .setFooter({ text: "Astro Exchange | Product Purchase" });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("confirm_product_ticket").setLabel("\u2705 Accept & Open Ticket").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("cancel_ticket").setLabel("\u274C Decline").setStyle(ButtonStyle.Danger)
        );
        return int.reply({ embeds: [tosEmbed], components: [row], ephemeral: true });
    }

    // ================= MODAL VOUCH FORM (4 fields \u2192 auto-generate vouch) =================
    if (int.isModalSubmit() && int.customId.startsWith("vouch_form_")) {
        const userId = int.customId.replace("vouch_form_", "");
        const product = int.fields.getTextInputValue('vouch_product');
        const quantity = int.fields.getTextInputValue('vouch_quantity');
        const price = int.fields.getTextInputValue('vouch_price');
        const method = int.fields.getTextInputValue('vouch_method');
        const vouchText = `+rep ${CONFIG.OWNER_ID} legit seller x${quantity} ${product} | ${price}\u20AC ${method.toUpperCase()}`;
        const targetUser = await client.users.fetch(userId).catch(() => null);
        if (targetUser) {
            const dmEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\u2705 Your Vouch is Ready!")
                .setDescription(`Here is your vouch, copy and paste it:\n\n\`\`\`${vouchText}\`\`\`\n\nPlease leave it in <#${CONFIG.VOUCH_CHANNEL_ID}>.`);
            await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
        }
        return int.reply({ content: `\u2705 Vouch sent to <@${userId}>:\n\`\`\`${vouchText}\`\`\``, ephemeral: true });
    }

    // ================= MM MODAL: PRODUCT FORM =================
    if (int.isModalSubmit() && int.customId.startsWith("mm_product_form_")) {
        const sessionId = int.customId.replace("mm_product_form_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C MM session not found.", ephemeral: true });

        const productDesc = int.fields.getTextInputValue('mm_product_desc');
        const priceEur = parseFloat(int.fields.getTextInputValue('mm_price_eur'));

        if (isNaN(priceEur) || priceEur <= 0) {
            return int.reply({ content: "\u274C Invalid price. Enter a number.", ephemeral: true });
        }

        const feePercent = 0.025;
        const buyerFeeEur = priceEur * feePercent;
        const sellerFeeEur = priceEur * feePercent;
        const totalBuyerEur = priceEur + buyerFeeEur;
        const totalBuyerLtc = (totalBuyerEur / cachedLtcPrice).toFixed(6);
        const sellerReceivesEur = priceEur - sellerFeeEur;
        const sellerReceivesLtc = (sellerReceivesEur / cachedLtcPrice).toFixed(6);
        const botFeeEur = buyerFeeEur + sellerFeeEur;
        const botFeeLtc = (botFeeEur / cachedLtcPrice).toFixed(6);

        mmData.productDescription = productDesc;
        mmData.priceEur = priceEur;
        mmData.buyerFeeEur = buyerFeeEur;
        mmData.sellerFeeEur = sellerFeeEur;
        mmData.totalBuyerLtc = parseFloat(totalBuyerLtc);
        mmData.sellerReceivesLtc = parseFloat(sellerReceivesLtc);
        mmData.botFeeLtc = parseFloat(botFeeLtc);
        mmData.confirmations = {};
        mmData.status = 'awaiting_deal_confirm';
        save("./mm_sessions.json", mmSessions);

        const channel = int.guild.channels.cache.get(mmData.channelId);
        if (!channel) return int.reply({ content: "\u274C Canale non trovato.", ephemeral: true });

        const dealEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83E\uDD1D Deal Summary - Confirmation Required")
            .setDescription(
                `Here is the deal summary. **Both** must confirm to proceed.\n\n` +
                `**Product/Servizio:** ${productDesc}\n\n` +
                `**Buyer** (<@${mmData.buyerId}>):\n` +
                `> Will pay: \`${totalBuyerLtc} LTC\` (${totalBuyerEur.toFixed(2)}\u20AC + 2.5% fee)\n\n` +
                `**Seller** (<@${mmData.sellerId}>):\n` +
                `> Will receive: \`${sellerReceivesLtc} LTC\` (${sellerReceivesEur.toFixed(2)}\u20AC - 2.5% fee)\n\n` +
                `**Bot Fee:** \`${botFeeLtc} LTC\` (5% totale)`
            )
            .setFooter({ text: "Both must press \u2705 Confirm to proceed" });

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mm_deal_confirm_${sessionId}`).setLabel("\u2705 Confermo").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`mm_deal_cancel_${sessionId}`).setLabel("\u274C Annulla").setStyle(ButtonStyle.Danger)
        );

        await channel.send({ content: `<@${mmData.buyerId}> <@${mmData.sellerId}>`, embeds: [dealEmbed], components: [confirmRow] });
        await int.reply({ content: "\u2705 Deal summary sent to the channel.", ephemeral: true });
    }

    // ================= MM SELLER ADDRESS MODAL =================
    if (int.isModalSubmit() && int.customId.startsWith("mm_seller_address_")) {
        const sessionId = int.customId.replace("mm_seller_address_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });

        const sellerAddress = int.fields.getTextInputValue('seller_ltc_address');
        mmData.sellerAddress = sellerAddress;
        save("./mm_sessions.json", mmSessions);

        const sellerSuccess = await transferLTC(mmData.escrowAddress, sellerAddress);
        
        const guild = int.guild;
        const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
        const globalLogCh = guild.channels.cache.get(CONFIG.GLOBAL_LOG_CHANNEL_ID);

        if (sellerSuccess) {
            await transferLTC(mmData.escrowAddress, CONFIG.MY_LTC_ADDRESS);
            
            delete tempWallets[mmData.escrowAddress];
            save("./temp_wallets.json", tempWallets);

            mmData.status = 'completed';
            save("./mm_sessions.json", mmSessions);

            const channel = guild.channels.cache.get(mmData.channelId);
            if (channel) {
                const completeEmbed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("\u2705 Deal Completed - Auto MM")
                    .setDescription(
                        `Deal completed successfully!\n\n` +
                        `**Buyer** (<@${mmData.buyerId}>): product received \u2705\n` +
                        `**Seller** (<@${mmData.sellerId}>): payment sent to \`${sellerAddress}\` \u2705\n` +
                        `**Bot Fee:** \`${mmData.botFeeLtc} LTC\` inviata \u2705\n\n` +
                        `Thank you for using Auto MM!\n` +
                        `Ticket closing in 30 seconds.`
                    )
                    .setTimestamp();

                const closeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`mm_close_ticket_${sessionId}`).setLabel("\uD83D\uDD12 Close Ticket").setStyle(ButtonStyle.Danger)
                );

                await channel.send({ content: `<@${mmData.buyerId}> <@${mmData.sellerId}>`, embeds: [completeEmbed], components: [closeRow] });

                setTimeout(async () => {
                    try {
                        const transcript = await discordTranscripts.createTranscript(channel);
                        const buyer = await guild.members.fetch(mmData.buyerId).catch(() => null);
                        const seller = await guild.members.fetch(mmData.sellerId).catch(() => null);
                        if (buyer) await buyer.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
                        if (seller) await seller.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
                        if (logCh) await logCh.send({ content: `\u2705 MM Completed | Buyer: <@${mmData.buyerId}> | Seller: <@${mmData.sellerId}>`, files: [transcript] });
                        await channel.delete().catch(() => {});
                        delete mmSessions[sessionId];
                        save("./mm_sessions.json", mmSessions);
                    } catch (e) { console.error("Error closing MM:", e); }
                }, 30000);
            }

            if (globalLogCh) {
                const mmLogEmbed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("\uD83E\uDD1D MM Completed")
                    .addFields(
                        { name: "Buyer", value: `<@${mmData.buyerId}>`, inline: true },
                        { name: "Seller", value: `<@${mmData.sellerId}>`, inline: true },
                        { name: "Product", value: mmData.productDescription, inline: false },
                        { name: "Amount", value: `${mmData.priceEur}\u20AC`, inline: true },
                        { name: "Bot Fee", value: `${mmData.botFeeLtc} LTC`, inline: true }
                    )
                    .setTimestamp();
                globalLogCh.send({ embeds: [mmLogEmbed] });
            }

            await int.reply({ content: "\u2705 Payment sent! Ticket will close automatically.", ephemeral: true });
        } else {
            await int.reply({ content: "\u274C LTC transfer error. Contact staff.", ephemeral: true });
            if (logCh) logCh.send(`\u274C MM transfer error for session ${sessionId}. Seller address: \`${sellerAddress}\``);
        }
    }

    if (int.isButton() && int.customId === "withdraw_all_ltc") {
        const modal = new ModalBuilder()
            .setCustomId('withdraw_modal')
            .setTitle('Withdraw LTC Funds');

        const addrInput = new TextInputBuilder()
            .setCustomId('dest_address')
            .setLabel("Destination LTC Address:")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(addrInput));
        return int.showModal(modal);
    }

    // ================= NEW: CONFIRM PRODUCT TICKET =================
    if (int.isButton() && int.customId === "confirm_product_ticket") {
        await int.deferUpdate();
        const s = sessions.get(int.user.id);
        if (!s) return;
        try {
            const safeName = int.user?.username || 'user';
            const ch = await int.guild.channels.create({
                name: `product-${safeName}`,
                parent: CONFIG.TICKET_CATEGORY_ID,
                permissionOverwrites: 
                    { id: [int.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: int.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                    { id: CONFIG.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });
            ticketTypes[ch.id] = "product";
            save("./ticket_types.json", ticketTypes);
            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("Product Purchase Ticket")
                .setThumbnail("https://cdn.discordapp.com/emojis/1430879303695863830.png")
                .setDescription(
                    `> Please refrain from pinging while waiting as we may be busy, we will get to you as soon as possible.\n\n` +
                    `**Terms Accepted:**\nYes\n\n` +
                    `**User ID:**\n\`${int.user.id}\`\n\n` +
                    `**Product Name:**\n${s.productName}\n\n` +
                    `**Quantity:**\n${s.quantity}\n\n` +
                    `**Other Info:**\n${s.otherInfo}`
                );
            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("claim_t").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary).setEmoji("\uD83C\uDFAB"),
                new ButtonBuilder().setCustomId("copy_u_id").setLabel("Copy ID's").setStyle(ButtonStyle.Secondary).setEmoji("\uD83D\uDD17"),
                new ButtonBuilder().setCustomId("close_t").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setEmoji("\uD83D\uDD12")
            );
            await ch.send({ content: `Welcomand <@${int.user.id}>, <@&${CONFIG.STAFF_ROLE_ID}> will be with you shortly`, embeds: [embed], components: [row1] });
            await int.editReply({ content: `\u2705 Ticket Created! <#${ch.id}>`, embeds: [], components: [] });
            sessions.delete(int.user.id);
        } catch (err) { await int.editReply({ content: "\u274C Error.", components: [] }); }
    }

    // ================= CONFIRM DELIVERY (staff \u2192 vouch form with 4 fields) =================
    // ================= VOUCH MODAL BUTTON (DM) =================
    // ================= ESCROW GENERATE DEPOSIT ADDRESS =================
    // ================= EXCHANGE SYSTEM BUTTONS =================
    if (int.isButton() && int.customId === "exchange_start") {
        const calcEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Exchange - Enter Amount")
            .setDescription("**Amount:** `00,00€`\n\nEnter the amount you want to exchange:")
            .setFooter({ text: "Astro Exchange | Step 1 of 3" });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_1").setLabel("1").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_2").setLabel("2").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_3").setLabel("3").setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_4").setLabel("4").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_5").setLabel("5").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_6").setLabel("6").setStyle(ButtonStyle.Secondary)
        );
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_7").setLabel("7").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_8").setLabel("8").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_9").setLabel("9").setStyle(ButtonStyle.Secondary)
        );
        const row4 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_clear").setLabel("C").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("exc_num_0").setLabel("0").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_comma").setLabel(",").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_confirm").setLabel("✓").setStyle(ButtonStyle.Success)
        );

        // Initialize session
        if (!exchangeRequests[int.message.id]) exchangeRequests[int.message.id] = {};
        exchangeRequests[int.message.id].userId = int.user.id;
        exchangeRequests[int.message.id].amount = "";
        save("./exchange_requests.json", exchangeRequests);

        return int.update({ embeds: [calcEmbed], components: [row1, row2, row3, row4] });
    }

    if (int.isButton() && int.customId.startsWith("exc_num_")) {
        const session = exchangeRequests[int.message.id];
        if (!session || session.userId !== int.user.id) return int.reply({ content: "❌ This is not your exchange request.", ephemeral: true });

        const action = int.customId.replace("exc_num_", "");

        if (action === "clear") {
            session.amount = "";
        } else if (action === "comma") {
            if (!session.amount.includes(",")) session.amount += ",";
        } else if (action === "confirm") {
            if (!session.amount || session.amount === "" || session.amount === "0" || session.amount === "00,00") {
                return int.reply({ content: "❌ Enter an amount first.", ephemeral: true });
            }
            // Move to send method selection
            const sendEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("Exchange - What are you Sending?")
                .setDescription(`**Amount:** ${session.amount}€\n\nSelect the payment method you're sending:`)
                .setFooter({ text: "Astro Exchange | Step 2 of 3" });

            const sendRow1 = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("exchange_send_method")
                    .setPlaceholder("Select what you're sending")
                    .addOptions([
                        { label: "Revolut", value: "revolut", emoji: { id: "1498488259842674823", name: "revolut" } },
                        { label: "PayPal Balance", value: "paypal_balance", emoji: { id: "1430879297362464848", name: "paypal" } },
                        { label: "PayPal Card", value: "paypal_card", emoji: { id: "1430879297362464848", name: "paypal" } },
                        { label: "Apple Pay", value: "apple_pay", emoji: { id: "1498488265974743231", name: "applepay" } },
                        { label: "Bank Transfer", value: "bank_transfer", emoji: { id: "1498724200053997711", name: "bank111" } },
                        { label: "BTC - Bitcoin", value: "btc", emoji: { id: "1498724194618314966", name: "BTC" } },
                        { label: "ETH - Ethereum", value: "eth", emoji: { id: "1498724198280073296", name: "eth" } },
                        { label: "LTC - Litecoin", value: "ltc", emoji: { id: "1497994881262682173", name: "ltc" } },
                        { label: "SOL - Solana", value: "sol", emoji: { id: "1498488264233844766", name: "Solana" } },
                        { label: "USDT - Tether", value: "usdt", emoji: { id: "1498724196367204484", name: "USDT" } }
                    ])
            );

            save("./exchange_requests.json", exchangeRequests);
            return int.update({ embeds: [sendEmbed], components: [sendRow1] });
        } else {
            // Number pressed
            session.amount += action;
        }

        save("./exchange_requests.json", exchangeRequests);

        // Format display: if empty show 00,00€, otherwise show what user typed
        let displayAmount = session.amount || "00,00";
        if (!displayAmount.includes(",") && displayAmount.length === 0) displayAmount = "00,00";

        const calcEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Exchange - Enter Amount")
            .setDescription(`**Amount:** \`${displayAmount}€\`\n\nEnter the amount you want to exchange:`)
            .setFooter({ text: "Astro Exchange | Step 1 of 3" });

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_1").setLabel("1").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_2").setLabel("2").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_3").setLabel("3").setStyle(ButtonStyle.Secondary)
        );
        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_4").setLabel("4").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_5").setLabel("5").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_6").setLabel("6").setStyle(ButtonStyle.Secondary)
        );
        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_7").setLabel("7").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_8").setLabel("8").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_9").setLabel("9").setStyle(ButtonStyle.Secondary)
        );
        const row4 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("exc_num_clear").setLabel("C").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("exc_num_0").setLabel("0").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_comma").setLabel(",").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("exc_num_confirm").setLabel("✓").setStyle(ButtonStyle.Success)
        );

        return int.update({ embeds: [calcEmbed], components: [row1, row2, row3, row4] });
    }

    if (int.isStringSelectMenu() && int.customId === "exchange_send_method") {
        const sendMethod = int.values[0];
        const session = exchangeRequests[int.message.id];
        if (!session) return int.reply({ content: "❌ Session expired. Please start again.", ephemeral: true });

        session.sendMethod = sendMethod;
        save("./exchange_requests.json", exchangeRequests);

        const methodLabels = {
            revolut: "<:revolut:1498488259842674823> Revolut",
            paypal_balance: "<:paypal:1430879297362464848> PayPal Balance",
            paypal_card: "<:paypal:1430879297362464848> PayPal Card",
            apple_pay: "<:applepay:1498488265974743231> Apple Pay",
            bank_transfer: "<:bank111:1498724200053997711> Bank Transfer",
            btc: "<:BTC:1498724194618314966> BTC - Bitcoin",
            eth: "<:eth:1498724198280073296> ETH - Ethereum",
            ltc: "<:ltc:1497994881262682173> LTC - Litecoin",
            sol: "<:Solana:1498488264233844766> SOL - Solana",
            usdt: "<:USDT:1498724196367204484> USDT - Tether"
        };

        const receiveEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Exchange - What do you want to Receive?")
            .setDescription(
                `**Amount:** ${session.amount}€\n` +
                `**Sending:** ${methodLabels[sendMethod]}\n\n` +
                `Select what you want to receive:`
            )
            .setFooter({ text: "Astro Exchange | Step 3 of 3" });

        const receiveRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId("exchange_receive_method")
                .setPlaceholder("Select what you want to receive")
                .addOptions([
                    { label: "Revolut", value: "revolut", emoji: { id: "1498488259842674823", name: "revolut" } },
                    { label: "PayPal Balance", value: "paypal_balance", emoji: { id: "1430879297362464848", name: "paypal" } },
                    { label: "PayPal Card", value: "paypal_card", emoji: { id: "1430879297362464848", name: "paypal" } },
                    { label: "Apple Pay", value: "apple_pay", emoji: { id: "1498488265974743231", name: "applepay" } },
                    { label: "Bank Transfer", value: "bank_transfer", emoji: { id: "1498724200053997711", name: "bank111" } },
                    { label: "BTC - Bitcoin", value: "btc", emoji: { id: "1498724194618314966", name: "BTC" } },
                    { label: "ETH - Ethereum", value: "eth", emoji: { id: "1498724198280073296", name: "eth" } },
                    { label: "LTC - Litecoin", value: "ltc", emoji: { id: "1497994881262682173", name: "ltc" } },
                    { label: "SOL - Solana", value: "sol", emoji: { id: "1498488264233844766", name: "Solana" } },
                    { label: "USDT - Tether", value: "usdt", emoji: { id: "1498724196367204484", name: "USDT" } }
                ])
        );

        return int.update({ embeds: [receiveEmbed], components: [receiveRow] });
    }

    if (int.isStringSelectMenu() && int.customId === "exchange_receive_method") {
        const receiveMethod = int.values[0];
        const session = exchangeRequests[int.message.id];
        if (!session) return int.reply({ content: "❌ Session expired.", ephemeral: true });

        session.receiveMethod = receiveMethod;
        session.createdAt = Date.now();
        save("./exchange_requests.json", exchangeRequests);

        const methodLabels = {
            revolut: "<:revolut:1498488259842674823> Revolut",
            paypal_balance: "<:paypal:1430879297362464848> PayPal Balance",
            paypal_card: "<:paypal:1430879297362464848> PayPal Card",
            apple_pay: "<:applepay:1498488265974743231> Apple Pay",
            bank_transfer: "<:bank111:1498724200053997711> Bank Transfer",
            btc: "<:BTC:1498724194618314966> BTC - Bitcoin",
            eth: "<:eth:1498724198280073296> ETH - Ethereum",
            ltc: "<:ltc:1497994881262682173> LTC - Litecoin",
            sol: "<:Solana:1498488264233844766> SOL - Solana",
            usdt: "<:USDT:1498724196367204484> USDT - Tether"
        };

        // Create ticket
        const ticketCategory = int.guild.channels.cache.get(CONFIG.TICKET_CATEGORY_ID);
        if (!ticketCategory) return int.reply({ content: "❌ Ticket category not found.", ephemeral: true });

        const ticketChannel = await int.guild.channels.create({
            name: `exchange-${int.user.username}`,
            type: ChannelType.GuildText,
            parent: ticketCategory.id,
            permissionOverwrites: 
                { id: [int.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: int.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: CONFIG.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });

        const ticketEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("Exchange Request")
            .setDescription(
                `**User:** <@${session.userId}>\n\n` +
                `**Amount:** ${session.amount}€\n` +
                `**Sending:** ${methodLabels[session.sendMethod]}\n` +
                `**Receiving:** ${methodLabels[receiveMethod]}\n\n` +
                `Staff will assist you shortly. Please provide any additional details needed.`
            )
            .setFooter({ text: "Astro Exchange | Exchange Ticket" })
            .setTimestamp();

        await ticketChannel.send({ content: `<@${session.userId}> <@&${CONFIG.STAFF_ROLE_ID}>`, embeds: [ticketEmbed] });

        const confirmEmbed = new EmbedBuilder()
            .setColor("#00FF00")
            .setTitle("Exchange Ticket Created")
            .setDescription(`Your exchange ticket has been created: <#${ticketChannel.id}>\n\nA staff member will assist you shortly.`)
            .setFooter({ text: "Astro Exchange" })
            .setTimestamp();

        return int.update({ embeds: [confirmEmbed], components: [] });
    }

    // ================= CASINO MENU BUTTON =================
    if (int.isButton() && int.customId === 'game_back_menu') {
        if (!userBalances[int.user.id]) userBalances[int.user.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0, blackjackStreak: 0, biggestWin: 0 };
        const { embed, components } = buildCasinoMenu(int.user.id);
        return int.update({ embeds: [embed], components });
    }

    if (int.isButton() && int.customId === 'game_recharge') {
        return int.reply({ content: '💰 Per ricaricare il saldo chiedi a uno staff di usare `,addbalance @tu [importo]`', ephemeral: true });
    }
    if (int.isButton() && int.customId === 'game_release_funds') {
        return int.reply({ content: '💸 Per prelevare apri un ticket o contatta lo staff.', ephemeral: true });
    }

    // ================= BLACKJACK GAME BUTTONS =================
    if (int.isButton() && (int.customId === 'game_blackjack_start' || int.customId === 'bj_new_game')) {
        if (!userBalances[int.user.id]) userBalances[int.user.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0, blackjackStreak: 0, biggestWin: 0 };
        const stats = userBalances[int.user.id];
        if (stats.balance < 1) return int.reply({ content: '❌ Servono almeno **1€**. Chiedi allo staff con `,addbalance`.', ephemeral: true });
        const modal = new ModalBuilder().setCustomId('bj_bet_modal').setTitle('♠ Blackjack — Puntata');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('bet_amount').setLabel(`Saldo: ${stats.balance.toFixed(2)}€ — Quanto vuoi puntare?`).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(10)
        ));
        return int.showModal(modal);
    }

    if (int.isModalSubmit() && int.customId === 'bj_bet_modal') {
        const raw = int.fields.getTextInputValue('bet_amount').replace(',', '.').trim();
        const bet = Math.round(parseFloat(raw));
        if (isNaN(bet) || bet < 1) return int.reply({ content: '❌ Puntata non valida. Inserisci un numero ≥ 1.', ephemeral: true });
        if (!userBalances[int.user.id]) userBalances[int.user.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0, blackjackStreak: 0, biggestWin: 0 };
        const stats = userBalances[int.user.id];
        if (stats.balance < bet) return int.reply({ content: `❌ Saldo insufficiente. Hai **${stats.balance.toFixed(2)}€**.`, ephemeral: true });

        stats.balance -= bet;
        stats.totalWagered = (stats.totalWagered||0) + bet;
        save('./user_balances.json', userBalances);

        const shoe = createShoe(6);
        const dealerHand = [shoe.pop(), shoe.pop()];
        const playerHands = [{ cards: [shoe.pop(), shoe.pop()], bet, surrendered: false, doubled: false }];
        const game = { userId: int.user.id, shoe, dealerHand, playerHands, currentHandIndex: 0, insuranceBet: 0, phase: 'playing' };
        activeGames[int.user.id] = game;

        // Dealing animation
        await int.deferReply();
        await int.editReply({ embeds: [buildDealingEmbed(int.user.id, 0, game)], components: [] });
        await new Promise(r => setTimeout(r, 600));
        await int.editReply({ embeds: [buildDealingEmbed(int.user.id, 1, game)], components: [] });
        await new Promise(r => setTimeout(r, 600));
        await int.editReply({ embeds: [buildDealingEmbed(int.user.id, 2, game)], components: [] });
        await new Promise(r => setTimeout(r, 500));

        if (dealerHand[0].rank === 'A') {
            const insuranceMax = Math.floor(bet / 2);
            const embed = buildBJEmbed(game, int.user.id, 'playing');
            embed.setFooter({ text: `Astro Casino • Assicurazione disponibile — max ${insuranceMax}€ (2:1 se dealer BJ)` });
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('bj_insurance').setLabel(`Assicurazione (${insuranceMax}€)`).setEmoji('🛡️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('bj_no_insurance').setLabel('No Grazie').setStyle(ButtonStyle.Secondary)
            );
            return int.editReply({ embeds: [embed], components: [row] });
        }

        if (bjIsBlackjack(playerHands[0].cards)) {
            applyBJResults(game, int.user.id);
            delete activeGames[int.user.id];
            const embed = buildBJEmbed(game, int.user.id, 'result');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('bj_new_game').setLabel('Gioca ancora').setEmoji('🔄').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('game_back_menu').setLabel('Casino').setEmoji('🎰').setStyle(ButtonStyle.Secondary)
            );
            return int.editReply({ embeds: [embed], components: [row] });
        }

        return int.editReply({ embeds: [buildBJEmbed(game, int.user.id, 'playing')], components: getBJActionButtons(game) });
    }

    if (int.isButton() && int.customId === 'bj_insurance') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        const stats = userBalances[int.user.id];
        const insuranceCost = Math.floor(game.playerHands[0].bet / 2);
        if (stats.balance < insuranceCost) return int.reply({ content: '❌ Saldo insufficiente per l\'assicurazione.', ephemeral: true });
        stats.balance -= insuranceCost;
        game.insuranceBet = insuranceCost;
        save('./user_balances.json', userBalances);
        return int.update({ embeds: [buildBJEmbed(game, int.user.id, 'playing')], components: getBJActionButtons(game) });
    }

    if (int.isButton() && int.customId === 'bj_no_insurance') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        return int.update({ embeds: [buildBJEmbed(game, int.user.id, 'playing')], components: getBJActionButtons(game) });
    }

    if (int.isButton() && int.customId === 'bj_hit') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        await int.deferUpdate();
        if (game.shoe.length < 60) game.shoe.push(...createShoe(6));
        const hand = game.playerHands[game.currentHandIndex];
        // Card flip animation
        const flipEmbed = new EmbedBuilder().setColor(0x1a5c36).setTitle('♠♥ Blackjack — Astro Casino ♦♣')
            .setDescription('```ansi\n[37;1m🎯 Carta in arrivo...[0m\n```')
            .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png');
        await int.editReply({ embeds: [flipEmbed], components: [] });
        await new Promise(r => setTimeout(r, 500));
        hand.cards.push(game.shoe.pop());
        if (bjHandValue(hand.cards) >= 21) return bjAdvanceOrDealer(game, int);
        return int.editReply({ embeds: [buildBJEmbed(game, int.user.id, 'playing')], components: getBJActionButtons(game) });
    }

    if (int.isButton() && int.customId === 'bj_stand') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        await int.deferUpdate();
        return bjAdvanceOrDealer(game, int);
    }

    if (int.isButton() && int.customId === 'bj_double') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        const stats = userBalances[int.user.id];
        const hand = game.playerHands[game.currentHandIndex];
        if (stats.balance < hand.bet) return int.reply({ content: '❌ Saldo insufficiente per raddoppiare.', ephemeral: true });
        await int.deferUpdate();
        stats.balance -= hand.bet;
        stats.totalWagered = (stats.totalWagered||0) + hand.bet;
        hand.bet *= 2;
        hand.doubled = true;
        save('./user_balances.json', userBalances);
        // Flip animation
        const flipEmbed = new EmbedBuilder().setColor(0x1a5c36).setTitle('♠♥ Blackjack — Astro Casino ♦♣')
            .setDescription('```ansi\n[33;1m⬆️ Raddoppio! Ultima carta...[0m\n```')
            .setThumbnail('https://s2.coinmarketcap.com/static/img/coins/64x64/2.png');
        await int.editReply({ embeds: [flipEmbed], components: [] });
        await new Promise(r => setTimeout(r, 600));
        if (game.shoe.length < 60) game.shoe.push(...createShoe(6));
        hand.cards.push(game.shoe.pop());
        return bjAdvanceOrDealer(game, int);
    }

    if (int.isButton() && int.customId === 'bj_split') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        const stats = userBalances[int.user.id];
        const hand = game.playerHands[game.currentHandIndex];
        if (!bjCanSplit(hand.cards) || game.playerHands.length >= 4) return int.reply({ content: '❌ Split non disponibile.', ephemeral: true });
        if (stats.balance < hand.bet) return int.reply({ content: '❌ Saldo insufficiente per splittare.', ephemeral: true });
        await int.deferUpdate();
        stats.balance -= hand.bet;
        stats.totalWagered = (stats.totalWagered||0) + hand.bet;
        save('./user_balances.json', userBalances);
        if (game.shoe.length < 60) game.shoe.push(...createShoe(6));
        const newHand = { cards: [hand.cards.pop(), game.shoe.pop()], bet: hand.bet, surrendered: false, doubled: false };
        hand.cards.push(game.shoe.pop());
        game.playerHands.splice(game.currentHandIndex + 1, 0, newHand);
        return int.editReply({ embeds: [buildBJEmbed(game, int.user.id, 'playing')], components: getBJActionButtons(game) });
    }

    if (int.isButton() && int.customId === 'bj_surrender') {
        const game = activeGames[int.user.id];
        if (!game) return int.reply({ content: '❌ Nessun gioco attivo.', ephemeral: true });
        await int.deferUpdate();
        const hand = game.playerHands[game.currentHandIndex];
        hand.surrendered = true;
        applyBJResults(game, int.user.id);
        delete activeGames[int.user.id];
        const embed = buildBJEmbed(game, int.user.id, 'result');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('bj_new_game').setLabel('Gioca ancora').setEmoji('🔄').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('game_back_menu').setLabel('Casino').setEmoji('🎰').setStyle(ButtonStyle.Secondary)
        );
        return int.editReply({ embeds: [embed], components: [row] });
    }

    // ================= ESCROW ROLE BUTTONS =================
    if (int.isButton() && int.customId.startsWith("escrow_role_sender_")) {
        const threadId = int.customId.replace("escrow_role_sender_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (int.user.id !== session.creatorId && !(session.addedUsers||[]).includes(int.user.id))
            return int.reply({ content: "❌ You are not part of this trade.", ephemeral: true });
        session.senderId = int.user.id;
        escrowSessions[threadId] = session; save("./escrow_sessions.json", escrowSessions);
        await updateIdentEmbed(int, session, threadId);
        return int.reply({ content: `You are now set as **Sender**.`, ephemeral: true });
    }

    if (int.isButton() && int.customId.startsWith("escrow_role_receiver_")) {
        const threadId = int.customId.replace("escrow_role_receiver_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (int.user.id !== session.creatorId && !(session.addedUsers||[]).includes(int.user.id))
            return int.reply({ content: "❌ You are not part of this trade.", ephemeral: true });
        session.receiverId = int.user.id;
        escrowSessions[threadId] = session; save("./escrow_sessions.json", escrowSessions);
        await updateIdentEmbed(int, session, threadId);
        return int.reply({ content: `You are now set as **Receiver**.`, ephemeral: true });
    }

    if (int.isButton() && int.customId.startsWith("escrow_reset_")) {
        const threadId = int.customId.replace("escrow_reset_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID) && int.user.id !== session.creatorId)
            return int.reply({ content: "❌ Only staff or the trade creator can reset.", ephemeral: true });
        session.senderId = null; session.receiverId = null;
        escrowSessions[threadId] = session; save("./escrow_sessions.json", escrowSessions);
        await updateIdentEmbed(int, session, threadId);
        return int.reply({ content: "Roles reset.", ephemeral: true });
    }

    if (int.isButton() && int.customId.startsWith("escrow_cancel_")) {
        const threadId = int.customId.replace("escrow_cancel_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID) && int.user.id !== session.creatorId)
            return int.reply({ content: "❌ Only staff or the trade creator can cancel.", ephemeral: true });
        session.status = "cancelled";
        escrowSessions[threadId] = session; save("./escrow_sessions.json", escrowSessions);
        const cancelEmbed = new EmbedBuilder().setColor("#FF0000")
            .setTitle("Trade Cancelled")
            .setDescription(`Trade **#${session.tradeNum}** has been cancelled by <@${int.user.id}>.`)
            .setTimestamp();
        await int.reply({ embeds: [cancelEmbed] });
        await int.channel.setArchived(true).catch(() => {});
    }

    if (int.isButton() && int.customId.startsWith("escrow_start_")) {
        const threadId = int.customId.replace("escrow_start_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID) && int.user.id !== session.creatorId)
            return int.reply({ content: "❌ Staff only.", ephemeral: true });

        // Check that a second user has been added
        if (!session.addedUsers || session.addedUsers.length === 0) {
            return int.reply({ content: "❌ You need to add the other party first. Mention them or paste their ID in this thread.", ephemeral: true });
        }

        await int.deferReply();
        const crypto = session.crypto;

        const cryptoEmojis = { LTC:"<:ltc:1497994881262682173>", SOL:"<:Solana:1498488264233844766>", ETH:"<:eth:1498724198280073296>", BTC:"<:BTC:1498724194618314966>", USDT_SOL:"<:USDT:1498724196367204484>" };
        const networkNames = { LTC:"Litecoin (LTC)", SOL:"Solana (SOL)", ETH:"Ethereum (ETH)", BTC:"Bitcoin (BTC)", USDT_SOL:"USDT on Solana" };
        const bcChain = { LTC:"ltc", BTC:"btc", ETH:"eth" };

        let depositAddress = null;
        let privateKeyWif = null;
        const network = networkNames[crypto] || crypto;

        try {
            if (crypto === "LTC") {
                const wallet = await generateLtcAddress();
                if (!wallet) return int.editReply("❌ Error generating LTC address.");
                depositAddress = wallet.address;
                privateKeyWif = wallet.wif;
                tempWallets[wallet.address] = {
                    ownerId: session.creatorId, balance: 0, createdAt: Date.now(),
                    privateKey: wallet.privateKey, wif: wallet.wif, escrowThreadId: threadId, crypto: "LTC"
                };
                save("./temp_wallets.json", tempWallets);
            } else if (crypto === "BTC" || crypto === "ETH") {
                const chain = bcChain[crypto];
                const res = await axios.post(
                    `https://api.blockcypher.com/v1/${chain}/main/addrs?token=${CONFIG.BLOCKCYPHER_TOKEN}`
                );
                depositAddress = res.data.address;
                privateKeyWif = res.data.wif || res.data.private;
                tempWallets[depositAddress] = {
                    ownerId: session.creatorId, balance: 0, createdAt: Date.now(),
                    privateKey: res.data.private, wif: res.data.wif,
                    escrowThreadId: threadId, crypto
                };
                save("./temp_wallets.json", tempWallets);
            } else if (crypto === "SOL" || crypto === "USDT_SOL") {
                const crypto_mod = require("crypto");
                const seed = crypto_mod.randomBytes(32);
                const base58chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
                const b58 = Array.from(seed).map(b => base58chars[b % 58]).join("");
                depositAddress = b58.slice(0, 44);
                privateKeyWif = seed.toString("hex");
                tempWallets[depositAddress] = {
                    ownerId: session.creatorId, balance: 0, createdAt: Date.now(),
                    privateKey: privateKeyWif, escrowThreadId: threadId, crypto
                };
                save("./temp_wallets.json", tempWallets);
            }
        } catch(e) {
            console.error("[Escrow] Address gen error:", e.message);
            return int.editReply(`❌ Error generating address: ${e.message.slice(0, 100)}`);
        }

        if (!depositAddress) return int.editReply("❌ Could not generate deposit address.");

        session.depositAddress = depositAddress;
        session.privateKey = privateKeyWif;
        session.status = "awaiting_deposit";
        escrowSessions[threadId] = session;
        save("./escrow_sessions.json", escrowSessions);

        const addrEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(`${cryptoEmojis[crypto]} Deposit Address — Trade #${session.tradeNum}`)
            .setDescription(
                `**Network:** ${network}\n\n` +
                `**Deposit Address:**\n\`\`\`${depositAddress}\`\`\`\n` +
                `Send the agreed amount to this address.\n` +
                `Once payment is detected the bot will notify here automatically.\n\n` +
                `**Fee:** 0.25% + network fees (deducted at settlement).`
            )
            .setFooter({ text: "Astro Exchange | Escrow System" })
            .setTimestamp();

        const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`escrow_confirm_${threadId}`)
                .setLabel("Confirm Payment Received")
                .setStyle(ButtonStyle.Success)
        );

        return int.editReply({ embeds: [addrEmbed], components: [confirmRow] });
    }

    // Escrow close trade
    if (int.isButton() && int.customId.startsWith("escrow_close_")) {
        const threadId = int.customId.replace("escrow_close_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "Session not found.", ephemeral: true });
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID) && int.user.id !== session.creatorId)
            return int.reply({ content: "Only staff or the trade creator can close.", ephemeral: true });

        await int.reply({ content: "Closing trade and generating transcript..." });

        const thread = int.channel;
        let transcript = null;
        try {
            transcript = await discordTranscripts.createTranscript(thread, {
                limit: -1, returnType: "buffer", filename: `trade-${session.tradeNum}.html`
            });
        } catch(e) { console.error("[Escrow Close] Transcript error:", e.message); }

        const closeEmbed = new EmbedBuilder()
            .setColor("#FF0000")
            .setTitle(`Trade #${session.tradeNum} Closed`)
            .setDescription(`Closed by <@${int.user.id}>.\nTranscript attached below.`)
            .setTimestamp();

        const files = transcript ? [{ attachment: transcript, name: `trade-${session.tradeNum}.html` }] : [];

        const logCh = int.guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
        if (logCh) await logCh.send({ embeds: [closeEmbed], files }).catch(() => {});

        const allUsers = [session.creatorId, ...(session.addedUsers || [])];
        for (const uid of [...new Set(allUsers)]) {
            const u = await int.client.users.fetch(uid).catch(() => null);
            if (u) await u.send({ embeds: [closeEmbed], files }).catch(() => {});
        }

        session.status = "closed";
        escrowSessions[threadId] = session;
        save("./escrow_sessions.json", escrowSessions);
        await thread.setArchived(true).catch(() => {});
        return;
    }

    if (int.isButton() && int.customId.startsWith("escrow_confirm_")) {
        const threadId = int.customId.replace("escrow_confirm_", "");
        const session = escrowSessions[threadId];
        if (!session) return int.reply({ content: "❌ Session not found.", ephemeral: true });
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "❌ Staff only.", ephemeral: true });

        session.status = "confirmed";
        escrowSessions[threadId] = session;
        save("./escrow_sessions.json", escrowSessions);

        const confirmEmbed = new EmbedBuilder()
            .setColor("#00cc66")
            .setTitle("Payment Confirmed")
            .setDescription(
                `Payment for **Trade #${session.tradeNum}** has been confirmed by staff.\n\n` +
                `The seller should now deliver the product/service.\n` +
                `Once the buyer confirms receipt, funds will be released.`
            )
            .setTimestamp();

        await int.reply({ embeds: [confirmEmbed] });
    }

    if (int.isButton() && int.customId.startsWith("open_vouch_modal_")) {
        const initiatorId = int.customId.replace("open_vouch_modal_", "");
        const ctx = sessions.get(`vouch_ctx_${initiatorId}`) || {};

        const modal = new ModalBuilder()
            .setCustomId(`vouch_quick_form_${initiatorId}`)
            .setTitle("Generate Vouch");
        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("vq_product").setLabel("Product name:").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Nitro Boost 1 Month")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("vq_quantity").setLabel("Quantity:").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("2")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("vq_price").setLabel("Price (EUR):").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("10.67")
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId("vq_method").setLabel("Payment method:").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("LTC")
            )
        );
        return int.showModal(modal);
    }

    // ================= VOUCH QUICK FORM MODAL SUBMIT =================
    if (int.isModalSubmit() && int.customId.startsWith("vouch_quick_form_")) {
        const initiatorId = int.customId.replace("vouch_quick_form_", "");
        const ctx = sessions.get(`vouch_ctx_${initiatorId}`) || {};
        const product = int.fields.getTextInputValue("vq_product");
        const quantity = int.fields.getTextInputValue("vq_quantity");
        const price = int.fields.getTextInputValue("vq_price");
        const method = int.fields.getTextInputValue("vq_method");

        // ID in vouch is ALWAYS the one who ran ,vouch (authorId)
        const vouchAuthorId = ctx.authorId || initiatorId;
        const vouchText = `+vouch ${vouchAuthorId} x${quantity} ${product} | ${price}€ ${method.toUpperCase()}`;

        // Send vouch to ticket user via DM
        const targetId = ctx.targetId;
        if (targetId) {
            const targetUser = await client.users.fetch(targetId).catch(() => null);
            if (targetUser) {
                const dmEmbed = new EmbedBuilder()
                    .setColor("#5FB3C4")
                    .setTitle(" Your Vouch is Ready!")
                    .setDescription(`Here is your vouch, copy and paste it:\n\n\`\`\`${vouchText}\`\`\`\n\nPlease leave it in <#${CONFIG.VOUCH_CHANNEL_ID}>.`);
                await targetUser.send({ embeds: [dmEmbed] }).catch(() => {});
            }
        }

        // Delete the prompt message from the channel
        const promptMsgId = sessions.get(`vouch_prompt_${initiatorId}`);
        if (promptMsgId && ctx.channelId) {
            const ch = int.guild?.channels.cache.get(ctx.channelId);
            if (ch) await ch.messages.fetch(promptMsgId).then(m => m.delete()).catch(() => {});
        }

        // Post result in the ticket channel
        const ticketCh = int.guild?.channels.cache.get(ctx.channelId);
        if (ticketCh) {
            await ticketCh.send(` Vouch generated${targetId ? ` for <@${targetId}>` : ""}:\n\`\`\`${vouchText}\`\`\``).catch(() => {});
        }

        sessions.delete(`vouch_ctx_${initiatorId}`);
        sessions.delete(`vouch_prompt_${initiatorId}`);
        return int.reply({ content: ` Done!`, ephemeral: true });
    }

    if (int.isButton() && int.customId.startsWith("confirm_delivery_")) {
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "\u274C Staff only.", ephemeral: true });
        const parts = int.customId.replace("confirm_delivery_", "").split("_");
        const userId = parts[1];
        const modal = new ModalBuilder()
            .setCustomId(`vouch_form_${userId}`)
            .setTitle('Generate Vouch for User');
        const productInput = new TextInputBuilder()
            .setCustomId('vouch_product')
            .setLabel("Product name:")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. Nitro Boost");
        const quantityInput = new TextInputBuilder()
            .setCustomId('vouch_quantity')
            .setLabel("Quantity:")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 10");
        const priceInput = new TextInputBuilder()
            .setCustomId('vouch_price')
            .setLabel("Price (EUR):")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. 25");
        const methodInput = new TextInputBuilder()
            .setCustomId('vouch_method')
            .setLabel("Payment method:")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("e.g. LTC");
        modal.addComponents(
            new ActionRowBuilder().addComponents(productInput),
            new ActionRowBuilder().addComponents(quantityInput),
            new ActionRowBuilder().addComponents(priceInput),
            new ActionRowBuilder().addComponents(methodInput)
        );
        return int.showModal(modal);
    }

    // ================= MM BUTTON: START MM =================
    if (int.isButton() && int.customId === "start_mm") {
        const sessionId = `mm_${int.user.id}_${Date.now()}`;
        
        const channel = await int.guild.channels.create({
            name: `mm-${int.user.username}`,
            parent: CONFIG.TICKET_CATEGORY_ID,
            permissionOverwrites: 
                { id: [int.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: int.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: CONFIG.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });

        mmSessions[sessionId] = {
            creatorId: int.user.id,
            channelId: channel.id,
            status: 'waiting_second_user',
            buyerId: null,
            sellerId: null,
            secondUserId: null,
            escrowAddress: null,
            productDescription: null,
            priceEur: null,
            totalBuyerLtc: null,
            sellerReceivesLtc: null,
            botFeeLtc: null,
            confirmations: {},
            createdAt: Date.now()
        };
        save("./mm_sessions.json", mmSessions);

        const startEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle("\uD83E\uDD1D MM Session Started")
            .setDescription(
                `Welcome <@${int.user.id}>!\n\n` +
                `Your MM session has been created.\n\n` +
                `**Next step:** Add the other user with:\n` +
                `\`\`,adduser [ID utente]\`\`\n\n` +
                `\u26A0\uFE0F The bot will apply a **5%** fee on the deal:\n` +
                `*(2.5% buyer + 2.5% seller)*`
            )
            .setFooter({ text: `Session ID: ${sessionId}` });

        const startCloseRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`mm_close_ticket_${sessionId}`)
                .setLabel("\uD83D\uDD12 Close Ticket")
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ content: `<@${int.user.id}>`, embeds: [startEmbed], components: [startCloseRow] });
        return int.reply({ content: `\u2705 MM session created! <#${channel.id}>`, ephemeral: true });
    }

    // ================= MM BUTTON: ROLE SELECTION =================
    if (int.isButton() && int.customId.startsWith("mm_role_buyer_")) {
        const sessionId = int.customId.replace("mm_role_buyer_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.creatorId && int.user.id !== mmData.secondUserId) {
            return int.reply({ content: "\u274C You are not part of this MM session.", ephemeral: true });
        }
        if (mmData.buyerId === int.user.id) return int.reply({ content: "\u2139\uFE0F You are already registered as buyer.", ephemeral: true });
        if (mmData.sellerId === int.user.id) return int.reply({ content: "\u274C You are already registered as seller.", ephemeral: true });
        
        mmData.buyerId = int.user.id;
        
        if (mmData.sellerId) {
            mmData.status = 'roles_confirmed';
            save("./mm_sessions.json", mmSessions);
            await int.reply({ content: `\u2705 Sei registrato come **Buyer**.`, ephemeral: true });
            await startMMAfterRoles(int, sessionId, mmData);
        } else {
            save("./mm_sessions.json", mmSessions);
            await int.reply({ content: `\u2705 Sei registrato come **Buyer**. Waiting for the other user to select their role.`, ephemeral: true });
        }
        return;
    }

    if (int.isButton() && int.customId.startsWith("mm_role_seller_")) {
        const sessionId = int.customId.replace("mm_role_seller_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.creatorId && int.user.id !== mmData.secondUserId) {
            return int.reply({ content: "\u274C You are not part of this MM session.", ephemeral: true });
        }
        if (mmData.sellerId === int.user.id) return int.reply({ content: "\u2139\uFE0F You are already registered as seller.", ephemeral: true });
        if (mmData.buyerId === int.user.id) return int.reply({ content: "\u274C You are already registered as buyer.", ephemeral: true });

        mmData.sellerId = int.user.id;

        if (mmData.buyerId) {
            mmData.status = 'roles_confirmed';
            save("./mm_sessions.json", mmSessions);
            await int.reply({ content: `\u2705 Sei registrato come **Seller**.`, ephemeral: true });
            await startMMAfterRoles(int, sessionId, mmData);
        } else {
            save("./mm_sessions.json", mmSessions);
            await int.reply({ content: `\u2705 Sei registrato come **Seller**. Waiting for the other user to select their role.`, ephemeral: true });
        }
        return;
    }

    // ================= MM BUTTON: DEAL CONFIRM =================
    if (int.isButton() && int.customId.startsWith("mm_deal_confirm_")) {
        const sessionId = int.customId.replace("mm_deal_confirm_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.buyerId && int.user.id !== mmData.sellerId) {
            return int.reply({ content: "\u274C You are not part of this session.", ephemeral: true });
        }

        if (!mmData.confirmations) mmData.confirmations = {};
        mmData.confirmations[int.user.id] = true;
        save("./mm_sessions.json", mmSessions);

        const bothConfirmed = mmData.confirmations[mmData.buyerId] && mmData.confirmations[mmData.sellerId];

        if (!bothConfirmed) {
            return int.reply({ content: "\u2705 Confirmed. Waiting for the other user.", ephemeral: true });
        }

        await int.deferReply({ ephemeral: true });

        const wallet = await generateLtcAddress();
        if (!wallet) return int.editReply({ content: "\u274C Error generating escrow wallet. Try again." });

        mmData.escrowAddress = wallet.address;
        mmData.status = 'awaiting_payment';
        tempWallets[wallet.address] = {
            ownerId: 'MM_ESCROW',
            mmSessionId: sessionId,
            balance: 0,
            createdAt: Date.now(),
            privateKey: wallet.privateKey,
            wif: wallet.wif
        };
        save("./temp_wallets.json", tempWallets);
        save("./mm_sessions.json", mmSessions);

        const channel = int.guild.channels.cache.get(mmData.channelId);
        if (channel) {
            const payEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCB3 Escrow Payment - Auto MM")
                .setDescription(
                    `<@${mmData.buyerId}> you must send the payment to the escrow address:\n\n` +
                    `**Escrow Address:** \`${wallet.address}\`\n` +
                    `**Amount da inviare:** \`${mmData.totalBuyerLtc} LTC\`\n` +
                    `*(price + 2.5% fee)*\n\n` +
                    `\u26A0\uFE0F Send **exactly** the indicated amount or more.\n` +
                    `Payment will be verified automatically.`
                );

            const payRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_addy_${wallet.address}`).setLabel("\uD83D\uDCCB Copy Address").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`copy_amt_${mmData.totalBuyerLtc}`).setLabel("\uD83D\uDCCB Copia Amount").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`mm_check_escrow_${sessionId}`).setLabel("\u2705 I Paid").setStyle(ButtonStyle.Success)
            );

            await channel.send({ content: `<@${mmData.buyerId}> <@${mmData.sellerId}>`, embeds: [payEmbed], components: [payRow] });
        }

        return int.editReply({ content: "\u2705 Both confirmed! Payment instructions sent to the channel." });
    }

    // ================= MM BUTTON: DEAL CANCEL =================
    if (int.isButton() && int.customId.startsWith("mm_deal_cancel_")) {
        const sessionId = int.customId.replace("mm_deal_cancel_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.buyerId && int.user.id !== mmData.sellerId) {
            return int.reply({ content: "\u274C You are not part of this session.", ephemeral: true });
        }

        mmData.status = 'cancelled';
        save("./mm_sessions.json", mmSessions);

        const channel = int.guild.channels.cache.get(mmData.channelId);
        if (channel) {
            await channel.send({ content: `\u274C Deal cancelled by <@${int.user.id}>. MM session terminated.` });
            setTimeout(() => channel.delete().catch(() => {}), 5000);
        }
        delete mmSessions[sessionId];
        save("./mm_sessions.json", mmSessions);
        return int.reply({ content: "\u274C Deal cancelled.", ephemeral: true });
    }

    // ================= MM BUTTON: CHECK ESCROW PAYMENT =================
    if (int.isButton() && int.customId.startsWith("mm_check_escrow_")) {
        const sessionId = int.customId.replace("mm_check_escrow_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.buyerId) return int.reply({ content: "\u274C Only the buyer can verify the payment.", ephemeral: true });

        try {
            const balUrl = `https://api.blockcypher.com/v1/ltc/main/addrs/${mmData.escrowAddress}/balance?token=${CONFIG.BLOCKCYPHER_TOKEN}`;
            const balRes = await fetch(balUrl);
            const data = await balRes.json();
            const confirmedBalance = (data.total_received || 0) / 100000000;
            const unconfirmed = (data.unconfirmed_balance || 0) / 100000000;

            if (confirmedBalance >= mmData.totalBuyerLtc) {
                mmData.status = 'payment_confirmed';
                save("./mm_sessions.json", mmSessions);

                const channel = int.guild.channels.cache.get(mmData.channelId);
                if (channel) {
                    const confirmEmbed = new EmbedBuilder()
                        .setColor("#00FF00")
                        .setTitle("\u2705 Payment Confirmed - Auto MM")
                        .setDescription(
                            `Payment of \`${mmData.totalBuyerLtc} LTC\` received!\n\n` +
                            `**Seller** (<@${mmData.sellerId}>): send the product to the buyer now.\n` +
                            `**Buyer** (<@${mmData.buyerId}>): confirm reception once received.`
                        );
                    
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`mm_confirm_received_${sessionId}`).setLabel("\u2705 Ho Ricevuto il Product").setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`mm_report_issue_${sessionId}`).setLabel("\u26A0\uFE0F Report Issue").setStyle(ButtonStyle.Danger)
                    );

                    await channel.send({ content: `<@${mmData.buyerId}> <@${mmData.sellerId}>`, embeds: [confirmEmbed], components: [row] });
                }
                return int.reply({ content: "\u2705 Payment confirmed!", ephemeral: true });
            } else if (unconfirmed > 0 || confirmedBalance > 0) {
                return int.reply({ content: "\u23F3 Transaction detected, waiting for blockchain confirmations.", ephemeral: true });
            } else {
                return int.reply({ content: "\u274C Payment not yet detected. Wait a few minutes.", ephemeral: true });
            }
        } catch (e) {
            return int.reply({ content: "\u274C API check error.", ephemeral: true });
        }
    }

    // ================= MM BUTTON: CONFIRM RECEIVED =================
    if (int.isButton() && int.customId.startsWith("mm_confirm_received_")) {
        const sessionId = int.customId.replace("mm_confirm_received_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.buyerId) return int.reply({ content: "\u274C Only the buyer can confirm reception.", ephemeral: true });

        mmData.status = 'awaiting_seller_address';
        save("./mm_sessions.json", mmSessions);

        const channel = int.guild.channels.cache.get(mmData.channelId);
        if (channel) {
            const sellerAddrEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCB0 Enter your LTC Address")
                .setDescription(`<@${mmData.sellerId}>, the buyer confirmed reception!\n\nClick below to enter your LTC address and receive payment.`);
            
            const sellerRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`mm_input_seller_addr_${sessionId}`).setLabel("\uD83D\uDCB0 Enter LTC Address").setStyle(ButtonStyle.Success)
            );
            await channel.send({ content: `<@${mmData.sellerId}>`, embeds: [sellerAddrEmbed], components: [sellerRow] });
        }

        return int.reply({ content: "\u2705 Reception confirmed! Seller will receive payment instructions.", ephemeral: true });
    }

    // ================= MM BUTTON: INPUT SELLER ADDRESS =================
    if (int.isButton() && int.customId.startsWith("mm_input_seller_addr_")) {
        const sessionId = int.customId.replace("mm_input_seller_addr_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.sellerId) return int.reply({ content: "\u274C Only the seller can enter the address.", ephemeral: true });

        const modal = new ModalBuilder()
            .setCustomId(`mm_seller_address_${sessionId}`)
            .setTitle('LTC Address for Payment');

        const addrInput = new TextInputBuilder()
            .setCustomId('seller_ltc_address')
            .setLabel("Your LTC address:")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("Lxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

        modal.addComponents(new ActionRowBuilder().addComponents(addrInput));
        return int.showModal(modal);
    }

    // ================= MM BUTTON: REPORT ISSUE =================
    if (int.isButton() && int.customId.startsWith("mm_report_issue_")) {
        const sessionId = int.customId.replace("mm_report_issue_", "");
        const mmData = mmSessions[sessionId];
        if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
        if (int.user.id !== mmData.buyerId) return int.reply({ content: "\u274C Only the buyer can report an issue.", ephemeral: true });

        mmData.status = 'dispute';
        save("./mm_sessions.json", mmSessions);

        const channel = int.guild.channels.cache.get(mmData.channelId);
        if (channel) {
            await channel.permissionOverwrites.edit(CONFIG.STAFF_ROLE_ID, {
                ViewChannel: true,
                SendMessages: true
            }).catch(() => {});

            const disputeEmbed = new EmbedBuilder()
                .setColor("#FF0000")
                .setTitle("\u26A0\uFE0F DISPUTE OPENED - Staff Required")
                .setDescription(
                    `Il compratorand <@${mmData.buyerId}> reported an issue!\n\n` +
                    `**Seller:** <@${mmData.sellerId}>\n` +
                    `**Product:** ${mmData.productDescription}\n` +
                    `**Amount in escrow:** \`${mmData.totalBuyerLtc} LTC\`\n\n` +
                    `\u26A0\uFE0F Staff, please intervene to resolve the dispute.`
                );

            await channel.send({ content: `<@&${CONFIG.STAFF_ROLE_ID}>`, embeds: [disputeEmbed] });
        }

        return int.reply({ content: "\u26A0\uFE0F Issue reported. Staff will intervene shortly.", ephemeral: true });
    }

    // ================= MM BUTTON: CLOSE TICKET =================
    if (int.isButton() && int.customId.startsWith("mm_close_ticket_")) {
        const sessionId = int.customId.replace("mm_close_ticket_", "");
        const mmData = mmSessions[sessionId];
        const isStaff = int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID);
        const isBuyer = int.user.id === mmData?.buyerId;
        const isSeller = int.user.id === mmData?.sellerId;
        const hasSecondUser = mmData?.secondUserId != null;

        if (!isStaff && !isBuyer && !isSeller) {
            return int.reply({ content: "\u274C No permissions.", ephemeral: true });
        }

        // Staff closes immediately and permanently
        if (isStaff) {
            try {
                const transcript = await discordTranscripts.createTranscript(int.channel);
                const guild = int.guild;
                if (mmData) {
                    const buyer = await guild.members.fetch(mmData.buyerId).catch(() => null);
                    const seller = mmData.sellerId ? await guild.members.fetch(mmData.sellerId).catch(() => null) : null;
                    if (buyer) await buyer.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
                    if (seller) await seller.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
                }
                const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
                if (logCh) await logCh.send({ content: `\uD83D\uDD12 MM Ticket permanently closed by staff <@${int.user.id}>`, files: [transcript] });
                delete mmSessions[sessionId];
                save("./mm_sessions.json", mmSessions);
                setTimeout(() => int.channel.delete().catch(() => {}), 2000);
                return int.reply({ content: "\uD83D\uDD12 Ticket closed by staff." });
            } catch(e) {
                return int.reply({ content: "\u274C Error closing ticket.", ephemeral: true });
            }
        }

        // Solo user (no second user added yet) \u2192 close immediately
        if (!hasSecondUser) {
            try {
                const transcript = await discordTranscripts.createTranscript(int.channel);
                const guild = int.guild;
                const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
                if (logCh) await logCh.send({ content: `\uD83D\uDD12 MM Ticket closed by <@${int.user.id}> (solo user \u2014 no second user added)`, files: [transcript] });
                await int.user.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
                delete mmSessions[sessionId];
                save("./mm_sessions.json", mmSessions);
                setTimeout(() => int.channel.delete().catch(() => {}), 2000);
                return int.reply({ content: "\uD83D\uDD12 Ticket closing..." });
            } catch(e) {
                return int.reply({ content: "\u274C Error closing ticket.", ephemeral: true });
            }
        }

        // Two users present \u2192 require both to confirm
        if (!mmData.closeConfirms) mmData.closeConfirms = {};
        if (mmData.closeConfirms[int.user.id]) {
            return int.reply({ content: "\u2139\uFE0F You already confirmed closure. Waiting for the other user.", ephemeral: true });
        }
        mmData.closeConfirms[int.user.id] = true;
        save("./mm_sessions.json", mmSessions);

        const otherUserId = isBuyer ? mmData.sellerId : mmData.buyerId;
        const otherConfirmed = mmData.closeConfirms[otherUserId];

        if (!otherConfirmed) {
            return int.reply({ content: `\u2705 You confirmed closure. Waiting for <@${otherUserId}>.`, ephemeral: false });
        }

        // Both confirmed \u2192 send transcript, hide from users, show staff delete embed
        try {
            const guild = int.guild;
            const transcript = await discordTranscripts.createTranscript(int.channel);

            // DM both users
            const buyer = await guild.members.fetch(mmData.buyerId).catch(() => null);
            const seller = await guild.members.fetch(mmData.sellerId).catch(() => null);
            if (buyer) await buyer.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});
            if (seller) await seller.send({ content: "\uD83D\uDCC4 Your MM transcript:", files: [transcript] }).catch(() => {});

            // Send to log channels
            const logCh = guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (logCh) await logCh.send({ content: `\uD83D\uDD12 MM Ticket closed by entrambi gli utenti | Buyer: <@${mmData.buyerId}> | Seller: <@${mmData.sellerId}>`, files: [transcript] });

            // Hide channel from both users but keep visible to staff
            await int.channel.permissionOverwrites.edit(mmData.buyerId, { ViewChannel: false }).catch(() => {});
            await int.channel.permissionOverwrites.edit(mmData.sellerId, { ViewChannel: false }).catch(() => {});
            await int.channel.permissionOverwrites.edit(CONFIG.STAFF_ROLE_ID, { ViewChannel: true, SendMessages: true }).catch(() => {});

            // Send staff embed asking permanent delete
            const staffEmbed = new EmbedBuilder()
                .setColor("#FF0000")
                .setTitle("\uD83D\uDDD1\uFE0F MM Ticket \u2014 Permanent Deletion")
                .setDescription(
                    `Both users have confirmed closure.\n\n` +
                    `**Buyer:** <@${mmData.buyerId}>\n` +
                    `**Seller:** <@${mmData.sellerId}>\n\n` +
                    `Transcripts have been sent to users and log channels.\n` +
                    `Do you want to permanently delete this channel?`
                )
                .setTimestamp();
            const deleteRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`mm_permanent_delete_${sessionId}`)
                    .setLabel("\uD83D\uDDD1\uFE0F Delete Permanently")
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`mm_keep_ticket_${sessionId}`)
                    .setLabel("\uD83D\uDCC1 Keep Channel")
                    .setStyle(ButtonStyle.Secondary)
            );
            await int.channel.send({ content: `<@&${CONFIG.STAFF_ROLE_ID}>`, embeds: [staffEmbed], components: [deleteRow] });
            return int.reply({ content: "\u2705 Both confirmed. Channel hidden from users, staff notified.", ephemeral: false });
        } catch(e) {
            return int.reply({ content: "\u274C Error closing ticket.", ephemeral: true });
        }
    }

    // ================= MM PERMANENT DELETE / KEEP =================
    if (int.isButton() && int.customId.startsWith("mm_permanent_delete_")) {
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "\u274C Staff only.", ephemeral: true });
        const sessionId = int.customId.replace("mm_permanent_delete_", "");
        delete mmSessions[sessionId];
        save("./mm_sessions.json", mmSessions);
        await int.reply({ content: "\uD83D\uDDD1\uFE0F Deleting channel..." });
        setTimeout(() => int.channel.delete().catch(() => {}), 2000);
    }

    if (int.isButton() && int.customId.startsWith("mm_keep_ticket_")) {
        if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "\u274C Staff only.", ephemeral: true });
        return int.reply({ content: "\uD83D\uDCC1 Channel kept. You can delete it manually when ready.", ephemeral: true });
    }

    if (int.isButton()) {
        if (int.customId.startsWith("calc_")) {
            const s = sessions.get(int.user.id);
            if (!s || s.type !== 'exchange') return int.reply({ content: "Session expired.", ephemeral: true });

            const action = int.customId.split("_")[1];

            if (action === "confirm") {
                if (s.amount === "0" || s.amount === "0.") return int.reply({ content: "Enter a valid amount before confirming.", ephemeral: true });
                
                const tosEmbed = new EmbedBuilder()
                    .setColor("#5FB3C4")
                    .setTitle("\uD83D\uDCCB Terms of Service Acceptance")
                    .setDescription(
                        `**Your exchange request summary:**\n\n` +
                        `\uD83D\uDCE4 **Sending:** \`${s.have}\`\n` +
                        `\uD83D\uDCE5 **Receiving:** \`${s.want}\`\n` +
                        `\uD83D\uDCB0 **Amount:** \`${s.amount}\`\n\n` +
                        `**Please read our Terms of Service before proceeding.**\n` +
                        `By accepting you confirm that:\n` +
                        `\u2022 The information provided is correct\n` +
                        `\u2022 You are aware of exchange risks\n` +
                        `\u2022 You will not open fraudulent disputes\n\n` +
                        `Press **"Yes, I Accept"** to open the ticket with staff, or **"No, Decline"** to cancel.`
                    )
                    .setFooter({ text: "Astro Exchange | Exchange Service" });
                
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("confirm_ticket").setLabel("Yes, I Accept").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("cancel_ticket").setLabel("No, Decline").setStyle(ButtonStyle.Danger)
                );
                
                return int.update({ embeds: [tosEmbed], components: [row] });
            }

            if (action === "clear") {
                s.amount = "0";
            } else if (action === "back") {
                s.amount = s.amount.slice(0, -1);
                if (s.amount.length === 0) s.amount = "0";
            } else if (action === "dot") {
                if (!s.amount.includes(".")) s.amount += ".";
            } else { 
                if (s.amount === "0") s.amount = action;
                else s.amount += action;
                if (s.amount.length > 15) s.amount = s.amount.slice(0, 15);
            }

            sessions.set(int.user.id, s);

            const amountEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCB1 Configurazione Exchange \u2014 Amount")
                .setDescription(
                    `**Step 3 of 3 \u2014 Enter amount**\n\n` +
                    `You are configuring an exchange:\n` +
                    `\uD83D\uDCE4 **Sending:** \`${s.have}\`\n` +
                    `\uD83D\uDCE5 **Receiving:** \`${s.want}\`\n\n` +
                    `Use the keypad below to type the amount.\n` +
                    `Press **Confirm \u2705** when ready.\n\n` +
                    `\uD83D\uDCB0 **Amount attuale: \`${s.amount}\`**`
                )
                .setFooter({ text: "Astro Exchange | Exchange Service" });

            return int.update({ embeds: [amountEmbed], components: getCalcRows() });
        }

        if (int.customId.startsWith('activate_slot_')) {
            if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: '❌ Solo lo staff può usare questo bottone.', ephemeral: true });
            const orderId = int.customId.replace('activate_slot_', '');
            let orders = {};
            try { orders = JSON.parse(fs.readFileSync('./pending_slot_orders.json', 'utf8')); } catch {}
            const order = orders[orderId];
            if (!order) return int.reply({ content: '❌ Ordine non trovato.', ephemeral: true });
            orders[orderId].status = 'activated';
            fs.writeFileSync('./pending_slot_orders.json', JSON.stringify(orders, null, 2));
            await int.reply({ embeds: [new EmbedBuilder().setColor(0x4ade80).setTitle('✅ Slot Attivato').addFields(
                { name: 'Categoria', value: order.tier, inline: true },
                { name: 'Durata', value: order.duration, inline: true },
                { name: 'Importo', value: `€${order.amountEur}`, inline: true },
                { name: 'Discord', value: order.discord || 'Non inserito', inline: true },
                { name: 'Order ID', value: `\`${orderId}\``, inline: false },
            )] });
            await int.message.edit({ components: [] }).catch(() => {});
            return;
        }
        if (int.customId.startsWith('cancel_slot_')) {
            if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: '❌ Solo lo staff può usare questo bottone.', ephemeral: true });
            const orderId = int.customId.replace('cancel_slot_', '');
            let orders = {};
            try { orders = JSON.parse(fs.readFileSync('./pending_slot_orders.json', 'utf8')); } catch {}
            if (orders[orderId]) {
                orders[orderId].status = 'cancelled';
                fs.writeFileSync('./pending_slot_orders.json', JSON.stringify(orders, null, 2));
            }
            await int.reply({ content: '❌ Ordine annullato.', ephemeral: true });
            await int.message.edit({ components: [] }).catch(() => {});
            return;
        }

                if (int.customId.startsWith("copy_addy_") || int.customId.startsWith("copy_amt_")) {
            const value = int.customId.split("_").slice(2).join("_");
            return int.reply({ content: `\`${value}\``, ephemeral: true });
        }

        if (int.customId === "check_payment_btn") {
            const payData = pendingPayments[int.user.id];
            if (!payData) return int.reply({ content: "\u274C No pending payment found.", ephemeral: true });

            // Fetch full TX details: confirmed + unconfirmed from BlockCypher
            async function fetchTxDetails(address) {
                const balRes = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${CONFIG.BLOCKCYPHER_TOKEN}`);
                const balData = await balRes.json();
                const confirmedReceived = (balData.total_received || 0) / 100000000;
                const unconfirmedBal = (balData.unconfirmed_balance || 0) / 100000000;

                // Full address info to get txrefs (confirmed) and unconfirmed_txrefs
                const addrRes = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=false&token=${CONFIG.BLOCKCYPHER_TOKEN}`);
                const addrData = await addrRes.json();

                const allRefs = [];
                if (addrData.txrefs) allRefs.push(...addrData.txrefs);
                if (addrData.unconfirmed_txrefs) allRefs.push(...addrData.unconfirmed_txrefs);
                // Most recent first
                allRefs.sort((a, b) => (b.received ? new Date(b.received) : 0) - (a.received ? new Date(a.received) : 0));
                const lastTx = allRefs[0] || null;

                let confirmations = 0;
                let txHash = "N/A";
                let status = "\u274C Not detected \u2014 waiting for transaction...";

                if (lastTx) {
                    txHash = lastTx.tx_hash || "N/A";
                    confirmations = lastTx.confirmations || 0;
                    if (confirmations === 0) status = "\u23F3 In mempool \u2014 unconfirmed";
                    else if (confirmations < 3) status = `\u26A0\uFE0F Partially confirmed (${confirmations}/3)`;
                    else status = `\u2705 Confirmed (${confirmations} confirmations)`;
                } else if (confirmedReceived > 0 || unconfirmedBal > 0) {
                    status = "\u23F3 Transaction detected \u2014 fetching details...";
                }

                // Use the higher of confirmed or unconfirmed as "received"
                const totalReceived = Math.max(confirmedReceived, unconfirmedBal);
                return { totalReceived, confirmedReceived, unconfirmedBal, txHash, confirmations, status };
            }

            // Build the live embed
            function buildTxEmbed(details, pd) {
                const pct = Math.min(100, Math.floor((details.totalReceived / pd.amountLtc) * 100));
                const filled = Math.floor(pct / 10);
                const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
                const color = details.totalReceived >= pd.amountLtc ? "#00FF00" : (details.totalReceived > 0 ? "#FFA500" : "#5FB3C4");
                return new EmbedBuilder()
                    .setColor(color)
                    .setTitle("\uD83D\uDD0D Live Transaction Monitor")
                    .addFields(
                        { name: "\uD83D\uDCE5 Receiver Address", value: `\`${pd.address}\``, inline: false },
                        { name: "\uD83D\uDCB0 Required", value: `\`${pd.amountLtc} LTC\``, inline: true },
                        { name: "\uD83D\uDCE8 Received (total)", value: `\`${details.totalReceived.toFixed(6)} LTC\``, inline: true },
                        { name: "\u2705 Confirmed", value: `\`${details.confirmedReceived.toFixed(6)} LTC\``, inline: true },
                        { name: "\uD83D\uDCCA Progress", value: `\`${bar}\` ${pct}%`, inline: false },
                        { name: "\uD83D\uDD17 TX Hash", value: details.txHash !== "N/A" ? `\`${details.txHash}\`` : "_No transaction detected yet_", inline: false },
                        { name: "\u2714\uFE0F Confirmations", value: `\`${details.confirmations}\``, inline: true },
                        { name: "\uD83D\uDCE1 Status", value: details.status, inline: true }
                    )
                    .setFooter({ text: "\uD83D\uDD04 Updating every 10 seconds \u2022 Astro Exchange" })
                    .setTimestamp();
            }

            // Process a confirmed payment (notify staff, transfer LTC, create slot if needed)
            async function processConfirmedPayment(userId, pd) {
                const guild = client.guilds.cache.first();
                const ticketCh = guild?.channels.cache.get(pd.ticketChannelId);
                if (guild && pd.ticketChannelId) {
                    await notifyStaffPayment(guild, pd.ticketChannelId, userId, pd.amountLtc, pd.ticketType || "slot");
                }
                if (ticketCh) await sendRecordingEmbed(ticketCh, userId, pd.ticketType || "slot");

                if (pd.ticketType === "slot" || !pd.ticketType) {
                    await checkPayments(userId);
                } else {
                    // Product ticket: transfer LTC only, NO slot creation
                    pd.completed = true;
                    save("./pending_payments.json", pendingPayments);
                    const success = await transferLTC(pd.address, CONFIG.MY_LTC_ADDRESS);
                    if (success) { delete tempWallets[pd.address]; save("./temp_wallets.json", tempWallets); }
                    if (!userTransactions[userId]) userTransactions[userId] = [];
                    userTransactions[userId].push({ type: "Product Purchase", amount: `${pd.amountLtc} LTC`, detail: pd.priceEur ? `${pd.priceEur}\u20AC` : "N/A", date: Date.now() });
                    save("./user_transactions.json", userTransactions);
                    delete pendingPayments[userId];
                    save("./pending_payments.json", pendingPayments);
                }
            }

            try {
                const initialDetails = await fetchTxDetails(payData.address);
                const txEmbed = buildTxEmbed(initialDetails, payData);
                const liveMsg = await int.reply({ embeds: [txEmbed], fetchReply: true });

                let alreadyProcessed = false;

                // Already confirmed at click time?
                if (initialDetails.totalReceived >= payData.amountLtc) {
                    alreadyProcessed = true;
                    await processConfirmedPayment(int.user.id, payData);
                    const doneEmbed = buildTxEmbed(initialDetails, payData);
                    doneEmbed.setTitle("\u2705 Payment Confirmed!");
                    await liveMsg.edit({ embeds: [doneEmbed] }).catch(() => {});
                    return;
                }

                // Infinite interval: updates every 10s, stops only when payment confirmed
                const interval = setInterval(async () => {
                    if (alreadyProcessed) { clearInterval(interval); return; }
                    try {
                        const details = await fetchTxDetails(payData.address);
                        const updatedEmbed = buildTxEmbed(details, payData);
                        await liveMsg.edit({ embeds: [updatedEmbed] }).catch(() => {});

                        if (details.totalReceived >= payData.amountLtc) {
                            alreadyProcessed = true;
                            clearInterval(interval);
                            await processConfirmedPayment(int.user.id, payData);
                            const doneEmbed = buildTxEmbed(details, payData);
                            doneEmbed.setTitle("\u2705 Payment Confirmed!");
                            await liveMsg.edit({ embeds: [doneEmbed] }).catch(() => {});
                        }
                    } catch(e) { /* API error, retry next tick */ }
                }, 10000);

            } catch(e) {
                return int.reply({ content: "\u274C API error while checking payment.", ephemeral: true });
            }
        }

        if (int.customId === "cancel_ticket") {
            sessions.delete(int.user.id);
            return int.update({ content: "\u274C Operation Cancelled.", embeds: [], components: [] });
        }

        if (int.customId === "confirm_ticket") {
            await int.deferUpdate();
            const s = sessions.get(int.user.id);
            if (!s) return;
            try {
                const isSlot = (s.type === "slot");
                const safeName = int.user?.username || 'user';
                const ch = await int.guild.channels.create({
                    name: `${isSlot ? 'slot-purchase' : 'exch'}-${safeName}`,
                    parent: CONFIG.TICKET_CATEGORY_ID,
                    permissionOverwrites: 
                        { id: [int.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: int.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: CONFIG.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                    ]
                });

                // NEW: track ticket type
                ticketTypes[ch.id] = s.type;
                save("./ticket_types.json", ticketTypes);

                if (!isSlot) {
                    const globalLogCh = int.guild.channels.cache.get(CONFIG.GLOBAL_LOG_CHANNEL_ID);
                    if (globalLogCh) {
                        const exchEmbed = new EmbedBuilder()
                            .setColor("#5FB3C4")
                            .setTitle("\uD83D\uDCF1 New Exchange Ticket")
                            .addFields(
                                { name: "User", value: `<@${int.user.id}>`, inline: true },
                                { name: "Sends", value: s.have, inline: true },
                                { name: "Receives", value: s.want, inline: true },
                                { name: "Amount", value: s.amount, inline: false }
                            )
                            .setTimestamp();
                        globalLogCh.send({ embeds: [exchEmbed] }).catch(()=>{});
                    }
                }
                
                const embed = new EmbedBuilder()
                    .setColor("#5FB3C4")
                    .setTitle(isSlot ? "Buy Slot Ticket" : "Exchange Ticket")
                    .setThumbnail("https://cdn.discordapp.com/emojis/1430879303695863830.png")
                    .setDescription(`> Please refrain from pinging while waiting as we may be busy, we will get to you as soon as possible.\n\n` + 
                        (isSlot ? 
                        `**Terms Accepted:**\nYes\n\n**User ID:**\n\`${int.user.id}\`\n\n**Selected Category:**\n${s.category}\n\n**Duration:**\n${s.duration}\n\n**Has Vouches:**\n${s.vouch}` : 
                        `**Terms Accepted:**\nYes\n\n**User ID:**\n\`${int.user.id}\`\n\n**Sends:**\n${s.have}\n\n**Receives:**\n${s.want}\n\n**Amount:**\n${s.amount}`));

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("claim_t").setLabel("Claim Ticket").setStyle(ButtonStyle.Primary).setEmoji("\uD83C\uDFAB"), 
                    new ButtonBuilder().setCustomId("copy_u_id").setLabel("Copy ID's").setStyle(ButtonStyle.Secondary).setEmoji("\uD83D\uDD17"),
                    new ButtonBuilder().setCustomId("close_t").setLabel("Close Ticket").setStyle(ButtonStyle.Danger).setEmoji("\uD83D\uDD12")
                );
                
                await ch.send({ 
                    content: `Welcomand <@${int.user.id}>, <@&${CONFIG.STAFF_ROLE_ID}> will be with you shortly`, 
                    embeds: [embed], 
                    components: [row1] 
                });
                await int.editReply({ content: `\u2705 Ticket Created! <#${ch.id}>`, embeds: [], components: [] });
                sessions.delete(int.user.id);
            } catch (err) { await int.editReply({ content: "\u274C Error.", components: [] }); }
        }

        if (int.customId === "copy_u_id") {
            const idMatch = int.message.embeds[0]?.description.match(/`(\d{17,19})`/);
            return int.reply({ content: idMatch ? idMatch[1] : "ID not found.", ephemeral: true });
        }
        if (int.customId === "claim_t") {
            if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "Staff only.", ephemeral: true });
            return int.reply({ content: `\uD83C\uDFAB Claimed by <@${int.user.id}>` });
        }
        if (int.customId === "close_t") {
            if (!int.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return int.reply({ content: "Staff only.", ephemeral: true });
            const transcript = await discordTranscripts.createTranscript(int.channel);
            const logCh = int.guild.channels.cache.get(CONFIG.LOG_CHANNEL_ID);
            if (logCh) await logCh.send({ content: `Ticket closed by ${int.user?.tag || 'User'}`, files: [transcript] });
            setTimeout(() => int.channel.delete().catch(() => {}), 2000);
        }
        if (int.customId.startsWith("qr_gen_")) {
            const parts = int.customId.split("_");
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=litecoin:${parts[2]}?amount=${parts[3]}`;
            const qrEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle("LTC QR Code").setImage(qrUrl);
            return int.reply({ embeds: [qrEmbed], ephemeral: true });
        }
    }

    if (int.isStringSelectMenu()) {

        // ================= ESCROW CRYPTO SELECT =================
        if (int.customId === "escrow_select_crypto") {
            const crypto = int.values[0];

            escrowTradeCount.count++;
            save("./escrow_trade_count.json", escrowTradeCount);
            const tradeNum = escrowTradeCount.count;

            const cryptoLabels = { LTC:"LTC", SOL:"SOL", ETH:"ETH", BTC:"BTC", USDT_SOL:"USDT" };
            const label = cryptoLabels[crypto] || crypto;
            const threadName = `${label} | Trade #${tradeNum} with @${int.user.username}`;

            const thread = await int.channel.threads.create({
                name: threadName,
                autoArchiveDuration: 10080,
                reason: `Escrow trade #${tradeNum} by ${int.user.tag}`
            }).catch(() => null);

            if (!thread) {
                await int.reply({ content: "❌ Failed to create thread.", ephemeral: true });
                return;
            }

            // Delete "bot created a thread" system message after 200ms
            setTimeout(async () => {
                try {
                    const messages = await int.channel.messages.fetch({ limit: 5 });
                    const sysMsg = messages.find(m => (m.type === 18 || m.type === 50) && !m.author?.bot === false);
                    if (sysMsg) await sysMsg.delete().catch(() => {});
                } catch(e) {}
            }, 200);

            await thread.members.add(int.user.id).catch(() => {});

            // Delete "bot added user to thread" system message after 500ms
            setTimeout(async () => {
                try {
                    const tMsgs = await thread.messages.fetch({ limit: 5 });
                    tMsgs.filter(m => m.type === 18 || m.type === 19 || m.system).forEach(m => m.delete().catch(() => {}));
                } catch(e) {}
            }, 500);

            escrowSessions[thread.id] = {
                tradeNum,
                crypto,
                creatorId: int.user.id,
                status: "awaiting_payment",
                createdAt: Date.now()
            };
            save("./escrow_sessions.json", escrowSessions);

            // Send embed inside the thread
            const cryptoEmojis = { LTC:"<:ltc:1497994881262682173>", SOL:"<:Solana:1498488264233844766>", ETH:"<:eth:1498724198280073296>", BTC:"<:BTC:1498724194618314966>", USDT_SOL:"<:USDT:1498724196367204484>" };
            const networkNames = { LTC:"Litecoin Network", SOL:"Solana Network", ETH:"Ethereum Network", BTC:"Bitcoin Network", USDT_SOL:"USDT on Solana Network" };

            const threadEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(`${cryptoEmojis[crypto]} Escrow Trade #${tradeNum}`)
                .setDescription(
                    `**Network:** ${networkNames[crypto]}\n` +
                    `**Opened by:** <@${int.user.id}>\n\n` +
                    `**How to start:**\n` +
                    `**1.** Mention the other user (@ or paste their ID) to add them to this thread.\n` +
                    `**2.** Both parties select their role (Sender / Receiver).\n` +
                    `**3.** Once both roles are set, click **Generate Deposit Address**.\n` +
                    `**4.** Buyer sends funds — seller delivers.\n` +
                    `**5.** Staff confirms and funds are released.\n\n` +
                    `Fee: **0.25%** + network fees (auto-deducted at settlement).`
                )
                .setFooter({ text: "Astro Exchange | Escrow System" })
                .setTimestamp();

            const threadRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`escrow_start_${thread.id}`)
                    .setLabel("Generate Deposit Address")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`escrow_close_${thread.id}`)
                    .setLabel("Close Trade")
                    .setStyle(ButtonStyle.Danger)
            );

            await thread.send({ embeds: [threadEmbed], components: [threadRow] });

            await int.reply({ content: `Thread created: <#${thread.id}>`, ephemeral: true });
            return;
        }

        if (int.customId === "ticket_main") {
            const type = int.values[0];
            sessions.set(int.user.id, { type: type });
            
            if (type === "slot") {
                // ================= SLOT STEP 1: CATEGORY =================
                const catEmbed = new EmbedBuilder()
                    .setColor("#5FB3C4")
                    .setTitle("\uD83C\uDFB0 Slot Purchase \u2014 Step 1 of 4")
                    .setDescription(
                        `Welcome to the **Slot** purchase system of Astro Exchange!\n\n` +
                        `Slots let you advertise your products or services directly in the server.\n\n` +
                        `**How it works:**\n` +
                        `1\uFE0F\u20E3 Choose the slot **category** (this step)\n` +
                        `2\uFE0F\u20E3 Choose the **duration**\n` +
                        `3\uFE0F\u20E3 Indicate if you have **vouches**\n` +
                        `4\uFE0F\u20E3 Accept **TOS** and the ticket will open\n\n` +
                        `**Available categories:**\n` +
                        `1\uFE0F\u20E3 **First** \u2014 premium position, maximum visibility\n` +
                        `2\uFE0F\u20E3 **Second** \u2014 intermediate position, great visibility\n` +
                        `3\uFE0F\u20E3 **Third** \u2014 base position, good visibility\n\n` +
                        `\uD83D\uDCC2 **Select the desired category:**`
                    )
                    .setFooter({ text: "Astro Exchange | Slot Purchase \u2022 Step 1 of 4" });

                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId("step_cat").addOptions([
                        { label: "First Category", value: "First", emoji: "1\uFE0F\u20E3" },
                        { label: "Second Category", value: "Second", emoji: "2\uFE0F\u20E3" },
                        { label: "Third Category", value: "Third", emoji: "3\uFE0F\u20E3" }
                    ]));
                return int.reply({ embeds: [catEmbed], components: [row], ephemeral: true });

            } else if (type === "product") {
                // NEW: Product Purchase - open modal directly
                const modal = new ModalBuilder().setCustomId("product_purchase_form").setTitle("Product Purchase");
                const productInput = new TextInputBuilder().setCustomId('pp_product_name').setLabel("Product name:").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. Nitro Boost x10");
                const quantityInput = new TextInputBuilder().setCustomId('pp_quantity').setLabel("Quantity:").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("e.g. 10");
                const otherInput = new TextInputBuilder().setCustomId('pp_other_info').setLabel("Other info (optional):").setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder("Any additional details...");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(productInput),
                    new ActionRowBuilder().addComponents(quantityInput),
                    new ActionRowBuilder().addComponents(otherInput)
                );
                return int.showModal(modal);

            } else if (type === "exchange") {
                const haveEmbed = new EmbedBuilder()
                    .setColor("#5FB3C4")
                    .setTitle("\uD83D\uDCB1 Exchange Setup \u2014 Step 1 of 3")
                    .setDescription(
                        `Welcome to the **Exchange** service of Astro Exchange!\n\n` +
                        `You can exchange currencies and crypto safely with staff assistance.\n\n` +
                        `**How it works:**\n` +
                        `1\uFE0F\u20E3 Choose what you will **send** (this step)\n` +
                        `2\uFE0F\u20E3 Choose what you will **receive**\n` +
                        `3\uFE0F\u20E3 Enter the **amount**\n` +
                        `4\uFE0F\u20E3 Accept **TOS** and the ticket will open automaticamente\n\n` +
                        `\uD83D\uDCE4 **What do you want to send?**\n` +
                        `Select from the menu below:`
                    )
                    .setFooter({ text: "Astro Exchange | Exchange Service" });
                
                const haveRow = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("exch_have")
                        .setPlaceholder("Choose what you send")
                        .addOptions([
                            { label: "PayPal Balance", value: "PayPal Balance" },
                            { label: "LTC", value: "LTC" },
                            { label: "BTC", value: "BTC" },
                            { label: "PayPal Card", value: "PayPal Card" },
                            { label: "Apple Pay", value: "Apple Pay" },
                            { label: "Revolut", value: "Revolut" },
                            { label: "Other Crypto", value: "Other Crypto" }
                        ])
                );
                return int.reply({ embeds: [haveEmbed], components: [haveRow], ephemeral: true });
            }
        }

        if (int.customId === "exch_have") {
            const s = sessions.get(int.user.id);
            if (!s) return;
            s.have = int.values[0];
            
            const wantEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCB1 Exchange Setup \u2014 Step 2 of 3")
                .setDescription(
                    `You chose to send: **${s.have}**\n\n` +
                    `Now indicate what you want to **receive** in exchange.\n` +
                    `Staff will verify feasibility and contact you in the ticket.\n\n` +
                    `\uD83D\uDCE5 **What do you want to receive?**\n` +
                    `Select from the menu below:`
                )
                .setFooter({ text: "Astro Exchange | Exchange Service \u2022 Step 2 of 3" });

            const wantRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("exch_want")
                    .setPlaceholder("Choose what you receive")
                    .addOptions([
                        { label: "PayPal Balance", value: "PayPal Balance" },
                        { label: "LTC", value: "LTC" },
                        { label: "BTC", value: "BTC" },
                        { label: "PayPal Card", value: "PayPal Card" },
                        { label: "Revolut", value: "Revolut" },
                        { label: "Other Crypto", value: "Other Crypto" }
                    ])
            );
            return int.update({ embeds: [wantEmbed], components: [wantRow] });
        }

        if (int.customId === "exch_want") {
            const s = sessions.get(int.user.id);
            if (!s) return;
            s.want = int.values[0];
            s.amount = "0";

            const amountEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83D\uDCB1 Exchange Setup \u2014 Step 3 of 3")
                .setDescription(
                    `**Step 3 of 3 \u2014 Enter amount**\n\n` +
                    `You are configuring an exchange:\n` +
                    `\uD83D\uDCE4 **Sending:** \`${s.have}\`\n` +
                    `\uD83D\uDCE5 **Receiving:** \`${s.want}\`\n\n` +
                    `Use the keypad below to type the amount.\n` +
                    `Press **Confirm \u2705** when ready.\n\n` +
                    `\uD83D\uDCB0 **Amount attuale: \`${s.amount}\`**`
                )
                .setFooter({ text: "Astro Exchange | Exchange Service \u2022 Step 3 of 3" });

            return int.update({ embeds: [amountEmbed], components: getCalcRows() });
        }

        if (int.customId === "step_cat") {
            const s = sessions.get(int.user.id);
            if (!s) return;
            s.category = int.values[0];

            const priceWeekly = CONFIG.PRICES[`${s.category}_Weekly`];
            const priceMonthly = CONFIG.PRICES[`${s.category}_Monthly`];
            const priceLifetime = CONFIG.PRICES[`${s.category}_Lifetime`];

            const durEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83C\uDFB0 Slot Purchase \u2014 Step 2 of 4")
                .setDescription(
                    `You selected category: **${s.category}**\n\n` +
                    `Now choose the **duration** of your slot.\n\n` +
                    `**Prices for ${s.category}:**\n` +
                    `\u23F1\uFE0F **Weekly** (7 days) \u2014 \`${priceWeekly}\u20AC\`\n` +
                    `\uD83D\uDCC5 **Monthly** (30 days) \u2014 \`${priceMonthly}\u20AC\`\n` +
                    `\u267E\uFE0F **Lifetime** (permanent) \u2014 \`${priceLifetime}\u20AC\`\n\n` +
                    `\u23F3 **Select the desired duration:**`
                )
                .setFooter({ text: "Astro Exchange | Slot Purchase \u2022 Step 2 of 4" });

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId("step_dur").addOptions([
                    { label: "Weekly \u2014 7 days", value: "Weekly", emoji: "\u23F1\uFE0F" },
                    { label: "Monthly \u2014 30 days", value: "Monthly", emoji: "\uD83D\uDCC5" },
                    { label: "Lifetime \u2014 Permanent", value: "Lifetime", emoji: "\u267E\uFE0F" }
                ]));
            return int.update({ embeds: [durEmbed], components: [row] });
        }

        if (int.customId === "step_dur") {
            const s = sessions.get(int.user.id);
            if (!s) return;
            s.duration = int.values[0];

            const vouchEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83C\uDFB0 Slot Purchase \u2014 Step 3 of 4")
                .setDescription(
                    `Great! You chose:\n` +
                    `\uD83D\uDCC2 **Category:** \`${s.category}\`\n` +
                    `\u23F3 **Duration:** \`${s.duration}\`\n\n` +
                    `Do you have **vouches** (reviews/feedback) to show?\n\n` +
                    `Vouches demonstrate your reliability and can speed up slot approval.\n\n` +
                    `\u2705 Select **"Yes"** if you have vouches to show staff.\n` +
                    `\u274C Select **"No"** if you don't have any yet.`
                )
                .setFooter({ text: "Astro Exchange | Slot Purchase \u2022 Step 3 of 4" });

            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId("step_vouch").addOptions([
                    { label: "Yes, I have vouches", value: "Yes", emoji: "\u2705" },
                    { label: "No, I don't have vouches", value: "No", emoji: "\u274C" }
                ]));
            return int.update({ embeds: [vouchEmbed], components: [row] });
        }

        if (int.customId === "step_vouch") {
            const s = sessions.get(int.user.id);
            if (!s) return;
            s.vouch = int.values[0];

            const priceKey = `${s.category}_${s.duration}`;
            const price = CONFIG.PRICES[priceKey] || "N/A";

            const tosEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle("\uD83C\uDFB0 Slot Purchase \u2014 Step 4 of 4 \u2014 Accept TOS")
                .setDescription(
                    `**Your order summary:**\n\n` +
                    `\uD83D\uDCC2 **Category:** \`${s.category}\`\n` +
                    `\u23F3 **Duration:** \`${s.duration}\`\n` +
                    `\uD83D\uDCB0 **Price:** \`${price}\u20AC\`\n` +
                    `\uD83C\uDFC5 **Vouches:** \`${s.vouch}\`\n\n` +
                    `**Terms of Service \u2014 please read before proceeding:**\n` +
                    `\u2022 You must follow the [slot rules](https://discordapp.com/channels/1418195263444619266/1430879274247651350)\n` +
                    `\u2022 No illegal products or scams allowed\n` +
                    `\u2022 Breaking rules results in immediate slot revocation without refund\n` +
                    `\u2022 You always accept the server MM (Middleman) service\n` +
                    `\u2022 Payment must be made in LTC at the address provided by staff\n\n` +
                    `Press **"Accept"** to open the ticket, or **"Decline"** to cancel.`
                )
                .setFooter({ text: "Astro Exchange | Slot Purchase \u2022 Step 4 of 4" });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("confirm_ticket").setLabel("\u2705 Accept & Open Ticket").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("cancel_ticket").setLabel("\u274C Decline").setStyle(ButtonStyle.Danger)
            );
            return int.update({ embeds: [tosEmbed], components: [row] });
        }
    }
});

// ================= MM HELPER: START AFTER ROLES =================
async function startMMAfterRoles(int, sessionId, mmData) {
    const channel = int.guild.channels.cache.get(mmData.channelId);
    if (!channel) return;

    const rolesEmbed = new EmbedBuilder()
        .setColor("#00FF00")
        .setTitle("\u2705 Roles Assigned - Auto MM")
        .setDescription(
            `Roles have been assigned:\n\n` +
            `**Buyer:** <@${mmData.buyerId}>\n` +
            `**Seller:** <@${mmData.sellerId}>\n\n` +
            `The **buyer** must now enter the deal details using the form below.`
        );

    const formRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`mm_open_product_form_${sessionId}`)
            .setLabel("\uD83D\uDCDD Enter Deal Details")
            .setStyle(ButtonStyle.Primary)
    );

    await channel.send({ content: `<@${mmData.buyerId}>`, embeds: [rolesEmbed], components: [formRow] });
}

// ================= MM BUTTON: OPEN PRODUCT FORM =================
client.on("interactionCreate", async int => {
    if (!int.isButton()) return;
    if (!int.customId.startsWith("mm_open_product_form_")) return;

    const sessionId = int.customId.replace("mm_open_product_form_", "");
    const mmData = mmSessions[sessionId];
    if (!mmData) return int.reply({ content: "\u274C Session not found.", ephemeral: true });
    if (int.user.id !== mmData.buyerId) return int.reply({ content: "\u274C Only the buyer can fill this form.", ephemeral: true });

    const modal = new ModalBuilder()
        .setCustomId(`mm_product_form_${sessionId}`)
        .setTitle('MM Deal Details');

    const productInput = new TextInputBuilder()
        .setCustomId('mm_product_desc')
        .setLabel("What are you buying? (brief description)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder("Es: Account Premium, Servizio X, Product Y...");

    const priceInput = new TextInputBuilder()
        .setCustomId('mm_price_eur')
        .setLabel("Price accordato (in EUR, es: 25.00)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("25.00");

    modal.addComponents(
        new ActionRowBuilder().addComponents(productInput),
        new ActionRowBuilder().addComponents(priceInput)
    );

    return int.showModal(modal);
});

// ================= SLASH COMMAND HANDLER =================
client.on("interactionCreate", async int => {
    if (!int.isChatInputCommand()) return;
    const { commandName: cmd, guild, member, channel } = int;

    // Helper: build a fake msg-like reply for slash commands
    async function slashReply(content, opts = {}) {
        if (int.replied || int.deferred) return int.followUp({ content, ...opts }).catch(() => {});
        return int.reply({ content, ...opts });
    }
    async function slashEmbed(embeds, opts = {}) {
        if (int.replied || int.deferred) return int.followUp({ embeds, ...opts }).catch(() => {});
        return int.reply({ embeds, ...opts });
    }

    //  User Commands 
    if (cmd === "help") {
        const banner = new AttachmentBuilder("https://cdn.discordapp.com/attachments/1430879287728148631/1498395062458126346/6DCCD550-4682-477F-AB9C-159B8F40BC19.png", { name: "banner.png" });
        const helpEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setImage("attachment://banner.png")
            .addFields(
                { name: " User Commands", value: "`/ltc [€]` — Convert EUR→LTC\n`/setltc [addr]` — Save LTC address (owner only)", inline: false },
                { name: " Tickets", value: "• **Slot Purchase** • **Product Purchase** • **Exchange** • **MM**\nOpen via the panel in the tickets channel.", inline: false },
                { name: " Lookup", value: "`/tx [txid]` — Track LTC tx\n`/ltcinfo [addr]` — LTC address info\n`/ltc [€]` — EUR to LTC", inline: false },
                { name: "ℹ Staff", value: "Use `,helpstaff` or `/helpstaff`.", inline: false }
            )
            .setFooter({ text: "Astro Exchange • Deletes in 10 seconds" })
            .setTimestamp();
        const r = await int.reply({ embeds: [helpEmbed], fetchReply: true });
        setTimeout(() => r.delete().catch(() => {}), 10000);
        return;
    }

    if (cmd === "setltc") {
        if (int.user.id !== CONFIG.OWNER_ID) return int.reply({ content: " Only the owner can use this command.", ephemeral: true });
        const address = int.options.getString("address");
        ltcData[int.user.id] = address;
        save("./ltc.json", ltcData);
        return int.reply({ content: " LTC Address saved successfully.", ephemeral: true });
    }

    if (cmd === "ltc") {
        const eur = int.options.getNumber("amount");
        const ltcAmt = (eur / cachedLtcPrice).toFixed(6);
        const addy = ltcData[int.user.id];
        if (!addy) return int.reply({ content: " Use `/setltc` first.", ephemeral: true });
        const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle("Litecoin")
            .setDescription(`**Address:**\n\`${addy}\`\n**Amount:**\n\`${ltcAmt}\` LTC`);
        const r1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copy_addy_${addy}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`copy_amt_${ltcAmt}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`qr_gen_${addy}_${ltcAmt}`).setLabel("QR Code").setStyle(ButtonStyle.Primary)
        );
        return int.reply({ embeds: [embed], components: [r1] });
    }

    //  Staff gate 
    const isStaff = member.roles.cache.has(CONFIG.STAFF_ROLE_ID);
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

    if (cmd === "helpstaff") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const banner = new AttachmentBuilder("https://cdn.discordapp.com/attachments/1430879287728148631/1498395062458126346/6DCCD550-4682-477F-AB9C-159B8F40BC19.png", { name: "banner.png" });
        const staffEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setImage("attachment://banner.png")
            .addFields(
                {
                    name: " Slots",
                    value: "`/slot` — Create slot (LTC or manual)\n`/cslot` — Manual slot\n`/do [€]` — LTC payment in ticket\n`/complete` — Force-complete\n`/revoke` — Revoke slot\n`/hold [reason]` / `/unhold` — Hold/unhold\n`/nuke` — Nuke channel\n`/setupslot` — Configure pings\n`/info` — User slot & history",
                    inline: false
                },
                {
                    name: " Shop",
                    value: "`/dash` — SellAuth dashboard\n`/stock` — View stock\n`/restock` — Add stock\n`/livestock` — Set live stock channel\n`/deleteproduct` — Delete product\n`/dashboard` — Temp LTC wallets\n`/testall` — Run diagnostics\n`/testorder` — Debug last order",
                    inline: false
                },
                {
                    name: " MM & Tickets",
                    value: "`/setup` — Post ticket panel\n`/setupmm` — Post MM panel\n`/adduser [ID]` — Add user to MM\n`/vouch` — Generate vouch",
                    inline: false
                },
                {
                    name: " Lookup",
                    value: "`/tx [txid]` — Track LTC tx (2s updates)\n`/txid [orderid]` — SellAuth order\n`/ltcinfo [addr]` — LTC address info",
                    inline: false
                },
                {
                    name: " Moderation",
                    value: "`/ban` `/unban` `/mute` `/kick`",
                    inline: false
                },
                {
                    name: " Server",
                    value: "`,addemoji <emoji>...` — Add emojis\n`/deleteallchannels` — Delete all channels in category\n`/purgeallchannels` — Purge all messages in category\n`/join` / `/unjoin` — Staff Exchange role",
                    inline: false
                }
            )
            .setFooter({ text: "Astro Exchange | Staff Commands" })
            .setTimestamp();
        await int.reply({ embeds: [staffEmbed], ephemeral: true });
        return;
    }

    // For all remaining slash commands simulate the prefix command logic
    // by building a fake args array and delegating to the same handlers via a synthetic message object
    // We do this by emitting a fake message-create equivalent with the guild/channel context

    if (cmd === "slot") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        await int.deferReply({ ephemeral: true });
        const target = int.options.getMember("user");
        const dur = int.options.getString("duration");
        const cat = int.options.getString("category");
        const method = int.options.getString("method");
        const price = int.options.getNumber("price") || null;
        const ovEv = int.options.getInteger("everyone");
        const ovHr = int.options.getInteger("here");
        const catMap = {"1":"First","2":"Second","3":"Third"};
        const durMap = {"W":"Weekly","M":"Monthly","L":"Lifetime"};
        if (Object.values(slots).some(s => s.ownerId === target.id)) return int.editReply(" User already has an active slot.");
        if (method === "MANUAL") {
            await createSlot(target, catMap[cat], durMap[dur], ovEv, ovHr);
            const slotEntry = Object.entries(slots).find(([,d]) => d.ownerId === target.id);
            const slotChId = slotEntry?.[0];
            const expiryTs = slotEntry?.[1]?.expiry;
            const expiryStr = expiryTs && expiryTs !== "Never" ? `<t:${Math.floor(expiryTs/1000)}:D>` : "Never";
            const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle("Slot Created!")
                .setDescription(`**• Username:** \`${target.user.username}\`\n**• User ID:** \`${target.id}\`\n\n**• Category:** \`${catMap[cat]}\`\n**• Expiry date:** ${expiryStr}`).setTimestamp();
            const jumpRow = slotChId ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Jump to Slot").setURL(`https://discord.com/channels/${guild.id}/${slotChId}`).setStyle(ButtonStyle.Link)) : null;
            return int.editReply({ content: "", embeds: [embed], components: jumpRow ? [jumpRow] : [] });
        } else {
            const priceEur = price || CONFIG.PRICES[`${catMap[cat]}_${durMap[dur]}`] || 10;
            const amountLtc = (priceEur / cachedLtcPrice).toFixed(6);
            const wallet = await generateLtcAddress();
            if (!wallet) return int.editReply(" Error generating wallet.");
            tempWallets[wallet.address] = { ownerId: target.id, balance: 0, createdAt: Date.now(), privateKey: wallet.privateKey, wif: wallet.wif };
            save("./temp_wallets.json", tempWallets);
            const pings = PING_DEFAULTS[`${catMap[cat]}_${durMap[dur]}`] || { ev: 0, hr: 0 };
            pendingPayments[target.id] = { address: wallet.address, amountLtc: parseFloat(amountLtc), category: catMap[cat], duration: durMap[dur], ovEv: ovEv ?? pings.ev, ovHr: ovHr ?? pings.hr, completed: false, ticketType: "slot" };
            save("./pending_payments.json", pendingPayments);
            const payEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" LTC Payment")
                .setDescription(`**Address:** \`${wallet.address}\`\n**Amount:** \`${amountLtc} LTC\`\n**EUR:** \`${priceEur}€\``);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`copy_addy_${wallet.address}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`copy_amt_${amountLtc}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId("check_payment_btn").setLabel(" Payment Completed").setStyle(ButtonStyle.Success)
            );
            return int.editReply({ embeds: [payEmbed], components: [row] });
        }
    }

    if (cmd === "cslot") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        await int.deferReply();
        const target = int.options.getMember("user");
        const dur = int.options.getString("duration");
        const cat = int.options.getString("category");
        const ovEv = int.options.getInteger("everyone");
        const ovHr = int.options.getInteger("here");
        const catMap = {"1":"First","2":"Second","3":"Third"};
        const durMap = {"W":"Weekly","M":"Monthly","L":"Lifetime"};
        if (Object.values(slots).some(s => s.ownerId === target.id)) return int.editReply(" User already has a slot.");
        await createSlot(target, catMap[cat], durMap[dur], ovEv, ovHr);
        const slotEntry = Object.entries(slots).find(([,d]) => d.ownerId === target.id);
        const slotChId = slotEntry?.[0];
        const expiryTs = slotEntry?.[1]?.expiry;
        const expiryStr = expiryTs && expiryTs !== "Never" ? `<t:${Math.floor(expiryTs/1000)}:D>` : "Never";
        const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle("Slot Created!")
            .setDescription(`**• Username:** \`${target.user.username}\`\n**• User ID:** \`${target.id}\`\n\n**• Category:** \`${catMap[cat]}\`\n**• Expiry date:** ${expiryStr}`).setTimestamp();
        const jumpRow = slotChId ? new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Jump to Slot").setURL(`https://discord.com/channels/${guild.id}/${slotChId}`).setStyle(ButtonStyle.Link)) : null;
        return int.editReply({ embeds: [embed], components: jumpRow ? [jumpRow] : [] });
    }

    if (cmd === "revoke") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const target = int.options.getMember("user");
        const slotEntry = Object.entries(slots).find(([,data]) => data.ownerId === target.id);
        if (slotEntry) {
            const ch = guild.channels.cache.get(slotEntry[0]);
            if (ch) await ch.delete();
            delete slots[slotEntry[0]]; save("./slots.json", slots);
        }
        await target.roles.remove(CONFIG.SLOT_OWNER_ROLE_ID).catch(() => {});
        await target.roles.remove(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
        return int.reply({ content: " Slot revoked.", ephemeral: true });
    }

    if (cmd === "hold") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const reason = int.options.getString("reason") || null;
        const optUser = int.options.getMember("user");
        let targetId = null, slotChannelId = null;
        if (slots[channel.id]) { slotChannelId = channel.id; targetId = slots[channel.id].ownerId; }
        else if (optUser) {
            const se = Object.entries(slots).find(([,d]) => d.ownerId === optUser.id);
            if (!se) return int.reply({ content: " No active slot found.", ephemeral: true });
            slotChannelId = se[0]; targetId = optUser.id;
        } else return int.reply({ content: " Use inside a slot channel or specify user.", ephemeral: true });
        const slotCh = guild.channels.cache.get(slotChannelId);
        const holdMember = await guild.members.fetch(targetId).catch(() => null);
        if (slotCh) await slotCh.permissionOverwrites.edit(targetId, { SendMessages: false }).catch(() => {});
        if (holdMember) await holdMember.roles.add(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
        const holdEmbed = new EmbedBuilder().setColor("#FF0000").setTitle(" Slot On Hold")
            .setDescription(`<@${targetId}>, your slot has been placed on hold.\n\n${reason ? `**Reason:** ${reason}\n\n` : ""}Please open a ticket to discuss this with staff.`).setTimestamp();
        const holdMsg = slotCh ? await slotCh.send({ embeds: [holdEmbed] }).catch(() => null) : null;
        if (holdMsg) { holdData[slotChannelId] = { userId: targetId, messageId: holdMsg.id, reason: reason || "No reason" }; save("./hold_data.json", holdData); }
        return int.reply({ content: ` Slot of <@${targetId}> is now on hold.`, ephemeral: true });
    }

    if (cmd === "unhold") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const optUser = int.options.getMember("user");
        let targetId = null, slotChannelId = null;
        if (slots[channel.id]) { slotChannelId = channel.id; targetId = slots[channel.id].ownerId; }
        else if (optUser) {
            const se = Object.entries(slots).find(([,d]) => d.ownerId === optUser.id);
            if (!se) return int.reply({ content: " No active slot found.", ephemeral: true });
            slotChannelId = se[0]; targetId = optUser.id;
        } else return int.reply({ content: " Use inside a slot channel or specify user.", ephemeral: true });
        const slotCh = guild.channels.cache.get(slotChannelId);
        const holdMember = await guild.members.fetch(targetId).catch(() => null);
        if (slotCh) await slotCh.permissionOverwrites.edit(targetId, { SendMessages: true }).catch(() => {});
        if (holdMember) await holdMember.roles.remove(CONFIG.ON_HOLD_ROLE_ID).catch(() => {});
        const hd = holdData[slotChannelId];
        if (hd && slotCh) { const hm = await slotCh.messages.fetch(hd.messageId).catch(() => null); if (hm) await hm.delete().catch(() => {}); }
        delete holdData[slotChannelId]; save("./hold_data.json", holdData);
        return int.reply({ content: ` Slot of <@${targetId}> is no longer on hold.`, ephemeral: true });
    }

    if (cmd === "nuke") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const slotD = slots[channel.id];
        if (!slotD) {
            const newCh = await channel.clone();
            await channel.delete();
            return newCh.send(" **Channel Nuked.**");
        }
        const cooldown = 48*60*60*1000;
        const remaining = (slotD.lastNuke + cooldown) - Date.now();
        if (remaining > 0) return int.reply({ content: ` Cooldown: wait ${Math.ceil(remaining/3600000)}h.`, ephemeral: true });
        const newCh = await channel.clone();
        await channel.delete();
        const newEmbed = EmbedBuilder.from(slotD.infoEmbed);
        const newMsg = await newCh.send({ content: `<@${slotD.ownerId}>`, embeds: [newEmbed] });
        await newMsg.pin().catch(() => {});
        slots[newCh.id] = { ...slotD, lastNuke: Date.now() };
        delete slots[channel.id];
        save("./slots.json", slots);
    }

    if (cmd === "do") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        await int.deferReply();
        const customPrice = int.options.getNumber("price") || null;
        const tType = ticketTypes[channel.id] || "slot";
        const msgs = await channel.messages.fetch({ limit: 50 });
        const ticketMsg = msgs.find(m => m.embeds.length > 0 && (m.embeds[0].title === "Buy Slot Ticket" || m.embeds[0].title === "Product Purchase Ticket"));
        if (!ticketMsg) return int.editReply(" No valid ticket found.");
        const desc = ticketMsg.embeds[0].description;
        const userIdMatch = desc.match(/\*\*User ID:\*\*\n`(\d+)`/);
        if (!userIdMatch) return int.editReply(" Missing ticket data.");
        const targetId = userIdMatch[1];
        const target = await guild.members.fetch(targetId).catch(() => null);
        if (!target) return int.editReply(" User not found.");
        let catName = "First", durName = "Weekly", priceEur = customPrice || 10;
        if (tType === "slot") {
            const catMatch = desc.match(/\*\*Selected Category:\*\*\n(First|Second|Third)/);
            const durMatch = desc.match(/\*\*Duration:\*\*\n(Weekly|Monthly|Lifetime)/);
            if (catMatch) catName = catMatch[1]; if (durMatch) durName = durMatch[1];
            if (!customPrice) priceEur = CONFIG.PRICES[`${catName}_${durName}`] || 10;
        }
        const amountLtc = (priceEur / cachedLtcPrice).toFixed(6);
        const wallet = await generateLtcAddress();
        if (!wallet) return int.editReply(" Error generating wallet.");
        tempWallets[wallet.address] = { ownerId: target.id, balance: 0, createdAt: Date.now(), privateKey: wallet.privateKey, wif: wallet.wif, ticketChannelId: channel.id, ticketType: tType };
        save("./temp_wallets.json", tempWallets);
        if (tType === "slot") {
            const pings = PING_DEFAULTS[`${catName}_${durName}`] || { ev:0, hr:0 };
            pendingPayments[target.id] = { address: wallet.address, amountLtc: parseFloat(amountLtc), category: catName, duration: durName, ovEv: pings.ev, ovHr: pings.hr, completed: false, ticketChannelId: channel.id, ticketType: "slot" };
        } else {
            pendingPayments[target.id] = { address: wallet.address, amountLtc: parseFloat(amountLtc), completed: false, ticketChannelId: channel.id, ticketType: tType, priceEur };
        }
        save("./pending_payments.json", pendingPayments);
        const payEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Automatic LTC Payment")
            .setDescription(`**Address:** \`${wallet.address}\`\n**Amount:** \`${amountLtc} LTC\`\n**EUR:** \`${priceEur}€\``);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`copy_addy_${wallet.address}`).setLabel("Copy Address").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`copy_amt_${amountLtc}`).setLabel("Copy Amount").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("check_payment_btn").setLabel(" Payment Completed").setStyle(ButtonStyle.Success)
        );
        return int.editReply({ content: `<@${targetId}>`, embeds: [payEmbed], components: [row] });
    }

    if (cmd === "vouch") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        let targetId = null;
        const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        if (msgs) {
            const te = msgs.find(m => m.embeds.length > 0 && m.embeds[0].description?.match(/\*\*User ID:\*\*\n`(\d+)`/));
            if (te) { const match = te.embeds[0].description.match(/\*\*User ID:\*\*\n`(\d+)`/); if (match) targetId = match[1]; }
        }
        sessions.set(`vouch_ctx_${int.user.id}`, { channelId: channel.id, guildId: guild.id, targetId, authorId: int.user.id });
        const promptEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Generate Vouch")
            .setDescription(targetId ? `**Customer detected:** <@${targetId}>\nFill in the details below.` : " No customer detected. Fill in below.");
        const vouchRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`open_vouch_modal_${int.user.id}`).setLabel(" Fill Vouch Form").setStyle(ButtonStyle.Primary));
        const prompt = await int.reply({ embeds: [promptEmbed], components: [vouchRow], fetchReply: true });
        sessions.set(`vouch_prompt_${int.user.id}`, prompt.id);
        setTimeout(() => prompt.delete().catch(() => {}), 120000);
        return;
    }

    if (cmd === "info") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const target = int.options.getMember("user");
        const userSlotId = Object.keys(slots).find(k => slots[k].ownerId === target.id);
        const slotInfo = userSlotId ? `Yes (<#${userSlotId}>) - ${slots[userSlotId].category} / ${slots[userSlotId].duration}` : "None";
        const history = userTransactions[target.id] || [];
        const historyText = history.length > 0 ? history.slice(-5).map(t => `• **${t.type}**: ${t.amount} - ${t.detail} (<t:${Math.floor(t.date/1000)}:d>)`).join("\n") : "No transactions recorded.";
        const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle(`User Info: ${target.user.username}`)
            .addFields({ name: "Active Slot", value: slotInfo }, { name: "Last Transactions", value: historyText })
            .setThumbnail(target.user.displayAvatarURL({ dynamic: true }));
        return int.reply({ embeds: [embed], ephemeral: true });
    }

    if (cmd === "setup") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const embed = new EmbedBuilder().setColor("#5FB3C4")
            .setDescription(`# Astra Tickets\n\nSelect the type of ticket you would like to open from below\n<:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114><:zz14:1430879309865816114> \n<:emoji_125:1430879303695863830> **Buy Slot:**\n• Purchase a new slot or renew your current slot\n<:emoji_125:1430879303695863830> **Product Purchase:**\n• Buy a specific product (from the owners)\n<:emoji_125:1430879303695863830> **Exchange:**\n• Exchange currencies or crypto`);
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("ticket_main").setPlaceholder("Select a category").addOptions([{ label:"Slot Purchase",value:"slot",emoji:"<:emoji_125:1430879303695863830>" },{ label:"Product Purchase",value:"product",emoji:"" },{ label:"Exchange",value:"exchange",emoji:"" }]));
        await channel.send({ embeds: [embed], components: [row] });
        return int.reply({ content: " Panel posted.", ephemeral: true });
    }

    // ================= SETUPEXCHANGE SLASH (CURRENCY/CRYPTO EXCHANGE) =================
    if (cmd === "setupexchange") {
        if (!isAdmin) return int.reply({ content: "❌ Admin only.", ephemeral: true });

        const exchangeEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setDescription(
                `# Welcome to Astro Exchange Panel\n` +
                `**Before creating ticket, make sure to check <#1430879271659900949>**\n\n` +
                `**Security & Safety**\n` +
                `• All deals are handled inside tickets only\n` +
                `• Each exchanger has a security limit.\n` +
                `• Deals exceeding it require a middleman.\n\n` +
                `**Important Reminders**\n` +
                `• Do not rush during exchanges\n` +
                `• No Third-Party Payments\n` +
                `• We do not cover transaction fees.\n\n` +
                `**Exchange Fees**\n` +
                `**PayPal to Crypto:**\n` +
                `• < 10€: ${exchangeFees.paypal_to_crypto.under_10}€ flat fee\n` +
                `• 10-25€: ${exchangeFees.paypal_to_crypto["10_25"]}%\n` +
                `• 25-50€: ${exchangeFees.paypal_to_crypto["25_50"]}%\n` +
                `• > 50€: ${exchangeFees.paypal_to_crypto.over_50}%\n\n` +
                `**Crypto to Crypto:**\n` +
                `• < 25€: ${exchangeFees.crypto_to_crypto.under_25}%\n` +
                `• 25-50€: ${exchangeFees.crypto_to_crypto["25_50"]}%\n` +
                `• > 50€: ${exchangeFees.crypto_to_crypto.over_50}%\n\n` +
                `**Crypto to PayPal:** ${exchangeFees.crypto_to_paypal}%`
            )
            .setFooter({ text: "Astro Exchange | Swap Service" })
            .setTimestamp();

        const startRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("exchange_start")
                .setLabel("Start Exchange")
                .setStyle(ButtonStyle.Secondary)
        );

        await int.channel.send({ embeds: [exchangeEmbed], components: [startRow] });
        return int.reply({ content: "✅ Exchange panel posted.", ephemeral: true });
    }

    if (cmd === "setupmm") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Auto Middleman Service")
            .setDescription("Welcome to the **Auto Middleman** service!\n\nOur system guarantees secure transactions between buyer and seller.\n\n**Fee:** `5%` of the total transaction\n*(2.5% from buyer + 2.5% from seller)*\n\nClick the button below to start an MM session.")
            .setFooter({ text: "Astro Exchange | Auto MM System" }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("start_mm").setLabel(" Start MM").setStyle(ButtonStyle.Success));
        await channel.send({ embeds: [embed], components: [row] });
        return int.reply({ content: " MM panel posted.", ephemeral: true });
    }

    if (cmd === "setupslot") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const catNum = int.options.getString("category");
        const durShort = int.options.getString("duration");
        const evPing = int.options.getInteger("everyone");
        const herePing = int.options.getInteger("here");
        const catMap = {"1":"First","2":"Second","3":"Third"};
        const durMap = {"W":"Weekly","M":"Monthly","L":"Lifetime"};
        if (!pingConfig[catMap[catNum]]) pingConfig[catMap[catNum]] = {};
        pingConfig[catMap[catNum]][durMap[durShort]] = { everyone: evPing, here: herePing };
        save("./pings.json", pingConfig);
        return int.reply({ content: ` Configured **${catMap[catNum]}** (${durMap[durShort]}) with **${evPing}** everyone and **${herePing}** here pings.`, ephemeral: true });
    }

    if (cmd === "dash") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        await int.deferReply();
        try {
            let orders = [], products = [], ordersErr = null, productsErr = null;
            try { const r = await sellAuthAPI.get("/orders"); const d = r.data; orders = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []; } catch(e) { ordersErr = e.message; }
            try { const r = await sellAuthAPI.get("/products"); const d = r.data; products = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : []; } catch(e) { productsErr = e.message; }
            let totalRev = 0, completed = 0, pending = 0, refunded = 0;
            orders.forEach(o => { const s=(o.status||"").toLowerCase(); const amt=parseFloat(o.price||o.total||0); if(s==="completed"||s==="paid"||s==="delivered"){totalRev+=amt;completed++;} else if(s==="pending"||s==="processing")pending++; else if(s==="refunded"||s==="cancelled")refunded++; });
            const inStock = products.filter(p => p.stock===undefined||p.stock===null||p.stock>0||(p.variants&&p.variants.some(v=>v.stock>0))).length;
            const productCounts = {}; orders.forEach(o => { const n=o.product_name||o.product?.name||"Unknown"; productCounts[n]=(productCounts[n]||0)+1; });
            const topProducts = Object.entries(productCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([n,c],i)=>`${["","",""][i]} **${n.slice(0,25)}** — \`${c}\` orders`).join("\n")||"No data.";
            const last10 = [...orders].reverse().slice(0,10);
            const last10Text = last10.length>0 ? last10.map(o=>{const s=(o.status||"?").toUpperCase();const icon=s==="COMPLETED"||s==="PAID"?"":s==="PENDING"?"⏳":"";const price=parseFloat(o.price||o.total||0).toFixed(2);const name=(o.product_name||o.product?.name||"N/A").slice(0,22);const date=o.created_at?`<t:${Math.floor(new Date(o.created_at).getTime()/1000)}:d>`:"N/A";return `${icon} **${name}** • \`${price}€\` • ${date}`;}).join("\n") : "No orders yet.";
            const stockLines = products.slice(0,8).map(p=>{let stock=p.stock??(p.variants?p.variants.reduce((s,v)=>s+(v.stock||0),0):0);return `${stock>0?"":""} **${(p.name||"?").slice(0,22)}** — \`${stock}\``;}).join("\n")||"No products.";
            const overviewEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" SellAuth Dashboard").setDescription(`\`${CONFIG.BASE_SHOP_URL}\``)
                .addFields(
                    { name:" Products",value:`Total: \`${products.length}\`\nIn Stock: \`${inStock}\`\nOut of Stock: \`${products.length-inStock}\``,inline:true },
                    { name:" Orders",value:`Total: \`${orders.length}\`\n Completed: \`${completed}\`\n⏳ Pending: \`${pending}\`\n↩ Refunded: \`${refunded}\``,inline:true },
                    { name:" Revenue",value:`Estimated: \`${totalRev.toFixed(2)} EUR\`\nAvg/order: \`${completed>0?(totalRev/completed).toFixed(2):"0.00"} EUR\``,inline:true },
                    { name:" Top Products",value:topProducts,inline:false },
                    { name:" Stock Overview",value:stockLines,inline:false }
                ).setTimestamp().setFooter({text:`${ordersErr?" Orders: "+ordersErr:""}${productsErr?" |  Products: "+productsErr:""}`||"Astro Exchange"});
            const ordersEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Last 10 Orders").setDescription(last10Text).setTimestamp();
            await int.editReply({ embeds: [overviewEmbed] });
            await int.followUp({ embeds: [ordersEmbed] });
        } catch(e) { await int.editReply({ content: ` Error: ${e.message}` }); }
    }

    if (cmd === "stock") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        try {
            const res = await sellAuthAPI.get("/products");
            const raw = res.data; const products = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
            const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Shop Stock (Staff View)").setDescription("Detailed view for staff.");
            products.forEach(p => {
                let variantsList = p.variants?.length > 0 ? p.variants.map(v=>`• ${v.name} (ID: \`${v.id}\`): **${v.stock}**`).join("\n") : `Stock: **${p.stock}**`;
                embed.addFields({ name:`${p.name} (ID: ${p.id})`, value:`Slug: \`${p.slug}\`\n${variantsList}`, inline: false });
            });
            return int.reply({ embeds: [embed], ephemeral: true });
        } catch(e) { return int.reply({ content: " Error retrieving stock.", ephemeral: true }); }
    }

    if (cmd === "restock") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const prodId = int.options.getString("id");
        const stockData = int.options.getString("items");
        try { await sellAuthAPI.post(`/products/${prodId}/stock`, { stock: stockData }); return int.reply({ content: ` Stock updated for ID: \`${prodId}\``, ephemeral: true }); }
        catch(e) { return int.reply({ content: " Error updating. Check the ID.", ephemeral: true }); }
    }

    if (cmd === "livestock") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const ch = int.options.getChannel("channel") || channel;
        liveStockConfig.channelId = ch.id; liveStockConfig.lastMsgId = null;
        save("./livestock.json", liveStockConfig);
        return int.reply({ content: ` LiveStock channel set to <#${ch.id}>.`, ephemeral: true });
    }

    if (cmd === "deleteproduct") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const prodId = int.options.getString("id");
        try { await sellAuthAPI.delete(`/products/${prodId}`); return int.reply({ content: ` Product \`${prodId}\` deleted.`, ephemeral: true }); }
        catch(e) { return int.reply({ content: " Error deleting product.", ephemeral: true }); }
    }

    if (cmd === "dashboard") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        let desc = "", totalHeld = 0;
        const addresses = Object.keys(tempWallets);
        if (!addresses.length) { desc = "No temporary wallets generated."; }
        else { addresses.forEach(addr => { const bal = tempWallets[addr].balance||0; totalHeld+=bal; desc+=`**Address:** \`${addr}\`\n**Balance:** \`${bal} LTC\`\n\n`; }); }
        const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Temporary Wallet Dashboard")
            .setDescription(`Total in Wallets: **${totalHeld} LTC**\n\n${desc}`);
        return int.reply({ embeds: [embed], ephemeral: true });
    }

    if (cmd === "adduser") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const userId = int.options.getString("id");
        const mmChannelData = Object.entries(mmSessions).find(([,d]) => d.channelId === channel.id && d.status === "waiting_second_user");
        if (!mmChannelData) return int.reply({ content: " No MM session waiting in this channel.", ephemeral: true });
        const [sessionId, mmData] = mmChannelData;
        const target = await guild.members.fetch(userId).catch(() => null);
        if (!target) return int.reply({ content: " User not found.", ephemeral: true });
        await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, SendMessages: true }).catch(() => {});
        mmData.secondUserId = target.id; mmData.status = "selecting_roles"; save("./mm_sessions.json", mmSessions);
        const roleEmbed = new EmbedBuilder().setColor("#5FB3C4").setTitle(" Role Selection - Auto MM")
            .setDescription(`<@${mmData.creatorId}> and <@${target.id}>, welcome!\n\nBoth of you must select your role in this transaction.`);
        const roleRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`mm_role_buyer_${sessionId}`).setLabel(" I am the Buyer").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`mm_role_seller_${sessionId}`).setLabel(" I am the Seller").setStyle(ButtonStyle.Secondary)
        );
        await channel.send({ content: `<@${mmData.creatorId}> <@${target.id}>`, embeds: [roleEmbed], components: [roleRow] });
        return int.reply({ content: " User added to MM session.", ephemeral: true });
    }

    if (cmd === "tx") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const txid = int.options.getString("txid");
        async function fetchTxInfoSlash(id) { const r = await fetch(`https://api.blockcypher.com/v1/ltc/main/txs/${id}?token=${CONFIG.BLOCKCYPHER_TOKEN}`); return r.json(); }
        function buildTxEmbedSlash(tx) {
            const confs=tx.confirmations||0; const done=confs>=6;
            const totalOut=(tx.outputs||[]).reduce((s,o)=>s+(o.value||0),0)/100000000;
            const fee=tx.fees?(tx.fees/100000000).toFixed(8):"N/A";
            const senders=(tx.inputs||[]).flatMap(i=>i.addresses||[]).slice(0,3).join("\n")||"N/A";
            const receivers=(tx.outputs||[]).flatMap(o=>o.addresses||[]).slice(0,3).join("\n")||"N/A";
            const receivedAt=tx.received?`<t:${Math.floor(new Date(tx.received).getTime()/1000)}:F>`:"N/A";
            const confirmedAt=tx.confirmed?`<t:${Math.floor(new Date(tx.confirmed).getTime()/1000)}:F>`:"Pending";
            const status=done?" Confirmed":confs>0?`⏳ ${confs}/6 confirmations`:" Unconfirmed";
            const color=done?"#00FF00":confs>0?"#FFA500":"#5FB3C4";
            return new EmbedBuilder().setColor(color).setTitle(" LTC Transaction Tracker")
                .addFields({ name:" TXID",value:`\`${txid}\``,inline:false },{ name:" Status",value:status,inline:true },{ name:" Confirmations",value:`\`${confs}\``,inline:true },{ name:" Total Sent",value:`\`${totalOut.toFixed(8)} LTC\``,inline:true },{ name:" Fee",value:`\`${fee} LTC\``,inline:true },{ name:" From",value:`\`${senders.slice(0,200)}\``,inline:false },{ name:" To",value:`\`${receivers.slice(0,200)}\``,inline:false },{ name:" Received",value:receivedAt,inline:true },{ name:" Confirmed At",value:confirmedAt,inline:true })
                .setFooter({text:done?" Confirmed":" Updates every 2 seconds"}).setTimestamp();
        }
        try {
            const tx = await fetchTxInfoSlash(txid);
            if (tx.error) return int.reply({ content: ` Not found: \`${tx.error}\``, ephemeral: true });
            await int.reply({ embeds: [buildTxEmbedSlash(tx)] });
            if ((tx.confirmations||0) >= 6) return;
            const liveMsg = await int.fetchReply();
            const interval = setInterval(async () => {
                try { const u=await fetchTxInfoSlash(txid); await liveMsg.edit({embeds:[buildTxEmbedSlash(u)]}).catch(()=>{}); if((u.confirmations||0)>=6)clearInterval(interval); } catch(e){}
            }, 2000);
        } catch(e) { return int.reply({ content: ` API error: ${e.message}`, ephemeral: true }); }
    }

    if (cmd === "txid") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const orderId = int.options.getString("orderid");
        try {
            const res = await sellAuthAPI.get(`/orders/${orderId}`);
            const o = res.data?.data || res.data;
            if (!o) return int.reply({ content: " Order not found.", ephemeral: true });
            const status=(o.status||"unknown").toUpperCase();
            const statusIcon=status==="COMPLETED"||status==="PAID"?"":status==="PENDING"?"⏳":"";
            const email=o.email||"N/A"; const atIdx=email.indexOf("@");
            const masked=atIdx>1?email[0]+"****"+email[atIdx-1]+email.slice(atIdx):email;
            const price=parseFloat(o.price||o.total||0).toFixed(2);
            const productName=o.product_name||o.product?.name||"N/A";
            const productSlug=o.product_slug||o.product?.slug||"";
            const productUrl=productSlug?`${CONFIG.BASE_SHOP_URL}/product/${productSlug}`:CONFIG.BASE_SHOP_URL;
            const quantity=o.quantity||o.qty||1;
            const date=o.created_at?`<t:${Math.floor(new Date(o.created_at).getTime()/1000)}:F>`:"N/A";
            const embed = new EmbedBuilder().setColor("#5FB3C4").setTitle(` SellAuth Order #${orderId}`)
                .addFields({ name:" Product",value:`[${productName}](${productUrl})`,inline:true },{ name:" Qty",value:`\`${quantity}\``,inline:true },{ name:" Status",value:`${statusIcon} \`${status}\``,inline:true },{ name:" Price",value:`\`${price} EUR\``,inline:true },{ name:" Method",value:`\`${o.gateway||o.payment_method||"N/A"}\``,inline:true },{ name:" Email",value:`\`${masked}\``,inline:true },{ name:" Date",value:date,inline:false })
                .setTimestamp().setFooter({text:"Astro Exchange | SellAuth Order"});
            if ((status==="COMPLETED"||status==="PAID") && o.serials) { const keys=Array.isArray(o.serials)?o.serials.join("\n"):String(o.serials); embed.addFields({name:" Delivered Keys",value:`\`\`\`${keys.slice(0,900)}\`\`\``,inline:false}); }
            return int.reply({ embeds: [embed], ephemeral: true });
        } catch(e) { return int.reply({ content: ` Error: ${e.message}`, ephemeral: true }); }
    }

    if (cmd === "ltcinfo") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        const address = int.options.getString("address");
        try {
            const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}?limit=10&token=${CONFIG.BLOCKCYPHER_TOKEN}`);
            const data = await res.json();
            if (data.error) return int.reply({ content: ` ${data.error}`, ephemeral: true });
            const balance=(data.balance||0)/100000000; const totalReceived=(data.total_received||0)/100000000; const totalSent=(data.total_sent||0)/100000000;
            const txRefs=[...(data.txrefs||[]),...(data.unconfirmed_txrefs||[])].slice(0,10);
            const txLines=txRefs.length>0?txRefs.map(t=>{const val=(t.value||0)/100000000;const sent=t.spent!==undefined?(t.spent?"":""):"";const conf=t.confirmations||0;const ts=t.confirmed?`<t:${Math.floor(new Date(t.confirmed).getTime()/1000)}:d>`:"Pending";return `${sent} \`${val.toFixed(6)} LTC\` • ${conf} conf • ${ts} • \`${t.tx_hash?.slice(0,12)}...\``;}).join("\n"):"No transactions.";
            const embed=new EmbedBuilder().setColor("#5FB3C4").setTitle(" LTC Address Info")
                .addFields({ name:" Address",value:`\`${address}\``,inline:false },{ name:" Balance",value:`\`${balance.toFixed(8)} LTC\``,inline:true },{ name:" Total Received",value:`\`${totalReceived.toFixed(8)} LTC\``,inline:true },{ name:" Total Sent",value:`\`${totalSent.toFixed(8)} LTC\``,inline:true },{ name:" Total TXs",value:`\`${data.n_tx||0}\``,inline:true },{ name:" Last 10 Transactions",value:txLines.slice(0,1024),inline:false })
                .setTimestamp().setFooter({text:"Astro Exchange | BlockCypher LTC"});
            return int.reply({ embeds: [embed], ephemeral: true });
        } catch(e) { return int.reply({ content: ` API error: ${e.message}`, ephemeral: true }); }
    }

    if (cmd === "testall") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        await int.deferReply({ ephemeral: true });
        const results = [];
        const check = async (name, fn) => { try { const r=await fn(); results.push({name,ok:true,detail:r||"OK"}); } catch(e) { results.push({name,ok:false,detail:e.message.slice(0,100)}); } };
        await check("SellAuth /orders", async()=>{ const r=await sellAuthAPI.get("/orders"); const d=r.data; const o=Array.isArray(d)?d:Array.isArray(d?.data)?d.data:[]; return `${o.length} orders`; });
        await check("SellAuth /products", async()=>{ const r=await sellAuthAPI.get("/products"); const d=r.data; const p=Array.isArray(d)?d:Array.isArray(d?.data)?d.data:[]; return `${p.length} products`; });
        await check("LTC Price", async()=>`1 LTC = ${cachedLtcPrice} EUR`);
        await check("BlockCypher API", async()=>{ const r=await fetch(`https://api.blockcypher.com/v1/ltc/main?token=${CONFIG.BLOCKCYPHER_TOKEN}`); const d=await r.json(); if(d.error)throw new Error(d.error); return `Block ${d.height}`; });
        for (const [key,id] of Object.entries({Log:CONFIG.LOG_CHANNEL_ID,"Global Log":CONFIG.GLOBAL_LOG_CHANNEL_ID,"Join Log":CONFIG.JOIN_LOG_CHANNEL_ID,"Leave Log":CONFIG.LEAVE_LOG_CHANNEL_ID,"Ping Log":CONFIG.PING_LOG_CHANNEL_ID,"Scammer":CONFIG.SCAMMER_CHANNEL_ID,"Vouch":CONFIG.VOUCH_CHANNEL_ID})) {
            await check(`Channel: ${key}`, async()=>{ const ch=guild.channels.cache.get(id); if(!ch)throw new Error("Not found"); return `#${ch.name}`; });
        }
        for (const [key,id] of Object.entries({Staff:CONFIG.STAFF_ROLE_ID,"Slot Owner":CONFIG.SLOT_OWNER_ROLE_ID,"On Hold":CONFIG.ON_HOLD_ROLE_ID})) {
            await check(`Role: ${key}`, async()=>{ const r=guild.roles.cache.get(id); if(!r)throw new Error("Not found"); return `@${r.name}`; });
        }
        await check("LiveStock Config", async()=>{ if(!liveStockConfig.channelId)throw new Error("Not set"); const ch=guild.channels.cache.get(liveStockConfig.channelId); if(!ch)throw new Error("Channel not found"); return `#${ch.name}`; });
        await check("Pending Payments", async()=>`${Object.keys(pendingPayments).length} pending`);
        await check("Active Slots", async()=>`${Object.keys(slots).length} slots`);
        await check("MM Sessions", async()=>`${Object.keys(mmSessions).length} sessions`);
        const passed=results.filter(r=>r.ok).length; const failed=results.filter(r=>!r.ok).length;
        const embed=new EmbedBuilder().setColor(failed===0?"#00FF00":failed<3?"#FFA500":"#FF0000")
            .setTitle(` Diagnostics — ${passed}/${results.length} passed`)
            .setDescription(results.map(r=>`${r.ok?"":""} **${r.name}** — ${r.detail}`).join("\n"))
            .setTimestamp().setFooter({text:"Astro Exchange | testall"});
        return int.editReply({ embeds: [embed] });
    }

    if (cmd === "testorder") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        try {
            const res = await sellAuthAPI.get("/orders");
            const raw = res.data; const orders = Array.isArray(raw)?raw:(Array.isArray(raw?.data)?raw.data:[]);
            if (!orders.length) return int.reply({ content: " No orders found.", ephemeral: true });
            const last = orders[orders.length-1];
            const fields = Object.entries(last).map(([k,v])=>`**${k}:** \`${JSON.stringify(v).slice(0,80)}\``).join("\n");
            return int.reply({ content: `**Raw fields of last order:**\n${fields.slice(0,1800)}`, ephemeral: true });
        } catch(e) { return int.reply({ content: ` Error: ${e.message}`, ephemeral: true }); }
    }

    if (cmd === "ban") {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return int.reply({ content: " No permission.", ephemeral: true });
        const target = int.options.getMember("user");
        const reason = int.options.getString("reason") || "No reason provided.";
        await target.ban({ reason });
        return int.reply({ content: ` Banned **${target.user.tag}**.`, ephemeral: true });
    }

    if (cmd === "unban") {
        if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return int.reply({ content: " No permission.", ephemeral: true });
        const id = int.options.getString("id");
        await guild.members.unban(id).then(()=>int.reply({content:" Unbanned.",ephemeral:true})).catch(()=>int.reply({content:" Error.",ephemeral:true}));
    }

    if (cmd === "mute") {
        if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) return int.reply({ content: " No permission.", ephemeral: true });
        const target = int.options.getMember("user");
        const minutes = int.options.getInteger("minutes");
        await target.timeout(minutes * 60 * 1000);
        return int.reply({ content: ` Muted <@${target.id}> for ${minutes}m.`, ephemeral: true });
    }

    if (cmd === "kick") {
        if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return int.reply({ content: " No permission.", ephemeral: true });
        const target = int.options.getMember("user");
        await target.kick();
        return int.reply({ content: ` Kicked **${target.user.tag}**.`, ephemeral: true });
    }

    if (cmd === "complete") {
        if (!isStaff) return int.reply({ content: " Staff only.", ephemeral: true });
        await int.deferReply({ ephemeral: true });
        const optUser = int.options.getMember("user");
        const msgs = await channel.messages.fetch({ limit: 50 }).catch(() => null);
        const ticketMsg = msgs?.find(m => m.embeds.length > 0 && (m.embeds[0].title === "Buy Slot Ticket" || m.embeds[0].title === "Product Purchase Ticket"));
        let targetId = optUser?.id || null, catName = "First", durName = "Weekly";
        if (ticketMsg && !targetId) { const desc=ticketMsg.embeds[0].description; const m=desc.match(/\*\*User ID:\*\*\n`(\d+)`/); if(m) targetId=m[1]; const cm=desc.match(/\*\*Selected Category:\*\*\n(First|Second|Third)/); if(cm) catName=cm[1]; const dm=desc.match(/\*\*Duration:\*\*\n(Weekly|Monthly|Lifetime)/); if(dm) durName=dm[1]; }
        if (!targetId) return int.editReply(" No user found.");
        const target = await guild.members.fetch(targetId).catch(() => null);
        if (!target) return int.editReply(" User not found.");
        const payData = pendingPayments[targetId];
        if (payData) { payData.completed=true; if(tempWallets[payData.address]){delete tempWallets[payData.address];save("./temp_wallets.json",tempWallets);} delete pendingPayments[targetId]; save("./pending_payments.json",pendingPayments); }
        if (!Object.values(slots).some(s => s.ownerId === targetId)) {
            const pings = PING_DEFAULTS[`${catName}_${durName}`] || { ev:0, hr:0 };
            await createSlot(target, catName, durName, pings.ev, pings.hr);
        }
        return int.editReply(` Payment marked as completed for <@${targetId}>. Slot generated.`);
    }

    if (cmd === "deleteallthread") {
        if (!msg.member.roles.cache.has(CONFIG.STAFF_ROLE_ID)) return msg.reply("❌ Staff only.");
        const channelId = args[0];
        if (!channelId) return msg.reply("❌ Usage: `,deleteallthread [channel id]`");

        let deleted = 0, failed = 0;

        // Fetch ALL channels in the guild and filter threads belonging to the target channel
        const allChannels = await msg.guild.channels.fetch().catch(() => new Map());
        const threads = allChannels.filter(ch => ch.isThread() && ch.parentId === channelId);

        if (!threads.size) return msg.reply(`❌ No threads found in channel <#${channelId}>.`);

        for (const [, thread] of threads) {
            await thread.delete()
                .then(() => { deleted++; console.log(`[deleteallthread] Deleted: ${thread.name}`); })
                .catch(e => { failed++; console.error(`[deleteallthread] Failed to delete ${thread.name}:`, e.message); });
        }

        return msg.reply(`✅ Deleted **${deleted}** threads from <#${channelId}>. Failed: **${failed}**.`);
    }

    if (cmd === "deleteallchannels") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const categoryId = int.options.getString("category_id");
        const category = guild.channels.cache.get(categoryId);
        if (!category || category.type !== 4) return int.reply({ content: " Category not found. Paste the category ID, not a channel ID.", ephemeral: true });
        const children = guild.channels.cache.filter(c => c.parentId === categoryId);
        if (!children.size) return int.reply({ content: " No channels found in that category.", ephemeral: true });
        await int.reply({ content: `⏳ Deleting **${children.size}** channels in **${category.name}**...`, ephemeral: true });
        let deleted = 0, failed = 0;
        for (const [, ch] of children) {
            await ch.delete().then(() => deleted++).catch(() => failed++);
        }
        return int.editReply({ content: ` Done. Deleted: **${deleted}** • Failed: **${failed}**` });
    }

    if (cmd === "purgeallchannels") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const categoryId = int.options.getString("category_id");
        const category = guild.channels.cache.get(categoryId);
        if (!category || category.type !== 4) return int.reply({ content: " Category not found.", ephemeral: true });
        const children = guild.channels.cache.filter(c => c.parentId === categoryId && c.isTextBased());
        if (!children.size) return int.reply({ content: " No text channels found in that category.", ephemeral: true });
        await int.reply({ content: `⏳ Purging messages in **${children.size}** channels of **${category.name}**...`, ephemeral: true });
        let totalDeleted = 0;
        for (const [, ch] of children) {
            let fetched;
            do {
                fetched = await ch.messages.fetch({ limit: 100 }).catch(() => null);
                if (!fetched || !fetched.size) break;
                const recent = fetched.filter(m => Date.now() - m.createdTimestamp < 12 * 24 * 60 * 60 * 1000);
                if (recent.size === 0) break;
                if (recent.size === 1) { await recent.first().delete().catch(() => {}); totalDeleted++; }
                else { const del = await ch.bulkDelete(recent, true).catch(() => null); totalDeleted += del?.size || 0; }
            } while (fetched && fetched.size >= 2);
        }
        return int.editReply({ content: ` Done. Deleted **${totalDeleted}** messages across **${children.size}** channels.` });
    }

    if (cmd === "join") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const STAFF_EXCHANGE_ROLE_ID = "1425886824932573304";
        const target = int.options.getMember("user");
        await target.roles.add(STAFF_EXCHANGE_ROLE_ID).catch(() => {});

        const welcomeEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(" Welcome to Staff Exchange!")
            .setDescription(
                `You have been added to the **Staff Exchange** team in **${guild.name}**!\n\n` +
                `**First thing to do:** create your personal LTC address.\n\n` +
                `**Step 1** — Go to the server and type:\n\`\`\`/createltc\`\`\`\n` +
                `This will generate a dedicated LTC address just for you.\n\n` +
                `**Step 2** — Save the recovery code you'll receive in DM. You won't be shown it again.\n\n` +
                `**Step 3** — Once your address is created, you'll receive a full list of available commands.\n\n` +
                ` Never share your recovery code with anyone.`
            )
            .setTimestamp()
            .setFooter({ text: "Astro Exchange | Staff Exchange" });

        await target.send({ embeds: [welcomeEmbed] }).catch(() => {});
        return int.reply({ content: ` <@${target.id}> added to Staff Exchange and notified via DM.`, ephemeral: true });
    }

    if (cmd === "createltc") {
        const STAFF_EXCHANGE_ROLE_ID = CONFIG.STAFF_EXCHANGE_ROLE_ID;
        if (!member.roles.cache.has(STAFF_EXCHANGE_ROLE_ID)) return int.reply({ content: " Staff Exchange only.", ephemeral: true });
        if (exchangerWallets[int.user.id]?.active) return int.reply({ content: " You already have a personal LTC address. Use `/myltc` to view it.", ephemeral: true });
        await int.deferReply({ ephemeral: true });

        const wallet = await generateLtcAddress();
        if (!wallet) return int.editReply(" Error generating LTC address. Try again.");

        // Generate unique recovery code
        const crypto = require("crypto");
        const recoveryCode = crypto.randomBytes(16).toString("hex").toUpperCase();

        exchangerWallets[int.user.id] = {
            address: wallet.address,
            privateKey: wallet.privateKey,
            wif: wallet.wif,
            recoveryCode,
            active: true,
            createdAt: Date.now()
        };
        save("./exchanger_wallets.json", exchangerWallets);

        // Log full info in the private channel
        const logCh = guild.channels.cache.get(CONFIG.EXCHANGER_WALLET_LOG_CHANNEL_ID);
        if (logCh) {
            const logEmbed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" New Exchanger Wallet Created")
                .addFields(
                    { name: " User", value: `<@${int.user.id}> (${int.user.tag})`, inline: true },
                    { name: " User ID", value: `\`${int.user.id}\``, inline: true },
                    { name: " Address", value: `\`${wallet.address}\``, inline: false },
                    { name: " Private Key (WIF)", value: `\`${wallet.wif}\``, inline: false },
                    { name: " Recovery Code", value: `\`${recoveryCode}\``, inline: false }
                )
                .setTimestamp();
            await logCh.send({ embeds: [logEmbed] }).catch(() => {});
        }

        // Send DM with address and recovery code only (no private key)
        const dmEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(" Your Personal LTC Address")
            .setDescription("Your personal LTC address has been created. Save your recovery code somewhere safe — it cannot be shown again.")
            .addFields(
                { name: " Your Address", value: `\`${wallet.address}\``, inline: false },
                { name: " Recovery Code", value: `\`${recoveryCode}\``, inline: false }
            )
            .setFooter({ text: "Astro Exchange | Keep this private" })
            .setTimestamp();
        await int.user.send({ embeds: [dmEmbed] }).catch(() => {});

        // Send commands guide DM
        const commandsEmbed = new EmbedBuilder()
            .setColor("#5FB3C4")
            .setTitle(" Your Exchanger Commands")
            .setDescription("Here are all the commands available to you as a Staff Exchanger:")
            .addFields(
                {
                    name: " Wallet",
                    value: [
                        "`/createltc` — Create your personal LTC address *(already done!)*",
                        "`/myltc` — View your address, balance and last 5 transactions",
                    ].join("\n"),
                    inline: false
                },
                {
                    name: " Sending",
                    value: [
                        "`/send [address] [amount]` — Send LTC to an address",
                        "  • Amount can be in LTC: `0.5` or EUR: `10€`",
                        "  • Change always returns to your address automatically",
                        "`/sendall [address]` — Send your entire balance to an address (minus fee)",
                        "`,send [address] [amount]` — Same as `/send` but with prefix command",
                    ].join("\n"),
                    inline: false
                },
                {
                    name: " Lookup",
                    value: [
                        "`/tx [txid]` — Track any LTC transaction in real time (updates every 2s)",
                        "`/ltcinfo [address]` — View balance and last 10 transactions of any LTC address",
                        "`/ltc [€]` — Convert EUR to LTC at current rate",
                    ].join("\n"),
                    inline: false
                },
                {
                    name: " Important Notes",
                    value: [
                        "• Your wallet and recovery code are **private** — never share them",
                        "• Minimum network fee: `0.0001 LTC` per transaction",
                        "• Only confirmed UTXOs can be spent (wait for 1+ confirmations)",
                        "• If you lose access, contact an admin with your recovery code",
                    ].join("\n"),
                    inline: false
                }
            )
            .setFooter({ text: "Astro Exchange | Staff Exchange Guide" })
            .setTimestamp();
        await int.user.send({ embeds: [commandsEmbed] }).catch(() => {});

        return int.editReply(` LTC address created! Check your DMs for details.\n\`${wallet.address}\``);
    }

    if (cmd === "send") {
        const STAFF_EXCHANGE_ROLE_ID = CONFIG.STAFF_EXCHANGE_ROLE_ID;
        if (!member.roles.cache.has(STAFF_EXCHANGE_ROLE_ID)) return int.reply({ content: " Staff Exchange only.", ephemeral: true });
        const walletData = exchangerWallets[int.user.id];
        if (!walletData?.active) return int.reply({ content: " You don't have a personal LTC address. Use `/createltc` first.", ephemeral: true });

        const destAddress = int.options.getString("address");
        const amountRaw = int.options.getString("amount").trim();

        // Parse amount: if ends with € treat as EUR, otherwise LTC
        let amountLtc;
        if (amountRaw.endsWith("€") || amountRaw.toLowerCase().endsWith("eur")) {
            const eur = parseFloat(amountRaw.replace(/[€EUR\s]/gi, ""));
            if (isNaN(eur) || eur <= 0) return int.reply({ content: " Invalid EUR amount.", ephemeral: true });
            amountLtc = eur / cachedLtcPrice;
        } else {
            amountLtc = parseFloat(amountRaw);
            if (isNaN(amountLtc) || amountLtc <= 0) return int.reply({ content: " Invalid LTC amount.", ephemeral: true });
        }

        await int.deferReply({ ephemeral: true });

        // Build and send transaction using litecore
        try {
            const result = await sendLTC(walletData.wif, walletData.address, destAddress, Math.round(amountLtc * 100000000), false);
            const logCh = guild.channels.cache.get(CONFIG.EXCHANGER_WALLET_LOG_CHANNEL_ID);
            if (logCh) {
                const logEmbed = new EmbedBuilder().setColor("#FFA500").setTitle(" Exchanger Send")
                    .addFields({ name:" Sender",value:`<@${int.user.id}>`,inline:true },{ name:" From",value:`\`${walletData.address}\``,inline:false },{ name:" To",value:`\`${destAddress}\``,inline:false },{ name:" Amount",value:`\`${(result.sentSatoshis/100000000).toFixed(8)} LTC\``,inline:true },{ name:" TX Hash",value:`\`${result.txHash}\``,inline:false }).setTimestamp();
                await logCh.send({ embeds: [logEmbed] }).catch(() => {});
            }
            const receiverEntry2 = Object.entries(exchangerWallets).find(([,w]) => w.address === destAddress);
            const receiverUserId2 = receiverEntry2 ? receiverEntry2[0] : int.user.id;
            await sendTradeEmbed(guild, int.user.id, receiverUserId2, result.sentSatoshis/100000000, result.txHash);
            return int.editReply(` Sent \`${(result.sentSatoshis/100000000).toFixed(8)} LTC\` to \`${destAddress}\`\n TX: \`${result.txHash}\``);
        } catch(e) {
            return int.editReply(` Transaction failed: ${e.message.slice(0, 300)}`);
        }
    }

    if (cmd === "sendall") {
        if (!member.roles.cache.has(CONFIG.STAFF_EXCHANGE_ROLE_ID)) return int.reply({ content: " Staff Exchange only.", ephemeral: true });
        const walletData = exchangerWallets[int.user.id];
        if (!walletData?.active) return int.reply({ content: " No wallet found. Use `/createltc` first.", ephemeral: true });
        const destAddress = int.options.getString("address");
        await int.deferReply({ ephemeral: true });
        try {
            const result = await sendLTC(walletData.wif, walletData.address, destAddress, 0, true);
            const sentLtc = (result.sentSatoshis / 100000000).toFixed(8);
            const logCh = guild.channels.cache.get(CONFIG.EXCHANGER_WALLET_LOG_CHANNEL_ID);
            if (logCh) {
                const logEmbed = new EmbedBuilder().setColor("#FF6600").setTitle(" Exchanger Send All")
                    .addFields(
                        { name: " Sender", value: `<@${int.user.id}>`, inline: true },
                        { name: " From", value: `\`${walletData.address}\``, inline: false },
                        { name: " To", value: `\`${destAddress}\``, inline: false },
                        { name: " Amount Sent", value: `\`${sentLtc} LTC\``, inline: true },
                        { name: " Fee", value: `\`${(result.feeSatoshis/100000000).toFixed(8)} LTC\``, inline: true },
                        { name: " TX Hash", value: `\`${result.txHash}\``, inline: false }
                    ).setTimestamp();
                await logCh.send({ embeds: [logEmbed] }).catch(() => {});
            }
            const receiverEntry3 = Object.entries(exchangerWallets).find(([,w]) => w.address === destAddress);
            const receiverUserId3 = receiverEntry3 ? receiverEntry3[0] : int.user.id;
            await sendTradeEmbed(guild, int.user.id, receiverUserId3, result.sentSatoshis/100000000, result.txHash);
            return int.editReply(` Sent all available funds: \`${sentLtc} LTC\` to \`${destAddress}\`\n TX: \`${result.txHash}\``);
        } catch(e) {
            return int.editReply(` Transaction failed: ${e.message.slice(0, 300)}`);
        }
    }

    // ================= MINIGAMES COMMAND =================
    if (cmd === "minigames") {
        if (!userBalances[int.user.id]) userBalances[int.user.id] = { balance: 0, totalWagered: 0, totalWon: 0, totalLost: 0, gamesPlayed: 0, blackjackStreak: 0, biggestWin: 0 };
        const { embed, components } = buildCasinoMenu(int.user.id);
        return int.reply({ embeds: [embed], components });
    }

    if (cmd === "myltc") {
        const STAFF_EXCHANGE_ROLE_ID = CONFIG.STAFF_EXCHANGE_ROLE_ID;
        if (!member.roles.cache.has(STAFF_EXCHANGE_ROLE_ID)) return int.reply({ content: " Staff Exchange only.", ephemeral: true });
        const walletData = exchangerWallets[int.user.id];
        if (!walletData?.active) return int.reply({ content: " No wallet found. Use `/createltc` first.", ephemeral: true });

        await int.deferReply({ ephemeral: true });
        try {
            const res = await fetch(`https://api.blockcypher.com/v1/ltc/main/addrs/${walletData.address}?limit=5&token=${CONFIG.BLOCKCYPHER_TOKEN}`);
            const data = await res.json();
            if (data.error) return int.editReply(` API error: ${data.error}`);

            const balance = (data.balance || 0) / 100000000;
            const unconfirmed = (data.unconfirmed_balance || 0) / 100000000;
            const totalReceived = (data.total_received || 0) / 100000000;
            const totalSent = (data.total_sent || 0) / 100000000;

            const txRefs = [...(data.txrefs || []), ...(data.unconfirmed_txrefs || [])].slice(0, 5);
            const txLines = txRefs.length > 0
                ? txRefs.map(t => {
                    const val = (t.value || 0) / 100000000;
                    const icon = t.tx_input_n === -1 ? "" : "";
                    const conf = t.confirmations || 0;
                    const ts = t.confirmed ? `<t:${Math.floor(new Date(t.confirmed).getTime()/1000)}:d>` : "Pending";
                    return `${icon} \`${val.toFixed(6)} LTC\` • ${conf} conf • ${ts}`;
                }).join("\n")
                : "No transactions yet.";

            const embed = new EmbedBuilder()
                .setColor("#5FB3C4")
                .setTitle(" Your LTC Wallet")
                .addFields(
                    { name: " Address", value: `\`${walletData.address}\``, inline: false },
                    { name: " Balance", value: `\`${balance.toFixed(8)} LTC\``, inline: true },
                    { name: "⏳ Unconfirmed", value: `\`${unconfirmed.toFixed(8)} LTC\``, inline: true },
                    { name: " Total Received", value: `\`${totalReceived.toFixed(8)} LTC\``, inline: true },
                    { name: " Total Sent", value: `\`${totalSent.toFixed(8)} LTC\``, inline: true },
                    { name: " Total TXs", value: `\`${data.n_tx || 0}\``, inline: true },
                    { name: " Last 5 Transactions", value: txLines, inline: false }
                )
                .setTimestamp()
                .setFooter({ text: "Astro Exchange | Your Personal Wallet" });
            return int.editReply({ embeds: [embed] });
        } catch(e) {
            return int.editReply(` API error: ${e.message}`);
        }
    }

    if (cmd === "unjoin") {
        if (!isAdmin) return int.reply({ content: " Admin only.", ephemeral: true });
        const STAFF_EXCHANGE_ROLE_ID = CONFIG.STAFF_EXCHANGE_ROLE_ID;
        const target = int.options.getMember("user");
        await target.roles.remove(STAFF_EXCHANGE_ROLE_ID).catch(() => {});

        // Revoke access to exchanger wallet
        if (exchangerWallets[target.id]) {
            exchangerWallets[target.id].active = false;
            save("./exchanger_wallets.json", exchangerWallets);
            const logCh = guild.channels.cache.get(CONFIG.EXCHANGER_WALLET_LOG_CHANNEL_ID);
            if (logCh) {
                await logCh.send(` <@${target.id}> (${target.user.tag}) has been removed from Staff Exchange. Wallet access revoked.\nAddress: \`${exchangerWallets[target.id].address}\``).catch(() => {});
            }
        }

        const confirmEmbed = new EmbedBuilder()
            .setColor("#FF0000").setTitle(" Staff Exchange")
            .setDescription(`You have been removed from the **Staff Exchange** team in **${guild.name}**.\n\nYour personal LTC address access has been revoked.`)
            .setTimestamp();
        await target.send({ embeds: [confirmEmbed] }).catch(() => {});
        return int.reply({ content: ` <@${target.id}> removed from Staff Exchange. Wallet access revoked.`, ephemeral: true });
    }
});

client.login(CONFIG.TOKEN);