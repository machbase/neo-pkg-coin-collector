'use strict';

/**
 * Machbase 연결 래퍼 (JSH machcli).
 *
 * CGI(cgi-bin/api/*)와 수집 서비스(service/collector.js)가 같이 쓴다.
 *
 * 접속 정보: cgi-bin/conf.d/db.json 이 있으면 그것을, 없으면 {} 를 넘긴다. machcli 는 빈 설정을
 * 받으면 /proc/share/db.json — 이 스크립트를 띄운 machbase-neo 자신의 접속 정보 — 로 채운다.
 * CGI·서비스·pkg run 모두에서 보이는 것을 실측했다 (v8.5.13). 그래서 포트가 기본값이 아닌 서버에
 * 설치해도 그 서버에 붙는다. db.json 은 다른 DB 에 쌓고 싶을 때만 직접 만든다.
 *
 * 예전처럼 127.0.0.1:5656 을 기본값으로 두면, 다른 포트로 띄운 서버에 설치했을 때 같은 머신의
 * 다른 서버에 몰래 쓰게 된다.
 */
const fs = require('fs');
const path = require('path');
const process = require('process');
const { Client } = require('machcli');

/** 패키지 루트. 실행 파일이 cgi-bin 아래(CGI)든 service/ 아래(수집기)든 같은 곳을 가리킨다. */
function packageRoot() {
    const script = String(process.argv[1] || '');
    const at = script.lastIndexOf('/cgi-bin/');
    if (at >= 0) return script.slice(0, at);
    return path.dirname(path.dirname(path.resolve(script)));
}

const ROOT = packageRoot();
const CONF = path.join(ROOT, 'cgi-bin', 'conf.d', 'db.json');
const DATA_DIR = path.join(ROOT, 'data');

function config() {
    if (fs.existsSync(CONF)) return JSON.parse(fs.readFileSync(CONF));   // 깨진 파일은 조용히 넘기지 않는다
    return {};
}

/** 어디에 붙는지 사람이 읽을 수 있게. install 로그·상태 표시용. */
function describe() {
    const own = fs.existsSync(CONF);
    let c = own ? config() : {};
    if (!own) {
        try { c = JSON.parse(fs.readFileSync('/proc/share/db.json', 'utf8')); } catch (_) {}
    }
    return (own ? 'conf.d/db.json' : 'this server') + ' (' + (c.host || '?') + ':' + (c.port || '?') + ')';
}

/** 열고, 쓰고, 반드시 닫는다. fn 안에서 던지면 그대로 전파된다. */
function withConn(fn) {
    const db = new Client(config());
    let conn = null;
    try {
        conn = db.connect();
        return fn(conn);
    } finally {
        try { conn && conn.close(); } catch (_) {}
        try { db.close(); } catch (_) {}
    }
}

function rows(conn, sql, values) {
    const it = values && values.length ? conn.query.apply(conn, [sql].concat(values)) : conn.query(sql);
    const out = [];
    for (const r of it) out.push(r);
    return out;
}

module.exports = { withConn, rows, config, describe, packageRoot, ROOT, CONF, DATA_DIR, Client };
