import { CALLER_MESSAGE_MAX_LENGTH, CONVERSATION_PAGE_MAX, type SendMessageRequest } from '@frontdesk/shared';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { stripControl } from './sanitize.js';

const clean = ({ value }: { value: unknown }) => (typeof value === 'string' ? stripControl(value).trim() : value);

export class ConversationParams {
  @IsUUID()
  id!: string;
}

export class SendMessageDto implements SendMessageRequest {
  @Transform(clean)
  @IsString()
  @MinLength(1)
  @MaxLength(CALLER_MESSAGE_MAX_LENGTH)
  text!: string;
}

export class ConversationListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONVERSATION_PAGE_MAX)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
