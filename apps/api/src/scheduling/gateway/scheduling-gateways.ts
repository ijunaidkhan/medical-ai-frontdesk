import { Injectable } from '@nestjs/common';
import { NativeAdapter } from './native-adapter.js';
import type { GatewayScope, SchedulingGateway } from './scheduling-gateway.js';

/**
 * Picks the calendar a practice's AI receptionist works with. Every practice uses our own tables for now; when EHR
 * connections exist, this reads the practice's connection and returns its adapter.
 */
@Injectable()
export class SchedulingGateways {
  constructor(private readonly native: NativeAdapter) {}

  // Async and given the scope already, because choosing an adapter will mean reading the practice's connection.
  forPractice(_scope: GatewayScope): Promise<SchedulingGateway> {
    return Promise.resolve(this.native);
  }
}
