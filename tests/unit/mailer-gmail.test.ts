import { sendMail } from '@/lib/notify/mailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
  fetch: vi.fn(),
}));
const message = { to: 'couple@example.test', subject: '件名', text: '本文' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('__workerMailer', {
    WorkerMailer: { connect: mocks.connect },
    LogLevel: { NONE: 4 },
  });
  mocks.connect.mockResolvedValue({ send: mocks.send, close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('GMAIL_USER', 'sender@gmail.example');
  vi.stubEnv('GMAIL_APP_PASSWORD', 'app-password');
  vi.stubEnv('RESEND_API_KEY', 're_test');
  vi.stubEnv('RESEND_FROM', 'noreply@example.test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe('Gmail SMTP での送信', () => {
  it('設定が揃えば Resend より先に smtp.gmail.com:465 から送る', async () => {
    mocks.send.mockResolvedValue(undefined);
    expect(await sendMail(message)).toEqual({ delivered: true, providerMessageId: null });
    expect(mocks.fetch).not.toHaveBeenCalled();
    const [options] = mocks.connect.mock.calls[0];
    const [email] = mocks.send.mock.calls[0];
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(options).toMatchObject({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      credentials: { username: 'sender@gmail.example', password: 'app-password' },
      logLevel: 4,
    });
    expect(email).toEqual({
      from: { name: 'Bellink', email: 'sender@gmail.example' },
      to: 'couple@example.test',
      subject: '件名',
      text: '本文',
    });
  });
  it('送信の例外は投げずに provider_error として返し、接続を閉じる', async () => {
    mocks.send.mockRejectedValue(new Error('550 recipient rejected'));
    expect(await sendMail(message)).toMatchObject({ delivered: false, reason: 'provider_error' });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('接続の失敗も provider_error として返す', async () => {
    mocks.connect.mockRejectedValue(new Error('535 auth failed'));
    expect(await sendMail(message)).toMatchObject({ delivered: false, reason: 'provider_error' });
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('Workerの入口を通っていなければ送らずに provider_error を返す', async () => {
    vi.stubGlobal('__workerMailer', undefined);
    expect(await sendMail(message)).toMatchObject({ delivered: false, reason: 'provider_error' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('アプリパスワードが無ければ従来どおり Resend へ送る', async () => {
    vi.stubEnv('GMAIL_APP_PASSWORD', '');
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'r1' })));
    expect(await sendMail(message)).toEqual({ delivered: true, providerMessageId: 'r1' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
