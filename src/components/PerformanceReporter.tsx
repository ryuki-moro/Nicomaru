'use client';

import { useReportWebVitals } from 'next/web-vitals';

import { screenPerformanceEvent } from '@/lib/observability/performance';

// ページ遷移後に報告されるLCP等も、計測開始時の画面へ紐づける。
let initialPathname: string | undefined;

function report(metric: { name: string; value: number }) {
  initialPathname ??= window.location.pathname;
  const event = screenPerformanceEvent(
    initialPathname,
    metric.name,
    metric.value,
    performance.timeOrigin,
  );
  if (event) console.info(JSON.stringify(event));
}

/** 外部収集基盤や新しい公開APIには送らず、ブラウザのアプリログに記録する。 */
export function PerformanceReporter() {
  if (typeof window !== 'undefined') initialPathname ??= window.location.pathname;
  useReportWebVitals(report);
  return null;
}
