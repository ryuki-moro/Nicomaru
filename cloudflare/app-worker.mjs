// 本番Workerの入口。OpenNextの束ね（esbuild）は cloudflare:sockets を解決できないため、
// SMTP送信の worker-mailer はwranglerが束ねるこの入口で読み込み、Next側（notify/mailer.ts）へ渡す。
import * as workerMailer from 'worker-mailer';
import handler from '../.open-next/worker.js';

globalThis.__workerMailer = workerMailer;

export * from '../.open-next/worker.js';
export default handler;
