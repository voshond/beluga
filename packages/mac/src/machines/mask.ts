/**
 * A mask from a mark's URL, quoted: Vite inlines a small SVG as a data: URL whose quotes and spaces
 * would break a bare url(…), and the browser would then drop the whole mask (a plain coloured square).
 */
export const maskOf = (url: string): string => `url(${JSON.stringify(url)})`;
