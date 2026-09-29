import { validate } from 'class-validator';
import { IsIanaTimezone, isKnownTimezone } from './timezone.js';

class Sample {
  @IsIanaTimezone()
  timezone: unknown;
}

describe('isKnownTimezone', () => {
  it.each(['UTC', 'America/New_York', 'Europe/London', 'Asia/Karachi', 'Australia/Sydney'])('accepts %s', (value) => {
    expect(isKnownTimezone(value)).toBe(true);
  });

  it.each(['', 'EST5EDT-ish', 'America/Atlantis', 'america/new_york ', 'GMT+5', 12, null, undefined, {}])(
    'rejects %j',
    (value) => {
      expect(isKnownTimezone(value)).toBe(false);
    },
  );
});

describe('IsIanaTimezone', () => {
  it('produces a helpful message', async () => {
    const sample = new Sample();
    sample.timezone = 'Nowhere/Land';
    const [error] = await validate(sample);
    expect(Object.values(error!.constraints!)[0]).toMatch(/IANA time zone/);
  });

  it('passes a real zone', async () => {
    const sample = new Sample();
    sample.timezone = 'Asia/Karachi';
    expect(await validate(sample)).toHaveLength(0);
  });
});
