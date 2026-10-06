'use strict';

/**
 * 체결·호가 수집 서비스 (JSH). install 이 neo-pkg-coin-collector-svc 서비스로 등록한다.
 *
 * 바이낸스 웹소켓(현물·선물, feeds.js) → 메모리 버퍼 → 1초마다 append.
 *   체결 → CC_TICK (분·시 롤업이 붙어 있다, schema.js), 호가 변화 → CC_BOOK (별도 연결의 appender — 초당 수천 행이라
 *   체결과 서로 막지 않게).
 *
 * 같은 체결로 고래를 감지해 CC_WHALE 에 넣는다 (whale.js) — 화면을 켜 두지 않아도 기록된다.
 * 같은 체결로 실시간 요약판(board.js)을 만들어 1초마다 data/live.json 에 쓴다 — 고래·모의투자 화면이 CGI 한 번으로 받는다.
 * 모의투자 게임 엔진(engine.js)도 여기서 1초마다 돈다 — 청산 판정에 모든 체결이 필요해서. 결과는 data/game.json.
 *
 * 무엇을 받을지는 설정 화면이 쓴 cgi-bin/conf.d/markets.json (src/config.js). 2초마다 파일이 바뀌었는지 보고,
 * 바뀌었으면 웹소켓을 새 목록으로 다시 연다 — 서비스를 재시작하지 않는다. 이미 버퍼에 든 체결은 그대로 적재한다.
 *
 * - 웹소켓이 끊기거나 30초 동안 조용하면 다시 붙는다 (바이낸스는 24시간마다 끊는다).
 * - DB 가 잠깐 죽어도 버퍼에 쌓아 두고 다시 연결해 넣는다. 버퍼가 MAX_BUFFER 를 넘으면
 *   오래된 것부터 버리고 dropped 로 센다 — 메모리가 무한히 늘어나는 것보다 낫다.
 * - 2초마다 data/status.json 에 상태를 쓴다. 화면은 /cgi-bin/api/status 로 이걸 본다.
 *
 * 이 파일은 cgi-bin 밖에 둔다. cgi-bin 안에 두면 HTTP 요청 한 번에 수집기가 하나 더 뜬다.
 *
 * 서비스 stop 은 SIGKILL 이라 종료 훅이 돌지 않는다 (v8.5.13 실측). 버퍼에 남은 최대 1초치 체결은
 * 잃는다. 훅은 jsh 로 직접 띄웠다가 정상 종료할 때만 의미가 있다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const { WebSocket } = require('ws');

const SRC = path.join(path.dirname(path.dirname(path.resolve(process.argv[1]))), 'cgi-bin', 'src');
const db = require(path.join(SRC, 'db.js'));
const schema = require(path.join(SRC, 'schema.js'));
const config = require(path.join(SRC, 'config.js'));
const markets = require(path.join(SRC, 'markets.js'));
const feeds = require(path.join(SRC, 'feeds.js'));
const clearLib = require(path.join(SRC, 'clear.js'));
const { WhaleDetector } = require(path.join(SRC, 'whale.js'));
const { LiveBoard } = require(path.join(SRC, 'board.js'));
const { GameEngine } = require(path.join(SRC, 'engine.js'));
const { frameText } = feeds;

const FLUSH_MS = 1000;
const STATUS_MS = 2000;
const SILENT_MS = 30000;
const RECONNECT_MS = 3000;
const MAX_BUFFER = 500000;
const MAX_BOOK_BUFFER = 1000000;   // 호가 약 100초치 — DB 가 그 이상 멈추면 오래된 것부터 버린다
const COUNTER_FILE = path.join(db.DATA_DIR, 'counters.json');
const RATE_WINDOW = 10;            // 초당 유입량은 최근 10번 flush 평균
const STATUS_FILE = path.join(db.DATA_DIR, 'status.json');
const LIVE_FILE = path.join(db.DATA_DIR, 'live.json');
const GAME_FILE = path.join(db.DATA_DIR, 'game.json');
const MAX_WHALE_BUFFER = 10000;

function log(level, message, extra) {
    const line = { ts: new Date().toISOString(), level: level, message: message };
    if (extra) for (const k in extra) line[k] = extra[k];
    console.println(JSON.stringify(line));
}
const errText = (e) => (e && e.message ? e.message : String(e));

// ── 상태 ──
const status = {
    startedAt: Date.now(),
    updatedAt: 0,
    // 종류별 요약 { spot, futures } — 화면은 이것만 본다. 연결별 상세는 connections
    feeds: {},
    connections: {},
    // 지금 받는 목록 { source: file|default, appliedAt, coins, spot, spotDepth, futures, futuresDepth, streams, error }
    markets: null,
    written: 0,
    bookWritten: 0,
    dropped: 0,
    buffered: 0,
    // 누적 적재 (재시작해도 이어짐, counters.json). 보관 정책이 오래된 행을 지우므로 테이블 건수와 다르다 —
    // 삭제가 있는 TAG 테이블은 V$_STAT 건수도 틀어진다 (실측). 적재량은 수집기가 직접 센다.
    total: { trades: 0, book: 0 },
    // 호가 테이블을 못 쓰면(서버의 TAG 캐시가 가득 차 CC_BOOK 을 만들 수 없는 경우 등) 호가만 건너뛰고 체결은 계속 받는다
    book: { enabled: true, error: '' },
    rate: { trades: 0, book: 0 },
    db: { connected: false, lastError: '' },
    whales: 0,          // 이번에 켜진 뒤 감지한 고래
    whaleRule: null,
    clear: null,   // { state: running|done|failed, step, startedAt, finishedAt, dropped, ms, error }
};
let buffer = [];
let bookBuffer = [];
let whaleBuffer = [];
try {
    const c = JSON.parse(fs.readFileSync(COUNTER_FILE));
    status.total.trades = Number(c.trades) || 0;
    status.total.book = Number(c.book) || 0;
} catch (_) {}
const rateLog = [];                // [{ at, trades, book }]
// 분마다 적재한 행 수 — 최근 60분. 화면(인사이드 저장 구조)의 스파크라인. [분 시작 ms, 체결, 호가]
const minutes = [];
function noteMinute(trades, book) {
    const m = Math.floor(Date.now() / 60000) * 60000;
    let last = minutes[minutes.length - 1];
    if (!last || last[0] !== m) {
        last = [m, 0, 0];
        minutes.push(last);
        if (minutes.length > 61) minutes.shift();
    }
    last[1] += trades;
    last[2] += book;
}
let stopping = false;

// 고래 기준은 cgi-bin/conf.d/whale.json 으로 덮어쓸 수 있다: { "ratio": 30, "minUsd": 50000 }
// ratio = 24시간 평균 초당 거래대금의 몇 배, minUsd = 1초 합계 최소 금액(USDT). 바꾼 뒤에는 서비스를 재시작한다.
function whaleRule() {
    const file = path.join(db.ROOT, 'cgi-bin', 'conf.d', 'whale.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file)); } catch (e) {
        log('warn', 'whale.json ignored', { error: errText(e) });
        return null;
    }
}
const whale = new WhaleDetector(whaleRule());
status.whaleRule = whale.rule;
const board = new LiveBoard([]);      // 태그는 applyConfig 가 정한다
const game = new GameEngine(log);

// ── 웹소켓 ──
// 설정이 바뀌면 generation 을 올린다. 옛 연결의 재접속 예약은 generation 이 달라 아무것도 하지 않는다.
let generation = 0;
let FEEDS = {};                    // name → { name, kind, url, streams, symbols, parse }
let configVersion = null;
const sockets = {};

function openFeed(name, gen) {
    if (stopping || gen !== generation || !FEEDS[name]) return;
    const feed = FEEDS[name];
    const st = status.connections[name];
    let ws;
    try {
        ws = new WebSocket(feed.url);
    } catch (e) {
        st.lastError = errText(e);
        scheduleReconnect(name, gen);
        return;
    }
    const entry = sockets[name] = { ws: ws, closed: false, gen: gen };

    ws.on('open', function () {
        if (entry.closed) return;
        st.connected = true;
        st.lastMsgAt = Date.now();
        log('info', 'feed open', { feed: name, streams: feed.streams });
    });
    ws.on('message', function (ev) {
        if (entry.closed) return;
        st.lastMsgAt = Date.now();
        let msg;
        try { msg = JSON.parse(frameText(ev && ev.data !== undefined ? ev.data : ev)); } catch (_) { return; }
        const t = feed.parse(msg);
        if (!t) return;
        if (t.refs) {
            for (const r of t.refs) { board.setRef(r); whale.setDaily(r.name, r.quoteVolume); }
            return;
        }
        if (t.book) {
            if (!status.book.enabled) return;
            st.book += t.book.length;
            for (const row of t.book) bookBuffer.push(row);
            if (bookBuffer.length > MAX_BOOK_BUFFER) {
                const over = bookBuffer.length - MAX_BOOK_BUFFER;
                bookBuffer.splice(0, over);
                status.dropped += over;
            }
            return;
        }
        st.trades++;
        board.feed(t);
        game.onTrade(t);
        buffer.push(t);
        const found = whale.feed(t);
        if (found.length) whaleBuffer = whaleBuffer.concat(found);
        if (buffer.length > MAX_BUFFER) {
            const over = buffer.length - MAX_BUFFER;
            buffer.splice(0, over);
            status.dropped += over;
        }
    });
    // JSH ws 는 비정상 종료를 'close', 정상 종료를 'error' 로 올린다 — 둘 다 재접속으로 처리한다.
    ws.on('close', function (e) { dropFeed(name, entry, e ? errText(e) : 'closed'); });
    ws.on('error', function (e) { dropFeed(name, entry, errText(e)); });
}

function dropFeed(name, entry, reason) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    try { entry.ws.close(); } catch (_) {}
    if (entry.gen !== generation) return;   // 설정이 바뀌어 일부러 닫은 연결
    const st = status.connections[name];
    st.connected = false;
    st.lastError = reason;
    log('warn', 'feed closed', { feed: name, reason: reason });
    scheduleReconnect(name, entry.gen);
}

function scheduleReconnect(name, gen) {
    if (stopping || gen !== generation) return;
    status.connections[name].reconnects++;
    setTimeout(function () { openFeed(name, gen); }, RECONNECT_MS);
}

function closeAllFeeds() {
    for (const name in sockets) {
        const entry = sockets[name];
        entry.closed = true;
        try { entry.ws.close(); } catch (_) {}
        delete sockets[name];
    }
}

// 30초 동안 메시지가 없으면 연결이 죽은 걸로 본다 (TCP 가 끊긴 걸 모르는 경우)
function watchdog() {
    const now = Date.now();
    for (const name in sockets) {
        const entry = sockets[name];
        const st = status.connections[name];
        if (!entry.closed && st && st.connected && now - st.lastMsgAt > SILENT_MS) {
            dropFeed(name, entry, 'silent for ' + SILENT_MS + 'ms');
        }
    }
}

/** 설정을 읽어 웹소켓을 (다시) 연다. 처음 한 번, 그리고 설정 파일이 바뀔 때마다 */
function applyConfig() {
    const version = config.version();
    if (version === configVersion) return;
    configVersion = version;
    const cfg = config.load();
    if (cfg.error) log('warn', 'config', { error: cfg.error });
    generation++;
    closeAllFeeds();
    const list = feeds.build(cfg.coins);
    const p = markets.plan(cfg.coins);
    board.setTags(p.spot.map((x) => x.tag).concat(p.futures.map((x) => x.tag)));
    FEEDS = {};
    status.connections = {};
    for (const f of list) {
        FEEDS[f.name] = f;
        status.connections[f.name] = { kind: f.kind, streams: f.streams, symbols: f.symbols, connected: false, lastMsgAt: 0, reconnects: 0, trades: 0, book: 0, lastError: '' };
    }
    status.markets = Object.assign({ source: cfg.source, appliedAt: Date.now(), connections: list.length, error: cfg.error || '' }, markets.summary(cfg.coins));
    log('info', 'markets applied', status.markets);
    const gen = generation;
    for (const f of list) openFeed(f.name, gen);
}

