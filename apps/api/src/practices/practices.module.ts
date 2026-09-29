import { Module } from '@nestjs/common';
import { PracticesController } from './practices.controller.js';
import { PracticesService } from './practices.service.js';

@Module({ controllers: [PracticesController], providers: [PracticesService] })
export class PracticesModule {}
