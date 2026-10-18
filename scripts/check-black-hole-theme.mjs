import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/black-hole-theme.js', import.meta.url), 'utf8');
const schedule = overrides => ({ timeZone: 'Asia/Shanghai', fixedDates: [], annualDates: [], ...overrides });

function loadTheme(search = '') {
  const window = { location: { search } };
  const document = { documentElement: { dataset: {} } };
  runInNewContext(source, { window, document, URLSearchParams, Date, Intl, console }, { timeout: 1000 });
  return window.BlackHoleTheme;
}

function resolveAt(theme, instant, options = {}) {
  return theme.resolve({ date: new Date(instant), search: '', schedule: schedule(), ...options });
}

await test('an empty schedule preserves the minimal theme without inventing special dates', () => {
  const theme = loadTheme();
  for (const instant of ['2026-01-01T00:00:00Z', '2026-10-15T04:00:00Z', '2026-12-31T23:59:59Z']) {
    assert.equal(resolveAt(theme, instant), 'minimal');
  }
});

await test('a fixed date starts and ends at midnight in its configured time zone', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ fixedDates: ['2026-10-15'] }) };
  assert.equal(resolveAt(theme, '2026-10-14T15:59:59.999Z', options), 'minimal');
  assert.equal(resolveAt(theme, '2026-10-14T16:00:00.000Z', options), 'ink');
  assert.equal(resolveAt(theme, '2026-10-15T15:59:59.999Z', options), 'ink');
  assert.equal(resolveAt(theme, '2026-10-15T16:00:00.000Z', options), 'minimal');
});

await test('a fixed date does not recur in a different year', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ fixedDates: ['2026-10-15'] }) };
  assert.equal(resolveAt(theme, '2025-10-15T04:00:00Z', options), 'minimal');
  assert.equal(resolveAt(theme, '2026-10-15T04:00:00Z', options), 'ink');
  assert.equal(resolveAt(theme, '2027-10-15T04:00:00Z', options), 'minimal');
});

await test('annual dates recur on their calendar day while neighbouring days stay minimal', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ annualDates: ['10-15'] }) };
  for (const year of [2025, 2026, 2027]) {
    assert.equal(resolveAt(theme, `${year}-10-14T15:59:59Z`, options), 'minimal');
    assert.equal(resolveAt(theme, `${year}-10-14T16:00:00Z`, options), 'ink');
    assert.equal(resolveAt(theme, `${year}-10-15T16:00:00Z`, options), 'minimal');
  }
});

await test('an annual leap day neither shifts to February 28 nor rolls over to March 1', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ annualDates: ['02-29'] }) };
  assert.equal(resolveAt(theme, '2024-02-29T04:00:00Z', options), 'ink');
  assert.equal(resolveAt(theme, '2028-02-29T04:00:00Z', options), 'ink');
  for (const instant of ['2025-02-28T04:00:00Z', '2025-03-01T04:00:00Z', '2024-02-28T04:00:00Z', '2024-03-01T04:00:00Z']) {
    assert.equal(resolveAt(theme, instant, options), 'minimal');
  }
});

await test('the configured zone determines the calendar year instead of UTC or the host zone', () => {
  const theme = loadTheme();
  const instant = '2026-12-31T11:30:00Z';
  assert.equal(resolveAt(theme, instant, {
    schedule: schedule({ timeZone: 'Pacific/Kiritimati', fixedDates: ['2027-01-01'] }),
  }), 'ink');
  assert.equal(resolveAt(theme, instant, {
    schedule: schedule({ timeZone: 'America/Los_Angeles', fixedDates: ['2027-01-01'] }),
  }), 'minimal');
});

await test('a Sydney annual date follows its DST calendar boundary', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ timeZone: 'Australia/Sydney', annualDates: ['10-04'] }) };
  assert.equal(resolveAt(theme, '2026-10-03T13:59:59Z', options), 'minimal');
  assert.equal(resolveAt(theme, '2026-10-03T14:00:00Z', options), 'ink');
  assert.equal(resolveAt(theme, '2026-10-04T12:59:59Z', options), 'ink');
  assert.equal(resolveAt(theme, '2026-10-04T13:00:00Z', options), 'minimal');
});

await test('fixed and annual dates both remain effective in one schedule', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ fixedDates: ['2026-10-15'], annualDates: ['01-02'] }) };
  assert.equal(resolveAt(theme, '2026-10-15T04:00:00Z', options), 'ink');
  assert.equal(resolveAt(theme, '2027-01-02T04:00:00Z', options), 'ink');
  assert.equal(resolveAt(theme, '2027-10-15T04:00:00Z', options), 'minimal');
});

await test('explicit supported query overrides take precedence over the date schedule', () => {
  const theme = loadTheme();
  assert.equal(resolveAt(theme, '2026-10-15T04:00:00Z', {
    search: '?blackhole=minimal', schedule: schedule({ fixedDates: ['2026-10-15'] }),
  }), 'minimal');
  assert.equal(resolveAt(theme, '2026-10-16T04:00:00Z', { search: '?blackhole=ink' }), 'ink');
  assert.equal(resolveAt(theme, '2026-10-16T04:00:00Z', { search: '?ref=preview&blackhole=%69nk' }), 'ink');
});

await test('unsupported or malformed query values cannot select a theme or suppress a matching date', () => {
  const theme = loadTheme();
  const invalidQueries = ['?blackhole=', '?blackhole=INK', '?blackhole=watercolor', '?blackhole=%', '?blackhole=%3Cscript%3E', '?theme=ink'];
  for (const search of invalidQueries) {
    assert.equal(resolveAt(theme, '2026-10-16T04:00:00Z', { search }), 'minimal', search);
    assert.equal(resolveAt(theme, '2026-10-15T04:00:00Z', {
      search, schedule: schedule({ fixedDates: ['2026-10-15'] }),
    }), 'ink', search);
  }
});

await test('unconfigured arguments use the current URL and the editable schedule', () => {
  const preview = loadTheme('?blackhole=ink');
  assert.equal(preview.resolve({ date: new Date('2026-10-16T04:00:00Z') }), 'ink');
  const scheduled = loadTheme();
  scheduled.config.fixedDates.push('2026-10-15');
  assert.equal(scheduled.resolve({ date: new Date('2026-10-15T04:00:00Z') }), 'ink');
  assert.equal(scheduled.resolve({ date: new Date('2026-10-16T04:00:00Z') }), 'minimal');
});

await test('malformed date rules do not become valid through date normalization', () => {
  const theme = loadTheme();
  const options = { schedule: schedule({ fixedDates: ['2026-2-28', '2026-02-30', '2026-02-28 '], annualDates: ['2-28', '02-30', '02-28 '] }) };
  assert.equal(resolveAt(theme, '2026-02-28T04:00:00Z', options), 'minimal');
  assert.equal(resolveAt(theme, '2026-03-02T04:00:00Z', options), 'minimal');
});

await test('an invalid clock or time zone fails safely while an explicit preview still works', () => {
  const theme = loadTheme();
  assert.equal(theme.resolve({ date: new Date(NaN), search: '', schedule: schedule() }), 'minimal');
  assert.equal(resolveAt(theme, '2026-10-15T04:00:00Z', {
    schedule: schedule({ timeZone: 'Invalid/Zone', fixedDates: ['2026-10-15'] }),
  }), 'minimal');
  assert.equal(theme.resolve({ date: new Date(NaN), search: '?blackhole=ink', schedule: schedule({ timeZone: 'Invalid/Zone' }) }), 'ink');
});
