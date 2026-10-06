'use strict';
/**
 * GET /cgi-bin/api/status — 수집기 상태 (data/status.json) + 지금 테이블에 있는 행 수.
 *
 * 수집기가 2초마다 쓰는 파일을 그대로 넘기고 stale 여부를 붙인다. 파일이 10초 넘게 안 바뀌었으면 수집기가 멈춘 것으로 본다.
 * rows: 테이블마다 지금 들어 있는 행 수 — TAG 통계 뷰(V$<테이블>_STAT)라 원본을 세지 않아 바로 온다.
 *   (수집기가 센 누적 적재 total 은 보관 정책이 지운 것도 포함한다 — 화면에는 rows 를 보여 준다)
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));

const STALE_MS = 10000;

function tableRows() {
    const out = {};
    try {
        db.withConn(function (conn) {
            for (const t of [schema.TABLE, schema.BOOK_TABLE]) {
                try { out[t] = Number(db.rows(conn, 'SELECT SUM(ROW_COUNT) AS N FROM V$' + t + '_STAT')[0].N) || 0; }
                catch (_) { out[t] = null; }   // 테이블이 없다 (비우는 중 등)
            }
        });
    } catch (_) { return null; }   // DB 에 못 붙음
    return out;
}

try {
    const file = path.join(db.DATA_DIR, 'status.json');
    const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { reason: 'collector has not written status yet' };
    s.running = Date.now() - (s.updatedAt || 0) < STALE_MS;
    s.rows = tableRows();
    cgi.ok(s);
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
