import type { SpecFormat } from "@openapi-proxy/core";

export type TokenKind = "key" | "string" | "number" | "punctuation" | "plain";
export type Token = [kind: TokenKind, text: string];

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g;

function jsonLine(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of line.matchAll(JSON_TOKEN)) {
    const index = match.index;
    if (index > last) tokens.push(["plain", line.slice(last, index)]);
    const [text, quoted, colon] = match;
    if (quoted !== undefined) {
      tokens.push([colon ? "key" : "string", quoted]);
      if (colon) tokens.push(["punctuation", colon]);
    } else if (/^[{}[\],]$/.test(text)) {
      tokens.push(["punctuation", text]);
    } else {
      tokens.push(["number", text]);
    }
    last = index + text.length;
  }
  if (last < line.length) tokens.push(["plain", line.slice(last)]);
  return tokens;
}

const YAML_LINE = /^(\s*(?:- )*)([^\s#'"][^:#]*|'[^']*'|"[^"]*")(:)(\s|$)(.*)$/;

function yamlValue(value: string): Token[] {
  if (value === "") return [];
  if (/^(?:-?\d+(?:\.\d+)?|true|false|null|~)$/.test(value)) return [["number", value]];
  if (/^[|>][+-]?$|^[[\]{}]+$/.test(value)) return [["punctuation", value]];
  return [["string", value]];
}

function yamlLine(line: string): Token[] {
  const match = YAML_LINE.exec(line);
  if (match) {
    const [, indent = "", key = "", colon = "", gap = "", rest = ""] = match;
    return [
      ["punctuation", indent],
      ["key", key],
      ["punctuation", colon + gap],
      ...yamlValue(rest),
    ];
  }
  const item = /^(\s*- )(.*)$/.exec(line);
  if (item) return [["punctuation", item[1] ?? ""], ...yamlValue(item[2] ?? "")];
  return [["string", line]];
}

/**
 * Colour one line of a JSON or YAML document. Deliberately small: enough to
 * tell keys from values at a glance, not a parser.
 */
export function highlightLine(line: string, format: SpecFormat): Token[] {
  return format === "json" ? jsonLine(line) : yamlLine(line);
}
