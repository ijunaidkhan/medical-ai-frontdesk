import {
  AFTER_HOURS_ACTIONS,
  EMERGENCY_MESSAGE_MAX_LENGTH,
  GREETING_MAX_LENGTH,
  PHONE_PATTERN,
  TRANSFER_LABEL_MAX_LENGTH,
  TRANSFER_PURPOSES,
  URGENT_ACTIONS,
  URGENT_PHRASE_MAX_LENGTH,
  URGENT_PHRASE_MIN_LENGTH,
  URGENT_PHRASES_MAX_COUNT,
  validateBusinessHours,
  type AfterHoursAction,
  type BusinessHours,
  type CreateTransferTargetRequest,
  type TransferPurpose,
  type UpdateAiSettingsRequest,
  type UpdateTransferTargetRequest,
  type UrgentAction,
} from '@frontdesk/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const trimEach = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.map((item: unknown) => (typeof item === 'string' ? item.trim() : item)) : value);
const provided = (_: unknown, value: unknown) => value !== undefined;
const present = (_: unknown, value: unknown) => value !== undefined && value !== null;

@ValidatorConstraint({ name: 'isBusinessHours', async: false })
class BusinessHoursConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return validateBusinessHours(value) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return validateBusinessHours(args.value) ?? 'businessHours is not valid';
  }
}

export class UpdateAiSettingsDto implements UpdateAiSettingsRequest {
  @ValidateIf(provided)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MaxLength(GREETING_MAX_LENGTH)
  greeting?: string;

  @ValidateIf(provided)
  @IsIn(AFTER_HOURS_ACTIONS)
  afterHoursAction?: AfterHoursAction;

  @ValidateIf(present)
  @IsUUID()
  afterHoursTransferTargetId?: string | null;

  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MaxLength(EMERGENCY_MESSAGE_MAX_LENGTH)
  emergencyMessage?: string;

  @ValidateIf(provided)
  @IsIn(URGENT_ACTIONS)
  urgentAction?: UrgentAction;

  @ValidateIf(present)
  @IsUUID()
  urgentTransferTargetId?: string | null;

  @ValidateIf(provided)
  @Transform(trimEach)
  @IsArray()
  @ArrayMaxSize(URGENT_PHRASES_MAX_COUNT)
  @IsString({ each: true })
  @MinLength(URGENT_PHRASE_MIN_LENGTH, { each: true })
  @MaxLength(URGENT_PHRASE_MAX_LENGTH, { each: true })
  extraUrgentPhrases?: string[];

  @ValidateIf(provided)
  @Validate(BusinessHoursConstraint)
  businessHours?: BusinessHours;
}

export class TransferTargetParams {
  @IsUUID()
  id!: string;
}

export class CreateTransferTargetDto implements CreateTransferTargetRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TRANSFER_LABEL_MAX_LENGTH)
  label!: string;

  @Matches(PHONE_PATTERN, { message: 'phone must be in international format, for example +14155550123' })
  phone!: string;

  @IsIn(TRANSFER_PURPOSES)
  purpose!: TransferPurpose;
}

export class UpdateTransferTargetDto implements UpdateTransferTargetRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TRANSFER_LABEL_MAX_LENGTH)
  label?: string;

  @ValidateIf(provided)
  @Matches(PHONE_PATTERN, { message: 'phone must be in international format, for example +14155550123' })
  phone?: string;

  @ValidateIf(provided)
  @IsIn(TRANSFER_PURPOSES)
  purpose?: TransferPurpose;

  @ValidateIf(provided)
  @IsBoolean()
  active?: boolean;
}
