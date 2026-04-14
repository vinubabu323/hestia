const everyPattern = /^@every\s+(\d+)(ms|s|m|h)$/;

function durationToMs(value, unit) {
  if (unit === "ms") {
    return value;
  }
  if (unit === "s") {
    return value * 1000;
  }
  if (unit === "m") {
    return value * 60 * 1000;
  }
  return value * 60 * 60 * 1000;
}

function parseField(field, min, max) {
  if (field === "*") {
    return { type: "wildcard" };
  }

  if (field.startsWith("*/")) {
    const step = Number(field.slice(2));
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid step: ${field}`);
    }
    return { type: "step", step };
  }

  const value = Number(field);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid value: ${field}`);
  }

  return { type: "value", value };
}

function matchField(rule, value) {
  if (rule.type === "wildcard") {
    return true;
  }
  if (rule.type === "step") {
    return value % rule.step === 0;
  }
  return rule.value === value;
}

export function validateSchedule(schedule) {
  computeNextRunAt(schedule, new Date());
}

export function computeNextRunAt(schedule, fromDate) {
  const everyMatch = schedule.match(everyPattern);
  if (everyMatch) {
    const amount = Number(everyMatch[1]);
    return new Date(fromDate.getTime() + durationToMs(amount, everyMatch[2]));
  }

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("schedule must be a 5-field cron expression or @every duration");
  }

  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;
  const minuteRule = parseField(minutePart, 0, 59);
  const hourRule = parseField(hourPart, 0, 23);
  const dayRule = parseField(dayPart, 1, 31);
  const monthRule = parseField(monthPart, 1, 12);
  const weekdayRule = parseField(weekdayPart, 0, 6);

  const candidate = new Date(fromDate.getTime() + 60 * 1000);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 366; i += 1) {
    if (
      matchField(monthRule, candidate.getMonth() + 1) &&
      matchField(dayRule, candidate.getDate()) &&
      matchField(weekdayRule, candidate.getDay()) &&
      matchField(hourRule, candidate.getHours()) &&
      matchField(minuteRule, candidate.getMinutes())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error("could not compute next run time for schedule");
}

export function computeRetryDelayMs(baseSeconds, attempt) {
  const exponent = Math.max(attempt - 1, 0);
  const baseMs = Math.max(baseSeconds, 1) * 1000;
  const withoutJitter = baseMs * 2 ** exponent;
  const jitter = Math.floor(withoutJitter * 0.2 * Math.random());
  return withoutJitter + jitter;
}
