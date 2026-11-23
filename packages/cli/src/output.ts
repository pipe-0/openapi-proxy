/**
 * What the commands print. Results go to standard output and everything else
 * to standard error, so that a result can be piped.
 */
const colored = (stream: NodeJS.WriteStream) =>
  stream.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (code: number, stream: NodeJS.WriteStream) => (text: string) =>
  colored(stream) ? `\u001b[${code}m${text}\u001b[0m` : text;

export const bold = paint(1, process.stdout);
export const dim = paint(2, process.stdout);
export const green = paint(32, process.stdout);
const red = paint(31, process.stderr);
const yellow = paint(33, process.stderr);

/**
 * How to run the tool, where a message says what to type next. This form
 * works whether it is installed in the project or not; `openapi-proxy` alone
 * only does inside the scripts of a package.json.
 */
export const RUN = "npx @pipe0/openapi-proxy";

export const print = (line = "") => process.stdout.write(`${line}\n`);
export const note = (line = "") => process.stderr.write(`${line}\n`);
export const warn = (line: string) => process.stderr.write(`${yellow("warning")} ${line}\n`);
export const fail = (line: string) => process.stderr.write(`${red("error")} ${line}\n`);

/** Columns of text, each as wide as its widest cell. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
