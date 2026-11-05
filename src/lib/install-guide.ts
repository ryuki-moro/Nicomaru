export type InstallGuideKind = 'ios' | 'android' | null;

/** 案内を提供できるブラウザだけに表示する。iPadOS のデスクトップ UA も含む。 */
export function installGuideKind({
  userAgent,
  maxTouchPoints = 0,
  standalone,
  dismissed,
}: {
  userAgent: string;
  maxTouchPoints?: number;
  standalone: boolean;
  dismissed: boolean;
}): InstallGuideKind {
  if (standalone || dismissed || /\bLine\//i.test(userAgent)) return null;
  const ios =
    /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  if (ios && /Safari\//i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(userAgent)) {
    return 'ios';
  }
  if (
    /Android/i.test(userAgent) &&
    /Chrome\//i.test(userAgent) &&
    !/EdgA|OPR|SamsungBrowser|; wv\)/i.test(userAgent)
  )
    return 'android';
  return null;
}
