import { DurableObject } from "cloudflare:workers";

// ===== Luật thi đấu — chỉ cần sửa 3 hằng số này nếu đổi quy chế =====
// (phải khớp với 3 hằng số cùng tên trong public/index.html)
const SET_POINTS = 15; // chạm mốc này và hơn đối thủ >= 2 điểm thì thắng set
const SET_CAP = 21;    // điểm trần: ai chạm trước thì thắng set, dù chỉ hơn 1 điểm
const SETS_TO_WIN = 2; // thắng 2 set là thắng trận (đấu tối đa 3 set)

// Sơ đồ bốc thăm ban đầu: hạt giống 1 (qf1/A) và hạt giống 2 (qf4/B) nằm ở
// hai nhánh khác nhau, chỉ có thể gặp nhau ở chung kết. 6 đội còn lại bốc
// thăm ngẫu nhiên vào các vị trí còn trống — đổi tên trực tiếp trên trang.
// Khung giờ ước tính cho thể thức 3 set 15: mỗi đợt ~35 phút, nghỉ 10 phút giữa vòng.
const SEED_MATCHES = [
  { id: "qf1",   round: "Tứ kết",    order_num: 1, court: "Sân 1", time: "13:30–14:00", teamA: "Đội A (Hạt giống 1)", teamB: "Đội B", nextMatch: "sf1",   nextSlot: "A" },
  { id: "qf2",   round: "Tứ kết",    order_num: 2, court: "Sân 2", time: "13:30–14:00", teamA: "Đội C",               teamB: "Đội D", nextMatch: "sf1",   nextSlot: "B" },
  { id: "qf3",   round: "Tứ kết",    order_num: 3, court: "Sân 1", time: "14:00–14:30", teamA: "Đội E",               teamB: "Đội F", nextMatch: "sf2",   nextSlot: "A" },
  { id: "qf4",   round: "Tứ kết",    order_num: 4, court: "Sân 2", time: "14:00–14:30", teamA: "Đội G",               teamB: "Đội H (Hạt giống 2)", nextMatch: "sf2", nextSlot: "B" },
  { id: "sf1",   round: "Bán kết",   order_num: 5, court: "Sân 1", time: "14:30–15:00", teamA: "",                    teamB: "",      nextMatch: "final", nextSlot: "A" },
  { id: "sf2",   round: "Bán kết",   order_num: 6, court: "Sân 2", time: "14:30–15:00", teamA: "",                    teamB: "",      nextMatch: "final", nextSlot: "B" },
  { id: "final", round: "Chung kết", order_num: 7, court: "Sân 1", time: "15:00–15:30", teamA: "",                    teamB: "",      nextMatch: null,    nextSlot: null },
];

// Điểm số được lưu dưới dạng nhật ký từng điểm: chuỗi ký tự "A"/"B" theo thứ tự
// ghi điểm (ví dụ "AABABB..."). Tỷ số từng set, số set thắng và đội thắng đều
// được tính lại từ nhật ký này, nên hoàn tác/sửa điểm luôn nhất quán qua ranh giới set.
function setWinner(a, b) {
  if (a >= SET_CAP) return "A";
  if (b >= SET_CAP) return "B";
  if (a >= SET_POINTS && a - b >= 2) return "A";
  if (b >= SET_POINTS && b - a >= 2) return "B";
  return null;
}

function replay(log) {
  let a = 0, b = 0, setsA = 0, setsB = 0, winner = null, setStart = 0, consumed = 0;
  const history = [];
  for (let i = 0; i < log.length && !winner; i++) {
    if (log[i] === "A") a++; else b++;
    consumed = i + 1;
    const w = setWinner(a, b);
    if (w) {
      history.push([a, b]);
      if (w === "A") setsA++; else setsB++;
      a = 0; b = 0; setStart = i + 1;
      if (setsA >= SETS_TO_WIN) winner = "A";
      else if (setsB >= SETS_TO_WIN) winner = "B";
    }
  }
  return { history, scoreA: a, scoreB: b, setsA, setsB, winner, setStart, consumed };
}

