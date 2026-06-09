const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const CHANNEL_DISPLAY = process.env.TWITCH_CHANNEL || "YoyoCaleb_";
const CHANNEL = CHANNEL_DISPLAY.toLowerCase();
const BOT_NAME = (process.env.TWITCH_BOT_NAME || "nightbot").toLowerCase();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "scores.json");
const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const MIN_LEADERBOARD_SPAFFS = 5;

let entries = loadEntries();
let chatSocket = null;
let chatStatus = "starting";
let reconnectTimer = null;
let lastCapture = null;

function loadEntries() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveEntries() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2));
}

function cleanUser(username) {
  return username.replace(/^@/, "").replace(/[^\w-]/g, "").toLowerCase();
}

function parseSpaffResult(text) {
  const line = text.replace(/\s+/g, " ").trim();
  const match = line.match(/(?:^|\s)(@?[\w-]{2,25})\s+has\s+spaffed\s+(-?\d+(?:\.\d+)?)\s*(?:ft|feet)?\b/i);
  if (!match) return null;

  return {
    id: crypto.randomUUID(),
    user: cleanUser(match[1]),
    value: Number(match[2]),
    raw: line,
    capturedAt: new Date().toISOString(),
  };
}

function addEntry(entry) {
  if (!entry || !entry.user || !Number.isFinite(entry.value)) return false;
  entries.push(entry);
  lastCapture = entry;
  saveEntries();
  return true;
}

const RANGE_WINDOWS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};

function entryTime(entry) {
  const time = Date.parse(entry.capturedAt || "");
  return Number.isFinite(time) ? time : 0;
}

function filterEntries(range) {
  if (!RANGE_WINDOWS[range]) return entries;

  const cutoff = Date.now() - RANGE_WINDOWS[range];
  return entries.filter((entry) => entryTime(entry) >= cutoff);
}

function buildStats(range = "all") {
  const filteredEntries = filterEntries(range);
  const users = new Map();

  for (const entry of filteredEntries) {
    if (!users.has(entry.user)) {
      users.set(entry.user, { user: entry.user, total: 0, runs: 0, best: -Infinity });
    }

    const row = users.get(entry.user);
    row.total += entry.value;
    row.runs += 1;
    row.best = Math.max(row.best, entry.value);
  }

  const leaderboard = [...users.values()]
    .filter((row) => row.runs >= MIN_LEADERBOARD_SPAFFS)
    .map((row) => ({ ...row, average: row.total / row.runs }))
    .sort((a, b) => b.average - a.average || b.best - a.best || a.user.localeCompare(b.user));

  const total = filteredEntries.reduce((sum, entry) => sum + entry.value, 0);

  return {
    channel: CHANNEL_DISPLAY,
    botName: BOT_NAME,
    range: RANGE_WINDOWS[range] ? range : "all",
    chatStatus,
    lastCapture,
    totalRuns: filteredEntries.length,
    totalUsers: leaderboard.length,
    overallAverage: filteredEntries.length ? total / filteredEntries.length : 0,
    topAverage: leaderboard[0]?.average || 0,
    leaderboard,
    recent: filteredEntries.slice(-10).reverse(),
    updatedAt: new Date().toISOString(),
  };
}

function connectToTwitch() {
  clearTimeout(reconnectTimer);

  if (!globalThis.WebSocket) {
    chatStatus = "node needs websocket support";
    return;
  }

  chatStatus = "connecting";
  chatSocket = new WebSocket(TWITCH_IRC_URL);

  chatSocket.addEventListener("open", () => {
    const nick = `justinfan${Math.floor(Math.random() * 90000 + 10000)}`;
    chatSocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    chatSocket.send("PASS SCHMOOPIIE");
    chatSocket.send(`NICK ${nick}`);
    chatSocket.send(`JOIN #${CHANNEL}`);
    chatStatus = "live";
  });

  chatSocket.addEventListener("message", (event) => {
    const messages = String(event.data).split("\r\n").filter(Boolean);

    for (const message of messages) {
      if (message.startsWith("PING")) {
        chatSocket.send("PONG :tmi.twitch.tv");
        continue;
      }

      handleIrcMessage(message);
    }
  });

  chatSocket.addEventListener("close", () => {
    chatStatus = "reconnecting";
    reconnectTimer = setTimeout(connectToTwitch, 5000);
  });

  chatSocket.addEventListener("error", () => {
    chatStatus = "connection error";
    try {
      chatSocket.close();
    } catch {
      queueReconnect();
    }
  });
}

function queueReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectToTwitch, 5000);
}

function handleIrcMessage(message) {
  const privmsgIndex = message.indexOf(" PRIVMSG ");
  if (privmsgIndex === -1) return;

  const senderMatch = message.match(/display-name=([^;]*)/i) || message.match(/:([^!]+)!/);
  const sender = cleanUser(decodeURIComponent(senderMatch?.[1] || ""));
  if (sender !== BOT_NAME) return;

  const textIndex = message.indexOf(" :", privmsgIndex);
  if (textIndex === -1) return;

  const chatText = message.slice(textIndex + 2);
  addEntry(parseSpaffResult(chatText));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function serveStatic(response, fileName, contentType) {
  const filePath = path.join(__dirname, fileName);
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    response.end(content);
  });
}

function serveAsset(response, urlPath) {
  const safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const fileName = safePath.replace(/^[/\\]/, "");
  const filePath = path.join(__dirname, fileName);

  if (!filePath.startsWith(__dirname)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };

  const contentType = contentTypes[extension];
  if (!contentType) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    });
    response.end(content);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/api/leaderboard") {
    sendJson(response, 200, buildStats(url.searchParams.get("range") || "all"));
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, chatStatus, channel: CHANNEL });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    serveStatic(response, "index.html", "text/html; charset=utf-8");
    return;
  }

  serveAsset(response, url.pathname);
  return;
});

server.listen(PORT, () => {
  console.log(`Spaff leaderboard running on http://localhost:${PORT}`);
  connectToTwitch();
});
