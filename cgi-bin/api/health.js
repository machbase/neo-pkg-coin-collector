'use strict';
/**
 * GET /cgi-bin/api/health — 앱스토어(neo-web) 실행 스위치용 서비스 상태.
 *
 * neo-web 은 package.json 에 packageService.managed:false 가 없으면 패키지 카드에 실행 스위치를 그리고, 이 응답으로
 * 켜짐/꺼짐을 정한다 (neo-web pkgLifecycle/steps/pkgHealth.ts). 스위치를 누르면 scripts/start.js·stop.js 가 돈다.
 *
 *   running                    200 { ok: true, data: { healthy: true,  status: 'running', … } }
 *   stopped/starting/failed …  200 { ok: true, data: { healthy: false, status, … } }
 *   서비스 등록 안 됨           200 { ok: true, data: { healthy: false, status: 'not_installed', … } }
 *   서비스 컨트롤러 응답 없음   503 { ok: false, reason }
 *
 * 상태는 프로세스가 떠 있느냐가 아니라 서비스 컨트롤러가 아는 상태다 (neo-pkg-llm-chat 의 health 와 같은 형식).
 */
const path = require('path');
const process = require('process');
const service = require('service');
const ROOT = process.argv[1].slice(0, process.argv[1].lastIndexOf('/cgi-bin/') + '/cgi-bin'.length);
const cgi = require(path.join(ROOT, 'src', 'cgi.js'));

const SERVICE_NAME = 'neo-pkg-coin-collector-svc';
const RPC_TIMEOUT_MS = 3000;

function reply(code, body) {
    const text = JSON.stringify(body);
    process.stdout.write('Content-Type: application/json\r\n');
    process.stdout.write('Status: ' + code + '\r\n');
    process.stdout.write('Content-Length: ' + cgi.utf8Length(text) + '\r\n');   // 없으면 keep-alive 응답 경계가 틀어진다 (cgi.js)
    process.stdout.write('Cache-Control: no-store\r\n');
    process.stdout.write('\r\n');
    process.stdout.write(text);
}

try {
    service.status(SERVICE_NAME, { timeout: RPC_TIMEOUT_MS }, function (err, info) {
        if (err) {
            const msg = err.message || String(err);
            if (/not\s*found|does not exist/i.test(msg)) {
                reply(200, { ok: true, data: { healthy: false, status: 'not_installed', pid: 0, exit_code: null, error: msg } });
            } else {
                reply(503, { ok: false, reason: msg });
            }
            return;
        }
        const status = String((info && info.status) || 'unknown').toLowerCase();
        reply(200, { ok: true, data: {
            healthy: status === 'running',
            status: status,
            pid: (info && info.pid) || 0,
            exit_code: info && info.exit_code != null ? info.exit_code : null,
            error: (info && info.error) || '',
        } });
    });
} catch (e) {
    reply(500, { ok: false, reason: e && e.message ? e.message : String(e) });
}
