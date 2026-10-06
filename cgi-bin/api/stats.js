'use strict';
/**
 * GET /cgi-bin/api/stats — 종목별 누적 건수와 첫·마지막 체결 시각.
 *
 * TAG 테이블이 태그마다 유지하는 통계 뷰 V$CC_TICK_STAT 를 읽는다. 원본을 세지 않으므로
 * 수억 건이 쌓여도 즉시 돌아온다.
 *
 * 응답: { total, elapsedMs, tags: { NAME: { rows, minTime, maxTime } } }
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));

try {
    // MIN_TIME·MAX_TIME 은 DATETIME 이라 JSH 에서 숫자로 꺼낼 수 없다 — SQL 에서 epoch ms 로 바꾼다.
    const sql = 'SELECT NAME, ROW_COUNT, TO_TIMESTAMP(MIN_TIME) / 1000000 AS MIN_MS, TO_TIMESTAMP(MAX_TIME) / 1000000 AS MAX_MS'
        + ' FROM V$' + schema.TABLE + '_STAT';
    const t0 = Date.now();
    const rows = db.withConn((conn) => db.rows(conn, sql));
    const elapsedMs = Date.now() - t0;
    const tags = {};
    let total = 0;
    for (const r of rows) {
        const n = Number(r.ROW_COUNT);
        total += n;
        tags[r.NAME] = { rows: n, minTime: Math.round(Number(r.MIN_MS)), maxTime: Math.round(Number(r.MAX_MS)) };
    }
    cgi.ok({ total: total, elapsedMs: elapsedMs, tags: tags });
} catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (msg.indexOf('does not exist') >= 0) cgi.ok({ total: 0, elapsedMs: 0, tags: {} });
    else cgi.fail(msg);
}
