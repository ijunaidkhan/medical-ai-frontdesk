import {
  APPOINTMENT_CANCEL_REASON_MAX_LENGTH,
  APPOINTMENT_LIST_LIMIT_MAX,
  APPOINTMENT_STATUSES,
  isValidBirthDate,
  PATIENT_NAME_MAX_LENGTH,
  PATIENT_SEARCH_LIMIT_MAX,
  PATIENT_SEARCH_MIN_LENGTH,
  PHONE_PATTERN,
  type BookAppointmentRequest,
  type CancelAppointmentRequest,
  type CreatePatientRequest,
  type RescheduleAppointmentRequest,
} from '@frontdesk/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

@ValidatorConstraint({ name: 'birthDate', async: false })
class BirthDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidBirthDate(value);
  }
  defaultMessage(): string {
    return 'dateOfBirth must be a real date in the form YYYY-MM-DD, not in the future';
  }
}

export class CreatePatientDto implements CreatePatientRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(PATIENT_NAME_MAX_LENGTH)
  firstName!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(PATIENT_NAME_MAX_LENGTH)
  lastName!: string;

  @Validate(BirthDateConstraint)
  dateOfBirth!: string;

  @Matches(PHONE_PATTERN, { message: 'phone must be in international format, for example +14155550123' })
  phone!: string;
}

export class PatientSearchQuery {
  @Transform(trim)
  @IsString()
  @MinLength(PATIENT_SEARCH_MIN_LENGTH)
  @MaxLength(100)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PATIENT_SEARCH_LIMIT_MAX)
  limit?: number;
}

export class BookAppointmentDto implements BookAppointmentRequest {
  @IsUUID()
  patientId!: string;

  @IsUUID()
  providerId!: string;

  @IsUUID()
  appointmentTypeId!: string;

  @IsISO8601({ strict: true })
  startsAt!: string;
}

export class RescheduleAppointmentDto implements RescheduleAppointmentRequest {
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;
}

export class CancelAppointmentDto implements CancelAppointmentRequest {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPOINTMENT_CANCEL_REASON_MAX_LENGTH)
  reason?: string;
}

export class AppointmentListQuery {
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @IsUUID()
  providerId?: string;

  @IsOptional()
  @IsUUID()
  patientId?: string;

  /** One status, or "all". The default is booked appointments only. */
  @IsOptional()
  @IsIn([...APPOINTMENT_STATUSES, 'all'])
  status?: (typeof APPOINTMENT_STATUSES)[number] | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(APPOINTMENT_LIST_LIMIT_MAX)
  limit?: number;
}