function userError(message) {
  return Object.assign(new Error(message), { userMessage: message });
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
        nextSlot TEXT,
        log TEXT DEFAULT ''
      );
    `);

    // Nâng cấp từ bản cũ (1 set 21 điểm): thêm cột log. Chỉ lần chạy đầu tiên thành công,
    // khi đó xoá điểm cũ (không còn ý nghĩa với luật mới) và cập nhật khung giờ; tên đội được giữ nguyên.
    try {
      this.sql.exec("ALTER TABLE matches ADD COLUMN log TEXT DEFAULT ''");
      // Xoá tên đội đã được tự động điền sang vòng sau từ các kết quả cũ.
      const decided = this.sql
        .exec("SELECT nextMatch, nextSlot FROM matches WHERE winner IS NOT NULL AND nextMatch IS NOT NULL")
        .toArray();
      for (const d of decided) {
        const field = d.nextSlot === "A" ? "teamA" : "teamB";
        this.sql.exec(`UPDATE matches SET ${field} = '' WHERE id = ?`, d.nextMatch);
      }
      this.sql.exec("UPDATE matches SET scoreA = 0, scoreB = 0, status = 'pending', winner = NULL, log = ''");
      for (const m of SEED_MATCHES) {
        this.sql.exec("UPDATE matches SET time = ? WHERE id = ?", m.time, m.id);
      }
    } catch (e) {
      if (!/duplicate column/i.test(String(e && e.message))) throw e;
    }

    // Khung giờ chỉ là nhãn hiển thị: luôn đồng bộ theo SEED_MATCHES để đổi giờ chỉ cần sửa code rồi deploy.
    for (const m of SEED_MATCHES) {
      this.sql.exec("UPDATE matches SET time = ? WHERE id = ?", m.time, m.id);
    }

    const count = this.sql.exec("SELECT COUNT(*) AS c FROM matches").one().c;
    if (count === 0) {
      for (const m of SEED_MATCHES) {
        this.sql.exec(
          `INSERT INTO matches (id, round, order_num, court, time, teamA, teamB, nextMatch, nextSlot, log)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '')`,
          m.id, m.round, m.order_num, m.court, m.time, m.teamA, m.teamB, m.nextMatch, m.nextSlot
        );
      }
    }
  }

  rowToMatch(r) {
    return {
      id: r.id, round: r.round, order_num: r.order_num, court: r.court, time: r.time,
      teamA: r.teamA || "", teamB: r.teamB || "",
      nextMatch: r.nextMatch || null, nextSlot: r.nextSlot || null,
      log: String(r.log || "").replace(/[^AB]/g, ""),
    };
  }

  getAllMatches() {
    return this.sql
      .exec("SELECT id, round, order_num, court, time, teamA, teamB, nextMatch, nextSlot, log FROM matches ORDER BY order_num ASC")
      .toArray()
      .map((r) => this.rowToMatch(r));
  }

  getMatch(id) {
    const rows = this.sql
      .exec("SELECT id, round, order_num, court, time, teamA, teamB, nextMatch, nextSlot, log FROM matches WHERE id = ?", id)
      .toArray();
    return rows[0] ? this.rowToMatch(rows[0]) : null;
  }

  broadcast() {
    const payload = JSON.stringify({ type: "state", matches: this.getAllMatches() });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch (e) { /* socket gone, ignore */ }
    }
  }

  // Ghi nhật ký mới; nếu đội thắng trận thay đổi thì cập nhật luôn vị trí ở trận kế tiếp.
  setLog(m, newLog) {
    newLog = newLog.slice(0, replay(newLog).consumed); // bỏ phần thừa sau khi trận đã phân thắng bại
    const prevWinner = replay(m.log).winner;
    const nextWinner = replay(newLog).winner;
    this.sql.exec("UPDATE matches SET log = ? WHERE id = ?", newLog, m.id);
    if (prevWinner !== nextWinner && m.nextMatch && m.nextSlot) {
      const name = nextWinner === "A" ? m.teamA : nextWinner === "B" ? m.teamB : "";
      const field = m.nextSlot === "A" ? "teamA" : "teamB";
      this.sql.exec(`UPDATE matches SET ${field} = ? WHERE id = ?`, name, m.nextMatch);
    }
  }

  // Không cho sửa/gỡ kết quả một trận nếu trận kế tiếp (có đội thắng của nó) đã bắt đầu.
  assertNextNotStarted(m) {
    if (replay(m.log).winner && m.nextMatch) {
      const next = this.getMatch(m.nextMatch);
      if (next && next.log.length > 0) {
        throw userError("Trận kế tiếp đã bắt đầu, không thể sửa kết quả trận này.");
      }
    }
  }

  applyPoint(matchId, side) {
    const m = this.getMatch(matchId);
    if (!m) return;
    if (replay(m.log).winner) throw userError("Trận đã kết thúc. Bấm Hoàn tác nếu ghi nhầm điểm.");
    this.setLog(m, m.log + side);
  }

  // Trừ 1 điểm của đội trong set đang đánh (điểm gần nhất của đội đó).
  applyMinus(matchId, side) {
    const m = this.getMatch(matchId);
    if (!m) return;
    const r = replay(m.log);
    if (r.winner) throw userError("Trận đã kết thúc. Bấm Hoàn tác nếu ghi nhầm điểm.");
    const idx = m.log.lastIndexOf(side);
    if (idx < r.setStart) return; // set đang đánh chưa có điểm của đội này
    this.setLog(m, m.log.slice(0, idx) + m.log.slice(idx + 1));
  }

  // Hoàn tác điểm cuối cùng, kể cả khi điểm đó vừa chốt một set hoặc cả trận.
  applyUndo(matchId) {
    const m = this.getMatch(matchId);
    if (!m || m.log.length === 0) return;
    this.assertNextNotStarted(m);
    this.setLog(m, m.log.slice(0, -1));
  }

  applyReset(matchId) {
    const m = this.getMatch(matchId);
    if (!m) return;
    this.assertNextNotStarted(m);
    this.setLog(m, "");
  }

  applyUpdateTeam(matchId, side, value) {
    const field = side === "A" ? "teamA" : "teamB";
    this.sql.exec(`UPDATE matches SET ${field} = ? WHERE id = ?`, String(value || "").slice(0, 120), matchId);
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
    const validSide = data.side === "A" || data.side === "B";

    try {
      if (data.type === "point" && validSide) {
        this.applyPoint(data.matchId, data.side);
      } else if (data.type === "minus" && validSide) {
        this.applyMinus(data.matchId, data.side);
      } else if (data.type === "undo") {
        this.applyUndo(data.matchId);
      } else if (data.type === "reset") {
        this.applyReset(data.matchId);
      } else if (data.type === "updateTeam" && validSide) {
        this.applyUpdateTeam(data.matchId, data.side, data.value);
      } else {
        return;
      }
      this.broadcast();
    } catch (e) {
      ws.send(JSON.stringify({
        type: "error",
        message: (e && e.userMessage) || "Không xử lý được thao tác, thử lại.",
      }));
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
