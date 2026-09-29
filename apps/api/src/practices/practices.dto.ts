import { PHONE_PATTERN, PRACTICE_NAME_MAX_LENGTH, type UpdatePracticeRequest } from '@frontdesk/shared';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsIanaTimezone } from '../common/timezone.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const provided = (_: unknown, value: unknown) => value !== undefined;

/**
 * Only these three fields can be changed. The short name and status are
 * deliberately not here (and the database role has no right to change them).
 * A property that is absent is left alone; `null` is only valid for phone.
 */
export class UpdatePracticeDto implements UpdatePracticeRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(PRACTICE_NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf(provided)
  @IsIanaTimezone()
  timezone?: string;

  @ValidateIf((_, value: unknown) => value !== undefined && value !== null)
  @Matches(PHONE_PATTERN, { message: 'phone must be in international format, for example +14155550123' })
  phone?: string | null;
}