/** 연결별 상태 → 종류별 요약. 연결이 없는 종류(현물만 고른 경우의 선물 등)는 enabled: false */
function summarizeFeeds() {
    const out = {};
    for (const kind of ['spot', 'futures']) {
        const list = Object.keys(status.connections).map((n) => status.connections[n]).filter((c) => c.kind === kind);
        out[kind] = {
            enabled: list.length > 0,
            connected: list.length > 0 && list.every((c) => c.connected),
            up: list.filter((c) => c.connected).length,
            connections: list.length,
            streams: list.reduce((a, c) => a + c.streams, 0),
            // 연결이 받은 누적 건수 (설정이 바뀌면 0 부터). 화면이 두 번 읽은 차이로 종류별 초당 유입을 낸다
            trades: list.reduce((a, c) => a + c.trades, 0),
            book: list.reduce((a, c) => a + c.book, 0),
            reconnects: list.reduce((a, c) => a + c.reconnects, 0),
            lastMsgAt: list.reduce((a, c) => Math.max(a, c.lastMsgAt), 0),
            lastError: (list.find((c) => !c.connected && c.lastError) || {}).lastError || '',
        };
    }
    status.feeds = out;
}

// ── DB ──
let client = null, conn = null, appender = null;
let bookClient = null, bookConn = null, bookAppender = null;

