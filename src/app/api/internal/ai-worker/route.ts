/**
 * POST /api/internal/ai-worker — ローカルLLMワーカー専用の窓口（D1版、基本設計 7-3）。
 *
 * Supabase版はワーカー専用DBロール（ai_worker）に3つのRPCだけを許していた。
 * D1には外部から握れるDB接続もロールも無いため、同じ3操作（心拍・取得・書込み）だけを
 * 共有トークン（AI_WORKER_TOKEN）で守ったこのAPIに寄せる。向きはワーカー→アプリのプル型のまま。
 */
import { z } from 'zod';

import { ok, parseBody, route } from '@/lib/api/route';
import { workerClaim, workerComplete, workerPing } from '@/lib/d1/ai';
import { localDB, usingD1 } from '@/lib/d1/runtime';
import { notFound } from '@/lib/errors';

const worker = z.string().min(1).max(80);
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('ping'), worker, model: z.string().max(80).nullish() }),
  z.object({ action: z.literal('claim'), worker, jobTypes: z.array(z.string()).max(20) }),
  z.object({
    action: z.literal('complete'),
    worker,
    id: z.string().min(1).max(64),
    output: z.unknown().optional(),
    error: z.string().min(1).max(4000).nullish(),
    model: z.string().max(80).nullish(),
  }),
]);

export const POST = route(
  async (request: Request) => {
    if (!usingD1()) throw notFound();
    const body = await parseBody(request, bodySchema);
    const db = await localDB();
    switch (body.action) {
      case 'ping':
        await workerPing(db, body.worker, body.model ?? null);
        return ok({ ok: true });
      case 'claim':
        return ok({ job: await workerClaim(db, body.worker, body.jobTypes) });
      case 'complete':
        return ok({ updated: await workerComplete(db, body.worker, body) });
    }
  },
  { source: 'ai-worker' },
);
