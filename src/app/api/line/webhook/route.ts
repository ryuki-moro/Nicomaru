/**
 * POST /api/line/webhook — LINE Webhook 受信（表6-6、機能1-3、Phase 2）。
 *
 * 正本: 基本設計書 Version 1.2 6-10「LINE連携設計」。
 *
 *   認証: 署名検証必須（ユーザー認証なし）
 *   「署名検証は x-line-signature を raw body に対して行い、定数時間比較する。
 *     受信イベントは webhookEventId を保存して重複配信を捨てる（LINE は再送を行う）」
 *   「受信内容は必要最小限のみ communication_logs に保存する」
 *
 * 【返す値について】
 * 署名が合わない場合だけ 401 を返し、それ以外は処理の成否によらず 200 を返す。
 * LINE は 2xx 以外を受け取ると再送するため、こちらの都合（DB の一時的な失敗など）で
 * 非 2xx を返すと同じイベントが延々と届く。取りこぼしは event_id の記録で検出できる。
 */
import { NextResponse } from 'next/server';

import {
  hashLinkNonce,
  issueLinkToken,
  buildFollowReply,
  replyLineMessage,
  verifyLineSignature,
  type LineEvent,
} from '@/lib/notify/line';
import { appBaseUrl } from '@/lib/notify/mailer';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  // 署名検証はパース前の生データに対して行う（6-10）。
  // JSON.parse を通した後の値から再構築すると、キーの順序や空白が変わって必ず落ちる。
  const rawBody = await request.text();
  if (!verifyLineSignature(rawBody, request.headers.get('x-line-signature'))) {
    return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
  }

  let events: LineEvent[] = [];
  try {
    events = ((JSON.parse(rawBody) as { events?: LineEvent[] }).events ?? []);
  } catch {
    // 署名は通っているので LINE からの正規のリクエスト。形が読めないだけなら再送させない
    return NextResponse.json({ ok: true });
  }

  const admin = createSupabaseAdminClient('line.webhook');

  for (const event of events) {
    try {
      await handleEvent(admin, event);
    } catch (error) {
      // 1件の失敗で残りを止めない。非 2xx を返すと全イベントが再送される
      console.error('[line] event handling failed', event.type, error);
    }
  }

  return NextResponse.json({ ok: true });
}

type Admin = ReturnType<typeof createSupabaseAdminClient>;

async function handleEvent(admin: Admin, event: LineEvent): Promise<void> {
  // 重複配信の排除（6-10）。event_id の一意性がそのまま冪等性になる。
  if (event.webhookEventId) {
    const seen = await admin
      .from('line_webhook_events')
      .insert({ event_id: event.webhookEventId, event_type: event.type })
      .select('event_id');
    // 23505 = 既に処理済み
    if (seen.error?.code === '23505') return;
  }

  const lineUserId = event.source?.userId;

  if (event.type === 'follow' && lineUserId && event.replyToken) {
    // 手順(2): linkToken を発行して連携用URLを返す。
    // ここで案件や利用者を推測して結び付けない（6-10 が明示的に禁じている）。
    const linkToken = await issueLinkToken(lineUserId);
    if (linkToken) {
      const url = `${appBaseUrl()}/mypage/account?linkToken=${encodeURIComponent(linkToken)}`;
      await replyLineMessage(event.replyToken, buildFollowReply(url));
    }
    return;
  }

  if (event.type === 'accountLink' && lineUserId && event.link) {
    // 手順(4): nonce と一致した利用者にだけ line_user_id を保存する。
    // 一致判定と消費は complete_line_link() が1文で行う。
    if (event.link.result !== 'ok') return;

    const userId = await admin.rpc('complete_line_link', {
      p_nonce_hash: hashLinkNonce(event.link.nonce),
      p_line_user_id: lineUserId,
    });
    if (userId.error || !userId.data) {
      console.warn('[line] accountLink: nonce が一致しませんでした');
      return;
    }

    // 受信内容は必要最小限のみ残す（6-10）。本文やLINEのプロフィールは保存しない。
    const profile = await admin
      .from('couple_profiles')
      .select('case_id')
      .eq('user_profile_id', userId.data as string)
      .maybeSingle();
    const caseId = (profile.data as { case_id: string } | null)?.case_id;
    if (caseId) {
      await admin.from('communication_logs').insert({
        case_id: caseId,
        channel: 'line',
        direction: 'inbound',
        source: 'line_account_link',
        summary: '公式LINEとの連携が完了しました',
        occurred_at: new Date().toISOString(),
      });
    }
    return;
  }

  if (event.type === 'unfollow' && lineUserId) {
    // ブロックされた相手へ送り続けるとLINE側の評価を落とす。紐付けを外してメールへ戻す（6-9）。
    await admin.from('user_profiles').update({ line_user_id: null })
      .eq('line_user_id', lineUserId);
    return;
  }

  // message 等は Phase 2 の範囲外（6-10「Webhookを利用する場合の受信は必要最小限」）。
  // 返信管理は第13章の合意論点であり、勝手に応答しない。
}
