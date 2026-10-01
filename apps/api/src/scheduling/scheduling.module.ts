import { Module } from '@nestjs/common';
import {
  AppointmentTypesController,
  AvailabilityController,
  ProviderTimeOffController,
  ProvidersController,
  SchedulingSettingsController,
} from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

/** Who can be booked, for what, when, and the practice's booking rules. Appointments and patients come next. */
@Module({
  controllers: [SchedulingSettingsController, ProvidersController, ProviderTimeOffController, AppointmentTypesController, AvailabilityController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
