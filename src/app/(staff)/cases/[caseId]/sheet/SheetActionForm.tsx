'use client';

import { useActionState } from 'react';

import type { SheetActionState } from './actions';
import { ErrorSummary } from '@/components/ui/ErrorSummary';

interface Props {
  action: (state: SheetActionState, formData: FormData) => Promise<SheetActionState>;
  caseId: string;
  label: string;
}

export function SheetActionForm({ action, caseId, label }: Props) {
  const [state, formAction, pending] = useActionState<SheetActionState, FormData>(action, {
    status: 'idle',
    message: '',
  });
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="caseId" value={caseId} />
      <button type="submit" className="btn-secondary w-auto px-5" disabled={pending}>
        {pending ? '処理中…' : label}
      </button>
      <ErrorSummary message={state.status === 'error' ? state.message : null} />
      {state.status === 'success' && (
        <p role="status" className="text-label">
          {state.message}
        </p>
      )}
    </form>
  );
}