function openDb() {
    client = new db.Client(db.config());
    conn = client.connect();
    const r = schema.ensure(conn);
    r.created.forEach(function (n) { log('info', 'table created', { table: n }); });
    // 수집기가 테이블을 직접 만든 경우(설치 때 TAG 캐시가 모자라 못 만들었다가 서버 재시작 뒤 등)에도 보관 정책을 건다.
    // 초당 수천 행이 쌓이는 테이블이라 빠지면 디스크가 계속 는다. 골라 둔 기간은 건드리지 않는다.
    try { require(path.join(SRC, 'retention.js')).ensureDefault(conn); } catch (e) { log('warn', 'retention check failed', { error: errText(e) }); }
    r.failed.forEach(function (n) { log('error', 'table create failed', { detail: n }); });
    appender = conn.append(schema.TABLE);
    try {
        bookClient = new db.Client(db.config());
        bookConn = bookClient.connect();
        bookAppender = bookConn.append(schema.BOOK_TABLE);
        status.book = { enabled: true, error: '' };
    } catch (e) {
        // 호가 때문에 체결까지 멈추면 안 된다 — 호가만 끈다
        try { bookConn && bookConn.close(); } catch (_) {}
        try { bookClient && bookClient.close(); } catch (_) {}
        bookAppender = bookConn = bookClient = null;
        bookBuffer = [];
        status.book = { enabled: false, error: errText(e) };
        log('warn', 'order book disabled', { error: status.book.error });
    }
    status.db.connected = true;
    status.db.lastError = '';
    log('info', 'db open');
}

