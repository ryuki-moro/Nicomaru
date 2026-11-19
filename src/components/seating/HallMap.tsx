'use client';

/**
 * 会場図。高砂・新郎側/新婦側の表示、卓の形と大きさ、卓のドラッグ移動を受け持つ。
 *
 * 卓の配置パターン（#180、SeatingLayoutEditor）と席次づくり（#181、SeatingChartEditor）で共有する。
 *   - 配置パターン: editable で卓を動かせる
 *   - 席次: editable を外して卓を押して選ぶだけにし、卓の中身（人数）と強調、ゲストのドロップを使う
 */
import { useRef, type ReactNode } from 'react';

import {
  HALL_SHAPE_LABEL,
  TABLE_SHAPE_LABEL,
  type HallShape,
  type TableShape,
} from '@/lib/seating/layout';

export interface HallMapTable {
  /** 画面内で卓を見分けるキー */
  key: string;
  name: string;
  capacity: number;
  shape: TableShape;
  /** 会場図の中の位置（左上 0、右下 1 の割合） */
  x: number;
  y: number;
}

/** 卓の強調。warn は定員超過や条件違反、dim は選んだゲストが座れない卓 */
export type HallMapTone = 'warn' | 'dim';

/** ゲストを卓へドラッグするときに dataTransfer へ入れる種類 */
export const GUEST_DRAG_TYPE = 'application/x-nicomaru-guest';

const DRAG_THRESHOLD_PX = 6;
const KEY_STEP = 0.01;

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

interface Props<T extends HallMapTable> {
  hall: HallShape;
  tables: T[];
  selectedKey: string | null;
  /** true なら卓を指やマウス・矢印キーで動かせる */
  editable: boolean;
  onSelect: (key: string) => void;
  onMove?: (key: string, x: number, y: number) => void;
  /** 卓の中に出す内容。省略すると「名前」と「◯名（定員）」 */
  renderBody?: (table: T) => ReactNode;
  /** 卓の読み上げ文。省略すると「名前、形、定員」 */
  describe?: (table: T) => string;
  tone?: (table: T) => HallMapTone | undefined;
  /** ゲストが卓へドロップされたとき（HTML5 drag。GUEST_DRAG_TYPE か text/plain に guestId を入れる） */
  onDropGuest?: (tableKey: string, guestId: string) => void;
  /** 小さな見本。卓は押せず、名前も出さない */
  compact?: boolean;
}

export function HallMap<T extends HallMapTable>({
  hall,
  tables,
  selectedKey,
  editable,
  onSelect,
  onMove,
  renderBody,
  describe,
  tone,
  onDropGuest,
  compact = false,
}: Props<T>) {
  const mapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    key: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const canMove = editable && !!onMove;

  return (
    <div
      ref={mapRef}
      className="relative w-full overflow-hidden rounded-card border border-border-mid bg-field-filled-bg"
      style={{
        aspectRatio: hall === 'wide' ? '3 / 2' : '3 / 4',
        maxWidth: compact ? 220 : hall === 'wide' ? 760 : 440,
      }}
      role={compact ? 'img' : 'group'}
      aria-label={`会場図（${HALL_SHAPE_LABEL[hall]}）`}
    >
      <div
        className={`absolute left-1/2 top-2 w-[34%] -translate-x-1/2 rounded-card bg-primary-dark px-2 text-center font-bold text-white ${
          compact ? 'py-0 text-[9px]' : 'py-1 text-caption'
        }`}
      >
        高砂
      </div>
      {!compact && (
        <>
          <span className="absolute left-2 top-2 text-caption text-text-secondary">◀ 新郎側</span>
          <span className="absolute right-2 top-2 text-caption text-text-secondary">新婦側 ▶</span>
        </>
      )}

      {tables.map((table) => {
        const size = TABLE_SIZE[hall][table.shape];
        const on = table.key === selectedKey;
        const t = tone?.(table);
        const shapeClass = table.shape === 'round' ? 'rounded-full' : 'rounded-card';
        const position = {
          left: `${table.x * 100}%`,
          top: `${table.y * 100}%`,
          width: size.width,
          aspectRatio: size.aspectRatio,
        };

        if (compact) {
          return (
            <span
              key={table.key}
              aria-hidden="true"
              className={`absolute -translate-x-1/2 -translate-y-1/2 border border-border-mid bg-surface ${shapeClass}`}
              style={position}
            />
          );
        }

        const colors = on
          ? 'border-primary bg-primary text-white'
          : t === 'warn'
            ? 'border-danger bg-danger-bg text-danger'
            : 'border-border-mid bg-surface text-text-primary';
        return (
          <button
            key={table.key}
            type="button"
            aria-pressed={on}
            aria-label={
              describe
                ? describe(table)
                : `${table.name}、${TABLE_SHAPE_LABEL[table.shape]}、定員${table.capacity}名${
                    canMove ? '。矢印キーで動かせます' : ''
                  }`
            }
            className={`absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center border-2 px-1 text-center leading-tight ${shapeClass} ${colors} ${
              t === 'dim' && !on ? 'opacity-40' : ''
            } ${canMove ? 'cursor-grab touch-none' : 'cursor-pointer'}`}
            style={position}
            onClick={() => onSelect(table.key)}
            onDragOver={
              onDropGuest
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                  }
                : undefined
            }
            onDrop={
              onDropGuest
                ? (e) => {
                    e.preventDefault();
                    const guestId =
                      e.dataTransfer.getData(GUEST_DRAG_TYPE) ||
                      e.dataTransfer.getData('text/plain');
                    if (guestId) onDropGuest(table.key, guestId);
                  }
                : undefined
            }
            onPointerDown={(e) => {
              onSelect(table.key);
              if (!canMove) return;
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
              onMove?.(table.key, d.originX + dx / rect.width, d.originY + dy / rect.height);
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              if (!canMove) return;
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
              onMove?.(table.key, table.x + move[0], table.y + move[1]);
            }}
          >
            {renderBody ? (
              renderBody(table)
            ) : (
              <>
                <span className="line-clamp-2 max-w-full break-all text-[11px] font-bold">
                  {table.name}
                </span>
                <span className="text-[10px]">{table.capacity}名</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
