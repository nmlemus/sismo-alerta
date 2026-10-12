// Colors come from CSS custom properties (css/app.css), so light and dark mode
// each use their own validated steps. Read them at draw time.

const root = () => getComputedStyle(document.documentElement);
export const token = (name) => root().getPropertyValue(name).trim();

/** Age-class colors, newest first (see AGE_CLASSES in config.js). */
export const ageColors = () => [1, 2, 3, 4].map((i) => token(`--age-${i}`));

export function onThemeChange(fn) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', fn);
}
