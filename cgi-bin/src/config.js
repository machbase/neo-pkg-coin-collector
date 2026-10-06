'use strict';

/**
 * 수집 종목 설정 파일 — cgi-bin/conf.d/markets.json
 *
 *   { "coins": [ { coin, spot, spotDepth, futures, futuresDepth, futuresSymbol, mult } … ], "updatedAt": <ms> }
 *
 * 설정 화면(settings.html) → cgi-bin/api/markets 가 쓰고, 수집기가 2초마다 파일의 수정 시각을 보고 바뀌면 다시 읽어
 * 웹소켓을 새 목록으로 다시 연다 (서비스 재시작 없음 — stop 은 SIGKILL 이라 버퍼의 1초치를 잃는다).
 * 파일이 없으면 기본 구성(lib/markets.js DEFAULT_COINS).
 * conf.d 는 앱스토어 업데이트에서 유지되고 pack.sh 가 아카이브에 넣지 않는다 — 서버마다 고른 목록이 다르다.
 *
 * machcli 를 쓰지 않는다 — Node 로 단위 테스트한다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const markets = require('./markets.js');

/** 패키지 루트. 실행 파일이 cgi-bin 아래(CGI)든 service/ 아래(수집기)든 같은 곳을 가리킨다 (db.js 와 같은 규칙) */
function packageRoot() {
    const script = String(process.argv[1] || '');
    const at = script.lastIndexOf('/cgi-bin/');
    if (at >= 0) return script.slice(0, at);
    return path.dirname(path.dirname(path.resolve(script)));
}

const FILE = path.join(packageRoot(), 'cgi-bin', 'conf.d', 'markets.json');

/** 지금 설정. 파일이 깨졌으면 기본 구성으로 돌고 error 에 이유를 남긴다 — 수집이 멈추는 것보다 낫다 */
function load(file) {
    file = file || FILE;
    if (!fs.existsSync(file)) return { source: 'default', coins: markets.DEFAULT_COINS, updatedAt: null };
    try {
        const j = JSON.parse(fs.readFileSync(file));
        return { source: 'file', coins: markets.normalize(j.coins), updatedAt: j.updatedAt || null };
    } catch (e) {
        return { source: 'default', coins: markets.DEFAULT_COINS, updatedAt: null, error: 'markets.json ignored: ' + (e && e.message ? e.message : String(e)) };
    }
}

/** 검사하고 저장한다. 임시 파일에 쓰고 이름을 바꾼다 — 수집기가 반쯤 쓴 파일을 읽지 않게 */
function save(coins, file) {
    file = file || FILE;
    const list = markets.normalize(coins);
    if (!list.length) throw new Error('수집할 코인을 하나 이상 고르세요');
    const body = { coins: list, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(body, null, 1));
    fs.renameSync(file + '.tmp', file);
    return { source: 'file', coins: list, updatedAt: body.updatedAt };
}

/** 설정을 지워 기본 구성으로 */
function reset(file) {
    file = file || FILE;
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return load(file);
}

/** 바뀌었는지 보려는 값 — 수정 시각, 없으면 'default' */
function version(file) {
    file = file || FILE;
    try { return String(fs.statSync(file).mtimeMs || fs.statSync(file).mtime); } catch (_) { return 'default'; }
}

module.exports = { FILE, load, save, reset, version };
