'use strict';

/**
 * 보관 기간 — Machbase retention 정책. 대량 TAG 테이블(CC_TICK·CC_BOOK)에 같이 건다.
 *
 * 설정을 고르지 않은 기본 구성(50개 코인)이면 체결·호가를 합쳐 초당 약 5,000~7,000 행, 다 두면 하루 약 17GB 씩 는다.
 * 1행 약 40바이트 — 사이드 패널이 지금 유입 속도로 하루 증가량을 보여 준다. 기본 1일 보관.
 *
 * 정책 이름 CC_RT_<n>D, DURATION n DAY INTERVAL 1 HOUR — 정리 주기는 1시간이 가장 짧다
 * (MINUTE·SECOND 는 문법 오류, v8.5.13 실측). 그래서 실제로는 최대 n일 + 1시간치가 남는다.
 * M$RETENTION 의 DURATION·INTERVAL 은 예약어라 컬럼으로 적으면 문법 오류 — SELECT * 로 읽는다.
 */
const schema = require('./schema.js');

const TABLES = [schema.TABLE, schema.BOOK_TABLE];
const CHOICES = [1, 7, 30, 0];      // 0 = 무제한
const DEFAULT_DAYS = 1;

function rows(conn, sql) {
    const out = [];
    for (const r of conn.query(sql)) out.push(r);
    return out;
}

/** 있는 테이블만 — CC_BOOK 은 서버 TAG 캐시가 가득 차면 만들어지지 않을 수 있다 */
function existing(conn) {
    const have = {};
    for (const r of rows(conn, 'SELECT NAME FROM M$SYS_TABLES')) have[r.NAME] = true;
    return TABLES.filter((t) => have[t]);
}

/** 테이블별 붙은 정책과 정리 작업 상태 */
function current(conn) {
    const jobs = {};
    for (const r of rows(conn, 'SELECT TABLE_NAME, POLICY_NAME, STATE, LAST_DELETED_TIME FROM V$RETENTION_JOB')) {
        if (TABLES.indexOf(r.TABLE_NAME) < 0) continue;
        jobs[r.TABLE_NAME] = { policy: r.POLICY_NAME, state: r.STATE, lastDeleted: r.LAST_DELETED_TIME == null ? null : String(r.LAST_DELETED_TIME) };
    }
    const policies = {};
    for (const r of rows(conn, 'SELECT * FROM M$RETENTION')) policies[r.POLICY_NAME] = { durationSec: Number(r.DURATION), intervalSec: Number(r.INTERVAL) };
    const tables = existing(conn).map((t) => {
        const j = jobs[t] || null;
        const p = j && policies[j.policy];
        return { table: t, days: p ? Math.round(p.durationSec / 86400) : 0, job: j };
    });
    // 두 테이블은 같이 바꾸므로 대표값은 CC_TICK 것
    return { days: tables.length ? tables[0].days : 0, tables: tables, choices: CHOICES };
}

/** 두 테이블 모두 days 일 보관으로. 0 이면 정책을 뗀다 */
function apply(conn, days) {
    if (CHOICES.indexOf(days) < 0) throw new Error('days must be one of ' + CHOICES.join(', '));
    const name = 'CC_RT_' + days + 'D';
    if (days > 0 && !rows(conn, "SELECT POLICY_NAME FROM M$RETENTION WHERE POLICY_NAME = '" + name + "'").length) {
        conn.exec('CREATE RETENTION ' + name + ' DURATION ' + days + ' DAY INTERVAL 1 HOUR');
    }
    const cur = current(conn);
    for (const t of cur.tables) {
        if (t.days === days && (days === 0 || (t.job && t.job.policy === name))) continue;
        if (t.job) conn.exec('ALTER TABLE ' + t.table + ' DROP RETENTION');   // 붙어 있을 때만 — 없으면 에러
        if (days > 0) conn.exec('ALTER TABLE ' + t.table + ' ADD RETENTION ' + name);
    }
    return current(conn);
}

/**
 * 설치 때: 정책이 하나도 안 붙은 테이블에만 기본 1일을 건다. 사용자가 골라 둔 보관 기간은 건드리지 않는다.
 * (새로 만든 CC_BOOK 에는 CC_TICK 과 같은 기간을 건다.)
 */
function ensureDefault(conn) {
    const cur = current(conn);
    const chosen = cur.tables.find((t) => t.job);
    const days = chosen ? chosen.days : DEFAULT_DAYS;
    if (cur.tables.every((t) => t.job) || days === 0) return { days: days, changed: false };
    return { days: days, changed: true, state: apply(conn, days) };
}

module.exports = { TABLES, CHOICES, DEFAULT_DAYS, current, apply, ensureDefault };
