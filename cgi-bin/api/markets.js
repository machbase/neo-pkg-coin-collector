'use strict';
/**
 * 수집 종목 설정 — 설정 화면(settings.html).
 *
 * GET  /cgi-bin/api/markets                 { source: file|default, coins, updatedAt, applied, defaults }
 *        applied  수집기가 지금 받고 있는 목록 요약 (data/status.json 의 markets) — 저장 후 반영됐는지 본다
 * POST /cgi-bin/api/markets { coins: [...] } 검사 후 cgi-bin/conf.d/markets.json 에 저장
 * POST /cgi-bin/api/markets { reset: true }  설정을 지워 기본 구성(50개)으로
 *
 * 저장만 한다. 수집기가 2초 안에 파일이 바뀐 것을 보고 웹소켓을 다시 연다 (service/collector.js applyConfig).
 * 코인 형식은 lib/markets.js normalize — 이름·심볼은 영문 대문자·숫자만 받는다 (태그 이름이 SQL 에 들어간다).
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const config = require(path.join(ROOT, 'src', 'config.js'));
const markets = require(path.join(ROOT, 'src', 'markets.js'));

const DATA_DIR = path.join(path.dirname(ROOT), 'data');

function applied() {
    try {
        const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'status.json')));
        return Object.assign({ running: Date.now() - (s.updatedAt || 0) < 10000 }, s.markets || {});
    } catch (_) {
        return { running: false };
    }
}

function view(cfg) {
    return { source: cfg.source, coins: cfg.coins, updatedAt: cfg.updatedAt, error: cfg.error || '',
        summary: markets.summary(cfg.coins), applied: applied(), defaults: markets.DEFAULT_COINS, max: markets.MAX_COINS };
}

try {
    if (cgi.method() === 'GET') {
        cgi.ok(view(config.load()));
    } else {
        const body = cgi.readBody() || {};
        if (body.reset === true) cgi.ok(view(config.reset()));
        else cgi.ok(view(config.save(body.coins)));
    }
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
