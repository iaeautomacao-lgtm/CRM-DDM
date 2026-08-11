// Formats a duration in seconds as HH:MM:SS. The hours part is not
// clamped to 2 digits — it grows past "99" for large sums like TTA
// (e.g. 30757 seconds worth of hours → "30757:03:15"), only the
// minutes/seconds are zero-padded to 2 digits.
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}
