'use strict';
/**
 * 수집기가 멈춰 있을 때의 DB 비우기 — 한 번만 도는 서비스 neo-pkg-coin-collector-clear.
 *
 * cgi-bin/api/control.js 가 요청 파일(data/clear.json)을 쓰고 이 서비스를 등록한다 (enable: true 라 등록과 동시에 돈다).
 * 지우고(src/clear.js) 진행 상황을 data/status.json 의 clear 에 남긴 뒤, 스스로 등록을 지운다.
 * 수집기 서비스는 켜지 않는다 — 사용자가 멈춰 둔 수집이 비우기 때문에 다시 돌면 안 된다.
 *
 * 수집기가 멈춰 있어 status.json 을 쓰는 쪽이 없다 — 여기서 고쳐 쓴다. 누적 적재(counters.json)도 0 으로.
 * 요청이 없으면(컨트롤러가 다시 띄운 경우 등) 아무것도 하지 않고 등록만 지운다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');

const SRC = path.join(path.dirname(path.dirname(path.resolve(process.argv[1]))), 'cgi-bin', 'src');
const db = require(path.join(SRC, 'db.js'));
const schema = require(path.join(SRC, 'schema.js'));
const retention = require(path.join(SRC, 'retention.js'));
const clear = require(path.join(SRC, 'clear.js'));

const SERVICE_NAME = 'neo-pkg-coin-collector-clear';
const STATUS_FILE = path.join(db.DATA_DIR, 'status.json');
const errText = (e) => (e && e.message ? e.message : String(e));

function patchStatus(fn) {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(STATUS_FILE)) || {}; } catch (_) {}
    fn(s);
    try { fs.writeFileSync(STATUS_FILE + '.tmp', JSON.stringify(s)); fs.renameSync(STATUS_FILE + '.tmp', STATUS_FILE); } catch (_) {}
}

function done() {
    service.uninstall(SERVICE_NAME, function (err) {
        if (err) console.println('WARN uninstall', SERVICE_NAME + ':', errText(err));
        process.exit(0);
    });
}

// 등록 직후 바로 지우지 않는다. 이 서비스를 등록한 CGI 요청(control.js)이 아직 끝나지 않았을 수 있고, 그 요청이 끊기면
// 이 프로세스도 같이 죽을 수 있다 — DROP 도중에 죽으면 엔진이 되돌리지 않아 테이블이 반쯤 지워진 채 잠긴다 (collector.js 참고).
const GRACE_MS = 5000;
setTimeout(run, GRACE_MS);

function run() {
const req = clear.claim(db.DATA_DIR);
if (!req) {
    done();
} else {
    const t0 = Date.now();
    const progress = { state: 'running', step: '', startedAt: t0, dropped: [], by: 'clear-service' };
    const step = (text) => { progress.step = text; patchStatus((s) => { s.clear = progress; }); console.println('clear:', text); };
    try {
        step('시작');
        const r = clear.run(db, schema, retention, step);
        progress.dropped = r.dropped;
        progress.retentionDays = r.retentionDays;
        progress.state = 'done';
        try { fs.writeFileSync(path.join(db.DATA_DIR, 'counters.json'), JSON.stringify({ trades: 0, book: 0 })); } catch (_) {}
    } catch (e) {
        progress.state = 'failed';
        progress.error = errText(e);
        console.println('clear failed:', progress.error);
    }
    progress.step = '';
    progress.finishedAt = Date.now();
    progress.ms = progress.finishedAt - t0;
    patchStatus((s) => {
        s.clear = progress;
        if (progress.state === 'done') { s.total = { trades: 0, book: 0 }; s.written = 0; s.bookWritten = 0; s.dropped = 0; }
    });
    clear.release(db.DATA_DIR);
    done();
}
}
