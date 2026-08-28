/**
 * AIジョブの進行をクライアント側で追う（Phase 3、機能9-1〜9-5）。
 *
 * 正本: 基本設計書 7-3。
 *
 *   「推論はバックグラウンドの非同期処理とし、画面操作をブロックしない。
 *     生成結果の目安は数分以内（画面応答性能には含めない）」
 *
 * 依頼した直後に結果を待たせない代わりに、開いている間だけ様子を見に行く。
 * 画面を閉じても処理は続き、次に開いたときにサーバー側の状態がそのまま出る。
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AiJobStatus } from '@/lib/ai/assist';
import { api } from '@/lib/api/client';

export interface AiJobView {
  id: string;
  status: AiJobStatus;
  output: unknown;
  reviewed_output: unknown;
  error_message: string | null;
}

const POLL_INTERVAL_MS = 5_000;
/**
 * 打ち切りまでの回数。5秒 × 48 = 4分。
 * 7-3 の「目安は数分以内」を超えたら、待ち続けるより開き直してもらったほうがよい。
 * 打ち切っても処理は続いているので、結果が消えるわけではない。
 */
const MAX_POLLS = 48;

function isPending(status: AiJobStatus): boolean {
  return status === 'queued' || status === 'processing';
}

export function useAiJob(initial: AiJobView | null) {
  const [job, setJob] = useState<AiJobView | null>(initial);
  const [timedOut, setTimedOut] = useState(false);
  const polls = useRef(0);

  // 依存は id と status だけにする。job そのものを見ると、
  // 取得のたびに新しいオブジェクトが入って interval を張り直すことになる。
  const jobId = job?.id;
  const status = job?.status;

  useEffect(() => {
    if (!jobId || !status || !isPending(status)) return undefined;

    let cancelled = false;
    const timer = setInterval(async () => {
      if (polls.current >= MAX_POLLS) {
        clearInterval(timer);
        setTimedOut(true);
        return;
      }
      polls.current += 1;
      try {
        const next = await api.get<AiJobView>(`/api/ai/jobs/${jobId}`);
        if (!cancelled) setJob(next);
      } catch {
        // 一時的な通信断で表示を壊さない。次の周期で取り直す。
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, status]);

  /** 新しく依頼したジョブに差し替える。打ち切りカウンタも戻す。 */
  const track = useCallback((next: AiJobView) => {
    polls.current = 0;
    setTimedOut(false);
    setJob(next);
  }, []);

  return { job, track, setJob, timedOut };
}
