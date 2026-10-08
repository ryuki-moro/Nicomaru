import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, ApiCallError, handleApiError } from '@/lib/api/client';

const COMMUNICATION_ERROR_MESSAGE = '通信に失敗しました。時間をおいてお試しください';

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: string | null) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function responseError(status: number, body: string): Promise<ApiCallError> {
  respond(status, body);
  try {
    await api.get('/api/example');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiCallError);
    return error as ApiCallError;
  }
  throw new Error('エラーレスポンスが成功として返されました');
}

function errorHandlers() {
  return {
    router: { push: vi.fn() },
    handlers: { onSummary: vi.fn(), onFieldErrors: vi.fn() },
  };
}

describe('api の正常応答と通信例外', () => {
  it('JSON を返し、GET には本文と content-type を付けない', async () => {
    const fetchMock = respond(200, '{"id":"example"}');

    await expect(api.get('/api/example')).resolves.toEqual({ id: 'example' });
    expect(fetchMock).toHaveBeenCalledWith('/api/example', {
      method: 'GET', headers: undefined, body: undefined,
    });
  });

  it.each(['post', 'patch', 'del'] as const)('%s は指定本文を JSON で送る', async (method) => {
    const fetchMock = respond(200, '{}');

    await api[method]('/api/example', { title: '宿題' });
    expect(fetchMock).toHaveBeenCalledWith('/api/example', {
      method: method === 'del' ? 'DELETE' : method.toUpperCase(),
      headers: { 'content-type': 'application/json' },
      body: '{"title":"宿題"}',
    });
  });

  it.each(['post', 'patch'] as const)('%s の省略本文は空の JSON オブジェクト', async (method) => {
    const fetchMock = respond(200, '{}');

    await api[method]('/api/example');
    expect(fetchMock).toHaveBeenCalledWith('/api/example', {
      method: method.toUpperCase(),
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  });

  it('DELETE の省略本文は送信しない', async () => {
    const fetchMock = respond(200, '{}');

    await api.del('/api/example');
    expect(fetchMock).toHaveBeenCalledWith('/api/example', {
      method: 'DELETE', headers: undefined, body: undefined,
    });
  });

  it('204 は本文を読まず undefined を返す', async () => {
    const response = new Response(null, { status: 204 });
    const readBody = vi.spyOn(response, 'text');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(api.del('/api/example')).resolves.toBeUndefined();
    expect(readBody).not.toHaveBeenCalled();
  });

  it('204 以外の正常な空本文は既存どおり空オブジェクトを返す', async () => {
    respond(200, '');
    await expect(api.get('/api/example')).resolves.toEqual({});
  });

  it('正常ステータスでも壊れた JSON は成功として返さない', async () => {
    respond(200, '<html>Unexpected response</html>');
    await expect(api.get('/api/example')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('ネットワーク例外を維持し、一般例外の表示へ渡せる', async () => {
    const networkError = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkError));

    await expect(api.get('/api/example')).rejects.toBe(networkError);
    const { router, handlers } = errorHandlers();
    expect(handleApiError(networkError, router, handlers)).toBe(false);
    expect(handlers.onSummary).toHaveBeenCalledWith(COMMUNICATION_ERROR_MESSAGE);
    expect(handlers.onFieldErrors).toHaveBeenCalledWith({});
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('非OK応答の正規化', () => {
  it('503の一時障害コードを維持し、再操作の案内を画面に表示する', async () => {
    const message = '認証サービスに接続できませんでした。時間をおいて再度お試しください';
    const error = await responseError(503, JSON.stringify({ error: {
      code: 'SERVICE_UNAVAILABLE', message, details: [],
    } }));
    expect(error.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(error.status).toBe(503);
    const { router, handlers } = errorHandlers();
    expect(handleApiError(error, router, handlers)).toBe(false);
    expect(handlers.onSummary).toHaveBeenCalledWith(message);
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([
    '', '<html>Server error</html>', '{broken', 'null', '[]', '{}',
    '{"error":null}', '{"error":"unexpected"}', '{"error":{}}',
    '{"error":{"message":42}}', '{"error":{"message":"   "}}',
  ])('不正な本文でも status と共通メッセージを持つ (%s)', async (body) => {
    const error = await responseError(500, body);

    expect(error.status).toBe(500);
    expect(error.name).toBe('ApiCallError');
    expect(error.message).toBe(COMMUNICATION_ERROR_MESSAGE);
    expect(error.body).toEqual({
      code: 'INTERNAL_ERROR', message: COMMUNICATION_ERROR_MESSAGE, details: [],
    });
    expect(error.fieldErrors).toEqual({});
  });

  it.each([400, 422])('正規エラーの code・message・項目文言を維持する (%i)', async (status) => {
    const body = {
      code: status === 400 ? 'VALIDATION_ERROR' : 'UNPROCESSABLE',
      message: '入力内容を確認してください',
      details: [
        { field: 'title', reason: '宿題名を入力してください' },
        { field: 'title', reason: '後の文言は採用しない' },
        { field: 'dueDate', reason: '期限を入力してください' },
      ],
    };
    const error = await responseError(status, JSON.stringify({ error: body }));

    expect(error.status).toBe(status);
    expect(error.body).toEqual(body);
    expect(error.fieldErrors).toEqual({
      title: '宿題名を入力してください', dueDate: '期限を入力してください',
    });
  });

  it.each([undefined, null, false, 'invalid', {}])('配列ではない details を空にする (%s)', async (details) => {
    const error = await responseError(400, JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message: '入力エラー', details },
    }));

    expect(error.message).toBe('入力エラー');
    expect(error.body.details).toEqual([]);
    expect(error.fieldErrors).toEqual({});
  });

  it('details の不正な要素だけを除去する', async () => {
    const valid = { field: 'title', reason: '必須です' };
    const error = await responseError(422, JSON.stringify({ error: {
      code: 'UNPROCESSABLE', message: '入力エラー',
      details: [null, false, 'invalid', [], {}, { field: 'title' },
        { field: 1, reason: 'invalid' }, { field: 'title', reason: null }, valid],
    } }));

    expect(error.body.details).toEqual([valid]);
    const { router, handlers } = errorHandlers();
    expect(handleApiError(error, router, handlers)).toBe(false);
    expect(handlers.onFieldErrors).toHaveBeenCalledWith({ title: '必須です' });
  });

  it('不正な code でも正規の message と details を維持する', async () => {
    const error = await responseError(409, JSON.stringify({ error: {
      code: 'unexpected', message: '競合しました',
      details: [{ field: 'title', reason: '更新済みです' }],
    } }));

    expect(error.body.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('競合しました');
    expect(error.fieldErrors).toEqual({ title: '更新済みです' });
  });

  it('手動で構築した ApiCallError も不正な details で落ちない', () => {
    const error = new ApiCallError({ message: 'ファイルを送信できませんでした', details: {} }, 500);
    expect(error.message).toBe('ファイルを送信できませんでした');
    expect(error.fieldErrors).toEqual({});
  });

  it('継承プロパティと同名の項目も先頭文言を保持し、prototype を変えない', () => {
    const fields = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const error = new ApiCallError({
      code: 'VALIDATION_ERROR', message: '入力エラー',
      details: fields.flatMap((field) => [
        { field, reason: '先頭のエラー' }, { field, reason: '後のエラー' },
      ]),
    }, 400);
    const fieldErrors = error.fieldErrors;

    expect(Object.getPrototypeOf(fieldErrors)).toBe(Object.prototype);
    expect(Object.keys(fieldErrors)).toEqual(fields);
    for (const field of fields) {
      expect(Object.hasOwn(fieldErrors, field)).toBe(true);
      expect(fieldErrors[field]).toBe('先頭のエラー');
    }
  });
});

describe('handleApiError の分岐', () => {
  it('401 は元の画面を next に付けてログインへ遷移する', async () => {
    vi.stubGlobal('window', { location: { pathname: '/cases/example' } });
    const error = await responseError(401, '<html>Unauthorized</html>');
    const { router, handlers } = errorHandlers();

    expect(handleApiError(error, router, handlers)).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/login?next=%2Fcases%2Fexample');
    expect(handlers.onSummary).not.toHaveBeenCalled();
    expect(handlers.onFieldErrors).not.toHaveBeenCalled();
  });

  it('window がない場合の 401 はログインへ遷移する', () => {
    vi.stubGlobal('window', undefined);
    const { router, handlers } = errorHandlers();

    expect(handleApiError(new ApiCallError(null, 401), router, handlers)).toBe(true);
    expect(router.push).toHaveBeenCalledWith('/login');
    expect(handlers.onSummary).not.toHaveBeenCalled();
    expect(handlers.onFieldErrors).not.toHaveBeenCalled();
  });

  it.each([403, 404])('不正な本文でも P04 へ遷移する (%i)', async (status) => {
    const error = await responseError(status, status === 403 ? '<html>Forbidden</html>' : 'null');
    const { router, handlers } = errorHandlers();

    expect(handleApiError(error, router, handlers)).toBe(true);
    expect(router.push).toHaveBeenCalledWith(`/error?code=${status}`);
    expect(handlers.onSummary).not.toHaveBeenCalled();
    expect(handlers.onFieldErrors).not.toHaveBeenCalled();
  });

  it.each([400, 422, 409, 500])('通常エラーは文言と項目エラーを表示する (%i)', (status) => {
    const error = new ApiCallError({
      code: 'VALIDATION_ERROR', message: '入力内容を確認してください',
      details: [{ field: 'title', reason: '必須です' }],
    }, status);
    const { router, handlers } = errorHandlers();

    expect(handleApiError(error, router, handlers)).toBe(false);
    expect(handlers.onSummary).toHaveBeenCalledWith('入力内容を確認してください');
    expect(handlers.onFieldErrors).toHaveBeenCalledWith({ title: '必須です' });
    expect(router.push).not.toHaveBeenCalled();
  });

  it.each([new Error('unexpected'), null, undefined, 'unexpected'])('一般例外は共通文言で項目エラーを消す (%s)', (error) => {
    const { router, handlers } = errorHandlers();

    expect(handleApiError(error, router, handlers)).toBe(false);
    expect(handlers.onSummary).toHaveBeenCalledWith(COMMUNICATION_ERROR_MESSAGE);
    expect(handlers.onFieldErrors).toHaveBeenCalledWith({});
    expect(router.push).not.toHaveBeenCalled();
  });

  it('項目エラーハンドラが省略されても処理できる', () => {
    const { router, handlers } = errorHandlers();
    const summaryOnly = { onSummary: handlers.onSummary };

    expect(handleApiError(new ApiCallError(null, 500), router, summaryOnly)).toBe(false);
    expect(handleApiError(new Error('unexpected'), router, summaryOnly)).toBe(false);
    expect(handlers.onSummary).toHaveBeenCalledTimes(2);
  });
});
