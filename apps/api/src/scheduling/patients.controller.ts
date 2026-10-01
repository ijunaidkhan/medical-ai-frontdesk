import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Patient } from '@frontdesk/shared';
import type { Request, Response } from 'express';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/current-auth.decorator.js';
import { requestMeta } from '../common/request-meta.js';
import { RequirePermissions } from '../tenancy/permissions.decorator.js';
import { CreatePatientDto, PatientSearchQuery } from './appointments.dto.js';
import { PatientsService } from './patients.service.js';
import { IdParams } from './scheduling.dto.js';

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  /** Search by name or part of a phone number. Audited by how many patients were shown, never by the search text. */
  @RequirePermissions('patients:read')
  @Get()
  search(@CurrentAuth() auth: AuthContext, @Query() query: PatientSearchQuery, @Req() request: Request): Promise<Patient[]> {
    return this.patients.search(auth, query, requestMeta(request));
  }

  @RequirePermissions('patients:read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param() params: IdParams, @Req() request: Request): Promise<Patient> {
    return this.patients.get(auth, params.id, requestMeta(request));
  }

  /** Adds a patient, or returns the one who already matches on name, date of birth and phone (200 instead of 201). */
  @RequirePermissions('schedule:manage')
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: CreatePatientDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Patient> {
    const { patient, created } = await this.patients.findOrCreate(auth, dto, requestMeta(request));
    response.status(created ? 201 : 200);
    return patient;
  }
}
