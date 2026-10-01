import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';
import {
  AppointmentTypesController,
  AvailabilityController,
  ProviderTimeOffController,
  ProvidersController,
  SchedulingSettingsController,
} from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

/** Who can be booked, for what, when, the practice's booking rules, and the patients and appointments themselves. */
@Module({
  controllers: [
    SchedulingSettingsController,
    ProvidersController,
    ProviderTimeOffController,
    AppointmentTypesController,
    AvailabilityController,
    PatientsController,
    AppointmentsController,
  ],
  providers: [SchedulingService, PatientsService, AppointmentsService],
  exports: [SchedulingService, PatientsService, AppointmentsService],
})
export class SchedulingModule {}
