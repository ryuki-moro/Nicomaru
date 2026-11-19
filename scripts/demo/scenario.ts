/**
 * デモ・テスト用の模擬データ（Issue #24）。
 *
 * ここに書いた人物・メールアドレス・提出内容はすべて架空のもの。実在の新郎新婦の情報は入れない。
 * メールアドレスは予約TLD `.test` を使うので、誤って送信しても外部へは届かない。
 *
 * 挙式日は「実行した日（日本時間）から何日後」で持つ。発表の前日に作り直しても、
 * 画面に出る状況（期限切れ・確認待ち・不備あり…）が毎回同じになるようにするため。
 *
 */

/** seed.sql の式場（BRIDAL01）。デモの案件はすべてここに作る */
export const DEMO_VENUE_ID = '11111111-1111-4111-8111-111111111111';

/** seed.sql のプラン種別 */
export const DEMO_PLAN_TYPES = {
  少人数婚: '21111111-1111-4111-8111-111111111111',
  家族婚: '21111111-1111-4111-8111-111111111112',
  フォト婚: '21111111-1111-4111-8111-111111111113',
  一般挙式: '21111111-1111-4111-8111-111111111114',
} as const;

/** 提出に使う宿題テンプレート（text／select と、添付を用意した file） */
export const DEMO_TEMPLATES = {
  ゲストリスト提出: '31111111-1111-4111-8111-111111111101',
  BGMリクエスト: '31111111-1111-4111-8111-111111111103',
  料理コースの選択: '31111111-1111-4111-8111-111111111104',
  引き出物の選択: '31111111-1111-4111-8111-111111111105',
} as const;

export type DemoTemplateName = keyof typeof DEMO_TEMPLATES;

/**
 * 案件を見分ける目印。wedding_cases.notes の先頭に入れる。
 * 作り直し（--reset）のときは、この目印が付いた案件だけを消す。
 */
export const DEMO_NOTE_PREFIX = '[demo:';

export function demoNote(key: string, text: string): string {
  return `${DEMO_NOTE_PREFIX}${key}] ${text}`;
}

export interface DemoPlanner {
  email: string;
  displayName: string;
}

/** デモで使うプランナー。パスワードはスクリプト側で決める（ローカルは固定値、共有デモは環境変数） */
export const DEMO_PLANNER: DemoPlanner = {
  email: 'planner@nicomaru.test',
  displayName: '佐藤 花子',
};

export interface DemoSubmission {
  template: DemoTemplateName;
  /** 提出後にプランナーがどう扱うか。submitted は「確認待ち」のまま残す */
  result: 'submitted' | 'needs_fix' | 'confirmed';
  /** text 形式の回答 */
  text?: string;
  /** select 形式の回答（seed.sql の選択肢から選ぶ） */
  selected?: string;
  /** file 形式の添付（リポジトリ内のパス）。提出済みの添付として R2 に置く */
  file?: string;
  /** 不備ありのときの指摘（必須） */
  feedback?: string;
}

export interface DemoPartner {
  name: string;
  email: string;
  /** true なら招待URLから初回登録を済ませた状態にする */
  registered: boolean;
}

export interface DemoCase {
  key: string;
  /** 画面で何を見せるための案件か（README と発表台本で使う） */
  purpose: string;
  daysUntilWedding: number;
  planType: keyof typeof DEMO_PLAN_TYPES;
  guestCount: number;
  primaryContact: 'groom' | 'bride';
  groom: DemoPartner;
  bride: DemoPartner;
  submissions: DemoSubmission[];
}

/**
 * デモの案件。上から「危ない順」に並べている。
 *
 * どれも宿題の期限は seed.sql のテンプレートから逆算されるので、
 * 挙式が近い案件ほど自然に「期限切れの宿題」が増える。
 */
