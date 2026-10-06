'use strict';
/**
 * 보관 기간 (Machbase retention 정책) — 체결(CC_TICK)·호가(CC_BOOK)에 같이 건다.
 *
 * GET  /cgi-bin/api/retention           현재 정책과 테이블별 정리 작업 상태
 * POST /cgi-bin/api/retention { days }  days: 1 | 7 | 30 | 0(무제한)
 *
 * 규칙·단위 제약은 src/retention.js 참고.
 */
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const retention = require(path.join(ROOT, 'src', 'retention.js'));

try {
    const out = db.withConn(function (conn) {
        if (cgi.method() === 'GET') return retention.current(conn);
        return retention.apply(conn, Number(cgi.readBody().days));
    });
    cgi.ok(out);
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
