// npm run demo:all の発表者の画面に出す台本を、docs/発表/AIデモ/発表台本.md から読む。

/** 「### 」の節ごとに、操作・きっかけ（（…））・セリフ（> …）を取り出す。キーは見出しの最初の語（導入・第1幕 など） */
export function parseScript(markdown) {
  const sections = {};
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      const title = line.slice(4).trim();
      current = { title, op: '', items: [] };
      sections[title.split(/[\s（]/)[0]] = current;
    } else if (line.startsWith('## ') || line === '---') current = null;
    else if (!current) continue;
    else if (/^\|\s*操作\s*\|/.test(line)) current.op = line.split('|')[2].trim();
    else if (line.startsWith('>'))
      current.items.push({ type: 'say', text: line.replace(/^>\s*/, '') });
    else if (line.startsWith('（')) current.items.push({ type: 'cue', text: line });
  }
  return sections;
}