function closeDb() {
    try { appender && appender.close(); } catch (_) {}
    try { conn && conn.close(); } catch (_) {}
    try { client && client.close(); } catch (_) {}
    try { bookAppender && bookAppender.close(); } catch (_) {}
    try { bookConn && bookConn.close(); } catch (_) {}
    try { bookClient && bookClient.close(); } catch (_) {}
    appender = conn = client = null;
    bookAppender = bookConn = bookClient = null;
    status.db.connected = false;
}

function flush() {
    const swept = whale.sweep(Date.now());
    if (swept.length) whaleBuffer = whaleBuffer.concat(swept);
    if (whaleBuffer.length > MAX_WHALE_BUFFER) whaleBuffer.splice(0, whaleBuffer.length - MAX_WHALE_BUFFER);
    if (buffer.length === 0 && bookBuffer.length === 0 && whaleBuffer.length === 0) { noteRate(0, 0); noteMinute(0, 0); return; }
    try {
        if (!appender) openDb();
    } catch (e) {
        status.db.lastError = errText(e);
        log('warn', 'db open failed', { error: status.db.lastError });
        closeDb();
        return;
    }
    const batch = buffer;
    buffer = [];
    let i = 0;
    try {
        for (; i < batch.length; i++) {
            const t = batch[i];
            // AMT 거래대금, SAMT 순매수 대금 — 롤업이 이 두 컬럼을 분·시 단위로 미리 합쳐 둔다 (schema.js)
            appender.append(t.name, new Date(t.time), t.price, t.qty, t.price * Math.abs(t.qty), t.price * t.qty, t.tradeId);
        }
        appender.flush();
        status.written += batch.length;
        status.total.trades += batch.length;
    } catch (e) {
        appendFailed(batch, i, e);
        return;
    }
    const books = flushBook();
    noteRate(batch.length, books);
    noteMinute(batch.length, books);
    flushWhales();
}

