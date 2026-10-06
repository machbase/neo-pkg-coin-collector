'use strict';
/**
 * 수집 서비스 켜고 끄기, 데이터 비우기 — 사이드 패널의 버튼.
 *
 * GET  /cgi-bin/api/control                         서비스 상태 { service: running|stopped|starting|missing }
 * POST /cgi-bin/api/control { action: 'stop' }      수집 중지 (컨트롤러가 SIGKILL — 최대 1초치 체결은 잃는다)
 * POST /cgi-bin/api/control { action: 'start' }     수집 시작. 이미 돌거나 시작 중이면 그대로 — 두 번 start 하면
 *                                                   수집기가 둘 뜬다 (scripts/start.js 와 같은 규칙)
 * POST /cgi-bin/api/control { action: 'clear', confirm: 'CLEAR' }
 *      비우기 요청 파일(data/clear.json)만 쓰고 바로 답한다. 지우기는 src/clear.js — 체결·호가·롤업 DROP 후 다시 만들기,
 *      보관 기간 복원, 누적 건수 0.
 *        수집 중이면  수집기가 2초 안에 가져가 지우고 이어서 수집한다.
 *        멈춰 있으면  일회성 서비스 neo-pkg-coin-collector-clear 를 등록해 지운다 (service/clear.js, 끝나면 스스로 등록 해제).
 *                    수집기 서비스는 켜지 않는다.
 *      진행 상황은 GET 의 progress 로 본다.
 *
 * CGI 요청 안에서 지우지 않는 이유: 호가 수억 행 DROP 은 수 분 걸려 요청이 중간에 끊기면 반쯤 지운 채 멈추고,
 * 누적 건수는 수집기 메모리에 있어 파일을 지워도 되살아난다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const service = require('service');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));
const db = require(path.join(ROOT, 'src', 'db.js'));

const SERVICE_NAME = 'neo-pkg-coin-collector-svc';
const CLEAR_SERVICE = 'neo-pkg-coin-collector-clear';
const clearLib = require(path.join(ROOT, 'src', 'clear.js'));

function status(cb) {
    service.status(SERVICE_NAME, function (missing, info) {
        cb(missing ? 'missing' : String((info && info.status) || '').toLowerCase() || 'unknown');
    });
}
const isUp = (st) => st === 'running' || st === 'starting';

function stop(cb) {
    status(function (st) {
        if (!isUp(st)) { cb(null, st); return; }
        service.stop(SERVICE_NAME, function (err) { if (err) cb(err); else status((s) => cb(null, s)); });
    });
}
function start(cb) {
    status(function (st) {
        if (st === 'missing') { cb(new Error('service not installed — 패키지를 다시 설치하세요')); return; }
        if (isUp(st)) { cb(null, st); return; }
        service.start(SERVICE_NAME, function (err) { if (err) cb(err); else status((s) => cb(null, s)); });
    });
}

const CLEAR_FILE = path.join(db.DATA_DIR, clearLib.REQUEST);
const PKG_DIR = path.dirname(ROOT);

/** 멈춰 있을 때: 일회성 비우기 서비스를 등록한다 (enable: true — 등록과 동시에 돈다). 지난 것이 남아 있으면 지우고 다시 */
function startClearService(cb) {
    const install = () => service.install({
        name: CLEAR_SERVICE, enable: true, working_dir: PKG_DIR,
        executable: path.join(PKG_DIR, 'service', 'clear.js'),
    }, cb);
    service.status(CLEAR_SERVICE, function (missing) {
        if (missing) { install(); return; }
        service.stop(CLEAR_SERVICE, function () { service.uninstall(CLEAR_SERVICE, function () { install(); }); });
    });
}
function readJson(file) {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null; } catch (_) { return null; }
}
/** 수집기가 쓴 진행 상황 + 아직 집어 가지 않은 요청 */
function clearState() {
    const st = readJson(path.join(db.DATA_DIR, 'status.json')) || {};
    return { pending: clearLib.pending(db.DATA_DIR), progress: st.clear || null };
}

try {
    if (cgi.method() === 'GET') {
        status((st) => cgi.ok(Object.assign({ service: st }, clearState())));
    } else {
        const body = cgi.readBody() || {};
        const done = (err, data) => (err ? cgi.fail(err.message || String(err)) : cgi.ok(data));
        if (body.action === 'stop') {
            // 지우는 중에 멈추면(SIGKILL) DROP 이 중간에 끊겨 테이블이 반쯤 지워진 채 잠긴다 — 끝날 때까지 막는다
            if (clearLib.pending(db.DATA_DIR) || (clearState().progress || {}).state === 'running') throw new Error('지우는 중에는 멈출 수 없어요. 끝난 뒤 다시 눌러 주세요');
            stop((err, st) => done(err, { service: st }));
        } else if (body.action === 'start') {
            start((err, st) => done(err, { service: st }));
        } else if (body.action === 'clear') {
            if (body.confirm !== 'CLEAR') throw new Error('confirm 이 필요합니다');
            status(function (st) {
                if (st === 'missing') { done(new Error('service not installed — 패키지를 다시 설치하세요')); return; }
                if (clearLib.pending(db.DATA_DIR)) { done(new Error('이미 비우는 중이에요')); return; }
                fs.mkdirSync(db.DATA_DIR, { recursive: true });
                fs.writeFileSync(CLEAR_FILE, JSON.stringify({ at: Date.now() }));
                if (isUp(st)) { done(null, Object.assign({ service: st, by: 'collector' }, clearState())); return; }
                startClearService((err) => done(err, Object.assign({ service: st, by: 'clear-service' }, clearState())));
            });
        } else {
            throw new Error('unknown action: ' + body.action);
        }
    }
} catch (e) {
    cgi.fail(e && e.message ? e.message : String(e));
}
