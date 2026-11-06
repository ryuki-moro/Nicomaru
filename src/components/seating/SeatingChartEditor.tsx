'use client';

/**
 * 新郎新婦が席次をつくって提出する（#181）。
 *
 * 席次プロトタイプの「新郎新婦 → ② 席次」を移したもの。
 *   - 席次はブラウザー側の下書きで編集し、「保存する」で全件をまとめて送る
 *   - 保存・提出のあとは router.refresh() でサーバーの値を読み直す
 *   - 二人が同時に編集したときは、保存時の版（version）の食い違いで 409 になる
 */
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { GUEST_DRAG_TYPE, HallMap, type HallMapTone } from '@/components/seating/HallMap';
import { ErrorSummary } from '@/components/ui/ErrorSummary';
import { ApiCallError, api } from '@/lib/api/client';
import {
  GUEST_AGE_CATEGORY_LABEL,
  GUEST_SEAT_ROLE_LABEL,
  PARTNER_ROLE_LABEL,
} from '@/lib/constants';
import {
  autoAssign,
  canSeat,
  canSubmit,
  checkSeating,
  childGroupsOf,
  moveInTable,
  placeGuest,
  placementWish,
  tableOf,
  unplaceGuest,
  type AutoAssignResult,
  type SeatGuest,
  type Seating,
} from '@/lib/seating/assign';
import type { SeatGuestInfo } from '@/lib/seating/guests';
import { totalSeats } from '@/lib/seating/layout';
import type { SeatingChart, SeatingLayout } from '@/lib/d1/seating';

interface Props {
  caseId: string;
  /** 新郎新婦に送られた配置パターン */
  layouts: SeatingLayout[];
  /** 席に入れる人（出席で確認済みの人） */
  guests: SeatGuest[];
  info: Record<string, SeatGuestInfo>;
  /** タグのキー → 表示名（卓の「座れる人」の説明に使う） */
  tagLabels: Record<string, string>;
  chart: SeatingChart;
}

const CONFLICT_MESSAGE = 'もう一人が先に席次を保存しました。最新の内容を読み込んでください';

// ------------------------------------------------------------------ 下書きの扱い
interface Draft {
  layoutId: string | null;
  seating: Seating;
}

/** 保存済みの席次から下書きの初期値を作る（届いていない配置・席に入れなくなった人は外す） */
function initialDraft(
  layouts: SeatingLayout[],
  guests: SeatGuest[],
  chart: SeatingChart,
): Draft & { missing: boolean } {
  const layout = chart.layoutId ? layouts.find((l) => l.id === chart.layoutId) : undefined;
  const missing = chart.layoutId !== null && !layout;
  if (!layout) {
    return {
      layoutId: !missing && layouts.length === 1 ? layouts[0].id : null,
      seating: {},
      missing,
    };
  }
  const known = new Set(guests.map((g) => g.id));
  const seating: Seating = {};
  for (const table of layout.tables) {
    const ids = (chart.seating[table.id] ?? []).filter((id) => known.has(id));
    if (ids.length) seating[table.id] = ids;
  }
  return { layoutId: layout.id, seating, missing: false };
}

/** 変更の有無を比べるための文字列（空の卓は無いものとして扱う） */
const snapshot = ({ layoutId, seating }: Draft) =>
  JSON.stringify([
    layoutId,
    Object.keys(seating)
      .filter((k) => seating[k].length > 0)
      .sort()
      .map((k) => [k, seating[k]]),
  ]);

const sideLabel = (side: SeatGuestInfo['side']) => (side ? `${PARTNER_ROLE_LABEL[side]}側` : '');

/** 卓の「座れる人」を文にする。同じ種類は「または」、違う種類は「で、」でつなぐ */
function describeAllowed(allowedTags: string[], labels: Record<string, string>): string {
  if (allowedTags.length === 0) return 'どなたでも座れます';
  const kinds = new Map<string, string[]>();
  for (const key of allowedTags) {
    const kind = key.split(':')[0];
    kinds.set(kind, [...(kinds.get(kind) ?? []), labels[key] ?? key]);
  }
  const order = ['side', 'relationship', 'age', 'role', 'assistance', 'allergy', 'tag'];
  const parts = [...kinds.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([, names]) => names.join('または'));
  return `${parts.join('で、')}の方が座れます`;
}

