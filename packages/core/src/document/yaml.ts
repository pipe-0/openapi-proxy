import { isJsonObject, type JsonObject } from "../types.js";
import { spend, spendText } from "./budget.js";
import { LONG_KEY } from "./limits.js";

/**
 * A document as YAML: block style, two spaces a level, as people write it.
 *
 * Written here because it is little, and because of what it costs otherwise.
 * A general YAML library first builds a tree of its own from the document,
 * several times the document's size, and decides for every text between a
 * dozen ways of writing it. A document here is plain data and needs three:
 *
 * - **as it is**, when no YAML reader of any version could take it for
 *   anything but that text;
 * - **as a block** (`|`), when it has several lines, so that descriptions
 *   read as they were written;
 * - **in double quotes**, the way JSON writes it, for everything else. Every
 *   JSON string is a YAML string.
 *
 * What it writes is counted like all other work, and `measure`
 * (document/limits.ts) says beforehand how much that can be.
 */
export function toYaml(doc: JsonObject): string {
  const out: string[] = [];
  const pads: string[] = [""];
  const pad = (depth: number) => {
    for (let known = pads.length; known <= depth; known++) pads.push(`${pads[known - 1]}  `);
    return pads[depth] as string;
  };
  const line = (text: string) => {
    spendText(text.length);
    out.push(text, "\n");
  };

  /**
   * Write `value` after `lead`, which is what its first line starts with
   * (`key:` or `-`, indented). Lines below the first are indented to `depth`.
   */
  const write = (value: unknown, lead: string, depth: number, inList: boolean): void => {
    spend();
    if (typeof value === "string") {
      const block = asBlock(value);
      if (!block) {
        line(`${lead} ${scalar(value)}`);
        return;
      }
      line(`${lead} ${block.header}`);
      const indent = pad(depth);
      for (const text of block.lines) line(text === "" ? "" : indent + text);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        line(`${lead} []`);
        return;
      }
      // In a list, the first item goes on the line of the dash: `- - a`.
      if (!inList) line(lead);
      value.forEach((item, i) => {
        write(item, `${i === 0 && inList ? `${lead} ` : pad(depth)}-`, depth + 1, true);
      });
      return;
    }
    if (isJsonObject(value)) {
      const keys = definedKeys(value);
      if (keys.length === 0) {
        line(`${lead} {}`);
        return;
      }
      // In a list, the first key goes on the line of the dash: `- name: a`.
      if (!inList) line(lead);
      keys.forEach((key, i) => {
        const start = i === 0 && inList ? `${lead} ` : pad(depth);
        if (key.length > LONG_KEY) {
          // Too long to be written before a colon.
          line(`${start}? ${quoted(key)}`);
          write(value[key], `${pad(depth)}:`, depth + 1, false);
        } else {
          write(value[key], `${start}${scalar(key)}:`, depth + 1, false);
        }
      });
      return;
    }
    line(`${lead} ${typeof value === "boolean" ? String(value) : number(value)}`);
  };

  const keys = definedKeys(doc);
  if (keys.length === 0) return "{}\n";
  for (const key of keys) {
    if (key.length > LONG_KEY) {
      line(`? ${quoted(key)}`);
      write(doc[key], ":", 1, false);
    } else {
      write(doc[key], `${scalar(key)}:`, 1, false);
    }
  }
  return out.join("");
}

/** As JSON has it: a key without a value is not written. */
const definedKeys = (object: JsonObject) =>
  Object.keys(object).filter((key) => object[key] !== undefined);

/**
 * A number, or `null` for anything else there is no way of writing (as JSON
 * does). With an exponent it gets a decimal point, without which YAML 1.1
 * readers take `1e-7` for text.
 */
function number(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "null";
  const text = String(value);
  return text.includes("e") && !text.includes(".") ? text.replace("e", ".0e") : text;
}

/**
 * Text that every YAML reader takes for itself. It starts with a letter (or
 * `/`, `$`, `_`: paths and `$ref` are the keys of this trade), which rules
 * out numbers, dates and everything YAML marks with a sign (a version number
 * is let through by name); it holds only
 * printable characters and none of the two sequences that end a text (`: `
 * and ` #`); and it is not one of the words older readers take for a boolean
 * or for nothing.
 */
/**
 * What can stand in a YAML text as it is: everything printable. Not control
 * characters, not the two Unicode line separators, not half a surrogate pair.
 */
const PRINTABLE =
  "\\u{20}-\\u{7e}\\u{a1}-\\u{2027}\\u{202a}-\\u{d7ff}\\u{e000}-\\u{fefe}\\u{ff00}-\\u{fffd}\\u{10000}-\\u{10ffff}";
const PLAIN = new RegExp(`^[A-Za-z_/$][${PRINTABLE}]*$`, "u");
const NOT_PLAIN = /: | #|[:\s]$/;
const WORDS = /^(?:true|false|null|yes|no|on|off|y|n)$/i;
/** The one kind of text that starts with a digit and is no number to anyone: `3.1.0`. */
const VERSION = /^\d+\.\d+\.[A-Za-z0-9.+-]+$/;

function scalar(text: string): string {
  spendText(text.length);
  if (VERSION.test(text)) return text;
  return PLAIN.test(text) && !NOT_PLAIN.test(text) && !WORDS.test(text) ? text : quoted(text);
}

/**
 * As JSON writes it, with the few characters escaped that JSON lets through
 * and a YAML reader would trip over or take for a line break.
 */
function quoted(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Characters a block can hold as they are: printable ones, tabs, and its line breaks. */
const BLOCK = new RegExp(`^[\\t\\n${PRINTABLE}]*$`, "u");

/**
 * A text of several lines as a block: its header and the lines under it.
 * Nothing for a text that is one line, or that a block could not give back
 * exactly (it starts with a space, or holds a character that has to be
 * escaped).
 */
function asBlock(text: string): { header: string; lines: string[] } | undefined {
  if (!text.includes("\n")) return undefined;
  spendText(text.length);
  if (/^\s/.test(text) || !BLOCK.test(text)) return undefined;
  const lines = text.split("\n");
  // How the line breaks at the end are kept: none (`|-`), one (`|`), or all of them (`|+`).
  const last = lines.at(-1);
  if (last !== "") return { header: "|-", lines };
  lines.pop();
  return { header: lines.at(-1) === "" ? "|+" : "|", lines };
}
