/**
 * ローカル Supabase の受信箱（Mailpit）からワンタイムコードを取り出す。
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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/**
 * `email` 宛てで `after` より後に届いたメールから6桁のコードを返す。
 * 届くまで最長 timeoutMs 待つ。
 */
export async function waitForOtpCode(
  email: string,
  options: { after: Date; timeoutMs?: number },
): Promise<string> {
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
      const text = `${body.Text ?? ''}\n${(body.HTML ?? '').replace(/<[^>]+>/g, ' ')}`;
      const match = text.match(/\b(\d{6})\b/);
      if (match) return match[1];
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `${email} 宛てのワンタイムコードが ${e2eEnv.mailUrl} に届かなかった。` +
      'supabase/config.toml の [auth.email.template.magic_link] が {{ .Token }} を含むか確認する',
  );
}
