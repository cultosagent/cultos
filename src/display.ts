const oscSequence = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const csiSequence = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const tab = /\t/g;
const controlsExceptNewline = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const everyControl = /[\u0000-\u001f\u007f-\u009f]/g;

function stripSequences(value: string): string {
  return value.replace(oscSequence, "").replace(csiSequence, "");
}

/**
 * Remote text that is allowed to span lines, such as an error message.
 *
 * Line breaks survive; everything else that can move the cursor does not,
 * including the carriage return that would let remote text overwrite a line
 * the CLI already printed. Tabs become spaces so the terminal UI can keep
 * measuring width by character count.
 */
export function plain(value: string): string {
  return stripSequences(value).replace(tab, " ").replace(controlsExceptNewline, "");
}

/**
 * Remote text printed on a single line.
 *
 * A maintainer reads this output immediately before approving a settlement,
 * so a provider must not be able to add or rewrite lines within it.
 */
export function safe(value: string): string {
  return stripSequences(value).replace(tab, " ").replace(everyControl, "");
}

/** Escape a value interpolated into a Markdown table cell in a receipt. */
export function cell(value: string): string {
  return safe(value).replace(/\|/g, "\\|");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Code points a terminal draws two columns wide.
 *
 * East Asian Wide and Fullwidth, plus the emoji blocks. Ranges rather than a
 * full Unicode table: the frame only needs to stop drifting, and a table would
 * have to be regenerated with every Unicode release.
 */
const wideRanges: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd]
];

const emojiPresentation = 0xfe0f;
const zeroWidthJoiner = 0x200d;

function isWide(codePoint: number): boolean {
  return wideRanges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * How many terminal columns one grapheme occupies.
 *
 * Measured per grapheme cluster, so combining marks, variation selectors and
 * joined emoji are already folded into the character they modify rather than
 * counted on their own.
 */
function graphemeWidth(grapheme: string): number {
  const first = grapheme.codePointAt(0);
  if (first === undefined) return 0;
  if (isWide(first)) return 2;
  for (const character of grapheme) {
    const code = character.codePointAt(0);
    if (code === emojiPresentation || code === zeroWidthJoiner) return 2;
  }
  return 1;
}

/**
 * The number of terminal columns a string occupies.
 *
 * `String.length` counts UTF-16 code units, so it reads a CJK character as one
 * column when the terminal draws two, and an emoji as two when the terminal
 * draws two but the cluster may span four units. Either way the frame border
 * drifts.
 */
export function width(value: string): number {
  let total = 0;
  for (const { segment } of graphemes.segment(value)) total += graphemeWidth(segment);
  return total;
}

/** Cut a string to at most `columns` terminal columns, never splitting a grapheme. */
export function truncate(value: string, columns: number): string {
  if (columns <= 0) return "";
  let total = 0;
  let result = "";
  for (const { segment } of graphemes.segment(value)) {
    const next = graphemeWidth(segment);
    if (total + next > columns) break;
    total += next;
    result += segment;
  }
  return result;
}

/** Split a string into runs of at most `columns` terminal columns. */
export function chunk(value: string, columns: number): string[] {
  if (columns <= 0) return [value];
  const lines: string[] = [];
  let current = "";
  let total = 0;
  for (const { segment } of graphemes.segment(value)) {
    const next = graphemeWidth(segment);
    if (total + next > columns) {
      lines.push(current);
      current = "";
      total = 0;
    }
    current += segment;
    total += next;
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}
