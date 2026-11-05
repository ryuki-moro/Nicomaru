import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// 全画面が動的描画のため、増分キャッシュ用のR2は使わない。
export default defineCloudflareConfig({});