// ---------------------------------------------------------------------- 本体
export function SeatingChartEditor({ caseId, layouts, guests, info, tagLabels, chart }: Props) {
  const router = useRouter();
  const serverSig = JSON.stringify([chart, layouts]);
  const initial = useMemo(
    () => initialDraft(layouts, guests, chart),
    // サーバーの値が変わったときだけ作り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverSig],
  );

  const [seenSig, setSeenSig] = useState(serverSig);
  const [layoutId, setLayoutId] = useState<string | null>(initial.layoutId);
  const [seating, setSeating] = useState<Seating>(initial.seating);
  const [base, setBase] = useState<Draft>({
    layoutId: initial.layoutId,
    seating: initial.seating,
  });
  const [version, setVersion] = useState(chart.version);
  const [layoutMissing, setLayoutMissing] = useState(initial.missing);

  const [tableId, setTableId] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [withParty, setWithParty] = useState(true);
  const [message, setMessage] = useState<{ kind: 'note' | 'error'; text: string } | null>(null);
  const [undo, setUndo] = useState<Seating | null>(null);
  const [report, setReport] = useState<AutoAssignResult | null>(null);
  const [confirming, setConfirming] = useState<'submit' | { layoutId: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const resetFromServer = () => {
    setLayoutId(initial.layoutId);
    setSeating(initial.seating);
    setBase({ layoutId: initial.layoutId, seating: initial.seating });
    setVersion(chart.version);
    setLayoutMissing(initial.missing);
    setTableId(null);
    setPickedId(null);
    setMessage(null);
    setUndo(null);
    setReport(null);
    setConfirming(null);
    setError(null);
    setConflict(false);
  };

  // 保存や読み直しでサーバーの値が変わったときだけ下書きを作り直す
  if (serverSig !== seenSig) {
    setSeenSig(serverSig);
    resetFromServer();
  }

  const readOnly = chart.status === 'submitted' || chart.status === 'approved';
  const layout = layouts.find((l) => l.id === layoutId) ?? null;
  const tables = useMemo(() => layout?.tables ?? [], [layout]);
  const hallTables = useMemo(() => tables.map((t) => ({ ...t, key: t.id })), [tables]);
  const kids = useMemo(() => childGroupsOf(guests), [guests]);
  const guestById = useMemo(() => new Map(guests.map((g) => [g.id, g])), [guests]);

  const dirty = !readOnly && snapshot({ layoutId, seating }) !== snapshot(base);
  const check = useMemo(() => checkSeating(seating, tables, guests), [seating, tables, guests]);

  const seatedCount = guests.length - check.unplaced.length;
  const seats = totalSeats(tables);
  const picked = pickedId ? (guestById.get(pickedId) ?? null) : null;
  const selectedTable = tables.find((t) => t.id === tableId) ?? null;

  const nameOf = (id: string) => info[id]?.name ?? '（不明）';
  const labelOf = (id: string) => {
    const g = info[id];
    return g ? `${g.title ? `${g.title} ` : ''}${g.name}` : '（不明）';
  };
  const tableName = (id: string) => tables.find((t) => t.id === id)?.name ?? '';

  /** 席の編集。別の操作をしたら「元に戻す」は使えなくする */
  const edit = (next: Seating) => {
    setSeating(next);
    setUndo(null);
  };

  const placeInto = (guestId: string, toTableId: string) => {
    if (readOnly) return;
    const result = placeGuest(seating, tables, guests, guestId, toTableId, withParty);
    setPickedId(null);
    setTableId(toTableId);
    if (result.error) {
      setMessage({ kind: 'error', text: result.error });
      return;
    }
    if (result.placed.length === 0) {
      setMessage(null);
      return;
    }
    edit(result.seating);
    const names = result.placed.map(nameOf).join('、');
    setMessage({
      kind: 'note',
      text: `${tableName(toTableId)}に ${names} さんを入れました${
        result.note ? `。${result.note}` : ''
      }`,
    });
  };

  const onSelectTable = (key: string) => {
    if (picked && !readOnly) {
      placeInto(picked.id, key);
      return;
    }
    setTableId(key);
    setMessage(null);
  };

  const changeLayout = (id: string) => {
    if (id === layoutId) return;
    const hasSeated = Object.values(seating).some((ids) => ids.length > 0);
    if (hasSeated) {
      setConfirming({ layoutId: id });
      return;
    }
    applyLayout(id);
  };
  const applyLayout = (id: string) => {
    setLayoutId(id);
    setSeating({});
    setUndo(null);
    setReport(null);
    setTableId(null);
    setPickedId(null);
    setMessage(null);
    setConfirming(null);
    setLayoutMissing(false);
  };

  const runAuto = () => {
    const result = autoAssign(seating, tables, guests);
    setUndo(seating);
    setSeating(result.seating);
    setReport(result);
    setPickedId(null);
    setMessage(null);
  };

  // ---------------------------------------------------------------- 保存・提出
  const assignments = () =>
    layout
      ? layout.tables.flatMap((t) =>
          (seating[t.id] ?? []).map((guestId) => ({ guestId, tableId: t.id })),
        )
      : [];

  /** 通信の共通処理。409 は「先に保存された」案内に、それ以外はサマリに出す */
  const run = async (job: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await job();
    } catch (cause) {
      if (cause instanceof ApiCallError && cause.status === 409) {
        setConflict(true);
        setError(CONFLICT_MESSAGE);
      } else {
        setError(cause instanceof ApiCallError ? cause.message : '保存できませんでした。');
      }
    } finally {
      setPending(false);
      setConfirming(null);
    }
  };

  const saveRequest = async (): Promise<number> => {
    const result = await api.put<{ version: number }>(`/api/cases/${caseId}/seating-chart`, {
      layoutId,
      version,
      assignments: assignments(),
    });
    setVersion(result.version);
    setBase({ layoutId, seating });
    return result.version;
  };

  const save = () =>
    run(async () => {
      await saveRequest();
      router.refresh();
    });

  const submit = () =>
    run(async () => {
      const needsSave = dirty || layoutId !== chart.layoutId;
      const current = needsSave ? await saveRequest() : version;
      await api.post(`/api/cases/${caseId}/seating-chart/submit`, { version: current });
      router.refresh();
    });

  // ---------------------------------------------------------- 提出できない理由
  const blockers: string[] = [];
  if (!layout) blockers.push('卓の配置を選んでください');
  else if (guests.length === 0) blockers.push('席に入れる方がまだいません');
  if (layout) {
    if (check.unplaced.length > 0)
      blockers.push(`席が決まっていない方が${check.unplaced.length}名います`);
    if (check.overTables.length > 0) {
      blockers.push(
        `定員を超えている卓があります（${check.overTables.map(tableName).join('、')}）`,
      );
    }
    if (check.mismatched.length > 0) {
      blockers.push(
        `卓の条件に合わない席の方がいます（${check.mismatched.map(nameOf).join('、')}）`,
      );
    }
  }
  const submittable = layout !== null && guests.length > 0 && canSubmit(check);
  const mixed = check.mixedTables.map(tableName);

  const tone = (id: string): HallMapTone | undefined => {
    const table = tables.find((t) => t.id === id);
    if (!table) return undefined;
    const members = seating[id] ?? [];
    if (
      members.length > table.capacity ||
      members.some((m) => {
        const g = guestById.get(m);
        return g ? !canSeat(table, g) : false;
      })
    ) {
      return 'warn';
    }
    if (picked && !canSeat(table, picked)) return 'dim';
    return undefined;
  };

  // ------------------------------------------------------------------ 表示
  if (layouts.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <StatusBanner chart={chart} />
        <p className="text-label text-text-muted">
          プランナーから卓の配置が届くまでお待ちください。
        </p>
      </div>
    );
  }

  const unplaced = guests.filter((g) => !tableOf(seating, g.id));

  return (
    <div className="flex flex-col gap-3">
      <StatusBanner chart={chart} />
      <ErrorSummary message={error} />
      {conflict && (
        <div>
          <button
            type="button"
            className="btn-secondary w-auto px-5"
            onClick={() => {
              resetFromServer();
              router.refresh();
            }}
          >
            最新を読み込む
          </button>
        </div>
      )}

      {layoutMissing && (
        <p role="status" className="banner-info">
          選んでいた卓の配置は、プランナーが送るのをやめました。あらためて配置を選んでください。
        </p>
      )}

      {/* 配置の選択 */}
      {layout === null && !readOnly && (
        <section className="flex flex-col gap-2">
          <h2 className="text-label font-bold text-text-primary">卓の配置を選んでください</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {layouts.map((l) => (
              <div key={l.id} className="card flex flex-col gap-2">
                <HallMap
                  hall={l.hallShape}
                  tables={l.tables.map((t) => ({ ...t, key: t.id }))}
                  selectedKey={null}
                  editable={false}
                  onSelect={() => {}}
                  compact
                />
                <p className="text-label font-bold text-text-primary">{l.name}</p>
                <p className="text-caption text-text-muted">
                  {l.tables.length}卓・{totalSeats(l.tables)}席
                </p>
                <button
                  type="button"
                  className="btn-primary w-auto px-5"
                  onClick={() => applyLayout(l.id)}
                >
                  この配置にする
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {layout !== null && layouts.length > 1 && !readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-text-muted">卓の配置</span>
          {layouts.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={l.id === layoutId}
              disabled={pending}
              onClick={() => changeLayout(l.id)}
              className={`min-h-[44px] rounded-button border px-3 py-2 text-label ${
                l.id === layoutId
                  ? 'border-primary bg-primary font-bold text-white'
                  : 'border-border-mid bg-surface text-text-primary'
              }`}
            >
              {l.name}
            </button>
          ))}
        </div>
      )}
      {confirming && typeof confirming === 'object' && (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-border-mid p-3">
          <span className="text-label">
            配置を変えると、いま決めている席は、すべて未配置に戻ります。よろしいですか？
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => applyLayout(confirming.layoutId)}
          >
            配置を変える
          </button>
          <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
            やめる
          </button>
        </div>
      )}

      {layout !== null && (
        <>
          {/* 合計 */}
          <p role="status" className="text-label text-text-secondary">
            席に着いた方 {seatedCount} / {guests.length}名・席は全部で{seats}席（
            {seats >= seatedCount
              ? `空き${seats - seatedCount}席`
              : `${seatedCount - seats}席足りません`}
            ）
          </p>
          {dirty && (
            <p role="status" className="text-caption font-bold text-warning-text">
              保存していない変更があります
            </p>
          )}

          {picked && !readOnly && (
            <div className="banner-info flex-wrap items-center">
              <span>{labelOf(picked.id)} さんを選んでいます。入れたい卓を押してください。</span>
              <button type="button" className="btn-ghost" onClick={() => setPickedId(null)}>
                選ぶのをやめる
              </button>
            </div>
          )}

          <HallMap
            hall={layout.hallShape}
            tables={hallTables}
            selectedKey={tableId}
            editable={false}
            onSelect={onSelectTable}
            tone={(t) => tone(t.key)}
            describe={(t) =>
              `${t.name}、${(seating[t.id] ?? []).length}名、定員${t.capacity}名${
                picked && !canSeat(t, picked) ? '。選んだ方は座れません' : ''
              }`
            }
            renderBody={(t) => (
              <>
                <span className="line-clamp-2 max-w-full break-all text-[11px] font-bold">
                  {t.name}
                </span>
                <span className="text-[10px]">
                  {(seating[t.id] ?? []).length}/{t.capacity}名
                </span>
              </>
            )}
            onDropGuest={readOnly ? undefined : (key, guestId) => placeInto(guestId, key)}
          />
          {!readOnly && (
            <p className="text-caption text-text-muted">
              スマホでは、下の一覧で人を押して選んでから、卓を押すと入ります。PCでは人を卓へドラッグしても入ります。
            </p>
          )}

          {message && (
            <p
              role={message.kind === 'error' ? 'alert' : 'status'}
              className={`text-caption ${message.kind === 'error' ? 'text-danger' : 'text-text-secondary'}`}
            >
              {message.text}
            </p>
          )}
          {mixed.length > 0 && (
            <p role="status" className="text-caption text-warning-text">
              新郎側と新婦側の方が同じ卓になっています（{mixed.join('、')}
              ）。このまま提出もできます。
            </p>
          )}

          {/* 選んだ卓 */}
          {selectedTable ? (
            <section className="rounded-card border border-border-mid p-3">
              <h2 className="mb-1 text-label font-bold text-text-primary">
                {selectedTable.name}（{(seating[selectedTable.id] ?? []).length}/
                {selectedTable.capacity}名）
              </h2>
              <p className="mb-2 text-caption text-text-muted">
                {describeAllowed(selectedTable.allowedTags, tagLabels)}
              </p>
              {(seating[selectedTable.id] ?? []).length === 0 ? (
                <p className="text-caption text-text-muted">まだだれも入っていません。</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {(seating[selectedTable.id] ?? []).map((id, i, list) => {
                    const g = info[id];
                    return (
                      <li
                        key={id}
                        draggable={!readOnly}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(GUEST_DRAG_TYPE, id);
                          e.dataTransfer.setData('text/plain', id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        className="flex flex-wrap items-center gap-2 text-label"
                      >
                        <span className="w-10 text-text-muted">{i + 1}番</span>
                        <span className="min-w-0 flex-1 break-all">{labelOf(id)}</span>
                        {g?.seatRole && (
                          <span className="badge badge-warning">
                            {GUEST_SEAT_ROLE_LABEL[g.seatRole]}
                          </span>
                        )}
                        {!readOnly && (
                          <span className="flex gap-1">
                            <button
                              type="button"
                              className="btn-ghost"
                              aria-label={`${nameOf(id)}さんを1つ前の席へ`}
                              disabled={i === 0}
                              onClick={() => edit(moveInTable(seating, id, -1))}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              aria-label={`${nameOf(id)}さんを1つ後ろの席へ`}
                              disabled={i === list.length - 1}
                              onClick={() => edit(moveInTable(seating, id, 1))}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn-ghost"
                              aria-label={`${nameOf(id)}さんを席から外す`}
                              onClick={() => {
                                edit(unplaceGuest(seating, id));
                                setMessage(null);
                              }}
                            >
                              外す
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}

              {!readOnly && (
                <div className="mt-3 flex flex-col gap-2">
                  <div>
                    <label className="field-label" htmlFor="seat-add">
                      この卓に入れる
                    </label>
                    <select
                      id="seat-add"
                      className="field"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) placeInto(e.target.value, selectedTable.id);
                      }}
                    >
                      <option value="">未配置の方から選ぶ</option>
                      {unplaced
                        .filter((g) => canSeat(selectedTable, g))
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            {labelOf(g.id)}
                          </option>
                        ))}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-label">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={withParty}
                      onChange={(e) => setWithParty(e.target.checked)}
                    />
                    ご家族・同伴者も一緒に入れる
                  </label>
                </div>
              )}
            </section>
          ) : (
            <p className="text-caption text-text-muted">
              卓を押すと、座っている方や席の順番を見られます。
            </p>
          )}

          {/* 未配置の人 */}
          <section className="flex flex-col gap-2">
            <h2 className="text-label font-bold text-text-primary">
              席がまだの方（{unplaced.length}名）
            </h2>
            {unplaced.length === 0 ? (
              <p className="text-caption text-text-muted">全員の席が決まっています。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {unplaced.map((g) => {
                  const wish = placementWish(g, kids);
                  const gi = info[g.id];
                  const on = pickedId === g.id;
                  return (
                    <li key={g.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        disabled={readOnly}
                        draggable={!readOnly}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(GUEST_DRAG_TYPE, g.id);
                          e.dataTransfer.setData('text/plain', g.id);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => {
                          setPickedId(on ? null : g.id);
                          setMessage(null);
                        }}
                        className={`flex min-h-[44px] w-full flex-wrap items-center gap-2 rounded-button border px-3 py-2 text-left text-label ${
                          on
                            ? 'border-primary bg-primary font-bold text-white'
                            : 'border-border-mid bg-surface text-text-primary'
                        }`}
                      >
                        <span className="min-w-0 flex-1 break-all">{labelOf(g.id)}</span>
                        {gi?.side && (
                          <span className="badge badge-neutral">{sideLabel(gi.side)}</span>
                        )}
                        {gi?.ageCategory && gi.ageCategory !== 'adult' && (
                          <span className="badge badge-neutral">
                            {GUEST_AGE_CATEGORY_LABEL[gi.ageCategory].replace(/（.*）$/, '')}
                          </span>
                        )}
                        {wish && (
                          <span className="badge badge-warning">
                            {wish.reason}（{wish.where === 'front' ? '前' : '後ろ'}の席の希望）
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ランダムに配置する */}
          {!readOnly && (
            <section className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={pending || unplaced.length === 0}
                  onClick={runAuto}
                >
                  ランダムに配置する
                </button>
                {undo && (
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={pending}
                    onClick={() => {
                      setSeating(undo);
                      setUndo(null);
                      setReport(null);
                    }}
                  >
                    元に戻す
                  </button>
                )}
              </div>
              {report && (
                <div role="status" className="rounded-card border border-border-mid p-3 text-label">
                  <p className="font-bold">{report.placed.length}名を配置しました。</p>
                  {report.fails.length > 0 && (
                    <div className="mt-2">
                      <p className="text-danger">入れられなかった方（{report.fails.length}名）</p>
                      <ul className="list-disc pl-5 text-caption">
                        {report.fails.map((f) => (
                          <li key={f.guestId}>
                            {labelOf(f.guestId)}：{f.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {report.wishes.length > 0 && (
                    <div className="mt-2">
                      <p>席の希望を考えて入れた方（{report.wishes.length}名）</p>
                      <ul className="list-disc pl-5 text-caption">
                        {report.wishes.map((w) => (
                          <li key={w.guestId}>
                            {labelOf(w.guestId)}（{w.wish.reason}）：{tableName(w.tableId)}
                            {w.note && `。${w.note}`}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 保存・提出 */}
          {!readOnly && (
            <section className="flex flex-col gap-2">
              {!submittable && blockers.length > 0 && (
                <ul className="list-disc pl-5 text-caption text-text-muted">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-primary w-auto px-5"
                  disabled={pending || !dirty || conflict}
                  onClick={save}
                >
                  保存する
                </button>
                {confirming === 'submit' ? (
                  <>
                    <span className="text-label">
                      プランナーの確認が終わるまで、席次は変更できなくなります。提出しますか？
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={pending}
                      onClick={submit}
                    >
                      提出する
                    </button>
                    <button type="button" className="btn-ghost" onClick={() => setConfirming(null)}>
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary w-auto px-5"
                    disabled={pending || !submittable || conflict}
                    onClick={() => setConfirming('submit')}
                  >
                    提出する
                  </button>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 状態の表示
function StatusBanner({ chart }: { chart: SeatingChart }) {
  if (chart.status === 'submitted') {
    return (
      <p role="status" className="banner-info">
        提出しました。プランナーが確認しています。確認が終わるまで席次は変更できません。
      </p>
    );
  }
  if (chart.status === 'approved') {
    return (
      <p role="status" className="banner-info">
        席次が確定しました。
      </p>
    );
  }
  if (chart.status === 'returned') {
    return (
      <div role="status" className="banner-info flex-col">
        <p className="font-bold">プランナーからのご連絡</p>
        {chart.feedback && <p className="whitespace-pre-wrap break-all">{chart.feedback}</p>}
        <p>直したら、もう一度提出してください。</p>
      </div>
    );
  }
  return null;
}