// 고래는 드물어 INSERT 로 넣는다. 실패하면 다음 flush 에 다시 넣는다.
function flushWhales() {
    if (!conn) return;   // 방금 적재가 실패해 연결을 닫았다 — 다음 flush 에 넣는다
    while (whaleBuffer.length) {
        const w = whaleBuffer[0];
        try {
            conn.exec('INSERT INTO ' + schema.WHALE_TABLE
                + ' (WHALE_AT, NAME, SIDE, AMOUNT_USD, RATIO, QTY, TRADE_CNT, FIRST_PRICE, LAST_PRICE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                new Date(w.time), w.name, w.side, w.usd, w.ratio, w.qty, w.count, w.firstPrice, w.lastPrice);
        } catch (e) {
            status.db.lastError = errText(e);
            log('warn', 'whale insert failed', { error: status.db.lastError, pending: whaleBuffer.length });
            return;
        }
        whaleBuffer.shift();
        status.whales++;
        log('info', 'whale', { name: w.name, side: w.side, usd: w.usd, ratio: w.ratio, count: w.count });
    }
}

// 실시간 요약판. 임시 파일에 쓰고 이름을 바꾼다 — CGI 가 반쯤 쓴 파일을 읽지 않게.
function writeLive() {
    try {
        fs.mkdirSync(db.DATA_DIR, { recursive: true });
        fs.writeFileSync(LIVE_FILE + '.tmp', JSON.stringify(board.snapshot(Date.now())));
        fs.renameSync(LIVE_FILE + '.tmp', LIVE_FILE);
    } catch (e) {
        log('warn', 'live write failed', { error: errText(e) });
    }
}

// 게임 엔진 한 번. DB 가 끊겨 있거나 비우는 중이면 건너뛴다 — 수집이 우선이다. 엔진 오류가 수집을 멈추지 않게 잡는다.
function gameTick() {
    if (!conn || clearing) return;
    try {
        const prices = {};
        for (const name in board.sym) if (board.sym[name].price != null) prices[name] = board.sym[name].price;
        const snap = game.tick(conn, prices, Date.now());
        fs.writeFileSync(GAME_FILE + '.tmp', JSON.stringify(snap));
        fs.renameSync(GAME_FILE + '.tmp', GAME_FILE);
    } catch (e) {
        log('warn', 'game tick failed', { error: errText(e) });
    }
}

// 호가. 실패하면 남은 것을 되돌리고 연결을 다시 연다 (체결과 같은 방식)
function flushBook() {
    if (!bookBuffer.length || !bookAppender) return 0;
    const batch = bookBuffer;
    bookBuffer = [];
    let i = 0;
    try {
        for (; i < batch.length; i++) {
            const r = batch[i];
            bookAppender.append(r[0], new Date(r[1]), r[2], r[3], r[4]);
        }
        bookAppender.flush();
        status.bookWritten += batch.length;
        status.total.book += batch.length;
        return batch.length;
    } catch (e) {
        bookBuffer = batch.slice(i).concat(bookBuffer);
        status.db.lastError = errText(e);
        log('warn', 'book append failed', { error: status.db.lastError, pending: bookBuffer.length });
        closeDb();
        return i;
    }
}

// 호가 테이블이 없어 꺼졌으면 1분마다 다시 열어 본다 — 테이블이 생기면(TAG 캐시를 비우는 등) 재시작 없이 켜진다
const BOOK_RETRY_MS = 60000;
let lastBookTry = 0;
function retryBook() {
    if (status.book.enabled || !conn || Date.now() - lastBookTry < BOOK_RETRY_MS) return;
    lastBookTry = Date.now();
    try {
        schema.ensure(conn);
        bookClient = new db.Client(db.config());
        bookConn = bookClient.connect();
        bookAppender = bookConn.append(schema.BOOK_TABLE);
        status.book = { enabled: true, error: '' };
        // 새로 생긴 CC_BOOK 에도 CC_TICK 과 같은 보관 기간을
        try { require(path.join(SRC, 'retention.js')).ensureDefault(conn); } catch (e) { log('warn', 'book retention failed', { error: errText(e) }); }
        log('info', 'order book enabled');
    } catch (e) {
        try { bookConn && bookConn.close(); } catch (_) {}
        try { bookClient && bookClient.close(); } catch (_) {}
        bookAppender = bookConn = bookClient = null;
        status.book.error = errText(e);
    }
}

function noteRate(trades, book) {
    rateLog.push({ at: Date.now(), trades: trades, book: book });
    if (rateLog.length > RATE_WINDOW + 1) rateLog.shift();
    if (rateLog.length < 2) return;
    const sec = (rateLog[rateLog.length - 1].at - rateLog[0].at) / 1000;
    let t = 0, b = 0;
    for (let k = 1; k < rateLog.length; k++) { t += rateLog[k].trades; b += rateLog[k].book; }
    status.rate = { trades: Math.round(t / sec), book: Math.round(b / sec) };
}

// 실패한 행부터 다시 버퍼 앞에 되돌린다. 앞쪽은 append 됐을 수 있다 — 드물게 중복될 수 있다.
function appendFailed(batch, i, e) {
    buffer = batch.slice(i).concat(buffer);
    status.db.lastError = errText(e);
    log('warn', 'append failed', { error: status.db.lastError, pending: buffer.length });
    closeDb();
}

function writeStatus() {
    status.updatedAt = Date.now();
    status.buffered = buffer.length + bookBuffer.length;
    status.minutes = minutes;
    summarizeFeeds();
    try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(status.total)); } catch (_) {}
    try {
        fs.mkdirSync(db.DATA_DIR, { recursive: true });
        fs.writeFileSync(STATUS_FILE, JSON.stringify(status));
    } catch (e) {
        log('warn', 'status write failed', { error: errText(e) });
    }
}

