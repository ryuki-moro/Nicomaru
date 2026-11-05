'use client';

/**
 * 卓の配置パターン（#180）。プランナーが会場図の上に卓を並べ、座れる人の条件を付けて、新郎新婦へ送る。
 *
 * 席次プロトタイプの「プランナー → ③ 卓の配置パターン」を移したもの。
 *   - 選んだパターンはブラウザー側の下書きで編集し、「保存する」で卓の全件をまとめて送る
 *   - 変更はAPIで保存したあと router.refresh() でサーバーの値を読み直す
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import type { SeatingLayout } from '@/lib/services/seating-layouts';
import {
  HALL_SHAPES,
  HALL_SHAPE_LABEL,
  HALL_SHAPE_NOTE,
  LAYOUTS_PER_CASE_MAX,
  LAYOUT_NAME_MAX,
  LAYOUT_TEMPLATES,
  TABLES_PER_LAYOUT_MAX,
  TABLE_CAPACITY_MAX,
  TABLE_CAPACITY_MIN,
  TABLE_NAME_MAX,
  TABLE_SHAPES,
  TABLE_SHAPE_LABEL,
  applyRules,
  buildGrid,
  findTemplate,
  totalSeats,
  type HallShape,
  type RuleNeeds,
  type SeatingTable,
  type TableShape,
} from '@/lib/seating/layout';

export interface SeatingTagOption {
  /** タグのキー（side:・relationship:・tag: など） */
  key: string;
  label: string;
}

interface Props {
  caseId: string;
  layouts: SeatingLayout[];
  /** 席次のルールに渡す、新郎新婦側・区分ごとの出席人数 */
  needs: RuleNeeds;
  /** この案件の出席人数（本人＋同伴者） */
  attendingPeople: number;
  /** 座れる人に選べるタグ（relationship: と自由タグ tag:） */
  tagOptions: SeatingTagOption[];
  /** アーカイブ済みの案件では false（閲覧のみ） */
  editable: boolean;
}

// 会場図の中で卓を動かせる範囲（高砂・壁にかからないように）
const X_RANGE = [0.1, 0.9] as const;
const Y_RANGE = [0.24, 0.84] as const;
const DRAG_THRESHOLD_PX = 6;
const KEY_STEP = 0.01;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, [min, max]: readonly [number, number]) =>
  round3(Math.min(max, Math.max(min, n)));

/**
 * 卓の大きさ。会場図の幅に合わせて伸び縮みさせる（幅の割合。最小・最大は px）。
 * 縦型の会場図は幅が狭いので、割合を大きめにする。
 */
const TABLE_SIZE: Record<HallShape, Record<TableShape, { width: string; aspectRatio: string }>> = {
  wide: {
    round: { width: 'clamp(56px, 12%, 92px)', aspectRatio: '1 / 1' },
    rect: { width: 'clamp(84px, 18%, 150px)', aspectRatio: '2.4 / 1' },
    rectv: { width: 'clamp(44px, 8%, 64px)', aspectRatio: '1 / 2.6' },
  },
  tall: {
    round: { width: 'clamp(56px, 20%, 92px)', aspectRatio: '1 / 1' },
    rect: { width: 'clamp(84px, 32%, 150px)', aspectRatio: '2.4 / 1' },
    rectv: { width: 'clamp(44px, 14%, 64px)', aspectRatio: '1 / 2.6' },
  },
};

/** 席数と出席人数の比較（作る前・編集中の両方で使う） */
function seatSummary(tables: Pick<SeatingTable, 'capacity'>[], attending: number): string {
  const seats = totalSeats(tables);
  const gap =
    seats < attending ? `席が${attending - seats}足りません` : `余り${seats - attending}席`;
  return `${tables.length}卓・${seats}席（この案件の出席 ${attending}名。${gap}）`;
}

