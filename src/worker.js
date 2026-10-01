import { DurableObject } from "cloudflare:workers";

// Sơ đồ bốc thăm ban đầu: hạt giống 1 (qf1/A) và hạt giống 2 (qf4/B) nằm ở
// hai nhánh khác nhau, chỉ có thể gặp nhau ở chung kết. 6 đội còn lại bốc
// thăm ngẫu nhiên vào các vị trí còn trống — đổi tên trực tiếp trên trang.
const SEED_MATCHES = [
  { id: "qf1",   round: "Tứ kết",   order_num: 1, court: "Sân 1", time: "00:10–00:30", teamA: "Đội A (Hạt giống 1)", teamB: "Đội B", nextMatch: "sf1",   nextSlot: "A" },
  { id: "qf2",   round: "Tứ kết",   order_num: 2, court: "Sân 2", time: "00:10–00:30", teamA: "Đội C",               teamB: "Đội D", nextMatch: "sf1",   nextSlot: "B" },
  { id: "qf3",   round: "Tứ kết",   order_num: 3, court: "Sân 1", time: "00:30–00:50", teamA: "Đội E",               teamB: "Đội F", nextMatch: "sf2",   nextSlot: "A" },
  { id: "qf4",   round: "Tứ kết",   order_num: 4, court: "Sân 2", time: "00:30–00:50", teamA: "Đội G",               teamB: "Đội H (Hạt giống 2)", nextMatch: "sf2", nextSlot: "B" },
  { id: "sf1",   round: "Bán kết",  order_num: 5, court: "Sân 1", time: "01:00–01:20", teamA: "",                    teamB: "",      nextMatch: "final", nextSlot: "A" },
  { id: "sf2",   round: "Bán kết",  order_num: 6, court: "Sân 2", time: "01:00–01:20", teamA: "",                    teamB: "",      nextMatch: "final", nextSlot: "B" },
  { id: "final", round: "Chung kết", order_num: 7, court: "Sân 1", time: "01:30–01:50", teamA: "",                   teamB: "",      nextMatch: null,     nextSlot: null },
];

function getWinner(a, b) {
  a = a || 0; b = b || 0;
  if (a >= 30) return "A";
  if (b >= 30) return "B";
  if (a >= 21 && a - b >= 2) return "A";
  if (b >= 21 && b - a >= 2) return "B";
  return null;
}

export class Tournament extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ensureSchema();
  }

  ensureSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        round TEXT,
        order_num INTEGER,
        court TEXT,
        time TEXT,
        teamA TEXT,
        teamB TEXT,
        scoreA INTEGER DEFAULT 0,
        scoreB INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        winner TEXT,
        nextMatch TEXT,
        nextSlot TEXT
      );
    `);
    const count = this.sql.exec("SELECT COUNT(*) AS c FROM matches").one().c;
    if (count === 0) {
      for (const m of SEED_MATCHES) {
        this.sql.exec(
          `INSERT INTO matches (id, round, order_num, court, time, teamA, teamB, scoreA, scoreB, status, winner, nextMatch, nextSlot)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending', NULL, ?, ?)`,
          m.id, m.round, m.order_num, m.court, m.time, m.teamA, m.teamB, m.nextMatch, m.nextSlot
        );
      }
    }
  }

  getAllMatches() {
    return this.sql.exec("SELECT * FROM matches ORDER BY order_num ASC").toArray();
  }

  getMatch(id) {
    const rows = this.sql.exec("SELECT * FROM matches WHERE id = ?", id).toArray();
    return rows[0] || null;
  }

  broadcast() {
    const payload = JSON.stringify({ type: "state", matches: this.getAllMatches() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* socket gone, ignore */ }
    }
  }

  applyAdjustScore(matchId, side, delta) {
    const m = this.getMatch(matchId);
    if (!m) return;
    let scoreA = m.scoreA || 0, scoreB = m.scoreB || 0;
    if (side === "A") scoreA = Math.max(0, scoreA + delta);
    else scoreB = Math.max(0, scoreB + delta);
    const prevWinner = m.winner || null;
    const newWinner = getWinner(scoreA, scoreB);
    const status = newWinner ? "done" : ((scoreA > 0 || scoreB > 0) ? "live" : "pending");

    this.sql.exec(
      "UPDATE matches SET scoreA = ?, scoreB = ?, status = ?, winner = ? WHERE id = ?",
      scoreA, scoreB, status, newWinner, matchId
    );

    if (newWinner && newWinner !== prevWinner && m.nextMatch && m.nextSlot) {
      const winningName = newWinner === "A" ? (m.teamA || "") : (m.teamB || "");
      const field = m.nextSlot === "A" ? "teamA" : "teamB";
      this.sql.exec(`UPDATE matches SET ${field} = ? WHERE id = ?`, winningName, m.nextMatch);
    }
  }

  applyUpdateTeam(matchId, side, value) {
    const field = side === "A" ? "teamA" : "teamB";
    this.sql.exec(`UPDATE matches SET ${field} = ? WHERE id = ?`, String(value || "").slice(0, 120), matchId);
  }

  applyReset(matchId) {
    this.sql.exec(
      "UPDATE matches SET scoreA = 0, scoreB = 0, status = 'pending', winner = NULL WHERE id = ?",
      matchId
    );
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade request", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "state", matches: this.getAllMatches() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch (e) {
      return;
    }
    const VALID_IDS = new Set(SEED_MATCHES.map((m) => m.id));
    if (!data || !VALID_IDS.has(data.matchId)) return;

    try {
      if (data.type === "adjustScore" && (data.side === "A" || data.side === "B") && (data.delta === 1 || data.delta === -1)) {
        this.applyAdjustScore(data.matchId, data.side, data.delta);
      } else if (data.type === "updateTeam" && (data.side === "A" || data.side === "B")) {
        this.applyUpdateTeam(data.matchId, data.side, data.value);
      } else if (data.type === "reset") {
        this.applyReset(data.matchId);
      } else {
        return;
      }
      this.broadcast();
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Không xử lý được thao tác, thử lại." }));
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (e) {}
  }

  async webSocketError(ws, error) {
    // Hibernation API: để kết nối tự dọn dẹp, không cần làm gì thêm.
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const id = env.TOURNAMENT.idFromName("main");
      const stub = env.TOURNAMENT.get(id);
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
