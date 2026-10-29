/** Small helpers shared by the page scripts. */

export const $ = (id) => document.getElementById(id);

/** Formats a number for display, showing `digits` decimals unless the value is a whole number. */
export function formatNumber(value, digits = 2) {
  const number = Number(value);
  const isWhole = Number.isInteger(Number(number.toFixed(digits)));
  return number.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: isWhole ? 0 : digits,
  });
}

/** Saves `content` as a file through a temporary download link. */
export function downloadFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** <dt>/<dd> elements for a <dl>, from [label, value] pairs. */
export function definitionItems(entries) {
  return entries.flatMap(([label, value]) => [
    Object.assign(document.createElement('dt'), { textContent: label }),
    Object.assign(document.createElement('dd'), { textContent: value }),
  ]);
}

export function tableRow(values) {
  const row = document.createElement('tr');
  for (const value of values) {
    row.append(Object.assign(document.createElement('td'), { textContent: value }));
  }
  return row;
}
