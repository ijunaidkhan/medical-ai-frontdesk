import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Task, TaskPage } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { CreateTaskDto, TaskListQuery, TaskParams, UpdateTaskDto } from './tasks.dto.js';
import { TasksService } from './tasks.service.js';

/** The signed-in practice's task queue. There is no way to name another practice. */
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @RequirePermissions('tasks:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: TaskListQuery): Promise<TaskPage> {
    return this.tasks.list(auth, query);
  }

  @RequirePermissions('tasks:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: TaskParams): Promise<Task> {
    return this.tasks.get(auth, params.id);
  }

  @RequirePermissions('tasks:manage')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateTaskDto, @Req() request: Request): Promise<Task> {
    return this.tasks.create(auth, dto, requestMeta(request));
  }

  @RequirePermissions('tasks:manage')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() params: TaskParams, @Body() dto: UpdateTaskDto, @Req() request: Request): Promise<Task> {
    return this.tasks.update(auth, params.id, dto, requestMeta(request));
  }
}
