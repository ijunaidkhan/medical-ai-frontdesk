import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import { IDEMPOTENCY_KEY_PATTERN, type Appointment } from '@frontdesk/shared';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { AppointmentListQuery, BookAppointmentDto, CancelAppointmentDto, RescheduleAppointmentDto } from './appointments.dto.js';
import { AppointmentsService } from './appointments.service.js';
import { IdParams } from './scheduling.dto.js';

/** Every booking and move needs a key that is the same when the same request is repeated, so a retry never books twice. */
function idempotencyKey(header: string | undefined): string {
  if (header === undefined || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new BadRequestException('Send an Idempotency-Key header of 8 to 100 letters, digits, "-" or "_"');
  }
  return header;
}

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** The calendar: appointments overlapping a window (default the next 7 days, at most 62), booked ones unless a status is asked for. */
  @RequirePermissions('schedule:read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: AppointmentListQuery): Promise<Appointment[]> {
    return this.appointments.list(auth, query);
  }

  @RequirePermissions('schedule:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: IdParams): Promise<Appointment> {
    return this.appointments.get(auth, params.id);
  }

  /** 201 when booked; 200 with the same appointment when the same Idempotency-Key is sent again. */
  @RequirePermissions('schedule:manage')
  @Post()
  async book(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: BookAppointmentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Appointment> {
    const { appointment, replayed } = await this.appointments.book(
      auth,
      { patientId: dto.patientId, providerId: dto.providerId, appointmentTypeId: dto.appointmentTypeId, startsAt: new Date(dto.startsAt), idempotencyKey: idempotencyKey(key) },
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return appointment;
  }

  @RequirePermissions('schedule:manage')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Body() dto: CancelAppointmentDto, @Req() request: Request): Promise<Appointment> {
    return this.appointments.cancel(auth, params.id, dto.reason, requestMeta(request));
  }

  /** Books the new time and releases the old one together. Returns the new appointment (200 on a repeated key). */
  @RequirePermissions('schedule:manage')
  @Post(':id/reschedule')
  async reschedule(
    @CurrentAuth() auth: AuthContext,
    @Param() params: IdParams,
    @Body() dto: RescheduleAppointmentDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Appointment> {
    const { appointment, replayed } = await this.appointments.reschedule(
      auth,
      params.id,
      { startsAt: new Date(dto.startsAt), providerId: dto.providerId, idempotencyKey: idempotencyKey(key) },
      requestMeta(request),
    );
    response.status(replayed ? 200 : 201);
    return appointment;
  }
}
