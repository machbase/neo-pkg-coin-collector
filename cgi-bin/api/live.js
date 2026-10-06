'use strict';
/**
 * GET /cgi-bin/api/live?whaleSince=<epoch ms>[&game=1]
 *
 * 고래·모의투자 화면이 1.5초마다 부르는 폴링 API. 한 번에 돌려준다:
 *   status   수집기 상태 (data/status.json) — running 은 10초 넘게 안 바뀌면 false
 *   board    실시간 요약판 (data/live.json) — 태그별 가격·1분 통계, 큰 체결 목록 (수집기가 1초마다 쓴다)
 *   whales   whaleSince 이후 고래 (없으면 최근 30건), 최신순
 *   game     game=1 일 때 모의투자 상태 (data/game.json — 수집기의 게임 엔진이 1초마다 쓴다)
 *
 * 화면이 CGI 를 여러 개 따로 부르지 않게 합쳤다. v8.5.13 은 CGI 응답 도중 브라우저가 요청을 끊으면
 * (탭 닫기·새로고침) 서버가 통째로 죽는 버그가 있다 — 요청 수와 응답 시간을 줄여 그 확률을 낮춘다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));
const schema = require(path.join(ROOT, 'src', 'schema.js'));

const STALE_MS = 10000;

function readJson(file) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch (_) { return null; }
}

try {
    const since = parseInt(cgi.query('whaleSince') || '0', 10);
    const now = Date.now();
    const status = readJson(path.join(db.DATA_DIR, 'status.json')) || {};
    status.running = now - (status.updatedAt || 0) < STALE_MS;
    delete status.minutes; delete status.connections;   // 이 화면들엔 필요 없다 — 응답을 줄인다
    const board = readJson(path.join(db.DATA_DIR, 'live.json'));

    let whales = [], dbError = '';
    try {
        // since 는 정수로 파싱한 값이라 문자열 결합해도 안전하다. 시각은 JSH 에서 숫자로 꺼내려고 epoch ms 로 바꾼다.
        const sql = 'SELECT TO_TIMESTAMP(WHALE_AT) / 1000000 AS MS, NAME, SIDE, AMOUNT_USD, RATIO, TRADE_CNT, FIRST_PRICE, LAST_PRICE'
            + ' FROM ' + schema.WHALE_TABLE
            + (since > 0 ? ' WHERE WHALE_AT > FROM_TIMESTAMP(' + since + ' * 1000000)' : '')
            + ' ORDER BY WHALE_AT DESC LIMIT ' + (since > 0 ? 100 : 30);
        whales = db.withConn((conn) => db.rows(conn, sql)).map((r) => ({
            time: Math.round(Number(r.MS)), name: r.NAME, side: Number(r.SIDE),
            usd: Number(r.AMOUNT_USD), ratio: Number(r.RATIO), count: Number(r.TRADE_CNT),
            firstPrice: Number(r.FIRST_PRICE), lastPrice: Number(r.LAST_PRICE),
        }));
    } catch (e) {
        dbError = e && e.message ? e.message : String(e);
        if (dbError.indexOf('does not exist') >= 0) dbError = '';   // 수집기가 아직 테이블을 안 만들었다
    }

    const game = cgi.query('game') === '1' ? readJson(path.join(db.DATA_DIR, 'game.json')) : undefined;
    cgi.ok({ now: now, status: status, board: board, whales: whales, dbError: dbError, game: game });
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
