/** 性能ログの経路名は固定値だけにする。URL・識別子・検索条件は保存しない。 */
const ROUTES = [
  '/api/admin/users',
  '/api/admin/users/[userId]',
  '/api/ai/jobs',
  '/api/ai/jobs/[jobId]',
  '/api/ai/status',
  '/api/auth/complete-invite',
  '/api/auth/initial-register',
  '/api/auth/otp-request',
  '/api/auth/otp-verify',
  '/api/auth/password-reset',
  '/api/auth/password-login',
  '/api/auth/password-update',
  '/api/cases',
  '/api/cases/[caseId]',
  '/api/cases/[caseId]/archive',
  '/api/cases/[caseId]/assign-tasks',
  '/api/cases/[caseId]/follow-logs',
  '/api/cases/[caseId]/invitations',
  '/api/cases/[caseId]/invitations/[invitationId]/send',
  '/api/cases/[caseId]/risk/recalculate',
  '/api/cases/[caseId]/tasks',
  '/api/cases/[caseId]/tasks/[taskId]',
  '/api/dashboard/follow-up-today',
  '/api/files/upload',
  '/api/files/[fileId]/download',
  '/api/health',
  '/api/internal/ai-job-reclaim',
  '/api/internal/case-purge',
  '/api/internal/notifications-dispatch',
  '/api/internal/rate-limit-cleanup',
  '/api/internal/risk-recalculate',
  '/api/internal/usage-rollup',
  '/api/internal/monitoring',
  '/api/internal/audit-log-purge',
  '/api/line/link',
  '/api/line/webhook',
  '/api/notifications',
  '/api/notifications/send',
  '/api/submissions/[submissionId]/defect-check',
  '/api/submissions/[submissionId]/review',
  '/api/system/notification-logs.csv',
  '/api/tasks/[taskId]/submit',
  '/api/venues',
  '/api/venues/[venueId]',
  '/',
  '/login',
  '/password',
  '/register/[token]',
  '/error',
  '/mypage',
  '/mypage/account',
  '/mypage/case',
  '/mypage/notifications',
  '/mypage/tasks',
  '/mypage/tasks/[taskId]',
  '/mypage/timeline',
  '/cases',
  '/cases/new',
  '/cases/[caseId]',
  '/cases/[caseId]/archive',
  '/cases/[caseId]/edit',
  '/cases/[caseId]/follow',
  '/cases/[caseId]/meeting-notes',
  '/cases/[caseId]/sheet',
  '/dashboard',
  '/notifications',
  '/plan-types',
  '/submissions',
  '/submissions/[submissionId]',
  '/system',
  '/templates',
  '/templates/[templateId]',
  '/users',
  '/users/new',
  '/users/[userId]',
  '/venues',
  '/venues/new',
  '/venues/[venueId]',
] as const;

// 静的な /new 等を動的IDより先に判定する。未知のパスも原文をログへ返さない。
const routePatterns = [...ROUTES]
  .sort((a, b) => Number(a.includes('[')) - Number(b.includes('[')))
  .map((name) => ({
    name,
    segments: name.split('/'),
  }));

export function performanceRouteName(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0];
  const parts = pathname.split('/');
  return (
    routePatterns.find(
      ({ segments }) =>
        segments.length === parts.length &&
        segments.every((segment, index) =>
          segment.startsWith('[') ? parts[index].length > 0 : segment === parts[index],
        ),
    )?.name ?? 'unknown'
  );
}

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface ApiPerformanceEvent {
  event: 'api_performance';
  route: string;
  method: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: number;
  failed: boolean;
}

/** ログ基盤が使えなくても業務APIの結果を変えない。 */
export function recordApiPerformance(
  request: Request,
  startedAt: number,
  startedMono: number,
  status: number,
): void {
  try {
    const event: ApiPerformanceEvent = {
      event: 'api_performance',
      route: performanceRouteName(new URL(request.url).pathname),
      method: METHODS.includes(request.method) ? request.method : 'OTHER',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(Math.max(0, performance.now() - startedMono) * 100) / 100,
      status,
      failed: status >= 400,
    };
    console.info(JSON.stringify(event));
  } catch {
    // 性能情報は補助情報。ログ出力の失敗から認証・業務処理を再実行しない。
  }
}

const WEB_VITALS = ['FCP', 'LCP', 'TTFB', 'INP', 'CLS'] as const;

/** Metric の id/entries/attribution はDOMやURLを含み得るため受け取らない。 */
export function screenPerformanceEvent(
  pathname: string,
  name: string,
  value: number,
  timeOrigin: number,
) {
  if (
    !WEB_VITALS.some((allowed) => allowed === name) ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isFinite(timeOrigin) ||
    timeOrigin < 0 ||
    timeOrigin > 8.64e15
  )
    return null;
  return {
    event: 'screen_performance',
    route: performanceRouteName(pathname),
    metric: name,
    value: Math.round(value * 1000) / 1000,
    unit: name === 'CLS' ? 'score' : 'ms',
    startedAt: new Date(timeOrigin).toISOString(),
    observedAt: new Date().toISOString(),
  };
}