// ── DB 비우기 ──
// 수집 중에 요청되면 수집기가 지운다 (src/clear.js): 적재를 멈추고 → DROP 후 다시 만들고 → 보관 기간 그대로 → 누적 건수 0 → 이어서 수집.
// 멈춰 있을 때의 요청은 일회성 서비스(service/clear.js)가 맡는다. 동기로 돈다 — 그동안 웹소켓 메시지는 쌓였다가 끝나고 들어온다.
let clearing = false;
// 켜진 직후에는 지우지 않는다. 켜 달라는 CGI 요청(control.js start)이 아직 끝나지 않았을 수 있고, 그 요청이 끊기면
// 막 켜진 수집기도 같이 죽는다 — DROP 도중에 죽으면 엔진이 되돌리지 않아 테이블이 반쯤 지워진 채 잠긴다
// (2026-10-06 실측: "DDL FAILURE (The session is canceled.)" 뒤 CC_TICK 이 DROP 도 append 도 안 되는 Resource busy).
const CLEAR_GRACE_MS = 5000;
function checkClear() {
    if (clearing || Date.now() - status.startedAt < CLEAR_GRACE_MS) return;
    const req = clearLib.claim(db.DATA_DIR);
    if (!req) return;
    clearing = true;
    const t0 = Date.now();
    const step = (text) => { status.clear.step = text; writeStatus(); log('info', 'clear', { step: text }); };
    status.clear = { state: 'running', step: '', startedAt: t0, dropped: [], by: 'collector' };
    try {
        step('적재 멈춤');
        buffer = []; bookBuffer = []; whaleBuffer = [];   // 요청 전에 받은 것 — 지울 데이터다
        closeDb();
        const r = clearLib.run(db, schema, require(path.join(SRC, 'retention.js')), step);
        status.clear.dropped = r.dropped;
        status.clear.retentionDays = r.retentionDays;
        status.total = { trades: 0, book: 0 };
        status.written = 0; status.bookWritten = 0; status.dropped = 0;
        rateLog.length = 0;
        minutes.length = 0;
        status.clear.state = 'done';
    } catch (e) {
        status.clear.state = 'failed';
        status.clear.error = errText(e);
        log('error', 'clear failed', { error: status.clear.error });
    }
    status.clear.step = '';
    status.clear.finishedAt = Date.now();
    status.clear.ms = status.clear.finishedAt - t0;
    clearLib.release(db.DATA_DIR);
    clearing = false;
    writeStatus();
    try { openDb(); } catch (e) { status.db.lastError = errText(e); closeDb(); }   // 실패하면 다음 flush 가 다시 연다
}

// ── 시작·종료 ──
function shutdown() {
    if (stopping) return;
    stopping = true;
    log('info', 'shutdown requested');
    closeAllFeeds();
    flush();
    closeDb();
    for (const name in status.connections) status.connections[name].connected = false;
    writeStatus();
}

if (typeof process.addShutdownHook === 'function') process.addShutdownHook(shutdown);

log('info', 'collector starting');
// 남은 비우기 요청은 CLEAR_GRACE_MS 뒤 첫 점검에서 처리한다 (켜진 직후에 지우지 않는다 — checkClear 참고)
try { if (!conn) openDb(); } catch (e) {
    status.db.lastError = errText(e);
    log('warn', 'db open failed, will retry', { error: status.db.lastError });
    closeDb();
}
applyConfig();
setInterval(flush, FLUSH_MS);
setInterval(function () { checkClear(); applyConfig(); watchdog(); writeStatus(); retryBook(); }, STATUS_MS);
setInterval(writeLive, 1000);
setInterval(gameTick, 1000);
