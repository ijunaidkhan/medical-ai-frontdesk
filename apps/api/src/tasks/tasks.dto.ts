import {
  PHONE_PATTERN,
  TASK_CONTACT_NAME_MAX_LENGTH,
  TASK_DETAILS_MAX_LENGTH,
  TASK_PAGE_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  TASK_TYPES,
  type CreateTaskRequest,
  type TaskPriority,
  type TaskStatus,
  type TaskStatusFilter,
  type TaskType,
  type UpdateTaskRequest,
} from '@frontdesk/shared';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Validate unless absent. (Absent leaves a field alone; null is checked separately below.) */
const provided = (_: unknown, value: unknown) => value !== undefined;
/** Validate only real values: null is allowed and means "clear this field". */
const present = (_: unknown, value: unknown) => value !== undefined && value !== null;

const PHONE_MESSAGE = 'contactPhone must be in international format, for example +14155550123';

export class TaskParams {
  @IsUUID()
  id!: string;
}

export class CreateTaskDto implements CreateTaskRequest {
  @IsIn(TASK_TYPES)
  type!: TaskType;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  title!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TASK_DETAILS_MAX_LENGTH)
  details?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TASK_CONTACT_NAME_MAX_LENGTH)
  contactName?: string;

  @IsOptional()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  contactPhone?: string;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: TaskPriority;

  @IsOptional()
  @IsISO8601({ strict: true })
  dueAt?: string;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}

export class UpdateTaskDto implements UpdateTaskRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TASK_TITLE_MAX_LENGTH)
  title?: string;

  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @MaxLength(TASK_DETAILS_MAX_LENGTH)
  details?: string | null;

  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(TASK_CONTACT_NAME_MAX_LENGTH)
  contactName?: string | null;

  @ValidateIf(present)
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  contactPhone?: string | null;

  @ValidateIf(provided)
  @IsIn(TASK_PRIORITIES)
  priority?: TaskPriority;

  @ValidateIf(present)
  @IsISO8601({ strict: true })
  dueAt?: string | null;

  @ValidateIf(present)
  @IsUUID()
  assignedTo?: string | null;

  @ValidateIf(provided)
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;
}

export class TaskListQuery {
  @IsOptional()
  @IsIn([...TASK_STATUSES, 'active', 'all'])
  status?: TaskStatusFilter;

  /** "me", "unassigned", or a person's id. */
  @IsOptional()
  @Matches(/^(me|unassigned|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, {
    message: 'assignee must be "me", "unassigned" or a person id',
  })
  assignee?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_PAGE_MAX)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
