/**
 * One label per Take that tells it apart from every other Take shown: its
 * recording time to the second (`format`), and for Takes ending within the
 * same second a "(2)", "(3)"... in recording order. A later Take never
 * changes an earlier Take's label. List items, the selected summary and the
 * buttons' accessible names all use these labels.
 */
export function takeTimeLabels(entries, format) {
  const bySecond = new Map();
  const chronological = [...entries]
    .filter((entry) => typeof entry?.takeId === 'string')
    .sort((a, b) => Number(a.endedAtMs) - Number(b.endedAtMs) || a.takeId.localeCompare(b.takeId));
  const labels = new Map();
  for (const entry of chronological) {
    const time = format(entry.endedAtMs);
    const seen = (bySecond.get(time) ?? 0) + 1;
    bySecond.set(time, seen);
    labels.set(entry.takeId, seen === 1 ? time : `${time} (${seen})`);
  }
  return labels;
}
