import {
  KNOWLEDGE_CATEGORIES,
  KNOWLEDGE_CONTENT_MAX_LENGTH,
  KNOWLEDGE_SEARCH_MAX_LENGTH,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  type CreateKnowledgeRequest,
  type KnowledgeCategory,
  type UpdateKnowledgeRequest,
} from '@frontdesk/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const provided = (_: unknown, value: unknown) => value !== undefined;

export class KnowledgeParams {
  @IsUUID()
  id!: string;
}

export class CreateKnowledgeDto implements CreateKnowledgeRequest {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_TITLE_MAX_LENGTH)
  title!: string;

  @IsIn(KNOWLEDGE_CATEGORIES)
  category!: KnowledgeCategory;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_CONTENT_MAX_LENGTH)
  content!: string;
}

export class UpdateKnowledgeDto implements UpdateKnowledgeRequest {
  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_TITLE_MAX_LENGTH)
  title?: string;

  @ValidateIf(provided)
  @IsIn(KNOWLEDGE_CATEGORIES)
  category?: KnowledgeCategory;

  @ValidateIf(provided)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_CONTENT_MAX_LENGTH)
  content?: string;
}

export class KnowledgeSearchQuery {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(KNOWLEDGE_SEARCH_MAX_LENGTH)
  q!: string;
}
