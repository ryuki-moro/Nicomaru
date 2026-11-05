/**
 * 卓の配置パターン（#180）の読み取り。書き込みは DB 関数（save_seating_layout など）だけが行う。
 * 参照範囲は RLS が決める（新郎新婦は新郎新婦に送られたものだけ）。
 */
import type { HallShape, SeatingTable, TableShape } from '@/lib/seating/layout';
import type { SupabaseServerClient } from '@/lib/supabase/server';

export interface SeatingLayout {
  id: string;
  name: string;
  hallShape: HallShape;
  /** 新郎新婦に送った日時。送っていなければ null */
  offeredAt: string | null;
  tables: (SeatingTable & { id: string })[];
}

interface LayoutRow {
  id: string;
  name: string;
  hall_shape: HallShape;
  offered_at: string | null;
  seating_tables: {
    id: string;
    name: string;
    capacity: number;
    shape: TableShape;
    pos_x: number | string;
    pos_y: number | string;
    allowed_tags: string[] | null;
    sort_order: number;
  }[];
}

/** 案件の配置パターンを作成順に読む。読めなかった場合は null。 */
export async function loadSeatingLayouts(
  supabase: SupabaseServerClient,
  caseId: string,
): Promise<SeatingLayout[] | null> {
  const { data, error } = await supabase
    .from('seating_layouts')
    .select(
      `id, name, hall_shape, offered_at,
       seating_tables ( id, name, capacity, shape, pos_x, pos_y, allowed_tags, sort_order )`,
    )
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) return null;
  return ((data ?? []) as unknown as LayoutRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    hallShape: row.hall_shape,
    offeredAt: row.offered_at,
    tables: [...(row.seating_tables ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        capacity: t.capacity,
        shape: t.shape,
        x: Number(t.pos_x),
        y: Number(t.pos_y),
        allowedTags: t.allowed_tags ?? [],
      })),
  }));
}
