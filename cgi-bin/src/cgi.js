'use strict';

/**
 * CGI 공통 헬퍼.
 *
 * 브라우저는 DB 를 직접 부르지 않는다. 기록·랭킹은 여기를 거치고, 실시간
 * 트래픽은 machbase-neo 내장 MQTT 로 간다 — CGI 는 서버 안에서 돌아 토큰이 필요 없다.
 */
const process = require('process');

function getEnv(name) {
    if (process.env && typeof process.env.get === 'function') return process.env.get(name);
    return process.env ? process.env[name] : undefined;
}

function method() {
    return String(getEnv('REQUEST_METHOD') || 'GET').toUpperCase();
}

/** UTF-8 바이트 길이. Content-Length 는 문자 수가 아니라 바이트 수다. */
function utf8Length(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }   // surrogate pair
        else n += 3;
    }
    return n;
}

/**
 * JSON 응답.
 *
 * Content-Length 를 반드시 붙인다. 없으면 keep-alive 연결에서 브라우저가 다음
 * 응답의 경계를 잘못 잡아, 병렬 요청 시 본문 뒤에 다른 응답이 붙어 보이는
 * "Unexpected non-whitespace character after JSON" 이 난다. curl 은 요청마다
 * 새 연결을 쓰기 때문에 이 증상이 안 보인다.
 */
function reply(body) {
    const text = JSON.stringify(body);
    process.stdout.write('Content-Type: application/json\r\n');
    process.stdout.write('Content-Length: ' + utf8Length(text) + '\r\n');
    process.stdout.write('Cache-Control: no-store\r\n');
    process.stdout.write('\r\n');
    process.stdout.write(text);
}

function ok(data) { reply({ ok: true, data: data === undefined ? null : data }); }
function fail(reason) { reply({ ok: false, reason: String(reason) }); }

/**
 * 요청 본문을 JSON 으로 읽는다.
 * CONTENT_LENGTH 를 주고 읽는 방식은 기존 패키지에서 문제가 있어 비활성화된
 * 이력이 있다. 검증된 쪽(길이 없이 read())을 그대로 따른다.
 */
function readBody() {
    try {
        const raw = process.stdin.read();
        return raw ? JSON.parse(raw) : {};
    } catch (_) {
        return {};
    }
}

/** 쿼리스트링 파라미터. */
function query(name) {
    const q = getEnv('QUERY_STRING') || '';
    const parts = String(q).split('&');
    for (let i = 0; i < parts.length; i++) {
        const kv = parts[i].split('=');
        if (decodeURIComponent(kv[0] || '') === name) {
            return decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
        }
    }
    return '';
}

/** 이름 문자열 정리 — 따옴표·역슬래시 제거, 길이 제한. */
function clean(s, n) {
    return String(s == null ? '' : s).replace(/['"\\<>]/g, '').slice(0, n || 64);
}

module.exports = { method, reply, ok, fail, readBody, query, clean, getEnv, utf8Length };
