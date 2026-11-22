/**
 * Questions a program asks its terminal (cursor position, colours, device attributes…). A screen
 * answers them by typing the answer into the program, so replaying old output to a screen that
 * attaches later would answer them again: into the shell's prompt, as garbage like `11;rgb:0000/…R`.
 */
const QUERIES = new RegExp(
  [
    '\\x1b\\[\\??[\\d;]*n',
    '\\x1b\\[[>=]?[\\d;]*c',
    '\\x1b\\[\\??[\\d;]*\\$p',
    '\\x1b\\[>[\\d;]*q',
    '\\x1b\\[\\?u',
    '\\x1b\\[(?:1[1345689]|2[01])(?:;[\\d;]*)?t',
    '\\x1b\\](?:4|1\\d|52)(?:;[^\\x07\\x1b]*)?;\\?(?:\\x07|\\x1b\\\\)',
    '\\x1bP[$+]q[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)',
  ].join('|'),
  'g',
);

/** Output with the terminal queries in it taken out (they draw nothing; the program had its answer then). */
export const withoutQueries = (output: string): string => output.replace(QUERIES, '');
