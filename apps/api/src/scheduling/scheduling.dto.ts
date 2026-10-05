import {
  APPOINTMENT_DURATION_MAX,
  APPOINTMENT_DURATION_MIN,
  APPOINTMENT_TYPE_NAME_MAX_LENGTH,
  AVAILABILITY_LIMIT_MAX,
  CANCEL_MIN_HOURS_MAX,
  IDENTITY_FAILURE_CAP_MAX,
  IDENTITY_FAILURE_CAP_MIN,
  MAX_ADVANCE_DAYS_MAX,
  MAX_APPOINTMENT_TYPES,
  MIN_NOTICE_HOURS_MAX,
  PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_TITLE_MAX_LENGTH,
  SLOT_MINUTES_OPTIONS,
  TIME_FORMATS,
  TIME_OFF_REASON_MAX_LENGTH,
  type BusinessHours,
  type CreateAppointmentTypeRequest,
  type CreateProviderRequest,
  type CreateTimeOffRequest,
  type SlotMinutes,
  type TimeFormat,
  type UpdateAppointmentTypeRequest,
  type UpdateProviderRequest,
  type UpdateSchedulingSettingsRequest,
} from '@frontdesk/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
} from 'class-validator';
import { BusinessHoursConstraint } from '../ai/ai.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Validate unless absent (an absent field is left alone). */
const provided = (_: unknown, value: unknown) => value !== undefined;

const idList = [IsArray(), ArrayMaxSize(MAX_APPOINTMENT_TYPES), ArrayUnique(), IsUUID(undefined, { each: true })];
const apply = (...decorators: PropertyDecorator[]): PropertyDecorator => (target, key) => decorators.forEach((decorator) => decorator(target, key));

export class IdParams {
  @IsUUID()
  id!: string;
}

// ------------------------------------------------------------------ settings

export class UpdateSchedulingSettingsDto implements UpdateSchedulingSettingsRequest {
  @ValidateIf(provided)
  @IsInt()
  @IsIn(SLOT_MINUTES_OPTIONS)
  slotMinutes?: SlotMinutes;

  @ValidateIf(provided)
  @IsInt()
  @Min(0)
  @Max(MIN_NOTICE_HOURS_MAX)
  minNoticeHours?: number;

  @ValidateIf(provided)
  @IsInt()
  @Min(1)
  @Max(MAX_ADVANCE_DAYS_MAX)
  maxAdvanceDays?: number;

  @ValidateIf(provided)
  @IsInt()
  @Min(0)
  @Max(CANCEL_MIN_HOURS_MAX)
  cancelMinHours?: number;

  @ValidateIf(provided)
  @IsBoolean()
  aiBookingEnabled?: boolean;

  @ValidateIf(provided)
  @IsIn(TIME_FORMATS)
  timeFormat?: TimeFormat;

  @ValidateIf(provided)
  @IsInt()
  @Min(IDENTITY_FAILURE_CAP_MIN)
  @Max(IDENTITY_FAILURE_CAP_MAX)
  identityFailureCapPerHour?: number;
}

// ----------------------------------------------------------------- providers

export class CreateProviderDto implements CreateProviderRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROVIDER_TITLE_MAX_LENGTH)
  title?: string;

  @IsOptional()
  @Validate(BusinessHoursConstraint)
  hours?: BusinessHours;

  @IsOptional()
  @apply(...idList)
  appointmentTypeIds?: string[];
}

export class UpdateProviderDto implements UpdateProviderRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MaxLength(PROVIDER_TITLE_MAX_LENGTH)
  title?: string;

  @ValidateIf(provided)
  @Validate(BusinessHoursConstraint)
  hours?: BusinessHours;

  @ValidateIf(provided)
  @IsBoolean()
  active?: boolean;

  @ValidateIf(provided)
  @apply(...idList)
  appointmentTypeIds?: string[];
}

// -------------------------------------------------------- appointment types

export class CreateAppointmentTypeDto implements CreateAppointmentTypeRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(APPOINTMENT_TYPE_NAME_MAX_LENGTH)
  name!: string;

  @IsInt()
  @Min(APPOINTMENT_DURATION_MIN)
  @Max(APPOINTMENT_DURATION_MAX)
  durationMinutes!: number;

  @IsOptional()
  @apply(...idList)
  providerIds?: string[];
}

export class UpdateAppointmentTypeDto implements UpdateAppointmentTypeRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(APPOINTMENT_TYPE_NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf(provided)
  @IsInt()
  @Min(APPOINTMENT_DURATION_MIN)
  @Max(APPOINTMENT_DURATION_MAX)
  durationMinutes?: number;

  @ValidateIf(provided)
  @IsBoolean()
  active?: boolean;

  @ValidateIf(provided)
  @apply(...idList)
  providerIds?: string[];
}

// ----------------------------------------------------------------- time off

export class CreateTimeOffDto implements CreateTimeOffRequest {
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TIME_OFF_REASON_MAX_LENGTH)
  reason?: string;
}

// ------------------------------------------------------------- availability

export class AvailabilityQuery {
  @IsUUID()
  appointmentTypeId!: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AVAILABILITY_LIMIT_MAX)
  limit?: number;
}