export const DEMO_CASES: readonly DemoCase[] = [
  {
    key: 'demo-01',
    purpose: '挙式まで約3週間。重要な宿題が期限切れで、リスク「高」になる',
    daysUntilWedding: 25,
    planType: '少人数婚',
    guestCount: 18,
    primaryContact: 'bride',
    groom: { name: '青木 翔太', email: 'demo-01-groom@demo.nicomaru.test', registered: false },
    bride: { name: '青木 美咲', email: 'demo-01-bride@demo.nicomaru.test', registered: true },
    submissions: [
      { template: '料理コースの選択', result: 'confirmed', selected: 'スタンダード' },
      {
        template: 'BGMリクエスト',
        result: 'submitted',
        text: '入場：明るいピアノ曲（曲名は打ち合わせで相談）\n歓談：ボサノバ系\n退場：アップテンポな曲',
      },
    ],
  },
  {
    key: 'demo-02',
    // AIデモ（docs/発表/AIデモ/発表台本.md）の主役。提出は済ませておき、本番はプランナー側のAI操作だけを見せる
    purpose: 'AIデモ：不備入りのゲストリストと英語のBGM希望が確認待ち',
    daysUntilWedding: 70,
    planType: '家族婚',
    guestCount: 24,
    primaryContact: 'groom',
    groom: { name: '石井 健太', email: 'demo-02-groom@demo.nicomaru.test', registered: true },
    bride: { name: '石井 結衣', email: 'demo-02-bride@demo.nicomaru.test', registered: true },
    submissions: [
      {
        template: 'ゲストリスト提出',
        result: 'submitted',
        file: 'docs/発表/AIデモ/ゲストリスト_石井家.csv',
      },
      {
        template: 'BGMリクエスト',
        result: 'submitted',
        text: [
          'Entrance: "Canon in D" played on piano, please.',
          'During dinner: relaxed acoustic songs, nothing too loud.',
          'Exit: an upbeat pop song so everyone can clap along.',
          'My grandparents are flying in from Sydney, so could we also play one Australian song during the toast? We will send the title by next week.',
        ].join('\n'),
      },
      { template: '料理コースの選択', result: 'submitted', selected: 'グレードアップ' },
      { template: '引き出物の選択', result: 'confirmed', selected: 'カタログギフトA' },
    ],
  },
  {
    key: 'demo-03',
    purpose: '確認待ちの提出が2件たまっている',
    daysUntilWedding: 45,
    planType: '少人数婚',
    guestCount: 12,
    primaryContact: 'groom',
    groom: { name: '上田 大輔', email: 'demo-03-groom@demo.nicomaru.test', registered: true },
    bride: { name: '上田 彩', email: 'demo-03-bride@demo.nicomaru.test', registered: false },
    submissions: [
      { template: '料理コースの選択', result: 'submitted', selected: 'シェフのおまかせ' },
      { template: '引き出物の選択', result: 'submitted', selected: '食器セット' },
    ],
  },
  {
    key: 'demo-04',
    purpose: '順調に進んでいる案件（比較用）',
    daysUntilWedding: 120,
    planType: '一般挙式',
    guestCount: 80,
    primaryContact: 'bride',
    groom: { name: '岡田 拓也', email: 'demo-04-groom@demo.nicomaru.test', registered: true },
    bride: { name: '岡田 真由', email: 'demo-04-bride@demo.nicomaru.test', registered: true },
    submissions: [
      {
        template: 'BGMリクエスト',
        result: 'confirmed',
        text: '入場：弦楽四重奏\n歓談：ジャズ\n退場：明るいポップス',
      },
      { template: '料理コースの選択', result: 'confirmed', selected: 'グレードアップ' },
      { template: '引き出物の選択', result: 'confirmed', selected: 'カタログギフトB' },
    ],
  },
  {
    key: 'demo-05',
    purpose: '登録したばかりで、新郎新婦がまだ招待URLを開いていない',
    daysUntilWedding: 150,
    planType: 'フォト婚',
    guestCount: 2,
    primaryContact: 'bride',
    groom: { name: '小川 悠人', email: 'demo-05-groom@demo.nicomaru.test', registered: false },
    bride: { name: '小川 さくら', email: 'demo-05-bride@demo.nicomaru.test', registered: false },
    submissions: [],
  },
];

/** すべてのデモ用メールアドレス（作り直しのときに Auth ユーザーを消す対象） */
export function demoEmails(): string[] {
  return [DEMO_PLANNER.email, ...DEMO_CASES.flatMap((c) => [c.groom.email, c.bride.email])];
}
