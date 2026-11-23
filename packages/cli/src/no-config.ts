import { HOSTED_URL, WAYS } from "@openapi-proxy/core";
import { fail, note, RUN } from "./output.js";

/** A sentence broken into lines a terminal shows whole. */
function lines(text: string, width = 76): string[] {
  const out: string[] = [];
  for (const word of text.split(" ")) {
    const last = out[out.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= width) {
      out[out.length - 1] = `${last} ${word}`;
    } else {
      out.push(word);
    }
  }
  return out;
}

/**
 * What to say when there is no definition file: the two ways to start, and
 * which is whose, in the words the app and the docs use for them.
 */
export function noConfig(path: string): void {
  fail(`There is no ${path} here.`);
  note("");
  note(`${WAYS.repository.title}.`);
  for (const line of lines(WAYS.repository.when)) note(line);
  note("");
  note(`  ${RUN} init <url or file of your OpenAPI document>`);
  note("");
  note(`${WAYS.url.title}.`);
  for (const line of lines(WAYS.url.when)) note(line);
  note("");
  note(`  ${HOSTED_URL}`);
}
