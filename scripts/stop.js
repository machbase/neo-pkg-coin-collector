'use strict';

// 수집 서비스를 멈춘다. 컨트롤러가 SIGKILL 로 죽이므로 종료 훅은 돌지 않는다 —
// 아직 append 안 된 체결(최대 1초치)은 잃는다.
// 앱스토어 업데이트는 stop → 덮어쓰기 → install → start 순서다.
const process = require('process');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-coin-collector-svc';

service.status(SERVICE_NAME, function (missing, info) {
    const st = String((info && info.status) || '').toLowerCase();
    if (missing || (st !== 'running' && st !== 'starting')) { console.println('service not running:', SERVICE_NAME); return; }
    console.println('stopping service:', SERVICE_NAME);
    service.stop(SERVICE_NAME, function (err) {
        if (err) { console.println('ERROR:', err.message); process.exit(1); }
        console.println('service stopped.');
    });
});
