import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  controllers: [TasksController],
  providers: [TasksService],
  // The AI receptionist (a later step) creates tasks through the same service.
  exports: [TasksService],
})
export class TasksModule {}
