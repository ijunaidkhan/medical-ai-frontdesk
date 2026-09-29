import { PASSWORD_MAX_LENGTH, type LoginRequest, type SwitchPracticeRequest } from '@frontdesk/shared';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LoginDto implements LoginRequest {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // No minimum-length rule here: that is enforced when a password is set, and
  // telling an attacker the length policy on login helps only them.
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @IsOptional()
  @IsUUID()
  practiceId?: string;
}

export class SwitchPracticeDto implements SwitchPracticeRequest {
  @IsUUID()
  practiceId!: string;
}
