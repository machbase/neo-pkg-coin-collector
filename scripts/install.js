'use strict';

/**
 * pkg run install
 *
 *   0) 지난 버전에서 빠진 파일 정리
 *   1) 테이블 생성 (없을 때만) — 체결 CC_TICK(+분·시 롤업), 호가 CC_BOOK, 고래 CC_WHALE, 모의투자 CC_GAME_*.
 *      체결·호가 테이블에 보관 정책이 없으면 기본 1일 (retention.js).
 *      실패해도 수집기가 시작할 때 다시 해 본다.
 *      접속 대상은 cgi-bin/src/db.js 참고 (기본은 이 서버 자신, db.json 은 만들지 않는다)
 *   2) 수집 서비스 neo-pkg-coin-collector-svc 등록 (enable: true 라 등록과 동시에 시작된다).
 *      이미 있으면 아무것도 하지 않는다 — 시작은 start 스크립트의 몫이다.
 *
 * 수집 종목 설정(cgi-bin/conf.d/markets.json)은 만들지 않는다 — 없으면 기본 50개 구성으로 돈다.
 *
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-coin-collector-svc';

function println() {
    const args = Array.prototype.slice.call(arguments);
    if (console.println) console.println.apply(console, args);
    else console.log.apply(console, args);
}
const errText = (e) => (e && e.message ? e.message : String(e));

const PKG_DIR = path.dirname(path.dirname(path.resolve(process.argv[1])));
const REQUIRED = ['index.html', 'main.html', 'settings.html', 'whales.html', 'game.html', 'side.html', 'package.json', 'service/collector.js'];
const missing = REQUIRED.filter(function (f) { return !fs.existsSync(path.join(PKG_DIR, f)); });
if (missing.length > 0) {
    println('ERROR: incomplete package, missing:', missing.join(', '));
    process.exit(1);
}

// ── 0) 지난 버전에서 빠진 파일 정리 ──
// 앱스토어 업데이트는 새 압축 파일을 기존 폴더에 덮어쓸 뿐 없어진 파일을 지우지 않는다. 남겨 두면 옛 화면·CGI 가
// 계속 열리고 불린다 (0.1.3 의 부하 테스트 CGI 는 워커 서비스까지 띄운다).
const OBSOLETE = [
    'inside.html',   // 0.1.2 까지의 DB 인사이드 → 0.2 부터 main.html (neo-web 은 main.html 을 앱 탭으로 연다)
];
for (const f of OBSOLETE) {
    const full = path.join(PKG_DIR, f);
    try {
        if (fs.existsSync(full)) { fs.rmSync(full); println('removed obsolete file:', f); }
    } catch (e) {
        println('WARN: could not remove', f + ':', errText(e));
    }
}

// ── 1) 테이블 ──
// 접속 정보는 cgi-bin/src/db.js 가 정한다 (conf.d/db.json 이 없으면 이 서버 자신).
const db = require(path.join(PKG_DIR, 'cgi-bin', 'src', 'db.js'));
println('database:', db.describe());
try {
    const schema = require(path.join(PKG_DIR, 'cgi-bin', 'src', 'schema.js'));
    db.withConn(function (conn) {
        const r = schema.ensure(conn);
        r.existed.forEach(function (n) { println('table exists:', n); });
        r.created.forEach(function (n) { println('table created:', n); });
        r.failed.forEach(function (n) { println('WARN: create failed:', n); });
        // 체결·호가는 초당 수천 행 — 보관 정책이 없으면 기본 1일을 건다 (골라 둔 기간은 그대로)
        const retention = require(path.join(PKG_DIR, 'cgi-bin', 'src', 'retention.js'));
        const rt = retention.ensureDefault(conn);
        println('retention:', rt.days ? rt.days + ' day(s)' : 'none', rt.changed ? '(applied)' : '(kept)');
    });
} catch (e) {
    println('WARN: DB not reachable, tables not created:', errText(e));
    println('      The collector creates them when it starts.');
}

// ── 2) 서비스 ──
function done(err) {
    if (err) {
        println('ERROR:', errText(err));
        process.exit(1);
    }
    println('neo-pkg-coin-collector installed at', PKG_DIR);
    println('  service   :', SERVICE_NAME);
    println('  app tab   : /public/neo-pkg-coin-collector/main.html (DB inside), settings.html (coins)');
    println('  side pane : /public/neo-pkg-coin-collector/side.html');
    process.exit(0);
}

// enable: true 로 install 하면 컨트롤러가 등록하면서 바로 띄운다. 여기서 start 를 또 부르면
// 컨트롤러가 "starting" 상태를 막지 않아 수집기가 두 개 떠서 모든 체결이 두 번 들어간다 (v8.5.13 실측).
//
// 이미 등록된 경우에도 여기서 시작하지 않는다. 앱스토어 업데이트는 stop → 덮어쓰기 → install → start
// 순서로 돌므로, install 이 시작하면 뒤이은 start 와 겹쳐 같은 문제가 난다.
service.status(SERVICE_NAME, function (statusErr, info) {
    if (!statusErr) {
        const st = String((info && info.status) || '').toLowerCase();
        println('service already installed:', SERVICE_NAME, st ? '(' + st + ')' : '');
        if (st !== 'running' && st !== 'starting') println('      run the start script to start it.');
        done(null);
        return;
    }
    service.install({
        name: SERVICE_NAME,
        enable: true,
        working_dir: PKG_DIR,
        executable: path.join(PKG_DIR, 'service', 'collector.js'),
    }, function (err) {
        if (err) { done(err); return; }
        println('service installed and started:', SERVICE_NAME);
        done(null);
    });
});
