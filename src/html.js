const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, ' [image: $1] ')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCharCode(parseInt(e.slice(1), 10)) : m))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every URL in a blob of HTML / markdown / text: hrefs, img srcs, markdown links and bare URLs. */
export function extractUrls(...blobs) {
  const found = new Set();
  for (const blob of blobs) {
    if (!blob) continue;
    const s = String(blob);
    for (const m of s.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) found.add(m[1]);
    for (const m of s.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) found.add(m[1]);
    for (const m of s.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) found.add(m[0]);
    for (const m of s.matchAll(/(?<![\w/])\/(?:private\/)?files\/[^\s"'<>)\]]+/g)) found.add(m[0]);
  }
  return [...found]
    .map((u) => u.replace(/&amp;/g, '&').replace(/[.,;:]+$/, ''))
    .filter((u) => !u.startsWith('mailto:') && !u.startsWith('#') && !u.startsWith('data:'));
}
