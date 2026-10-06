'use strict';
/**
 * DB 비우기 — 체결(CC_TICK, 롤업 포함)·호가(CC_BOOK)를 DROP 후 다시 만들고, 보관 기간을 그대로 다시 건다.
 *
 * 누가 지우나 (cgi-bin/api/control.js 가 요청 파일 data/clear.json 을 쓴다)
 *   수집 중이면  수집기(service/collector.js) — 적재를 멈추고 지운 뒤 이어서 수집한다. 누적 건수가 수집기 메모리에 있다.
 *   멈춰 있으면  한 번만 도는 서비스 neo-pkg-coin-collector-clear (service/clear.js) — 지우고 스스로 등록을 지운다.
 *               수집기 서비스는 켜지 않는다.
 * HTTP 요청 안에서 지우지 않는 이유: 호가 수억 행 DROP 은 수 분 — 그사이 브라우저가 요청을 끊으면 서버가 죽는다 (README).
 *
 * 요청은 claim() 으로 이름을 바꿔 가져간다 — 수집기와 일회성 서비스가 같은 요청을 두 번 처리하지 않게.
 */
const fs = require('fs');
const path = require('path');

const REQUEST = 'clear.json';
const CLAIMED = 'clear.running.json';

/** 요청을 가져온다. 없거나 다른 쪽이 먼저 가져갔으면 null */
function claim(dataDir) {
    const from = path.join(dataDir, REQUEST), to = path.join(dataDir, CLAIMED);
    if (!fs.existsSync(from)) return null;
    try { fs.renameSync(from, to); } catch (_) { return null; }
    let req = {};
    try { req = JSON.parse(fs.readFileSync(to)) || {}; } catch (_) {}
    return req;
}

function release(dataDir) {
    try { fs.unlinkSync(path.join(dataDir, CLAIMED)); } catch (_) {}
}

function pending(dataDir) {
    return fs.existsSync(path.join(dataDir, REQUEST)) || fs.existsSync(path.join(dataDir, CLAIMED));
}

/**
 * 지운다. step(text) 로 진행 상황을 알린다. 반환 { dropped: [테이블], retentionDays }
 * db·schema·retention 은 cgi-bin/src 의 모듈 (machcli 를 쓰므로 JSH 에서만 돈다).
 */
function run(db, schema, retention, step) {
    const dropped = [];
    let days = 1;
    db.withConn(function (c) {
        try { days = retention.current(c).days; } catch (_) {}
        for (const [name, cascade] of [[schema.TABLE, true], [schema.BOOK_TABLE, false]]) {
            if (!db.rows(c, "SELECT NAME FROM M$SYS_TABLES WHERE NAME = '" + name + "'").length) continue;
            step(name + ' 지우는 중');
            // 롤업이 딸린 테이블은 CASCADE 가 없으면 MACHCLI-ERR-2651
            c.exec('DROP TABLE ' + name + (cascade ? ' CASCADE' : ''));
            dropped.push(name);
        }
        step('테이블 다시 만드는 중');
        schema.ensure(c);
        retention.apply(c, days);   // 고른 보관 기간 그대로
    });
    return { dropped: dropped, retentionDays: days };
}

module.exports = { claim, release, pending, run, REQUEST, CLAIMED };
