import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { AppointmentType, AvailabilityResponse, Provider, ProviderTimeOff, SchedulingSettings } from '@frontdesk/shared';
import type { Request } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import {
  AvailabilityQuery,
  CreateAppointmentTypeDto,
  CreateProviderDto,
  CreateTimeOffDto,
  IdParams,
  UpdateAppointmentTypeDto,
  UpdateProviderDto,
  UpdateSchedulingSettingsDto,
} from './scheduling.dto.js';
import { SchedulingService } from './scheduling.service.js';

/** The practice's booking rules. There is no way to name another practice. */
@Controller('scheduling/settings')
export class SchedulingSettingsController {
  constructor(private readonly scheduling: SchedulingService) {}

  @RequirePermissions('schedule:read')
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<SchedulingSettings> {
    return this.scheduling.getSettings(auth);
  }

  @RequirePermissions('schedule:configure')
  @Patch()
  update(@CurrentAuth() auth: AuthContext, @Body() dto: UpdateSchedulingSettingsDto, @Req() request: Request): Promise<SchedulingSettings> {
    return this.scheduling.updateSettings(auth, dto, requestMeta(request));
  }
}

@Controller('providers')
export class ProvidersController {
  constructor(private readonly scheduling: SchedulingService) {}

  @RequirePermissions('schedule:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<Provider[]> {
    return this.scheduling.listProviders(auth);
  }

  @RequirePermissions('schedule:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: IdParams): Promise<Provider> {
    return this.scheduling.getProvider(auth, params.id);
  }

  @RequirePermissions('schedule:configure')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateProviderDto, @Req() request: Request): Promise<Provider> {
    return this.scheduling.createProvider(auth, dto, requestMeta(request));
  }

  @RequirePermissions('schedule:configure')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Body() dto: UpdateProviderDto, @Req() request: Request): Promise<Provider> {
    return this.scheduling.updateProvider(auth, params.id, dto, requestMeta(request));
  }

  @RequirePermissions('schedule:read')
  @Get(':id/time-off')
  timeOff(@CurrentAuth() auth: AuthContext, @Param() params: IdParams): Promise<ProviderTimeOff[]> {
    return this.scheduling.listTimeOff(auth, params.id);
  }

  @RequirePermissions('schedule:configure')
  @Post(':id/time-off')
  addTimeOff(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Body() dto: CreateTimeOffDto, @Req() request: Request): Promise<ProviderTimeOff> {
    return this.scheduling.createTimeOff(auth, params.id, dto, requestMeta(request));
  }
}

@Controller('provider-time-off')
export class ProviderTimeOffController {
  constructor(private readonly scheduling: SchedulingService) {}

  @RequirePermissions('schedule:configure')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Req() request: Request): Promise<ProviderTimeOff> {
    return this.scheduling.cancelTimeOff(auth, params.id, requestMeta(request));
  }
}

@Controller('appointment-types')
export class AppointmentTypesController {
  constructor(private readonly scheduling: SchedulingService) {}

  @RequirePermissions('schedule:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext): Promise<AppointmentType[]> {
    return this.scheduling.listAppointmentTypes(auth);
  }

  @RequirePermissions('schedule:configure')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() dto: CreateAppointmentTypeDto, @Req() request: Request): Promise<AppointmentType> {
    return this.scheduling.createAppointmentType(auth, dto, requestMeta(request));
  }

  @RequirePermissions('schedule:configure')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Body() dto: UpdateAppointmentTypeDto, @Req() request: Request): Promise<AppointmentType> {
    return this.scheduling.updateAppointmentType(auth, params.id, dto, requestMeta(request));
  }
}

/** What a caller would be offered right now, computed by the same code the AI receptionist uses. */
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly scheduling: SchedulingService) {}

  @RequirePermissions('schedule:read')
  @Get()
  find(@CurrentAuth() auth: AuthContext, @Query() query: AvailabilityQuery): Promise<AvailabilityResponse> {
    return this.scheduling.availability(auth, query);
  }
}
