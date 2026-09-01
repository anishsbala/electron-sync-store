export function shortenIdentifier(value: string | null): string {
  if (value === null) {
    return "—";
  }
  if (value.length <= 13) {
    return value;
  }
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

export function formatClock(date = new Date()): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
