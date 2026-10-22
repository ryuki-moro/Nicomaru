/** 架空の人物・提出内容のみ。日時は起動した日の日本時間を基準にする。 */
export const STORAGE_KEY = 'nicomaru-login-free-demo-v1';
export const VERSION = 1;
export const PLANS = ['少人数婚', '家族婚', 'フォト婚', '一般挙式'];
export const STATUS_LABELS = {
  not_started: '未着手',
  submitted: '提出済',
  needs_fix: '不備あり',
  confirmed: '確認済',
};

export function todayJst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function defaultTasks(weddingDate) {
  return [
    {
      id: 'guests',
      title: 'ゲストリスト提出',
      days: -90,
      important: true,
      description: 'ゲストの人数と内訳を教えてください。デモではテキストで入力できます。',
      type: 'text',
    },
    {
      id: 'seating',
      title: '席次表の確認',
      days: -45,
      important: true,
      description: 'ご家族・ご友人のお席のご希望を教えてください。',
      type: 'text',
    },
    {
      id: 'bgm',
      title: 'BGMリクエスト',
      days: -60,
      important: false,
      description: '入場・歓談・退場の曲名や、ご希望の雰囲気を教えてください。',
      type: 'text',
    },
    {
      id: 'meal',
      title: '料理コースの選択',
      days: -30,
      important: true,
      description: 'ご希望の料理コースをお選びください。',
      type: 'select',
      options: ['スタンダード', 'グレードアップ', 'シェフのおまかせ'],
    },
    {
      id: 'gift',
      title: '引き出物の選択',
      days: -30,
      important: false,
      description: 'ゲストへお渡しする引き出物をお選びください。',
      type: 'select',
      options: ['カタログギフトA', 'カタログギフトB', '食器セット'],
    },
  ].map(({ days, ...task }) => ({
    ...task,
    dueDate: shiftDate(weddingDate, days),
    status: 'not_started',
    answer: '',
    feedback: '',
  }));
}

export function seedData(now = new Date()) {
  const today = todayJst(now);
  const scenarios = [
    ['青木 翔太', '青木 美咲', 25, '少人数婚', 18, '期限の過ぎた宿題を一緒に確認しましょう。'],
    ['石井 健太', '石井 結衣', 70, '家族婚', 24, 'BGMの希望をもう少し詳しく相談します。'],
    ['上田 大輔', '上田 彩', 45, '少人数婚', 12, 'お料理と引き出物の提出内容を確認します。'],
    ['岡田 拓也', '岡田 真由', 120, '一般挙式', 80, '準備は順調です。次回は会場装花を相談します。'],
    ['小川 悠人', '小川 さくら', 150, 'フォト婚', 2, '衣装と撮影のイメージを相談しましょう。'],
  ];
  const cases = scenarios.map(([groom, bride, days, plan, guestCount, notes], index) => {
    const weddingDate = shiftDate(today, days);
    return {
      id: `demo-0${index + 1}`,
      code: `BRIDAL01-000${index + 1}`,
      groom,
      bride,
      weddingDate,
      plan,
      guestCount,
      notes,
      tasks: defaultTasks(weddingDate),
    };
  });
  const set = (index, id, status, answer, feedback = '') => {
    Object.assign(
      cases[index].tasks.find((task) => task.id === id),
      { status, answer, feedback },
    );
  };
  set(0, 'meal', 'confirmed', 'スタンダード');
  set(0, 'bgm', 'submitted', '入場：明るいピアノ曲\n歓談：ボサノバ\n退場：アップテンポな曲');
  set(1, 'guests', 'confirmed', 'ご家族12名、ご友人12名、合計24名です。');
  set(
    1,
    'bgm',
    'needs_fix',
    '入場：おまかせ',
    '入場・歓談・退場それぞれの雰囲気を教えてください。',
  );
  set(1, 'meal', 'submitted', 'グレードアップ');
  set(1, 'gift', 'confirmed', 'カタログギフトA');
  set(2, 'guests', 'confirmed', 'ご家族12名です。');
  set(2, 'meal', 'submitted', 'シェフのおまかせ');
  set(2, 'gift', 'submitted', '食器セット');
  for (const task of cases[3].tasks) {
    task.status = 'confirmed';
    task.answer = task.type === 'select' ? task.options[1] : '内容を打ち合わせで確認しました。';
  }
  return { version: VERSION, cases, activity: [] };
}
