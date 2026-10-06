'use strict';

// 수집 서비스를 시작한다. 이미 돌고 있으면 아무것도 하지 않는다 — "starting" 중에 start 를
// 한 번 더 부르면 컨트롤러가 수집기를 하나 더 띄운다 (v8.5.13 실측).
const process = require('process');
const service = require('service');

const SERVICE_NAME = 'neo-pkg-coin-collector-svc';

service.status(SERVICE_NAME, function (statusErr, info) {
    if (statusErr) {
        console.println('ERROR: service not installed:', SERVICE_NAME, '— run the install script first.');
        process.exit(1);
    }
    const st = String((info && info.status) || '').toLowerCase();
    if (st === 'running' || st === 'starting') {
        console.println('service already ' + st + ':', SERVICE_NAME);
        return;
    }
    console.println('starting service:', SERVICE_NAME);
    service.start(SERVICE_NAME, function (err) {
        if (err) {
            console.println('ERROR:', err.message);
            process.exit(1);
        }
        console.println('service started.');
    });
});
