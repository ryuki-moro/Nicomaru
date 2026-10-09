/** 認証本体が完了した後に、監査通信だけで画面を待たせ続けない。 */
const AUDIT_TIMEOUT_MS = 2_000;

interface AuditQuery {
  abortSignal(signal: AbortSignal): PromiseLike<{ error: unknown }>;
}

export async function awaitAudit(query: AuditQuery): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Audit deadline exceeded'));
    }, AUDIT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([query.abortSignal(controller.signal), timeout]);
    if (result.error) throw new Error('Audit unavailable');
  } finally {
    clearTimeout(timer);
  }
}
