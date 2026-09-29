import { Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';

let known: ReadonlySet<string> | undefined;

/** True for an IANA time zone name such as "America/New_York", or "UTC". */
export function isKnownTimezone(value: unknown): value is string {
  known ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return typeof value === 'string' && known.has(value);
}

@ValidatorConstraint({ name: 'isIanaTimezone', async: false })
class IanaTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isKnownTimezone(value);
  }

  defaultMessage(): string {
    return 'timezone must be an IANA time zone name such as "America/New_York" or "UTC"';
  }
}

export const IsIanaTimezone = () => Validate(IanaTimezoneConstraint);
