// Day boundaries in the store's timezone. "Today" is decided here, inside the tool, so the
// model never has to guess what date it is or which timezone the store uses.

/** YYYY-MM-DD for `date` as seen in `timeZone`. */
export function localDate(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves "today" / "yesterday" / "YYYY-MM-DD" into a [after, before) window of local
 * wall-clock timestamps. WooCommerce interprets after/before in the site timezone when
 * dates_are_gmt is false, and the store's WordPress timezone is set to the same value.
 */
export function dayWindow(day: string, timeZone: string, now = new Date()): { date: string; after: string; before: string } {
  let ymd: string;
  if (day === "today") ymd = localDate(now, timeZone);
  else if (day === "yesterday") ymd = addDays(localDate(now, timeZone), -1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))) ymd = day;
  else throw new Error(`Invalid date "${day}". Use "today", "yesterday" or YYYY-MM-DD.`);
  return { date: ymd, after: `${ymd}T00:00:00`, before: `${addDays(ymd, 1)}T00:00:00` };
}
