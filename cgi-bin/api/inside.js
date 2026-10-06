'use strict';
/**
 * GET /cgi-bin/api/inside — "Machbase 인사이드" 탭이 3초마다 부르는 상태 한 벌.
 *
 *   status     수집기 상태 (초당 유입·누적 적재·연결)
 *   tables     테이블마다 종류·행 수·기간. TAG 는 통계 뷰(V$<테이블>_STAT, 원본을 세지 않는다), 롤업은 COUNT(*)
 *   rollups    롤업마다 간격·마지막/다음 실행·걸린 시간(V$ROLLUP), 원본보다 얼마나 뒤처졌나(lagMs),
 *              spark — 칸마다 요약한 체결 수 [[ms, n]] (분 롤업은 최근 60분, 시 롤업은 최근 24시간). 롤업 테이블을 바로 읽는다
 *   status.minutes  수집기가 센 분당 적재 [[분 ms, 체결, 호가]] 최근 60분 — 체결·호가 테이블의 스파크라인
 *   retention  원본 보관 정책과 정리 작업 (src/retention.js)
 *   statMs     이 상태를 모으는 데 걸린 DB 시간
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));
const retention = require(path.join(ROOT, 'src', 'retention.js'));

const ms = (v) => (v == null ? null : Math.round(Number(v)));
function readJson(file) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch (_) { return null; }
}
function one(conn, sql) {
    try { return db.rows(conn, sql)[0] || null; } catch (_) { return null; }
}

// 표에 보일 테이블 — 왜 이 종류인지 한 줄씩
const TABLES = [
    { name: schema.TABLE, kind: 'TAG', role: '체결 원본', why: '태그(코인)·시각으로 쏟아지는 시계열. 태그와 시각으로 바로 찾는다', retention: true },
    { name: schema.BOOK_TABLE, kind: 'TAG', role: '호가 변화 원본', why: '초당 수천 행 — 가장 많이 들어오는 데이터', retention: true },
];

try {
    const now = Date.now();
    const status = readJson(path.join(db.DATA_DIR, 'status.json')) || {};
    status.running = now - (status.updatedAt || 0) < 10000;

    const t0 = Date.now();
    const out = db.withConn(function (conn) {
        const tables = [];
        for (const t of TABLES) {
            const row = { name: t.name, kind: t.kind, role: t.role, why: t.why, retention: !!t.retention };
            if (t.kind === 'TAG') {
                const r = one(conn, 'SELECT SUM(ROW_COUNT) AS N, COUNT(*) AS TAGS, TO_TIMESTAMP(MIN(MIN_TIME)) / 1000000 AS F,'
                    + ' TO_TIMESTAMP(MAX(MAX_TIME)) / 1000000 AS L FROM V$' + t.name + '_STAT');
                if (r) Object.assign(row, { rows: Number(r.N) || 0, tags: Number(r.TAGS) || 0, first: ms(r.F), last: ms(r.L) });
            }
            tables.push(row);
        }
        const tick = tables[0];

        // 롤업: 테이블마다 행 수·기간, 실행 상태는 V$ROLLUP (파티션마다 한 줄이라 이름으로 모은다)
        const state = {};
        try {
            // 시각 컬럼은 JSH 에서 날짜 객체로 와 숫자로 못 바꾼다 — SQL 에서 epoch ms 로
            for (const r of db.rows(conn, 'SELECT ROLLUP_NAME, COLUMN_NAME, INTERVAL_TIME, TO_TIMESTAMP(LAST_WAKEUP_TIME) / 1000000 AS LW,'
                    + ' TO_TIMESTAMP(NEXT_WAKEUP_TIME) / 1000000 AS NW, LAST_ELAPSED_MSEC, ENABLED FROM V$ROLLUP')) {
                const s = state[r.ROLLUP_NAME] = state[r.ROLLUP_NAME] || { column: r.COLUMN_NAME, intervalMs: Number(r.INTERVAL_TIME), last: 0, next: 0, elapsedMs: 0, enabled: true };
                s.last = Math.max(s.last, Math.round(Number(r.LW)) || 0);
                s.next = Math.max(s.next, Math.round(Number(r.NW)) || 0);
                s.elapsedMs = Math.max(s.elapsedMs, Number(r.LAST_ELAPSED_MSEC) || 0);
                if (!Number(r.ENABLED)) s.enabled = false;
            }
        } catch (_) {}
        const rollups = schema.ROLLUP_TABLES.map((name) => {
            const r = one(conn, 'SELECT COUNT(*) AS N, TO_TIMESTAMP(MIN(TIME)) / 1000000 AS F, TO_TIMESTAMP(MAX(TIME)) / 1000000 AS L FROM ' + name) || {};
            const st = state[name] || {};
            const last = ms(r.L);
            // 칸(분·시)마다 요약한 체결 수. 롤업 테이블은 태그마다 한 행이라 시각으로 다시 묶는다
            let spark = [];
            const hourly = /_HOUR$/.test(name);
            try {
                const from = Date.now() - (hourly ? 24 * 3600000 : 3600000);
                // 같은 쿼리에서 GROUP BY TIME 과 TO_TIMESTAMP(TIME) 을 같이 쓰면 MACHCLI-ERR-2044 — 서브쿼리로 나눈다
                spark = db.rows(conn, 'SELECT TO_TIMESTAMP(B) / 1000000 AS T, N FROM (SELECT TIME AS B, SUM(COUNT) AS N FROM ' + name
                    + ' WHERE TIME >= FROM_TIMESTAMP(' + Math.floor(from) + ' * 1000000) GROUP BY TIME) ORDER BY T')
                    .map((x) => [Math.round(Number(x.T)), Number(x.N) || 0]);
            } catch (_) {}
            return {
                name: name, rows: Number(r.N) || 0, first: ms(r.F), last: last,
                column: st.column || (name.indexOf('_AMT_') > 0 ? 'AMT' : name.indexOf('_SAMT_') > 0 ? 'SAMT' : 'VALUE'),
                intervalMs: st.intervalMs || (/_HOUR$/.test(name) ? 3600000 : 60000),
                lastRun: st.last || null, nextRun: st.next || null, elapsedMs: st.elapsedMs || 0, enabled: st.enabled !== false,
                // 롤업 한 칸은 간격이 끝나야 채워진다 — 원본 마지막 시각과의 차이
                lagMs: last && tick.last ? Math.max(0, tick.last - last) : null,
                spark: spark,
            };
        });

        let rt = null;
        try { rt = retention.current(conn); } catch (_) {}
        return { tables: tables, rollups: rollups, retention: rt };
    });
    out.statMs = Date.now() - t0;
    out.now = now;
    out.status = { updatedAt: status.updatedAt || 0, running: status.running, rate: status.rate || {}, total: status.total || {}, feeds: status.feeds || {},
        db: status.db || {}, book: status.book || {}, markets: status.markets || null, buffered: status.buffered || 0, minutes: status.minutes || [] };
    cgi.ok(out);
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