/** API を呼び、成功したらサーバーの値を読み直す。失敗はフォーム上部に出す。 */
function useMutation() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      const result = await call();
      router.refresh();
      return result;
    } catch (cause) {
      setError(cause instanceof ApiCallError ? cause.message : '保存できませんでした。');
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, setError, mutate };
}

export function SeatingLayoutEditor({
  caseId,
  layouts,
  needs,
  attendingPeople,
  tagOptions,
  editable,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const current = selectedId
    ? layouts.find((l) => l.id === selectedId)
    : creating
      ? undefined
      : layouts[0];

  const guard = (go: () => void) => {
    if (dirty) {
      setNotice('保存していない変更があります。先に「保存する」か「変更を破棄」を押してください。');
      return;
    }
    setNotice(null);
    go();
  };

  return (
    <div className="flex flex-col gap-3">
      {layouts.length === 0 && !creating && (
        <p className="text-label text-text-muted">
          まだ配置パターンはありません。
          {editable && '「配置を作る」から、会場に合わせた卓の並びを作れます。'}
        </p>
      )}

      {(layouts.length > 0 || editable) && (
        <div className="flex flex-wrap items-center gap-2">
          {layouts.map((layout) => {
            const on = !creating && current?.id === layout.id;
            return (
              <button
                key={layout.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  guard(() => {
                    setCreating(false);
                    setSelectedId(layout.id);
                  })
                }
                className={`flex min-h-[44px] items-center gap-2 rounded-button border px-3 py-2 text-label ${
                  on
                    ? 'border-primary bg-primary font-bold text-white'
                    : 'border-border-mid bg-surface text-text-primary'
                }`}
              >
                {layout.name}
                {layout.offeredAt && (
                  <span className="badge badge-success !px-2 !py-0">送付済み</span>
                )}
              </button>
            );
          })}
          {editable && (
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={creating}
              disabled={layouts.length >= LAYOUTS_PER_CASE_MAX}
              onClick={() =>
                guard(() => {
                  setCreating(true);
                  setSelectedId(null);
                })
              }
            >
              配置を作る
            </button>
          )}
        </div>
      )}
      {editable && layouts.length >= LAYOUTS_PER_CASE_MAX && (
        <p className="text-caption text-text-muted">
          配置パターンは{LAYOUTS_PER_CASE_MAX}個まで作れます。不要なものを削除してください。
        </p>
      )}
      {notice && (
        <p role="status" className="text-caption text-warning-text">
          {notice}
        </p>
      )}

      {creating && editable && (
        <LayoutCreator
          caseId={caseId}
          needs={needs}
          attendingPeople={attendingPeople}
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
        />
      )}

      {!creating && selectedId && !current && (
        <p role="status" className="text-label text-text-muted">
          読み込んでいます…
        </p>
      )}

      {!creating && current && (
        <LayoutPanel
          key={current.id}
          caseId={caseId}
          layout={current}
          needs={needs}
          attendingPeople={attendingPeople}
          tagOptions={tagOptions}
          editable={editable}
          onDirtyChange={setDirty}
          onDeleted={() => {
            setSelectedId(null);
            setNotice(null);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 配置を作る
function LayoutCreator({
  caseId,
  needs,
  attendingPeople,
  onCancel,
  onCreated,
}: {
  caseId: string;
  needs: RuleNeeds;
  attendingPeople: number;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const { pending, error, mutate } = useMutation();
  const [hall, setHall] = useState<HallShape>('wide');
  const [mode, setMode] = useState<'template' | 'grid'>('template');
  const [templateKey, setTemplateKey] = useState(LAYOUT_TEMPLATES.wide[0].key);
  const [shape, setShape] = useState<TableShape>('round');
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(2);
  const [capacity, setCapacity] = useState(8);
  const [name, setName] = useState<string | null>(null);
  const [useRules, setUseRules] = useState(true);

  const template = findTemplate(hall, templateKey) ?? LAYOUT_TEMPLATES[hall][0];
  const tooMany = mode === 'grid' && cols * rows > TABLES_PER_LAYOUT_MAX;
  const baseTables = useMemo(
    () =>
      mode === 'template'
        ? template.make()
        : tooMany
          ? []
          : buildGrid(hall, shape, cols, rows, capacity),
    [mode, template, tooMany, hall, shape, cols, rows, capacity],
  );
  const defaultName = mode === 'template' ? template.name : '新しい配置';
  const shownName = name ?? defaultName;

  const create = async () => {
    const tables = useRules ? applyRules(baseTables, needs) : baseTables;
    const result = await mutate(() =>
      api.post<{ id: string }>(`/api/cases/${caseId}/seating-layouts`, {
        name: shownName,
        hallShape: hall,
        tables,
      }),
    );
    if (result?.id) onCreated(result.id);
  };

  return (
    <div className="card flex flex-col gap-3">
      <ErrorSummary message={error} />
      <h3 className="text-label font-bold text-text-primary">配置を作る</h3>

      <fieldset>
        <legend className="field-label">会場の形</legend>
        <div className="flex flex-wrap gap-4">
          {HALL_SHAPES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-label">
              <input
                type="radio"
                name="hall-shape"
                className="h-4 w-4 accent-primary"
                checked={hall === value}
                onChange={() => {
                  setHall(value);
                  setTemplateKey(LAYOUT_TEMPLATES[value][0].key);
                }}
              />
              {HALL_SHAPE_LABEL[value]}
              <span className="text-caption text-text-muted">（{HALL_SHAPE_NOTE[value]}）</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="field-label">作り方</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-label">
            <input
              type="radio"
              name="layout-mode"
              className="h-4 w-4 accent-primary"
              checked={mode === 'template'}
              onChange={() => setMode('template')}
            />
            テンプレートから
          </label>
          <label className="flex items-center gap-2 text-label">
            <input
              type="radio"
              name="layout-mode"
              className="h-4 w-4 accent-primary"
              checked={mode === 'grid'}
              onChange={() => setMode('grid')}
            />
            卓の数を指定して並べる
          </label>
        </div>
      </fieldset>

      {mode === 'template' ? (
        <div>
          <label className="field-label" htmlFor="seating-template">
            テンプレート
          </label>
          <select
            id="seating-template"
            className="field"
            value={template.key}
            onChange={(e) => setTemplateKey(e.target.value)}
          >
            {LAYOUT_TEMPLATES[hall].map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className="field-label" htmlFor="grid-shape">
              卓の形
            </label>
            <select
              id="grid-shape"
              className="field"
              value={shape}
              onChange={(e) => setShape(e.target.value as TableShape)}
            >
              {TABLE_SHAPES.map((value) => (
                <option key={value} value={value}>
                  {TABLE_SHAPE_LABEL[value]}
                </option>
              ))}
            </select>
          </div>
          <NumberSelect id="grid-cols" label="列" min={1} max={6} value={cols} onChange={setCols} />
          <NumberSelect id="grid-rows" label="段" min={1} max={6} value={rows} onChange={setRows} />
          <NumberSelect
            id="grid-capacity"
            label="1卓の定員"
            min={TABLE_CAPACITY_MIN}
            max={TABLE_CAPACITY_MAX}
            value={capacity}
            onChange={setCapacity}
          />
        </div>
      )}

      <div>
        <label className="field-label" htmlFor="seating-layout-name">
          配置の名前
        </label>
        <input
          id="seating-layout-name"
          className="field"
          maxLength={LAYOUT_NAME_MAX}
          value={shownName}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-label">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={useRules}
          onChange={(e) => setUseRules(e.target.checked)}
        />
        席次のルールで「座れる人」を振る
      </label>

      {tooMany ? (
        <p role="alert" className="text-caption text-danger">
          卓は{TABLES_PER_LAYOUT_MAX}卓までです。列と段を減らしてください。
        </p>
      ) : (
        <p role="status" className="text-label text-text-secondary">
          {seatSummary(baseTables, attendingPeople)}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary w-auto px-5"
          disabled={pending || tooMany || !shownName.trim()}
          onClick={create}
        >
          この内容で作る
        </button>
        <button type="button" className="btn-ghost" disabled={pending} onClick={onCancel}>
          やめる
        </button>
      </div>
    </div>
  );
}

function NumberSelect({
  id,
  label,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="field"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </div>
  );
}

// ------------------------------------------------------------ 選んだ配置の編集
interface DraftTable extends SeatingTable {
  /** 画面内で卓を見分けるキー。保存済みの卓は ID、新しい卓は連番 */
  key: string;
}
interface Draft {
  name: string;
  tables: DraftTable[];
}

let keySeq = 0;
const newKey = () => `new-${++keySeq}`;

const toDraft = (layout: SeatingLayout): Draft => ({
  name: layout.name,
  tables: layout.tables.map((t) => ({ ...t, allowedTags: [...t.allowedTags], key: t.id })),
});

const toPayloadTables = (tables: DraftTable[]): SeatingTable[] =>
  tables.map((t) => ({
    id: t.id,
    name: t.name.trim(),
    capacity: t.capacity,
    shape: t.shape,
    x: t.x,
    y: t.y,
    allowedTags: t.allowedTags,
  }));

const snapshot = (d: Draft) =>
  JSON.stringify({ name: d.name.trim(), tables: toPayloadTables(d.tables) });

const SIDE_KEYS = { groom: 'side:groom', bride: 'side:bride' } as const;
type SideChoice = 'any' | 'groom' | 'bride';
const SIDE_CHOICES: { value: SideChoice; label: string }[] = [
  { value: 'any', label: 'どちらでも' },
  { value: 'groom', label: '新郎側だけ' },
  { value: 'bride', label: '新婦側だけ' },
];
const sideOf = (tags: string[]): SideChoice =>
  tags.includes(SIDE_KEYS.groom) ? 'groom' : tags.includes(SIDE_KEYS.bride) ? 'bride' : 'any';

/** 空いている位置と名前を探して、新しい卓を作る */
function makeNewTable(tables: DraftTable[]): DraftTable {
  const free = (x: number, y: number) =>
    tables.every((t) => Math.abs(t.x - x) >= 0.1 || Math.abs(t.y - y) >= 0.12);
  let pos: { x: number; y: number } | null = null;
  for (let y = 0.3; y <= 0.84 && !pos; y += 0.12) {
    for (let x = 0.15; x <= 0.85 && !pos; x += 0.14) {
      if (free(x, y)) pos = { x: round3(x), y: round3(y) };
    }
  }
  const names = new Set(tables.map((t) => t.name));
  let name = '追加の卓';
  for (let n = 2; names.has(name); n++) name = `追加の卓${n}`;
  return {
    key: newKey(),
    name,
    capacity: 8,
    shape: 'round',
    x: pos?.x ?? 0.5,
    y: pos?.y ?? 0.5,
    allowedTags: [],
  };
}

function LayoutPanel({
  caseId,
  layout,
  needs,
  attendingPeople,
  tagOptions,
  editable,
  onDirtyChange,
  onDeleted,
}: {
  caseId: string;
  layout: SeatingLayout;
  needs: RuleNeeds;
  attendingPeople: number;
  tagOptions: SeatingTagOption[];
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDeleted: () => void;
}) {
  const { pending, error, setError, mutate } = useMutation();
  const [draft, setDraft] = useState<Draft>(() => toDraft(layout));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'rules' | 'delete' | null>(null);

  // 保存や読み直しでサーバーの値が変わったときだけ下書きを作り直す（他の操作の refresh では消さない）
  const layoutSig = JSON.stringify(layout);
  const [seenSig, setSeenSig] = useState(layoutSig);
  if (layoutSig !== seenSig) {
    setSeenSig(layoutSig);
    setDraft(toDraft(layout));
    setSelectedKey(null);
    setConfirming(null);
  }

  const dirty = editable && snapshot(draft) !== snapshot(toDraft(layout));
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const selected = draft.tables.find((t) => t.key === selectedKey) ?? null;
  const patchTable = useCallback(
    (key: string, patch: Partial<SeatingTable>) =>
      setDraft((d) => ({
        ...d,
        tables: d.tables.map((t) => (t.key === key ? { ...t, ...patch } : t)),
      })),
    [],
  );

  const base = `/api/cases/${caseId}/seating-layouts/${layout.id}`;
  const nameOk =
    draft.name.trim().length > 0 && draft.tables.every((t) => t.name.trim().length > 0);

  const save = () =>
    mutate(() =>
      api.patch(base, {
        name: draft.name.trim(),
        hallShape: layout.hallShape,
        tables: toPayloadTables(draft.tables),
      }),
    );

  const offered = layout.offeredAt !== null;

  return (
    <div className="flex flex-col gap-3">
      <ErrorSummary message={error} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="badge badge-neutral">{HALL_SHAPE_LABEL[layout.hallShape]}</span>
        {offered && <span className="badge badge-success">送付済み</span>}
        {dirty && (
          <span role="status" className="text-caption font-bold text-warning-text">
            保存していない変更があります
          </span>
        )}
      </div>

      {editable && (
        <div>
          <label className="field-label" htmlFor="seating-draft-name">
            配置の名前
          </label>
          <input
            id="seating-draft-name"
            className="field"
            maxLength={LAYOUT_NAME_MAX}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </div>
      )}

      <HallMap
        hall={layout.hallShape}
        tables={draft.tables}
        selectedKey={selectedKey}
        editable={editable}
        onSelect={setSelectedKey}
        onMove={(key, x, y) => patchTable(key, { x: clamp(x, X_RANGE), y: clamp(y, Y_RANGE) })}
      />
      {editable && (
        <p className="text-caption text-text-muted">
          卓を押して選ぶと、下で名前や座れる人を変えられます。指やマウスで動かすこともできます（PCでは矢印キーでも動かせます）。
        </p>
      )}

      <p role="status" className="text-label text-text-secondary">
        {seatSummary(draft.tables, attendingPeople)}
      </p>

      {editable && selected && (
        <TableForm
          table={selected}
          tagOptions={tagOptions}
          canDelete={draft.tables.length > 1}
          onChange={(patch) => patchTable(selected.key, patch)}
          onDelete={() => {
            setDraft((d) => ({ ...d, tables: d.tables.filter((t) => t.key !== selected.key) }));
            setSelectedKey(null);
          }}
        />
      )}

      {editable && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={pending || draft.tables.length >= TABLES_PER_LAYOUT_MAX}
              onClick={() => {
                const table = makeNewTable(draft.tables);
                setDraft((d) => ({ ...d, tables: [...d.tables, table] }));
                setSelectedKey(table.key);
              }}
            >
              卓を追加（{draft.tables.length}/{TABLES_PER_LAYOUT_MAX}）
            </button>
            <button
              type="button"
              className="btn-primary w-auto px-5"
              disabled={pending || !dirty || !nameOk}
              onClick={save}
            >
              保存する
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={pending || !dirty}
              onClick={() => {
                setDraft(toDraft(layout));
                setSelectedKey(null);
                setError(null);
              }}
            >
              変更を破棄
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {confirming === 'rules' ? (
              <>
                <span className="text-label">
                  席次のルールで、すべての卓の名前と「座れる人」を振り直します。卓の位置・形・定員は変わりません。よろしいですか？
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setDraft((d) => ({
                      ...d,
                      tables: applyRules(d.tables, needs) as DraftTable[],
                    }));
                    setConfirming(null);
                  }}
                >
                  振り直す
                </button>
                <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                  やめる
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-ghost"
                disabled={pending}
                onClick={() => setConfirming('rules')}
              >
                席次のルールで「座れる人」を振り直す
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={pending || dirty}
              onClick={() => mutate(() => api.patch(base, { offered: !offered }))}
            >
              {offered ? '送るのをやめる' : 'この配置を新郎新婦に送る'}
            </button>
            {dirty && (
              <span className="text-caption text-text-muted">
                先に「保存する」を押してください。
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {confirming === 'delete' ? (
              <>
                <span className="text-label">
                  「{layout.name}」を削除しますか？{offered && '新郎新婦からも見えなくなります。'}
                </span>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending}
                  onClick={async () => {
                    const result = await mutate(() => api.del(base));
                    if (result !== undefined) onDeleted();
                    setConfirming(null);
                  }}
                >
                  削除する
                </button>
                <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                  やめる
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn-ghost"
                disabled={pending}
                onClick={() => setConfirming('delete')}
              >
                この配置を削除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- 会場図
function HallMap({
  hall,
  tables,
  selectedKey,
  editable,
  onSelect,
  onMove,
}: {
  hall: HallShape;
  tables: DraftTable[];
  selectedKey: string | null;
  editable: boolean;
  onSelect: (key: string) => void;
  onMove: (key: string, x: number, y: number) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    key: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);

  return (
    <div
      ref={mapRef}
      className="relative w-full overflow-hidden rounded-card border border-border-mid bg-field-filled-bg"
      style={{
        aspectRatio: hall === 'wide' ? '3 / 2' : '3 / 4',
        maxWidth: hall === 'wide' ? 760 : 440,
      }}
      role="group"
      aria-label={`会場図（${HALL_SHAPE_LABEL[hall]}）`}
    >
      <div className="absolute left-1/2 top-2 w-[34%] -translate-x-1/2 rounded-card bg-primary-dark px-2 py-1 text-center text-caption font-bold text-white">
        高砂
      </div>
      <span className="absolute left-2 top-2 text-caption text-text-secondary">◀ 新郎側</span>
      <span className="absolute right-2 top-2 text-caption text-text-secondary">新婦側 ▶</span>

      {tables.map((table) => {
        const size = TABLE_SIZE[hall][table.shape];
        const on = table.key === selectedKey;
        return (
          <button
            key={table.key}
            type="button"
            aria-pressed={on}
            aria-label={`${table.name}、${TABLE_SHAPE_LABEL[table.shape]}、定員${table.capacity}名${
              editable ? '。矢印キーで動かせます' : ''
            }`}
            className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-2 px-1 text-center leading-tight ${
              table.shape === 'round' ? 'rounded-full' : 'rounded-card'
            } ${
              on
                ? 'border-primary bg-primary text-white'
                : 'border-border-mid bg-surface text-text-primary'
            } ${editable ? 'cursor-grab touch-none' : 'cursor-default'}`}
            style={{
              left: `${table.x * 100}%`,
              top: `${table.y * 100}%`,
              width: size.width,
              aspectRatio: size.aspectRatio,
            }}
            onClick={() => onSelect(table.key)}
            onPointerDown={(e) => {
              onSelect(table.key);
              if (!editable) return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              drag.current = {
                key: table.key,
                startX: e.clientX,
                startY: e.clientY,
                originX: table.x,
                originY: table.y,
                moved: false,
              };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              const rect = mapRef.current?.getBoundingClientRect();
              if (!d || d.key !== table.key || !rect || rect.width === 0) return;
              const dx = e.clientX - d.startX;
              const dy = e.clientY - d.startY;
              if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
              d.moved = true;
              onMove(table.key, d.originX + dx / rect.width, d.originY + dy / rect.height);
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              if (!editable) return;
              const step: Record<string, [number, number]> = {
                ArrowLeft: [-KEY_STEP, 0],
                ArrowRight: [KEY_STEP, 0],
                ArrowUp: [0, -KEY_STEP],
                ArrowDown: [0, KEY_STEP],
              };
              const move = step[e.key];
              if (!move) return;
              e.preventDefault();
              onSelect(table.key);
              onMove(table.key, table.x + move[0], table.y + move[1]);
            }}
          >
            <span className="line-clamp-2 max-w-full break-all text-[11px] font-bold">
              {table.name}
            </span>
            <span className="text-[10px]">{table.capacity}名</span>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 卓の編集欄
function TableForm({
  table,
  tagOptions,
  canDelete,
  onChange,
  onDelete,
}: {
  table: DraftTable;
  tagOptions: SeatingTagOption[];
  canDelete: boolean;
  onChange: (patch: Partial<SeatingTable>) => void;
  onDelete: () => void;
}) {
  const relationships = tagOptions.filter((o) => o.key.startsWith('relationship:'));
  const customs = tagOptions.filter((o) => o.key.startsWith('tag:'));
  const side = sideOf(table.allowedTags);

  // 画面で扱う種類のキーだけを増減し、それ以外（年齢区分・アレルギーなど）は残す
  const setSide = (choice: SideChoice) => {
    const rest = table.allowedTags.filter((k) => k !== SIDE_KEYS.groom && k !== SIDE_KEYS.bride);
    onChange({ allowedTags: choice === 'any' ? rest : [SIDE_KEYS[choice], ...rest] });
  };
  const toggle = (key: string, on: boolean) =>
    onChange({
      allowedTags: on
        ? [...table.allowedTags.filter((k) => k !== key), key]
        : table.allowedTags.filter((k) => k !== key),
    });

  const checkboxes = (options: SeatingTagOption[]) =>
    options.map((o) => (
      <label key={o.key} className="flex items-center gap-2 text-label">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={table.allowedTags.includes(o.key)}
          onChange={(e) => toggle(o.key, e.target.checked)}
        />
        {o.label}
      </label>
    ));

  return (
    <div className="rounded-card border border-border-mid p-3">
      <h3 className="mb-2 text-label font-bold text-text-primary">卓の設定：{table.name}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="field-label" htmlFor="table-name">
            卓の名前
          </label>
          <input
            id="table-name"
            className="field"
            maxLength={TABLE_NAME_MAX}
            value={table.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <NumberSelect
          id="table-capacity"
          label="定員"
          min={TABLE_CAPACITY_MIN}
          max={TABLE_CAPACITY_MAX}
          value={table.capacity}
          onChange={(capacity) => onChange({ capacity })}
        />
        <div>
          <label className="field-label" htmlFor="table-shape">
            卓の形
          </label>
          <select
            id="table-shape"
            className="field"
            value={table.shape}
            onChange={(e) => onChange({ shape: e.target.value as TableShape })}
          >
            {TABLE_SHAPES.map((value) => (
              <option key={value} value={value}>
                {TABLE_SHAPE_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="mt-3">
        <legend className="field-label">座れる人：新郎新婦側</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {SIDE_CHOICES.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-label">
              <input
                type="radio"
                name="table-side"
                className="h-4 w-4 accent-primary"
                checked={side === c.value}
                onChange={() => setSide(c.value)}
              />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>

      {relationships.length > 0 && (
        <fieldset className="mt-3">
          <legend className="field-label">座れる人：ご関係（選ばなければどなたでも）</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">{checkboxes(relationships)}</div>
        </fieldset>
      )}

      {customs.length > 0 && (
        <fieldset className="mt-3">
          <legend className="field-label">座れる人：自由タグ</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">{checkboxes(customs)}</div>
        </fieldset>
      )}

      <div className="mt-3">
        <button type="button" className="btn-ghost" disabled={!canDelete} onClick={onDelete}>
          卓を削除
        </button>
        {!canDelete && (
          <span className="ml-2 text-caption text-text-muted">最後の1卓は削除できません。</span>
        )}
      </div>
    </div>
  );
}
