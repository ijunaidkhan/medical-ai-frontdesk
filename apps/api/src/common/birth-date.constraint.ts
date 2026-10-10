import { isValidBirthDate } from '@frontdesk/shared';
import { ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface } from 'class-validator';

/** A date of birth: a real calendar date written YYYY-MM-DD, not in the future. */
@ValidatorConstraint({ name: 'birthDate', async: false })
export class BirthDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidBirthDate(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a real date in the form YYYY-MM-DD, not in the future`;
  }
}
