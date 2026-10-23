/**
 * ローカル Supabase の受信箱（Mailpit）からワンタイムコードとログインリンクを取り出す。
 * 本番のメール経路（Custom SMTP）は再現しない。ローカルスタックが
 * 送ったメールが Mailpit に溜まるので、その API を読むだけ。
 */
import { e2eEnv } from './env';

interface MailpitSearchResponse {
  messages?: { ID: string; Created: string; Subject?: string }[];
}

interface MailpitMessage {
  Text?: string;
  HTML?: string;
  Subject?: string;
}

/** ワンタイム認証メールの中身 */
export interface OtpMail {
  /** 本文の6桁コード */
  code: string;
  /**
   * 本文の a 要素の href。HTML の文字参照（`&amp;` など）はブラウザと同じく元の文字に戻す。
   * Supabase がテンプレートをどう描画したか（戻り先・フラグメント）を検査するために使う。
   */
  links: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** href 属性値の文字参照を戻す（a 要素をブラウザが解釈したときと同じ文字列にする） */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? '';
  });
}

/**
 * `email` 宛てで `after` より後に届いた、いちばん新しいワンタイム認証メールを返す。
 * 届くまで最長 timeoutMs 待つ。
 */
export async function waitForOtpMail(
  email: string,
  options: { after: Date; timeoutMs?: number },
): Promise<OtpMail> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const query = encodeURIComponent(`to:${email}`);

  while (Date.now() < deadline) {
    const search = await getJson<MailpitSearchResponse>(
      `${e2eEnv.mailUrl}/api/v1/search?query=${query}&limit=10`,
    );
    const fresh = (search.messages ?? [])
      .filter((m) => new Date(m.Created).getTime() >= options.after.getTime() - 1000)
      .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime());

    for (const message of fresh) {
      const body = await getJson<MailpitMessage>(`${e2eEnv.mailUrl}/api/v1/message/${message.ID}`);
      const html = body.HTML ?? '';
      const text = `${body.Text ?? ''}\n${html.replace(/<[^>]+>/g, ' ')}`;
      const match = text.match(/\b(\d{6})\b/);
      if (match) {
        const links = [...html.matchAll(/href="([^"]*)"/g)].map((m) => decodeAttribute(m[1]));
        return { code: match[1], links };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `${email} 宛てのワンタイムコードが ${e2eEnv.mailUrl} に届かなかった。` +
      'supabase/config.toml の [auth.email.template.magic_link] が {{ .Token }} を含むか確認する',
  );
}

/**
 * `email` 宛てで `after` より後に届いたメールから6桁のコードを返す。
 * 届くまで最長 timeoutMs 待つ。
 */
export async function waitForOtpCode(
  email: string,
  options: { after: Date; timeoutMs?: number },
): Promise<string> {
  return (await waitForOtpMail(email, options)).code;
}
