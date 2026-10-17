// Namespace-prefix-tolerant lookups. Enough for UPnP descriptions and SOAP replies; not a general XML parser.

const NAMED_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()];
    const hex = entity[1].toLowerCase() === "x";
    return String.fromCodePoint(hex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

export function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const elementPattern = (tag, flags) =>
  new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, flags);

export function elementContent(xml, tag) {
  return elementPattern(tag).exec(xml)?.[1] ?? null;
}

export function elementBlocks(xml, tag) {
  return [...xml.matchAll(elementPattern(tag, "g"))].map((m) => m[1]);
}

export function elementText(xml, tag) {
  const content = elementContent(xml, tag);
  if (content === null) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(content);
  return cdata ? cdata[1] : decodeXml(content.trim());
}
